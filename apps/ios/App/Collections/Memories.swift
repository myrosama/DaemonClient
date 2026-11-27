import SwiftUI
import AVFoundation
import Vision

// MARK: - Modell

/// Ein Rückblick wie in Fotos: Titel, Untertitel, ausgewählte Fotos, Schlüsselfoto.
struct Memory: Identifiable, Hashable {
    let id: String
    var title: String
    let subtitle: String
    let assets: [Asset]          // bereits kuratiert, chronologisch
    let key: Asset
    let date: Date
    var custom = false
    /// Worum es geht – für „… weniger zeigen“ (REA: PXPhotoKitFeatureLessActionPerformer)
    var place: String? = nil
    var personID: String? = nil
    var personName: String? = nil
}

/// Was der Nutzer an Rückblicken geändert hat (nur auf diesem Gerät).
struct MemoryPrefs: Codable {
    var favorites: Set<String> = []
    var deleted: Set<String> = []
    var titles: [String: String] = [:]
    var mood: [String: Int] = [:]
    var style: [String: Int] = [:]
    var length: [String: Int] = [:]
    var custom: [Custom] = []
    /// „weniger zeigen“ wie Fotos: Tage (yyyy-MM-dd, Wanduhr), Orte, Personen
    var lessDays: Set<String> = []
    var lessPlaces: Set<String> = []
    var lessPeople: Set<String> = []
    /// „Aus Rückblick entfernen“ (REA: PXStoryRemoveAssetActionPerformer): je Rückblick ausgeschlossene Fotos
    var removed: [String: Set<String>] = [:]
    /// „Als Titelbild“ (REA: PXStoryMakeKeyPhotoActionPerformer): selbst gewähltes Titelbild je Rückblick
    var keys: [String: String] = [:]
    struct Custom: Codable, Hashable { let id: String; let title: String; let ids: [String]; let created: Date }

    init() {}
    /// Fehlende Felder (ältere gespeicherte Stände) dürfen nicht alles verwerfen.
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        favorites = try c.decodeIfPresent(Set<String>.self, forKey: .favorites) ?? []
        deleted = try c.decodeIfPresent(Set<String>.self, forKey: .deleted) ?? []
        titles = try c.decodeIfPresent([String: String].self, forKey: .titles) ?? [:]
        mood = try c.decodeIfPresent([String: Int].self, forKey: .mood) ?? [:]
        style = try c.decodeIfPresent([String: Int].self, forKey: .style) ?? [:]
        length = try c.decodeIfPresent([String: Int].self, forKey: .length) ?? [:]
        custom = try c.decodeIfPresent([Custom].self, forKey: .custom) ?? []
        lessDays = try c.decodeIfPresent(Set<String>.self, forKey: .lessDays) ?? []
        lessPlaces = try c.decodeIfPresent(Set<String>.self, forKey: .lessPlaces) ?? []
        lessPeople = try c.decodeIfPresent(Set<String>.self, forKey: .lessPeople) ?? []
        removed = try c.decodeIfPresent([String: Set<String>].self, forKey: .removed) ?? [:]
        keys = try c.decodeIfPresent([String: String].self, forKey: .keys) ?? [:]
    }

    nonisolated static func dayKey(_ d: Date) -> String {
        let c = Calendar.wall.dateComponents([.year, .month, .day], from: d)
        return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }

    static var shared: MemoryPrefs {
        get { (UserDefaults.standard.data(forKey: "memoryPrefs")).flatMap { try? JSONDecoder().decode(Self.self, from: $0) } ?? .init() }
        set { UserDefaults.standard.set(try? JSONEncoder().encode(newValue), forKey: "memoryPrefs") }
    }
}

/// Hält die gebauten Rückblicke für Sammlungen, Rückblick-Liste und Angepinnt.
/// Heikle Fotos (Wunden, Ausweise …) gehören nicht in Rückblicke und Empfehlungen – Apple filtert so etwas auch.
/// KI-Suche je Begriff + Relevanz-Prüfung (nur klare Treffer), einmal je App-Start.
@MainActor
enum SensitiveFilter {
    // Die Kategorie-Tags erfassen nicht jedes abfotografierte Papier (Briefe, Formulare) – deshalb auch die KI-Suche
    static let terms = ["Wunde", "Verletzung Haut Nahaufnahme", "Ausweis", "Reisepass", "Krankenhaus Patient",
                        "Brief", "Dokument", "Formular", "Rechnung", "QR-Code"]
    private static var cache: (String, Set<String>)?
    static func ids() async -> Set<String> {
        let account = ImmichClient.shared.token ?? ""
        if let cache, cache.0 == account { return cache.1 }
        let api = ImmichClient.shared
        var out = Set<String>()
        for t in terms {
            let found = ((try? await api.smartSearch(t, filter: [:], size: 300)) ?? []).map(\.asset.id)
            if let keep = await api.relevant(t, ids: found) { out.formUnion(keep) }
        }
        cache = (account, out)
        return out
    }

