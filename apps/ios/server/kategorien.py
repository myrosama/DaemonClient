"""Ordnet Immich-Fotos automatisch Kategorien zu (Tags „Kategorie/…“) – für die eigene Fotos-App.

Liest NUR aus der Immich-Datenbank (Rolle mit Leserechten) und schreibt Tags über die Immich-API
mit dem API-Key des jeweiligen Besitzers. Jedes Objekt wird genau einmal je Regel-Version geprüft;
von Hand entfernte Tags kommen deshalb nicht wieder.

Apple-eigene Arten (Porträt, Zeitraffer, Kino, Importe) kann nur das iPhone wissen – die setzt die App
beim Sichern mit denselben Tag-Namen.
"""
import json, os, re, sqlite3, time, logging
import numpy as np, cv2, psycopg, requests

RULES_VERSION = 1
IMMICH = os.environ.get("IMMICH_URL", "http://immich-server:2283/api")
ML = os.environ.get("ML_URL", "http://immich-machine-learning:3003")
# Datenbank-Zugang lieber aus einer Datei (Docker-Secret) als aus der Umgebung (GitHub-Issue #10)
DB = open(os.environ["DB_URL_FILE"]).read().strip() if os.environ.get("DB_URL_FILE") else os.environ["DB_URL"]
KEYS = json.load(open(os.environ.get("KEYS_FILE", "/config/keys.json")))  # {userId: apiKey}
STATE = os.environ.get("STATE_DB", "/data/state.db")
INTERVAL = int(os.environ.get("INTERVAL", "900"))
DRY = bool(os.environ.get("DRY"))  # Probelauf: nur anzeigen, nichts schreiben
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
log = logging.info

RAW = (".dng", ".cr2", ".cr3", ".nef", ".arw", ".raf", ".orf", ".rw2", ".pef", ".srw")
RECEIPT = re.compile(r"\b(summe|gesamt|total|mwst|ust\.?|zwischensumme|bar|ec-?karte|kasse|bon|beleg|quittung|rückgeld|rueckgeld|toplam|kdv|fiş|fis)\b", re.I)
DOC_CHARS = int(os.environ.get("DOC_CHARS", "150"))
PRICE = re.compile(r"\d+[.,]\d{2}\b")

# Null-Schuss-Einordnung mit dem Bild-Text-Modell: Klasse gewinnt nur, wenn sie vor allen „normalen“ Motiven liegt.
CLIP_CLASSES = {
    "Handschrift": ["eine handgeschriebene Notiz auf Papier", "a handwritten note on paper", "handwriting with a pen"],
    "Illustrationen": ["eine Illustration oder Zeichnung", "a flat cartoon illustration", "clip art drawing", "a digital painting"],
}
# Nötiger Vorsprung vor dem besten normalen Motiv (an Testbildern geeicht: Notizen ≥ +0,024, Briefe ≤ +0,001;
# Zeichnungen +0,002…+0,017, Tierfotos ≤ 0). Bilder ohne Kamera-Hersteller sind öfter Grafiken → kleinerer Abstand.
CLIP_MARGIN = {"Handschrift": 0.015, "Illustrationen": 0.005}
NO_CAMERA_BONUS = 0.005
CLIP_OTHER = ["a photo of a person", "a selfie", "a landscape photo", "a photo of an animal", "a photo of a flower",
              "a printed document page", "a typed letter", "ein gedrucktes Schreiben", "a shopping receipt", "a screenshot of a phone screen", "a QR code poster",
              "a photo of food", "a city street", "a photo of an object", "a musical instrument", "a sports ball",
              "a colorful gradient background with white text", "a beach", "a building", "a car"]


BATCH = int(os.environ.get("BATCH", "500"))
READY = """
        from asset a
        join asset_job_status j on j."assetId" = a.id
        left join smart_search s on s."assetId" = a.id
        where a."ownerId" = %s and a."deletedAt" is null and a.visibility <> 'hidden'::asset_visibility_enum
          and j."metadataExtractedAt" is not null
          and (a.type = 'VIDEO' or (j."ocrAt" is not null and s."assetId" is not null))
"""
def ready_ids(cur, owner, done):
    """Nur die IDs – beim Import von zehntausenden Fotos bleibt der Speicher klein."""
    cur.execute("select a.id::text" + READY, (owner,))
    return [r[0] for r in cur.fetchall() if r[0] not in done]
def details(cur, ids):
    cur.execute("""
        select a.id::text, a.type, a."originalFileName", a.width, a.height, a."livePhotoVideoId" is not null,
               e.make, e."lensModel", e.fps, e."autoStackId", v."codecName",
               (select string_agg(o.text, ' ') from asset_ocr o where o."assetId" = a.id) as ocr,
               s.embedding::text
        from asset a
        left join asset_exif e on e."assetId" = a.id
        left join asset_video v on v."assetId" = a.id
        left join smart_search s on s."assetId" = a.id
        where a.id = any(%s::uuid[])
    """, (ids,))
    return cur.fetchall()
def text_emb(prompts, model):
    out = []
    for p in prompts:
        r = requests.post(f"{ML}/predict", data={"entries": json.dumps({"clip": {"textual": {"modelName": model, "options": {}}}}), "text": p}, timeout=120)
        r.raise_for_status()
        v = r.json()["clip"]; v = np.array(json.loads(v) if isinstance(v, str) else v, dtype=np.float32)
        out.append(v / np.linalg.norm(v))
    return np.stack(out)


