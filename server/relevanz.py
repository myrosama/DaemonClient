"""Relevanz-Prüfung für die KI-Suche der Fotos-App.

Immich liefert bei der KI-Suche immer die ähnlichsten Fotos – auch wenn gar nichts passt (z. B. „Hund“ ohne Hund).
Dieser Dienst bewertet die gefundenen Fotos: Wie weit hebt sich ein Foto vom Rest der eigenen Mediathek ab?
(z = Abstand zum Median aller Fotos in Standardabweichungen.) Nur klare Ausreißer gelten als Treffer.

POST /relevanz  {"query": "Eule", "ids": ["…", …]}   Header wie bei Immich (Authorization: Bearer … oder x-api-key)
→ {"keep": [ids…], "z": {id: z}}

POST /relevanz {"check": [ids…], "queries": ["Wunde", …]}   heikle Fotos für Titelbilder: Treffer je Foto über alle
Begriffe; fehlen einem Foto die KI-Merkmale (Server rechnet noch), werden sie hier aus der Vorschau berechnet.
→ {"flagged": [ids…]}

POST /gesichter (oder /relevanz mit personId, so reicht der vorhandene Proxy-Pfad) {"personId": "…"}   „Ist das X?“ wie bei Apple: noch keiner Person zugeordnete Gesichter, die den
Gesichtern dieser Person am ähnlichsten sind (Abstand zum Mittelwert der Gesichts-Merkmale).
→ {"faces": [{"faceId", "assetId", "distance", "box": [x1, y1, x2, y2], "size": [w, h]}, …]}
Zuordnen macht die App danach selbst über Immich (PUT /faces/{personId}).

Liest NUR aus der Datenbank (Rolle „kategorien“), prüft die Anmeldung über Immich selbst (/users/me).
"""
import json, os, time, logging, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import numpy as np, psycopg, requests

IMMICH = os.environ.get("IMMICH_URL", "http://immich-server:2283/api")
ML = os.environ.get("ML_URL", "http://immich-machine-learning:3003")
# Datenbank-Zugang lieber aus einer Datei (Docker-Secret) als aus der Umgebung (GitHub-Issue #10)
DB = open(os.environ["DB_URL_FILE"]).read().strip() if os.environ.get("DB_URL_FILE") else os.environ["DB_URL"]
PORT = int(os.environ.get("PORT", "2284"))
# An Testbildern geeicht (03.11.2026): Fehlgriffe ≤ 2,7, echte Treffer ≥ 2,8; Einzeltreffer ragen ≥ 0,8 über Platz 10.
Z_MIN = float(os.environ.get("Z_MIN", "2.8"))
GAP_MIN = float(os.environ.get("GAP_MIN", "0.8"))
GAP_FLOOR = float(os.environ.get("GAP_FLOOR", "2.2"))
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
log = logging.info

_users: dict[str, tuple[str, float]] = {}      # Anmeldung → (userId, gültig bis)
_emb: dict[tuple[str, str], np.ndarray] = {}    # (Modell, Text) → Vektor
_lock = threading.Lock()


# --- Schutz (GitHub-Issue #6): Größenlimit, höchstens N gleichzeitige Anfragen, Fehlversuche je Adresse bremsen ---
MAX_BODY = int(os.environ.get("MAX_BODY_MB", "2")) << 20
_slots = threading.BoundedSemaphore(int(os.environ.get("MAX_CONCURRENT", "4")))
_fails: dict[str, list[float]] = {}
_fails_lock = threading.Lock()


def too_many_failures(ip: str) -> bool:
    """Mehr als 20 abgelehnte Anmeldungen je Minute von einer Adresse → 429 (schont auch Immich)."""
    now = time.time()
    with _fails_lock:
        recent = [t for t in _fails.get(ip, []) if now - t < 60]
        _fails[ip] = recent
        return len(recent) >= 20


def note_failure(ip: str) -> None:
    with _fails_lock:
        _fails.setdefault(ip, []).append(time.time())


def user_id(headers) -> str | None:
    auth = headers.get("Authorization") or ""
    key = headers.get("x-api-key") or ""
    cred = auth or key
    if not cred:
        return None
    now = time.time()
    with _lock:
        hit = _users.get(cred)
        if hit and hit[1] > now:
            return hit[0]
    h = {"Authorization": auth} if auth else {"x-api-key": key}
    try:
        r = requests.get(f"{IMMICH}/users/me", headers=h, timeout=5)
    except requests.RequestException:
        return None
    if r.status_code != 200:
        return None
    uid = r.json()["id"]
    with _lock:
        _users[cred] = (uid, now + 600)
    return uid