    /// Die KI-Suche findet nur Fotos, die der Server schon ausgewertet hat. Titelbilder und Rückblick-Fotos deshalb
    /// einzeln prüfen – der Dienst rechnet fehlende Merkmale nach (~3 s je Foto). Ergebnis je Konto dauerhaft gemerkt,
    /// damit ein einmal erkanntes Foto beim nächsten Start schon vor dem Anzeigen fehlt.
    static let photoTerms = ["Wunde", "Verletzung Haut Nahaufnahme", "Ausweis", "Reisepass", "Krankenhaus Patient"]
    private static var checked: (String, [String: Bool]) = ("", [:])
    private static func file(_ account: String) -> URL {
        let d = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d.appendingPathComponent("heikel-\(account).json")
    }
    /// Konto = Benutzer-ID (TimelineStore.account), nicht der Zugangsschlüssel
    private static func use(_ account: String) {
        guard checked.0 != account else { return }
        let known = (try? Data(contentsOf: file(account))).flatMap { try? JSONDecoder().decode([String: Bool].self, from: $0) } ?? [:]
        checked = (account, known)
    }
    /// Schon bekannte heikle Fotos (ohne Server-Anfrage).
    static func known(_ ids: [String], account: String) -> Set<String> {
        guard !account.isEmpty else { return [] }
        use(account)
        return Set(ids.filter { checked.1[$0] == true })
    }
    /// Nacheinander: Zwei Aufbauten sollen dieselben Fotos nicht doppelt rechnen lassen.
    private static var queue: Task<Void, Never>?
    static func flagged(_ assets: [Asset], account: String) async -> Set<String> {
        guard !account.isEmpty else { return [] }
        let prev = queue
        let t = Task { @MainActor in await prev?.value; await check(assets, account: account) }
        queue = t
        await t.value
        guard checked.0 == account else { return [] }
        return Set(assets.map(\.id).filter { checked.1[$0] == true })
    }
    private static func check(_ assets: [Asset], account: String) async {
        use(account)
        let open = Array(Set(assets.map(\.id).filter { checked.1[$0] == nil })).sorted()
        // 30 je Anfrage (~90 s, wenn keinem Foto die KI-Merkmale vorliegen) – bleibt unter der Zeitgrenze
        for part in stride(from: 0, to: open.count, by: 30).map({ Array(open[$0..<min($0 + 30, open.count)]) }) {
            guard let bad = await ImmichClient.shared.sensitive(part, queries: photoTerms) else { break }
            guard checked.0 == account else { return }
            for id in part { checked.1[id] = bad.contains(id) }
            if let d = try? JSONEncoder().encode(checked.1) { try? d.write(to: file(account), options: .atomic) }
        }
        #if DEBUG
        // Test: FOTOS_TEST_SENSITIVE=<ID-Anfang> gilt als heikel (Tausch des Titelbilds prüfen, ohne echtes heikles Foto)
        if let t = ProcessInfo.processInfo.environment["FOTOS_TEST_SENSITIVE"], !t.isEmpty {
            for a in assets where a.id.hasPrefix(t) { checked.1[a.id] = true }
        }
        #endif
    }
}

/// Prüfung direkt auf dem iPhone (wie Apple): abfotografierte Briefe, Formulare, Speisekarten haben viel Text;
/// dazu fast schwarze Fotos und solche ohne Vorschau. true = als Titelbild/Empfehlung ungeeignet.
/// Greift auch, solange der Server noch keine KI-Merkmale hat. Ergebnis je Foto gemerkt.
enum TextHeavy {
    @MainActor private static var known: [String: Bool] = [:]
    @MainActor static func check(_ a: Asset) async -> Bool {
        if let k = known[a.id] { return k }
        // ohne Vorschau (Server rechnet noch) nicht nehmen – sonst bleibt die Kachel leer; nicht merken, kommt später
        guard let img = await ImageCache.shared.load(a.id, .preview), let cg = img.cgImage else { return true }
        let heavy = await Task.detached(priority: .utility) { () -> Bool in
            let req = VNRecognizeTextRequest()
            req.recognitionLevel = .fast
            req.usesLanguageCorrection = false
            try? VNImageRequestHandler(cgImage: cg).perform([req])
            let lines = (req.results ?? []).compactMap { $0.topCandidates(1).first }.filter { $0.confidence > 0.3 }
            let chars = lines.reduce(0) { $0 + $1.string.count }
            // fast schwarze Fotos (Bildschirm im Dunkeln, Hosentasche) taugen auch nicht als Titelbild
            var px = [UInt8](repeating: 0, count: 4)
            let avg = CIImage(cgImage: cg).applyingFilter("CIAreaAverage", parameters: [kCIInputExtentKey: CIVector(cgRect: CGRect(x: 0, y: 0, width: cg.width, height: cg.height))])
            CIContext().render(avg, toBitmap: &px, rowBytes: 4, bounds: CGRect(x: 0, y: 0, width: 1, height: 1), format: .RGBA8, colorSpace: nil)
            let r = Double(px[0]) * 0.299, g = Double(px[1]) * 0.587, b = Double(px[2]) * 0.114
            let light = (r + g + b) / 255
            return lines.count >= 6 || chars >= 80 || light < 0.12
        }.value
        known[a.id] = heavy
        return heavy
    }
}

@MainActor @Observable
final class MemoryCenter {
    static let shared = MemoryCenter()
    private(set) var items: [Memory] = []
    /// Erster Aufbau für dieses Konto fertig – vorher zeigt die Ansicht Platzhalter statt „Keine Rückblicke“
    private(set) var settled = false
    private var builtFor = ""
    private var builtAccount = ""
    /// Laufende Nummer des Aufbaus: Nur der neueste darf die Liste ändern. Rückblicke verschiedener Konten
    /// haben teils dieselbe Kennung („Winter 2026“) – ein noch laufender Titelbild-Tausch des vorigen Kontos
    /// hat sonst den gleichnamigen Rückblick des neuen Kontos durch seinen ersetzt.
    private var generation = 0

    func rebuild(timeline: TimelineStore, server: [MemoryDTO], force: Bool = false) async {
        let all = timeline.allLoaded
        let account = timeline.account
        // anderes Konto: alte Rückblicke sofort weg (sonst zeigt das neue Konto Fotos des vorigen)
        if account != builtAccount { items = []; settled = false; builtAccount = account; builtFor = ""; generation += 1 }
        let stamp = "\(account)-\(all.count)-\(server.count)-\(MemoryPrefs.shared.custom.count)"
        if all.isEmpty { settled = true }   // leere Mediathek: dann wirklich „Keine Rückblicke“
        guard force || stamp != builtFor, !all.isEmpty else { return }
        builtFor = stamp
        generation += 1
        let gen = generation
        // wie Apple: Bildschirmfotos, Belege, Dokumente und QR-Codes gehören nicht in Rückblicke
        var skip = Set<String>()
        for c in [Category.screenshots, .screenRecordings, .receipts, .documents, .qrCodes] {
            skip.formUnion(await CategoryLoader.load(c, timeline: timeline).map(\.id))
        }
        skip.formUnion(await SensitiveFilter.ids())
        let serverSets = server.map { ($0.data.year, $0.assets.map(\.asset).filter { !skip.contains($0.id) }) }
        let prefs = MemoryPrefs.shared
        let pool = all.filter { !skip.contains($0.id) }
        let built = await Task.detached(priority: .utility) { MemoryEngine.build(all: pool, server: serverSets, prefs: prefs) }.value
        guard gen == generation else { return }   // inzwischen Konto gewechselt oder neuer Aufbau
        // schon bekannte heikle Fotos fehlen sofort (nicht erst nach der Prüfung sichtbar)
        var shown = Self.without(SensitiveFilter.known(built.flatMap { [$0.key.id] + $0.assets.map(\.id) }, account: account), built)
        // neue Titelbilder: bis zu 4 s auf die Prüfung warten (mit KI-Merkmalen dauert sie Millisekunden), dann trotzdem zeigen
        let keys = Array(shown.prefix(20).map(\.key))
        let check = Task { await SensitiveFilter.flagged(keys, account: account) }
        let early = await withTaskGroup(of: Set<String>?.self) { g in
            g.addTask { await check.value }
            g.addTask { try? await Task.sleep(for: .seconds(4)); return nil }
            let first = await g.next() ?? nil
            g.cancelAll()
            return first
        }
        guard gen == generation else { return }
        if let early { shown = Self.without(early, shown) }
        items = shown
        settled = true
        await addBirthdays(skip: skip, prefs: prefs, gen: gen)
        await fixCovers(gen: gen)
        dump("angezeigt")
        await filterSensitive(gen: gen, account: account)
        if gen == generation { dump("fertig") }
    }