def qr_found(asset_id, key):
    """Nur echte, lesbare QR-Codes zählen (reines Erkennen des Musters gibt zu viele Fehltreffer)."""
    r = requests.get(f"{IMMICH}/assets/{asset_id}/thumbnail", params={"size": "preview"}, headers={"x-api-key": key}, timeout=60)
    if r.status_code != 200: return False
    img = cv2.imdecode(np.frombuffer(r.content, np.uint8), cv2.IMREAD_GRAYSCALE)
    if img is None: return False
    det = cv2.QRCodeDetector()
    for im in (img, cv2.resize(img, None, fx=1.6, fy=1.6)):
        text, _, _ = det.detectAndDecode(im)
        if text: return True
    return False


def classify(row, prompts, labels, key):
    (aid, typ, name, w, h, live, make, lens, fps, burst, codec, ocr, emb) = row
    name = (name or "").lower(); cats = set()
    ratio = (max(w, h) / min(w, h)) if w and h else 0
    if typ == "VIDEO":
        if name.startswith("rpreplay"): cats.add("Bildschirmaufnahmen")
        if fps and fps >= 100: cats.add("Slo-Mo")
        if codec and "prores" in codec.lower(): cats.add("ProRes")
        return cats
    if lens and "front" in lens.lower(): cats.add("Selfies")
    if live: cats.add("Live Photos")
    if burst: cats.add("Serien")
    if name.endswith(RAW): cats.add("RAW")
    if name.endswith(".gif"): cats.add("Animiert")
    screenshot = name.endswith(".png") and not make and 1.7 <= ratio <= 2.4
    if screenshot: cats.add("Bildschirmfotos")
    if ratio >= 2.5 and not screenshot: cats.add("Panoramen")
    text = ocr or ""
    if len(RECEIPT.findall(text)) >= 2 and len(PRICE.findall(text)) >= 3: cats.add("Belege")
    elif len(text) >= DOC_CHARS and not screenshot: cats.add("Dokumente")
    if emb and prompts is not None and not screenshot:
        v = np.array(json.loads(emb), dtype=np.float32); v /= np.linalg.norm(v)
        sims = prompts @ v
        other = max(s for s, l in zip(sims, labels) if l == "_")
        for c in CLIP_CLASSES:
            best = max(s for s, l in zip(sims, labels) if l == c)
            if DRY and best > other - 0.03: log(f"    {name}: {c} {best - other:+.3f} ocr={len(text)}")
            need = CLIP_MARGIN[c] - (NO_CAMERA_BONUS if not make and c == "Illustrationen" else 0)
            if best - other >= need: cats.add(c)
        # Gedrucktes ist keine Handschrift
        if cats & {"Belege", "Dokumente"}: cats.discard("Handschrift")
    if not screenshot and qr_found(aid, key): cats.add("QR-Codes")
    return cats


def run_once(state):
    with psycopg.connect(DB) as con, con.cursor() as cur:
        cur.execute("select value from system_metadata where key = 'system-config'")
        cfg = (cur.fetchone() or [{}])[0] or {}
        model = cfg.get("machineLearning", {}).get("clip", {}).get("modelName", "ViT-B-32__openai")
        prompts = labels = None
        try:
            names = [(c, p) for c, ps in CLIP_CLASSES.items() for p in ps] + [("_", p) for p in CLIP_OTHER]
            prompts = text_emb([p for _, p in names], model); labels = [c for c, _ in names]
        except Exception as e:
            log(f"Bild-Text-Modell nicht erreichbar ({e}) – CLIP-Kategorien diese Runde aus")
        for owner, key in KEYS.items():
            done = {r[0] for r in state.execute("select id from done where version = ?", (RULES_VERSION,))}
            todo = ready_ids(cur, owner, done)
            # Stapelweise prüfen und nach jedem Stapel merken – ein Abbruch kostet höchstens einen Stapel
            for start in range(0, len(todo), BATCH):
                rows = details(cur, todo[start:start + BATCH])
                if prompts is None: rows = [r for r in rows if r[1] == "VIDEO"]
                if not rows: continue
                by_cat = {}
                for r in rows:
                    cats = classify(r, prompts, labels, key)
                    if DRY and cats: log(f"  {r[2]}: {', '.join(sorted(cats))}")
                    for c in cats: by_cat.setdefault(c, []).append(r[0])
                summary = ", ".join(f"{c} {len(a)}" for c, a in sorted(by_cat.items()))
                if DRY:
                    log(f"PROBELAUF {owner[:8]} Stapel {start // BATCH + 1}: {len(rows)} – {summary}")
                    continue
                h = {"x-api-key": key}
                if by_cat:
                    tags = requests.put(f"{IMMICH}/tags", json={"tags": [f"Kategorie/{c}" for c in by_cat]}, headers=h, timeout=60)
                    tags.raise_for_status()
                    ids = {t["value"].split("/", 1)[1]: t["id"] for t in tags.json() if t["value"].startswith("Kategorie/")}
                    for c, assets in by_cat.items():
                        requests.put(f"{IMMICH}/tags/assets", json={"tagIds": [ids[c]], "assetIds": assets}, headers=h, timeout=120).raise_for_status()
                state.executemany("insert or replace into done(id, version) values (?, ?)", [(r[0], RULES_VERSION) for r in rows])
                state.commit()
                log(f"{owner[:8]}: {start + len(rows)}/{len(todo)} geprüft – {summary}")


def main():
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    state = sqlite3.connect(STATE)
    state.execute("create table if not exists done (id text primary key, version int)")
    while True:
        try: run_once(state)
        except Exception as e: log(f"Fehler: {e}")
        if os.environ.get("ONCE"): break
        time.sleep(INTERVAL)


if __name__ == "__main__":
    main()