def clip_model(cur) -> str:
    cur.execute("select value from system_metadata where key = 'system-config'")
    row = cur.fetchone()
    cfg = row[0] if row else {}
    if isinstance(cfg, str):
        cfg = json.loads(cfg)
    return cfg.get("machineLearning", {}).get("clip", {}).get("modelName", "ViT-B-32__openai")


def text_emb(model: str, text: str) -> np.ndarray:
    k = (model, text)
    if k in _emb:
        return _emb[k]
    r = requests.post(f"{ML}/predict", timeout=60, data={
        "entries": json.dumps({"clip": {"textual": {"modelName": model, "options": {}}}}), "text": text})
    r.raise_for_status()
    v = r.json()["clip"]
    v = np.array(json.loads(v) if isinstance(v, str) else v, dtype=np.float32)
    v /= np.linalg.norm(v)
    if len(_emb) > 2000:
        _emb.clear()
    _emb[k] = v
    return v


def score(uid: str, query: str, ids: list[str]) -> dict:
    with psycopg.connect(DB) as c, c.cursor() as cur:
        model = clip_model(cur)
        vec = "[" + ",".join(f"{x:.7f}" for x in text_emb(model, query)) + "]"
        cur.execute("""
            with sc as materialized (
                select s."assetId" as id, 1 - (s.embedding <=> %s::vector) as sim
                from smart_search s join asset a on a.id = s."assetId"
                where a."ownerId" = %s and a."deletedAt" is null
            ), st as (
                select percentile_cont(0.5) within group (order by sim) as med, stddev_pop(sim) as sd,
                       (select sim from sc order by sim desc offset 9 limit 1) as r10
                from sc
            )
            select st.med, st.sd, st.r10, sc.id::text, sc.sim
            from st left join sc on sc.id = any(%s::uuid[])
        """, (vec, uid, ids))
        rows = cur.fetchall()
    if not rows or rows[0][1] in (None, 0):
        return {"keep": ids, "z": {}}
    med, sd, r10 = rows[0][0], rows[0][1], rows[0][2]
    z10 = ((r10 - med) / sd) if r10 is not None else 0
    z = {r[3]: round((r[4] - med) / sd, 2) for r in rows if r[3]}
    keep = [i for i in ids if i in z and (z[i] >= Z_MIN or (z[i] >= GAP_FLOOR and z[i] - z10 >= GAP_MIN))]
    log("relevanz %r: %d von %d (z10=%.2f)", query, len(keep), len(ids), z10)
    return {"keep": keep, "z": z}


def image_emb(model: str, auth: dict, asset: str) -> np.ndarray | None:
    r = requests.get(f"{IMMICH}/assets/{asset}/thumbnail", params={"size": "preview"}, headers=auth, timeout=30)
    if r.status_code != 200:
        return None
    p = requests.post(f"{ML}/predict", timeout=120, files={"image": ("bild.jpg", r.content)}, data={
        "entries": json.dumps({"clip": {"visual": {"modelName": model, "options": {}}}})})
    p.raise_for_status()
    v = p.json()["clip"]
    v = np.array(json.loads(v) if isinstance(v, str) else v, dtype=np.float32)
    return v / np.linalg.norm(v)


def check_sensitive(uid: str, auth: dict, ids: list[str], queries: list[str]) -> dict:
    with psycopg.connect(DB) as c, c.cursor() as cur:
        model = clip_model(cur)
        cur.execute('select s."assetId"::text, s.embedding::text from smart_search s join asset a on a.id = s."assetId" '
                    'where a."ownerId" = %s and s."assetId" = any(%s::uuid[])', (uid, ids))
        have = {r[0]: np.array(json.loads(r[1]), dtype=np.float32) for r in cur.fetchall()}
        flagged = set()
        for q in queries:
            vec = text_emb(model, q)
            lit = "[" + ",".join(f"{x:.7f}" for x in vec) + "]"
            cur.execute("""
                with sc as materialized (
                    select 1 - (s.embedding <=> %s::vector) as sim from smart_search s join asset a on a.id = s."assetId"
                    where a."ownerId" = %s and a."deletedAt" is null)
                select percentile_cont(0.5) within group (order by sim), stddev_pop(sim) from sc""", (lit, uid))
            med, sd = cur.fetchone()
            if not sd:
                continue
            for i in ids:
                if i not in have:
                    e = image_emb(model, auth, i)
                    if e is None:
                        continue
                    have[i] = e
                v = have[i]
                z = (float(np.dot(v / np.linalg.norm(v), vec)) - med) / sd
                if z >= Z_MIN:
                    flagged.add(i)
    log("heikel: %d von %d", len(flagged), len(ids))
    return {"flagged": sorted(flagged)}