    /// Heikle Fotos (Wunde, Ausweis …) raus: zuerst die Titelbilder (schnell), dann alle Fotos der ersten
    /// Rückblicke (Hintergrund, einmal je Foto – danach gemerkt). Fällt ein Titelbild weg, kommt ein anderes Foto.
    private func filterSensitive(gen: Int, account: String) async {
        for _ in 0..<3 {   // das Ersatz-Titelbild kann selbst heikel sein (Nachbarfoto derselben Wunde)
            let bad = await SensitiveFilter.flagged(items.prefix(20).map(\.key), account: account)
            guard gen == generation else { return }
            if bad.isEmpty { break }
            items = Self.without(bad, items)
        }
        // „Heute vor …“ und die übrigen vorderen Rückblicke werden am häufigsten abgespielt (auch im Widget)
        let bad = await SensitiveFilter.flagged(items.prefix(6).flatMap(\.assets), account: account)
        guard gen == generation, !bad.isEmpty else { return }
        items = Self.without(bad, items)
        let more = await SensitiveFilter.flagged(items.prefix(20).map(\.key), account: account)
        guard gen == generation else { return }
        if !more.isEmpty { items = Self.without(more, items) }
        await fixCovers(gen: gen)   // neue Titelbilder ebenfalls auf viel Text prüfen
    }

    #if DEBUG
    /// Test: FOTOS_DUMP_MEMORIES=1 schreibt die Rückblicke (Titel, Titelbild, Fotos) nach tmp/rueckblicke.json
    private func dump(_ step: String) {
        guard ProcessInfo.processInfo.environment["FOTOS_DUMP_MEMORIES"] == "1" else { return }
        let list = items.map { ["id": $0.id, "title": $0.title, "key": $0.key.id, "place": $0.place ?? "", "assets": $0.assets.map(\.id).joined(separator: ",")] }
        let obj: [String: Any] = ["step": step, "account": builtAccount, "generation": generation, "items": list]
        if let d = try? JSONSerialization.data(withJSONObject: obj) {
            try? d.write(to: FileManager.default.temporaryDirectory.appendingPathComponent("rueckblicke.json"), options: .atomic)
        }
    }
    #else
    private func dump(_ step: String) {}
    #endif

    /// Rückblicke ohne die Fotos aus `bad`; zu kleine fallen weg, ein heikles Titelbild wird ersetzt.
    nonisolated static func without(_ bad: Set<String>, _ list: [Memory]) -> [Memory] {
        guard !bad.isEmpty else { return list }
        return list.compactMap { m in
            guard bad.contains(m.key.id) || m.assets.contains(where: { bad.contains($0.id) }) else { return m }
            let rest = m.assets.filter { !bad.contains($0.id) }
            guard rest.count >= 3 else { return nil }   // wie beim Bauen: unter 3 Fotos ist es kein Rückblick
            let key = bad.contains(m.key.id) ? (MemoryEngine.keyPhoto(rest) ?? rest[0]) : m.key
            return Memory(id: m.id, title: m.title, subtitle: m.subtitle, assets: rest, key: key, date: m.date, custom: m.custom)
        }
    }

    /// Geburtstage wie Apple (BirthdayPeople): Fotos einer Person rund um ihren Geburtstag aus allen Jahren.
    /// Steht der Geburtstag bevor (±3 Tage), kommt der Rückblick nach vorn.
    private func addBirthdays(skip: Set<String>, prefs: MemoryPrefs, gen: Int) async {
        guard let people = try? await ImmichClient.shared.allPeople(withHidden: false) else { return }
        let cal = Calendar.wall, now = Date()
        let iso = DateFormatter(); iso.dateFormat = "yyyy-MM-dd"; iso.timeZone = DateParsing.utc
        for p in people where !p.name.isEmpty {
            guard let bs = p.birthDate, let b = iso.date(from: String(bs.prefix(10))),
                  !prefs.deleted.contains("birthday-\(p.id)"), !prefs.lessPeople.contains(p.id) else { continue }
            let bm = cal.component(.month, from: b), bd = cal.component(.day, from: b)
            let list = ((try? await ImmichClient.shared.search(filter: ["personIds": ["any": [p.id]]], size: 1000, order: "asc")) ?? [])
                .map(\.asset).filter { a in
                    guard a.isImage, !skip.contains(a.id) else { return false }
                    var c = cal.dateComponents([.year], from: a.date); c.month = bm; c.day = bd
                    guard let day = cal.date(from: c) else { return false }
                    return abs(a.date.timeIntervalSince(day) / 86_400) <= 1.5
                }
            let id = "birthday-\(p.id)"
            let picked = MemoryEngine.curate(list.filter { !(prefs.removed[id]?.contains($0.id) ?? false) }, max: 40)
            guard picked.count >= 4, let key = MemoryEngine.keyPhoto(picked) else { continue }
            let m = Memory(id: id, title: prefs.titles[id] ?? String(localized: "Geburtstag von \(p.name)"), subtitle: MemoryEngine.range(picked),
                           assets: picked, key: key, date: picked.last!.date, personID: p.id, personName: p.name)
            var next = cal.dateComponents([.year], from: now); next.month = bm; next.day = bd
            let soon = cal.date(from: next).map { abs($0.timeIntervalSince(now)) / 86_400 <= 3 } ?? false
            guard gen == generation else { return }
            items.removeAll { $0.id == id }
            if soon { items.insert(m, at: 0) } else { items.append(m) }
        }
    }

    /// Titelbilder mit viel Text (Briefe, Speisekarten …) gegen ein anderes Foto des Rückblicks tauschen.
    private func fixCovers(gen: Int) async {
        for (i, m) in items.prefix(20).enumerated() where await TextHeavy.check(m.key) {
            var alt: Asset?
            for c in m.assets where c.isImage && c.id != m.key.id {
                if await !TextHeavy.check(c) { alt = c; break }
            }
            guard gen == generation else { return }
            guard let alt, i < items.count, items[i].id == m.id else { continue }
            items[i] = Memory(id: m.id, title: m.title, subtitle: m.subtitle, assets: m.assets, key: alt, date: m.date, custom: m.custom)
        }
    }

    /// Abmelden: nichts vom bisherigen Konto stehen lassen.
    func reset() { items = []; builtAccount = ""; builtFor = ""; generation += 1 }

    func setKey(_ assetID: String, for memoryID: String) {
        var p = MemoryPrefs.shared; p.keys[memoryID] = assetID; MemoryPrefs.shared = p
        guard let i = items.firstIndex(where: { $0.id == memoryID }), let a = items[i].assets.first(where: { $0.id == assetID }) else { return }
        let m = items[i]
        items[i] = Memory(id: m.id, title: m.title, subtitle: m.subtitle, assets: m.assets, key: a, date: m.date,
                          custom: m.custom, place: m.place, personID: m.personID, personName: m.personName)
    }

    /// Foto aus einem Rückblick nehmen; ist danach zu wenig übrig, verschwindet der Rückblick wie bei Apple.
    func remove(_ assetID: String, from memoryID: String) {
        var p = MemoryPrefs.shared; p.removed[memoryID, default: []].insert(assetID); MemoryPrefs.shared = p
        guard let i = items.firstIndex(where: { $0.id == memoryID }) else { return }
        let m = items[i]
        let rest = m.assets.filter { $0.id != assetID }
        if rest.count < 3 { items.remove(at: i); return }
        let key = m.key.id == assetID ? (MemoryEngine.keyPhoto(rest) ?? rest[0]) : m.key
        items[i] = Memory(id: m.id, title: m.title, subtitle: MemoryEngine.range(rest), assets: rest, key: key, date: m.date,
                          custom: m.custom, place: m.place, personID: m.personID, personName: m.personName)
    }

    func update(_ change: (inout MemoryPrefs) -> Void) {
        var p = MemoryPrefs.shared; change(&p); MemoryPrefs.shared = p
        let prefs = p
        items = items.filter { m in
            !prefs.deleted.contains(m.id) && !(m.place.map(prefs.lessPlaces.contains) ?? false)
                && !(m.personID.map(prefs.lessPeople.contains) ?? false)
                && !(m.id.hasPrefix("today-") && m.assets.contains { prefs.lessDays.contains(MemoryPrefs.dayKey($0.date)) })
        }.map { m in
            var m = m; if let t = prefs.titles[m.id] { m.title = t }; return m
        }
    }

    func addCustom(title: String, assets: [Asset]) -> Memory? {
        let picked = MemoryEngine.curate(assets, max: 60)
        guard let key = MemoryEngine.keyPhoto(picked) else { return nil }
        let id = "custom-\(UUID().uuidString)"
        update { $0.custom.insert(.init(id: id, title: title, ids: assets.map(\.id), created: Date()), at: 0) }
        let m = Memory(id: id, title: title, subtitle: MemoryEngine.range(picked), assets: picked, key: key, date: Date(), custom: true)
        items.insert(m, at: 0)
        return m
    }
}