# Immich ordnet ab Abstand 0,5 nicht mehr zu; für Vorschläge etwas strenger, damit kaum Fremde dabei sind
FACE_MAX = float(os.environ.get("FACE_MAX", "0.45"))


def similar_faces(uid: str, person: str, limit: int = 40) -> dict | None:
    with psycopg.connect(DB) as c, c.cursor() as cur:
        cur.execute('select 1 from person where "ownerId" = %s and "personGroupId" = %s', (uid, person))
        if not cur.fetchone():
            return None
        cur.execute("""
            with mine as materialized (
                select avg(fs.embedding) as c from asset_face af join face_search fs on fs."faceId" = af.id
                where af."personGroupId" = %s and af."ownerId" = %s and af."deletedAt" is null
            )
            select af.id::text, af."assetId"::text, fs.embedding <=> (select c from mine) as d,
                   af."boundingBoxX1", af."boundingBoxY1", af."boundingBoxX2", af."boundingBoxY2",
                   af."imageWidth", af."imageHeight"
            from asset_face af
            join face_search fs on fs."faceId" = af.id
            join asset a on a.id = af."assetId"
            where af."ownerId" = %s and af."personGroupId" is null and af."deletedAt" is null and af."isVisible"
              and a."deletedAt" is null and (select c from mine) is not null
            order by d limit %s
        """, (person, uid, uid, limit))
        rows = [r for r in cur.fetchall() if r[2] is not None and r[2] <= FACE_MAX]
    log("gesichter %s: %d Vorschläge", person[:8], len(rows))
    return {"faces": [{"faceId": r[0], "assetId": r[1], "distance": round(float(r[2]), 3),
                       "box": [r[3], r[4], r[5], r[6]], "size": [r[7], r[8]]} for r in rows]}


class Handler(BaseHTTPRequestHandler):
    def _send(self, code: int, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self._send(200, {"ok": True}) if self.path == "/health" else self._send(404, {})

    def do_POST(self):
        if self.path not in ("/gesichter", "/relevanz"):
            return self._send(404, {})
        ip = self.client_address[0]
        if too_many_failures(ip):
            return self._send(429, {"error": "zu viele Versuche"})
        if int(self.headers.get("Content-Length") or 0) > MAX_BODY:
            return self._send(413, {"error": "zu groß"})
        if not _slots.acquire(timeout=30):
            return self._send(503, {"error": "ausgelastet"})
        try:
            self.handle_post(ip)
        finally:
            _slots.release()

    def handle_post(self, ip: str):
        if self.path == "/gesichter":
            return self.faces(ip=ip)
        try:
            uid = user_id(self.headers)
            if not uid:
                note_failure(ip)
                return self._send(401, {"error": "nicht angemeldet"})
            n = int(self.headers.get("Content-Length") or 0)
            req = json.loads(self.rfile.read(n) or b"{}")
            if "personId" in req:
                return self.faces(req, ip)
            if "check" in req:
                auth = {"Authorization": self.headers["Authorization"]} if self.headers.get("Authorization") else {"x-api-key": self.headers.get("x-api-key", "")}
                ids = [str(i) for i in req.get("check", [])][:60]
                qs = [str(q)[:80] for q in req.get("queries", [])][:12]
                return self._send(200, check_sensitive(uid, auth, ids, qs) if ids and qs else {"flagged": []})
            q = str(req.get("query", "")).strip()[:200]
            ids = [str(i) for i in req.get("ids", [])][:2000]
            if not q or not ids:
                return self._send(200, {"keep": ids, "z": {}})
            self._send(200, score(uid, q, ids))
        except Exception as e:  # lieber alles zeigen als die Suche kaputt machen
            log("Fehler: %s", e)
            self._send(500, {"error": "intern"})

    def faces(self, req=None, ip: str = ""):
        try:
            uid = user_id(self.headers)
            if not uid:
                note_failure(ip)
                return self._send(401, {"error": "nicht angemeldet"})
            if req is None:
                n = int(self.headers.get("Content-Length") or 0)
                req = json.loads(self.rfile.read(min(n, 10_000)) or b"{}")
            res = similar_faces(uid, str(req.get("personId", "")))
            self._send(404, {"error": "unbekannte Person"}) if res is None else self._send(200, res)
        except Exception as e:
            log("Fehler Gesichter: %s", e)
            self._send(500, {"error": "intern"})

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    log("Relevanz-Dienst auf Port %d (z ≥ %.1f)", PORT, Z_MIN)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