/// Baut Rückblicke aus der Zeitleiste – wie Apple ohne Cloud: Jahrestage, Reisen, Jahres-Highlights,
/// Jahreszeiten und Orte im Laufe der Jahre.
enum MemoryEngine {
    nonisolated static func build(all: [Asset], server: [(Int?, [Asset])], prefs: MemoryPrefs) -> [Memory] {
        // „Diesen Tag weniger zeigen“: Fotos dieser Tage kommen in keinen Rückblick mehr
        let photos = all.filter { $0.isImage && (prefs.lessDays.isEmpty || !prefs.lessDays.contains(MemoryPrefs.dayKey($0.date))) }
            .sorted { $0.date < $1.date }
        guard !photos.isEmpty else { return [] }
        let cal = Calendar.wall
        let now = Date(), thisYear = cal.component(.year, from: now)
        var out: [Memory] = []
        func add(_ id: String, _ title: String, _ list: [Asset], min: Int, max: Int = 50, date: Date? = nil, place: String? = nil) {
            guard list.count >= min, !prefs.deleted.contains(id) else { return }
            if let place, prefs.lessPlaces.contains(place) { return }
            var list = prefs.lessDays.isEmpty ? list : list.filter { !prefs.lessDays.contains(MemoryPrefs.dayKey($0.date)) }
            if let gone = prefs.removed[id] { list.removeAll { gone.contains($0.id) } }
            guard list.count >= min else { return }
            let picked = curate(list, max: max)
            // Rückblicke ohne eine einzige fertige Vorschau (Server rechnet noch) erst später zeigen – sonst schwarze Karte
            // nach dem Aussortieren (Serien, Bildschirmfotos) müssen genug Fotos bleiben, sonst ist es kein Rückblick
            guard picked.count >= Swift.max(3, min / 2),
                  picked.contains(where: { ImageCache.shared.hash($0.id) != nil }), let auto = keyPhoto(picked) else { return }
            let key = prefs.keys[id].flatMap { k in picked.first { $0.id == k } } ?? auto
            out.append(Memory(id: id, title: prefs.titles[id] ?? title, subtitle: range(picked), assets: picked, key: key,
                              date: date ?? picked.last!.date, place: place))
        }

        // 1. Heute vor X Jahren (Server-Vorschlag, sonst selbst: ±3 Tage um heute in früheren Jahren)
        if !server.isEmpty {
            for (year, list) in server {
                let n = year.map { thisYear - $0 } ?? 0
                add("today-\(year ?? 0)", n > 0 ? (n == 1 ? String(localized: "Heute vor 1 Jahr") : String(localized: "Heute vor \(n) Jahren")) : String(localized: "Erinnerungen"), list, min: 3, date: now)
            }
        } else {
            let doy = cal.ordinality(of: .day, in: .year, for: now) ?? 0
            let byYear = Dictionary(grouping: photos.filter { a in
                let y = cal.component(.year, from: a.date), d = cal.ordinality(of: .day, in: .year, for: a.date) ?? 0
                return y < thisYear && abs(d - doy) <= 3
            }) { cal.component(.year, from: $0.date) }
            for (y, list) in byYear.sorted(by: { $0.key > $1.key }) {
                let n = thisYear - y
                add("today-\(y)", (n == 1 ? String(localized: "Heute vor 1 Jahr") : String(localized: "Heute vor \(n) Jahren")), list, min: 4, date: now)
            }
        }

        // 2. Reisen (wie „Reisen“ in Sammlungen), größte zuerst
        for t in CollectionsView.trips(from: all).sorted(by: { $0.assets.count > $1.assets.count }).prefix(8) {
            let y = cal.component(.year, from: t.start)
            add("trip-\(Int(t.start.timeIntervalSince1970))", "\(t.title) \(y)", t.assets.filter(\.isImage), min: 6, date: t.start, place: t.title)
        }

        // 3. Das Beste aus <Jahr>
        let byYear = Dictionary(grouping: photos) { cal.component(.year, from: $0.date) }
        for (y, list) in byYear.sorted(by: { $0.key > $1.key }).prefix(4) where y < thisYear || cal.component(.month, from: now) >= 11 {
            add("best-\(y)", String(localized: "Das Beste aus \(String(y))"), list, min: 30, max: 45)
        }

        // 4. Jahreszeiten
        let seasons: [(String, [Int])] = [("Sommer", [6, 7, 8]), ("Winter", [12, 1, 2]), ("Frühling", [3, 4, 5]), ("Herbst", [9, 10, 11])]
        var seasonCount = 0
        for (y, list) in byYear.sorted(by: { $0.key > $1.key }) where seasonCount < 4 {
            for (name, months) in seasons where seasonCount < 4 {
                let s = list.filter { months.contains(cal.component(.month, from: $0.date)) }
                if s.count >= 20 { add("season-\(name)-\(y)", "\(L(name)) \(y)", s, min: 20, max: 40); seasonCount += 1 }
            }
        }

        // 5. Orte im Laufe der Jahre (mindestens 3 verschiedene Jahre)
        let byCity = Dictionary(grouping: photos.filter { $0.city != nil }) { $0.city! }
        for (city, list) in byCity.sorted(by: { $0.value.count > $1.value.count }).prefix(6) {
            let years = Set(list.map { cal.component(.year, from: $0.date) })
            if years.count >= 3 { add("city-\(city)", String(localized: "\(city) im Laufe der Jahre"), list, min: 15, max: 45, place: city) }
        }

        // 6. Selbst erstellte (oben, neueste zuerst)
        let byID = Dictionary(photos.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        var custom: [Memory] = []
        for c in prefs.custom where !prefs.deleted.contains(c.id) {
            let list = c.ids.compactMap { byID[$0] }.filter { !(prefs.removed[c.id]?.contains($0.id) ?? false) }
            let picked = curate(list, max: 60)
            if let key = prefs.keys[c.id].flatMap({ k in picked.first { $0.id == k } }) ?? keyPhoto(picked) {
                custom.append(Memory(id: c.id, title: prefs.titles[c.id] ?? c.title, subtitle: range(picked), assets: picked,
                                     key: key, date: c.created, custom: true))
            }
        }
        // „Heute“ zuerst, dann nach Datum
        let today = out.filter { $0.id.hasPrefix("today-") }
        let rest = out.filter { !$0.id.hasPrefix("today-") }.sorted { $0.date > $1.date }
        return custom + today + rest
    }

    /// Auswahl wie bei Apple: Serienbilder ausdünnen, Favoriten bevorzugen, gleichmäßig über die Zeit verteilen.
    nonisolated static func curate(_ list: [Asset], max: Int) -> [Asset] {
        var kept: [Asset] = []
        // Fotos und Videos ab 2 s (wie Apple), keine Bildschirmfotos/-aufnahmen
        let usable = list.filter { !looksLikeScreenshot($0) && ($0.isImage || ($0.durationMs ?? 0) >= 2000) }
        var videos = 0
        for a in usable.sorted(by: { $0.date < $1.date }) {
            if a.isVideo { if videos >= Swift.max(1, max / 5) { continue }; videos += 1 }
            if let last = kept.last, a.date.timeIntervalSince(last.date) < 45, !a.isFavorite { continue }
            kept.append(a)
        }
        guard kept.count > max else { return kept }
        let favs = kept.filter(\.isFavorite).prefix(max / 2)
        let others = kept.filter { !$0.isFavorite }
        guard !others.isEmpty else { return Array(kept.prefix(max)) }   // nur Favoriten
        let need = max - favs.count
        let step = Double(others.count) / Double(Swift.max(1, need))
        let sampled = (0..<need).map { others[Swift.min(others.count - 1, Int(Double($0) * step))] }
        return (Array(favs) + sampled).sorted { $0.date < $1.date }
    }

    /// Titelbild: Favorit mit fertiger Vorschau, sonst ein Foto mit Vorschau (sonst bliebe die Karte schwarz).
    nonisolated static func keyPhoto(_ list: [Asset]) -> Asset? {
        let ready = list.filter { ImageCache.shared.hash($0.id) != nil }
        let pool = ready.isEmpty ? list : ready
        let photos = pool.filter(\.isImage).isEmpty ? pool : pool.filter(\.isImage)
        return photos.first(where: \.isFavorite) ?? (photos.isEmpty ? nil : photos[photos.count / 3])
    }

    /// iPhone-Bildschirmfotos haben das Seitenverhältnis des Bildschirms (~0,46), Kamerafotos 3:4, 9:16 oder 1:1.
    /// Hilft, solange der Kategorien-Dienst noch nicht alles markiert hat.
    nonisolated static func looksLikeScreenshot(_ a: Asset) -> Bool {
        let r = a.ratio < 1 ? a.ratio : 1 / a.ratio
        return a.livePhotoVideoId == nil && (0.455...0.470).contains(r)
    }

    nonisolated static func range(_ list: [Asset]) -> String {
        guard let f = list.first?.date, let l = list.last?.date else { return "" }
        let cal = Calendar.wall
        if cal.isDate(f, inSameDayAs: l) { return Fmt.dayMonthYear.string(from: f).uppercased() }
        let fy = cal.component(.year, from: f), ly = cal.component(.year, from: l)
        if fy != ly { return "\(fy) – \(ly)" }
        // wie Apple: „1. SEPT. – 24. SEPT. 2026“
        let short = DateFormatter(); short.locale = .autoupdatingCurrent; short.timeZone = DateParsing.utc
        short.setLocalizedDateFormatFromTemplate("d MMM")
        return (short.string(from: f) + " – " + short.string(from: l) + " \(ly)").uppercased()
    }
}

// MARK: - Stile & Musik

enum MemoryStyle: Int, CaseIterable, Identifiable {
    case natural, warm, cool, vivid, contrast, mono
    var id: Int { rawValue }
    var title: String {
        switch self {
        case .natural: String(localized: "Natürlich"); case .warm: String(localized: "Warm"); case .cool: String(localized: "Kühl")
        case .vivid: String(localized: "Lebendig"); case .contrast: String(localized: "Kontrastreich"); case .mono: String(localized: "Schwarzweiß")
        }
    }
}

extension View {
    @ViewBuilder func memoryStyle(_ s: MemoryStyle) -> some View {
        switch s {
        case .natural: self
        case .warm: self.saturation(1.08).colorMultiply(Color(red: 1, green: 0.93, blue: 0.84))
        case .cool: self.saturation(0.95).colorMultiply(Color(red: 0.86, green: 0.94, blue: 1))
        case .vivid: self.saturation(1.35).contrast(1.06)
        case .contrast: self.contrast(1.3).saturation(0.9)
        case .mono: self.grayscale(1).contrast(1.15)
        }
    }
}

/// Selbst erzeugte Hintergrundmusik (keine Musikdateien, keine Lizenzen): Akkordfläche, Arpeggio, Bass.
enum MemoryMood: Int, CaseIterable, Identifiable {
    case none, gentle, happy, thoughtful, epic
    var id: Int { rawValue }
    var title: String {
        switch self {
        case .none: String(localized: "Ohne Musik"); case .gentle: String(localized: "Sanft"); case .happy: String(localized: "Fröhlich")
        case .thoughtful: String(localized: "Nachdenklich"); case .epic: String(localized: "Episch")
        }
    }
    var icon: String {
        switch self {
        case .none: "speaker.slash"; case .gentle: "leaf"; case .happy: "sun.max"
        case .thoughtful: "cloud.drizzle"; case .epic: "mountain.2"
        }
    }
}

final class MemoryMusic: @unchecked Sendable {
    private let engine = AVAudioEngine()
    private var node: AVAudioSourceNode?
    private let synth = Synth()

    func play(_ mood: MemoryMood) {
        stop()
        guard mood != .none else { return }
        try? AVAudioSession.sharedInstance().setCategory(.playback, options: [.mixWithOthers])
        try? AVAudioSession.sharedInstance().setActive(true)
        let sr = engine.outputNode.outputFormat(forBus: 0).sampleRate
        synth.configure(mood, sampleRate: sr > 0 ? sr : 44100)
        let fmt = AVAudioFormat(standardFormatWithSampleRate: synth.sr, channels: 2)!
        let s = synth
        let n = AVAudioSourceNode(format: fmt) { _, _, frames, abl -> OSStatus in
            s.render(Int(frames), UnsafeMutableAudioBufferListPointer(abl)); return noErr
        }
        node = n
        engine.attach(n)
        engine.connect(n, to: engine.mainMixerNode, format: fmt)
        engine.mainMixerNode.outputVolume = 0.9
        try? engine.start()
    }
    func pause() { synth.paused = true }
    func resume() { synth.paused = false }
    func stop() {
        engine.stop()
        if let node { engine.detach(node) }
        node = nil
    }
}

final class Synth: @unchecked Sendable {
    var sr: Double = 44100
    var paused = false
    private var t: Int = 0
    private var gain: Double = 0
    private var lp: Double = 0
    private var bpm: Double = 72
    private var chords: [[Double]] = []
    private var pattern: [Int] = [0, 1, 2, 1]
    private var stepsPerBeat: Double = 1
    private var padLevel = 0.05, bellLevel = 0.11, bassLevel = 0.07, bright = 0.25

    func configure(_ mood: MemoryMood, sampleRate: Double) {
        sr = sampleRate; t = 0; gain = 0; lp = 0
        switch mood {
        case .gentle:
            bpm = 72; stepsPerBeat = 1; pattern = [0, 1, 2, 1]
            chords = [[60, 64, 67], [57, 60, 64], [53, 57, 60], [55, 59, 62]]
        case .happy:
            bpm = 112; stepsPerBeat = 2; pattern = [0, 1, 2, 1, 0, 2, 1, 2]; padLevel = 0.035; bellLevel = 0.09; bright = 0.45
            chords = [[55, 59, 62], [52, 55, 59], [48, 52, 55], [50, 54, 57]]
        case .thoughtful:
            bpm = 64; stepsPerBeat = 1; pattern = [0, 2, 1, 2]; bright = 0.18
            chords = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]]
        case .epic:
            bpm = 80; stepsPerBeat = 2; pattern = [0, 1, 2, 1, 0, 1, 2, 1]; padLevel = 0.07; bassLevel = 0.11; bright = 0.3
            chords = [[50, 53, 57], [46, 50, 53], [48, 52, 55], [45, 49, 52]]
        case .none: chords = [[60, 64, 67]]
        }
    }

    private func hz(_ m: Double) -> Double { 440 * pow(2, (m - 69) / 12) }

    func render(_ frames: Int, _ abl: UnsafeMutableAudioBufferListPointer) {
        let twoPi = 2 * Double.pi
        let beatLen = 60 / bpm, segLen = beatLen * 8          // Akkordwechsel alle 2 Takte
        let stepLen = beatLen / stepsPerBeat
        for f in 0..<frames {
            var v = 0.0
            if !paused {
                let time = Double(t) / sr
                let seg = Int(time / segLen), inSeg = time - Double(seg) * segLen
                let chord = chords[seg % chords.count]
                // Fläche: weich ein-/ausblenden je Akkord, leicht verstimmte Sinus-Paare
                let padEnv = min(1, inSeg / 0.8) * min(1, (segLen - inSeg) / 0.6)
                for m in chord {
                    let fr = hz(m)
                    v += padLevel * padEnv * (sin(twoPi * fr * time) + 0.6 * sin(twoPi * fr * 1.003 * time)) * 0.6
                }
                // Glocken-Arpeggio
                let step = Int(time / stepLen), inStep = time - Double(step) * stepLen
                let note = chord[pattern[step % pattern.count] % chord.count] + 12
                let env = min(1, inStep / 0.006) * exp(-inStep * 3.2)
                let bf = hz(note)
                v += bellLevel * env * (sin(twoPi * bf * inStep) + bright * sin(twoPi * bf * 2 * inStep))
                // Bass auf jedem Takt
                let bar = Int(time / (beatLen * 4)), inBar = time - Double(bar) * beatLen * 4
                let benv = min(1, inBar / 0.02) * exp(-inBar * 0.9)
                v += bassLevel * benv * sin(twoPi * hz(chord[0] - 12) * time)
                t += 1
            }
            // sanft starten/anhalten, dann leichter Tiefpass gegen Härte
            gain += ((paused ? 0 : 1) - gain) * 0.00005
            lp += (v * gain - lp) * 0.35
            let out = Float(max(-1, min(1, lp)))
            for b in 0..<abl.count { abl[b].mData?.assumingMemoryBound(to: Float.self)[f] = out }
        }
    }
}

// MARK: - Karten & Liste

/// Große Rückblick-Karte (Sammlungen, Rückblicke-Liste).
struct MemoryCard: View {
    let memory: Memory
    var height: CGFloat = 270
    var body: some View {
        AssetThumb(id: memory.key.id, size: .preview).scaledToFill()
            .frame(maxWidth: .infinity).frame(height: height)
            .clipShape(RoundedRectangle(cornerRadius: 26, style: .continuous))
            .overlay {
                LinearGradient(colors: [.clear, .clear, .black.opacity(0.6)], startPoint: .top, endPoint: .bottom)
                    .clipShape(RoundedRectangle(cornerRadius: 26, style: .continuous))
            }
            .overlay(alignment: .bottomLeading) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(memory.title).font(.system(size: 24, weight: .bold)).lineLimit(2)
                    Text(memory.subtitle).font(.system(size: 13, weight: .semibold)).opacity(0.85)
                }
                .foregroundStyle(.white).shadow(radius: 6).padding(18)
            }
            .overlay(alignment: .topTrailing) {
                if MemoryPrefs.shared.favorites.contains(memory.id) {
                    Image(systemName: "heart.fill").foregroundStyle(.white).shadow(radius: 4).padding(16)
                }
            }
            .contentShape(RoundedRectangle(cornerRadius: 26, style: .continuous))
    }
}

/// Tippen auf „Rückblicke >“: alle Rückblicke groß, Filter Alle/Favoriten, „Rückblick erstellen“.
struct MemoriesScreen: View {
    @Environment(AppModel.self) private var app
    @State private var center = MemoryCenter.shared
    @State private var onlyFavs = false
    @State private var create = false
    @State private var notify = MemoryNotifications.enabled
    @State private var planned = 0
    @Environment(TimelineStore.self) private var timeline

    var body: some View {
        let favs = MemoryPrefs.shared.favorites
        let list = center.items.filter { !onlyFavs || favs.contains($0.id) }
        ScrollView {
            VStack(spacing: 16) {
                Button { create = true } label: {
                    Label(String(localized: "Rückblick erstellen"), systemImage: "sparkles")
                        .font(.system(size: 17, weight: .semibold)).frame(maxWidth: .infinity).frame(height: 52)
                        .background(RoundedRectangle(cornerRadius: 18, style: .continuous).fill(Color.appFill))
                }
                .buttonStyle(.plain)
                Picker("", selection: $onlyFavs) { Text(String(localized: "Alle")).tag(false); Text(String(localized: "Favoriten")).tag(true) }
                    .pickerStyle(.segmented)
                ForEach(list) { m in
                    Button { app.memory = m } label: { MemoryCard(memory: m, height: 420) }
                        .buttonStyle(.plain)
                        .contextMenu { MemoryMenuItems(memory: m) }
                }
                if list.isEmpty {
                    ContentUnavailableView(onlyFavs ? String(localized: "Keine Favoriten") : String(localized: "Keine Rückblicke verfügbar"), systemImage: "clock.arrow.circlepath",
                                           description: Text(onlyFavs ? String(localized: "Markiere einen Rückblick mit dem Herz, um ihn hier zu sehen.")
                                                             : String(localized: "Rückblicke erscheinen hier, wenn mehr Fotos zur Mediathek hinzugefügt werden.")))
                }
            }
            .padding(20).padding(.bottom, 90)
        }
        .background(Color.appBackground)
        .navigationTitle(String(localized: "Rückblicke"))
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Toggle(isOn: Binding(get: { notify }, set: { on in
                        Task { notify = await MemoryNotifications.set(on, timeline: timeline); planned = await MemoryNotifications.pendingCount() }
                    })) { Label(String(localized: "Mitteilung „Heute vor … Jahren“"), systemImage: "bell") }
                    if notify { Text(planned == 1 ? String(localized: "1 Mitteilung geplant") : String(localized: "\(planned) Mitteilungen geplant")) }
                } label: { Image(systemName: notify ? "bell.fill" : "bell") }
            }
        }
        .task { planned = await MemoryNotifications.pendingCount() }
        .sheet(isPresented: $create) { CreateMemorySheet() }
    }
}

/// Gemeinsame Einträge für Kontextmenü und „…“ im Player.
struct MemoryMenuItems: View {
    let memory: Memory
    var onDelete: () -> Void = {}
    @Environment(AppModel.self) private var app

    private func less(_ toast: String, _ change: (inout MemoryPrefs) -> Void) {
        MemoryCenter.shared.update(change)
        app.toast(toast)
        onDelete()
    }
    var body: some View {
        let fav = MemoryPrefs.shared.favorites.contains(memory.id)
        Button(fav ? String(localized: "Aus Favoriten entfernen") : String(localized: "Zu Favoriten"), systemImage: fav ? "heart.slash" : "heart") {
            MemoryCenter.shared.update { p in if fav { p.favorites.remove(memory.id) } else { p.favorites.insert(memory.id) } }
        }
        Button(String(localized: "Fotos teilen"), systemImage: "square.and.arrow.up") { Task { await ShareService.share(memory.assets.map(\.id), app: app) } }
        // wie Fotos: „… weniger zeigen“ – danach baut die App die Rückblicke ohne das Thema
        Menu {
            if let name = memory.personName, let pid = memory.personID {
                Button("\(name) weniger zeigen", systemImage: "person.crop.circle.badge.minus") {
                    less(String(localized: "Weniger von \(name)")) { $0.lessPeople.insert(pid) }
                }
            }
            if let place = memory.place {
                Button("\(place) weniger zeigen", systemImage: "mappin.slash") {
                    less(String(localized: "Weniger aus \(place)")) { $0.lessPlaces.insert(place) }
                }
            }
            // immer anbieten (sonst ist das Menü bei „Das Beste aus …“/Jahreszeiten leer und iOS blendet es aus)
            do {
                Button("Diese Tage weniger zeigen", systemImage: "calendar.badge.minus") {
                    let days = Set(memory.assets.map { MemoryPrefs.dayKey($0.date) })
                    less(String(localized: "Diese Tage erscheinen seltener")) { $0.lessDays.formUnion(days) }
                }
            }
        } label: { Label("Weniger zeigen", systemImage: "hand.thumbsdown") }
        Divider()
        Button(String(localized: "Rückblick löschen"), systemImage: "trash", role: .destructive) {
            MemoryCenter.shared.update { $0.deleted.insert(memory.id) }
            app.toast(String(localized: "Rückblick gelöscht"))
            onDelete()
        }
    }
}

/// „Rückblick erstellen“: eigener Satz → Suche (Personen, Orte, Jahre, KI) → neuer Rückblick.
struct CreateMemorySheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(AppModel.self) private var app
    @State private var text = ""
    @State private var working = false
    @State private var failed = false
    @State private var cities: [String] = []
    @State private var people: [PersonDTO] = []
    @FocusState private var focused: Bool

    private let ideas = [String(localized: "Urlaub 2025"), String(localized: "Istanbul"), String(localized: "Sonnenuntergänge"), String(localized: "Essen mit Freunden"), String(localized: "Berge und Natur"), String(localized: "Familie")]

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 16) {
                Text(String(localized: "Beschreibe den Rückblick, den du sehen möchtest – zum Beispiel einen Ort, ein Jahr, eine Person oder ein Motiv."))
                    .foregroundStyle(.secondary)
                TextField(String(localized: "Beschreibe einen Rückblick …"), text: $text, axis: .vertical)
                    .font(.system(size: 20)).lineLimit(1...3)
                    .padding(16).background(RoundedRectangle(cornerRadius: 18).fill(Color.appFill))
                    .focused($focused).submitLabel(.go).onSubmit { Task { await create() } }
                FlowLayout(spacing: 8) {
                    ForEach(ideas, id: \.self) { i in
                        Button(i) { text = i }.font(.system(size: 15, weight: .medium)).foregroundStyle(.primary)
                            .padding(.horizontal, 14).frame(height: 36).background(Capsule().fill(Color.appFill2))
                            .buttonStyle(.plain)
                    }
                }
                if failed { Text(String(localized: "Dazu habe ich keine passenden Fotos gefunden.")).foregroundStyle(.orange) }
                Spacer()
            }
            .padding(20)
            .overlay { if working { ProgressView(String(localized: "Rückblick wird erstellt …")).padding(24).glassEffect(.regular, in: .rect(cornerRadius: 20)) } }
            .navigationTitle(String(localized: "Rückblick erstellen"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { Button { dismiss() } label: { Image(systemName: "xmark") } }
                ToolbarItem(placement: .topBarTrailing) {
                    Button(String(localized: "Erstellen")) { Task { await create() } }.buttonStyle(.borderedProminent)
                        .disabled(text.trimmingCharacters(in: .whitespaces).isEmpty || working)
                }
            }
        }
        .task {
            focused = true
            async let c = try? ImmichClient.shared.cities()
            async let p = try? ImmichClient.shared.people()
            cities = (await c ?? []).compactMap { $0.exifInfo?.city }
            people = (await p ?? []).filter { !$0.name.isEmpty }
        }
    }

    private func create() async {
        let q = text.trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty else { return }
        working = true; failed = false
        defer { working = false }
        let plan = await SearchPlan.make(q, cities: cities, people: people, forced: nil)
        let r = await plan.execute(smart: true)
        let found = (r.text + r.photos).filter(\.isImage)
        guard found.count >= 3, let m = MemoryCenter.shared.addCustom(title: q.prefix(1).uppercased() + q.dropFirst(), assets: found) else {
            failed = true; return
        }
        dismiss()
        try? await Task.sleep(for: .milliseconds(400))
        app.memory = m
    }
}

// MARK: - Abspielen

/// „Alle Fotos anzeigen“ eines Rückblicks.
struct MemoryGrid: View {
    let assets: [Asset]
    let open: (Int) -> Void
    /// gesetzt = Fotos lassen sich aus dem Rückblick nehmen (lange drücken)
    var remove: ((Asset) -> Void)? = nil
    var makeKey: ((Asset) -> Void)? = nil
    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 2), count: 3), spacing: 2) {
                    ForEach(Array(assets.enumerated()), id: \.element.id) { i, a in
                        Button { open(i) } label: { GridCell(asset: a) }.buttonStyle(.plain)
                            .contextMenu {
                                if let makeKey, a.isImage {
                                    Button("Als Titelbild verwenden", systemImage: "photo") { makeKey(a) }
                                }
                                if let remove {
                                    Button("Aus Rückblick entfernen", systemImage: "minus.circle", role: .destructive) { remove(a) }
                                }
                            }
                    }
                }
            }
            .background(Color.black)
            .navigationTitle(String(localized: "\(assets.count) Fotos"))
            .navigationBarTitleDisplayMode(.inline)
        }
        .preferredColorScheme(.dark)
    }
}

/// Zuletzt angesehene Rückblicke (für „Zuletzt“ in der Suche später nutzbar).
enum MemoryRecent {
    static func add(_ m: Memory) {
        var l = UserDefaults.standard.stringArray(forKey: "recentMemories") ?? []
        l.removeAll { $0 == m.id }; l.insert(m.id, at: 0)
        UserDefaults.standard.set(Array(l.prefix(30)), forKey: "recentMemories")
    }
}
