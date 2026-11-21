import SwiftUI

struct DayGroup: Identifiable, Hashable, Sendable {
    let day: Date
    let assets: [Asset]
    var id: Date { day }
    var place: String? {
        Dictionary(grouping: assets.compactMap(\.city), by: { $0 }).max(by: { $0.value.count < $1.value.count })?.key
    }
    /// Ort, sonst Wochentag – wie die Tageskarten in Apple Fotos.
    var title: String { place ?? Fmt.weekday.string(from: day) }
    var subtitle: String {
        (place != nil ? Fmt.weekdayDay.string(from: day) : Fmt.dayMonthYear.string(from: day)).uppercased()
    }
    var keyAsset: Asset {
        assets.first(where: { $0.isImage && ImageCache.shared.hash($0.id) != nil }) ?? assets.first(where: \.isImage) ?? assets[0]
    }
}

/// Ein Monat der Zeitleiste – eigenes Observable, damit das Nachladen eines Monats nur dessen Ansichten neu zeichnet
/// (bei 80 000 Fotos in 116 Monaten sonst 116 × alles neu = Sekunden-Hänger).
@MainActor @Observable
final class BucketData {
    private(set) var assets: [Asset]?
    private(set) var days: [DayGroup] = []
    /// Objekte ohne Server-Vorschau (kein thumbhash) → Monat wird später erneut abgefragt.
    @ObservationIgnored private(set) var missing = 0
    /// Zuletzt angezeigt (Wächter fragt zuerst die Monate nach, die man gerade ansieht).
    @ObservationIgnored var touched = Date.distantPast
    func refreshMissing() {
        missing = (assets ?? []).reduce(0) { $0 + (ImageCache.shared.isMissing($1.id) ? 1 : 0) }
    }
    func set(_ a: [Asset], days d: [DayGroup]? = nil) {
        assets = a
        missing = a.reduce(0) { $0 + (ImageCache.shared.isMissing($1.id) ? 1 : 0) }
        days = d ?? Self.group(a)
    }
    /// Tage eines Monats (im Hintergrund vorberechnet, wenn viele Monate auf einmal kommen).
    nonisolated static func group(_ a: [Asset]) -> [DayGroup] {
        let g = Dictionary(grouping: a) { Calendar.wall.startOfDay(for: $0.date) }
        return g.keys.sorted().map { DayGroup(day: $0, assets: g[$0]!) }
    }
}

/// Lädt die Zeitleiste monatsweise (Immich-Buckets) und hält sie im Speicher.
@MainActor @Observable
final class TimelineStore {
    /// Älteste zuerst – die Mediathek zeigt wie Apple Fotos das Neueste unten.
    private(set) var buckets: [TimeBucket] = [] { didSet { contentRevision += 1 } }
    @ObservationIgnored private var data: [String: BucketData] = [:]
    private(set) var loading = false
    var error: String?
    @ObservationIgnored private var inFlight: Set<String> = []

    /// Alle geladenen Objekte (älteste zuerst) und das Raster für „Alle“ – gebündelt neu gebaut, nicht je Monat.
    private(set) var allLoaded: [Asset] = []
    private(set) var gridCells: [GridItemRef] = []
    @ObservationIgnored private(set) var gridIndex: [String: Int] = [:]
    /// Zählt jede Neuberechnung – Ansichten mit teuren Ableitungen (Reisen, Letzte Tage) hängen daran.
    private(set) var version = 0
    @ObservationIgnored private var rebuildPending = false
    /// Zählt Inhaltsänderungen; ist der gebündelte Stand schon aktuell, wird nicht neu gebaut (Idee aus dem Fork vands2013)
    @ObservationIgnored private var contentRevision = 0
    @ObservationIgnored private var builtRevision = -1

    var totalCount: Int { buckets.reduce(0) { $0 + $1.count } }

    /// Neue iPhone-Fotos, die noch nicht auf dem Server sind (LocalPending) – stehen am Ende des Rasters „Alle“.
    /// Nicht in `allLoaded`: Sammlungen, Suche usw. arbeiten nur mit Server-Objekten.
    @ObservationIgnored private(set) var localAssets: [Asset] = []
    func setLocal(_ a: [Asset]) {
        guard a != localAssets else { return }
        localAssets = a
        scheduleRebuild()
    }

    /// Objekt per Kennung über das Raster-Verzeichnis – `allLoaded.filter` ging bei 85 000 Objekten jedes Mal alle
    /// durch (gemessen ~25 ms für „Zuletzt angesehen“ je Tastendruck, ~7 ms je Auswahl-Änderung).
    func asset(_ id: String) -> Asset? {
        guard let i = gridIndex[id], i < gridCells.count, case .asset(let a, _) = gridCells[i] else { return nil }
        return a
    }
    /// Mehrere Objekte in Zeitleisten-Reihenfolge (älteste zuerst, wie `allLoaded.filter`), ohne Doppelte.
    func assets(_ ids: some Sequence<String>) -> [Asset] {
        Set(ids.compactMap { gridIndex[$0] }).sorted().compactMap { i in
            guard i < gridCells.count, case .asset(let a, _) = gridCells[i] else { return nil }
            return a
        }
    }

    var years: [Int] {
        Array(Set(buckets.map { Calendar.wall.component(.year, from: $0.monthDate) })).sorted()
    }

    func buckets(inYear y: Int) -> [TimeBucket] {
        buckets.filter { Calendar.wall.component(.year, from: $0.monthDate) == y }
    }

    /// Monatsdaten (beobachtet nur diesen Monat).
    func bucket(_ b: String) -> BucketData {
        if let d = data[b] { return d }
        let d = BucketData(); data[b] = d; return d
    }
    func assets(_ b: String) -> [Asset]? { bucket(b).assets }
    func days(in b: String) -> [DayGroup] { bucket(b).days }

    // MARK: Zeitleiste auf dem iPhone (sofort da beim Start, auch offline)

    /// Konto, zu dem der Speicher gehört (aus /users/me, siehe RootView).
    @ObservationIgnored private var user = UserDefaults.standard.string(forKey: "timeline.user") ?? ""
    /// Angemeldetes Konto (für Daten, die je Konto getrennt sein müssen, z. B. Rückblicke)
    var account: String { user }
    @ObservationIgnored private var restored = false
    /// Zählt Kontowechsel – ein noch laufendes Einlesen des alten Kontos darf danach nichts mehr eintragen
    @ObservationIgnored private var generation = 0
    /// Liest gerade den gespeicherten Stand ein (Offline-Abgleich wartet darauf, sonst lädt er alles doppelt).
    @ObservationIgnored private(set) var restoring = false
    private var cacheDir: URL? {
        guard !user.isEmpty else { return nil }
        let d = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("timeline-\(user)")
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }
    private func file(_ b: String) -> URL? { cacheDir?.appendingPathComponent("b-\(b).json") }
    private func save(_ d: Data, to url: URL?) {
        guard let url else { return }
        Task.detached(priority: .utility) { try? d.write(to: url, options: .atomic) }
    }
    private func forget(_ b: String) { if let f = file(b) { try? FileManager.default.removeItem(at: f) } }

    /// Anderes Konto angemeldet → Speicher dieses Kontos verwenden, Anzeige neu aufbauen.
    /// Gibt true zurück, wenn dabei schon neu geladen wurde.
    @discardableResult func setUser(_ id: String) async -> Bool {
        guard id != user else { return false }
        let first = user.isEmpty
        user = id; UserDefaults.standard.set(id, forKey: "timeline.user")
        // Erster Start: angezeigt wird schon dieses Konto → nur speichern, nicht neu aufbauen.
        if first { await reload(); return true }
        generation += 1
        loadAllTask?.cancel(); loadAllTask = nil
        buckets = []; data = [:]; restored = false
        await rebuildNow()
        await reload()
        return true
    }

    /// Nur den auf dem iPhone gespeicherten Stand zeigen (sofort, auch offline) – vom Server wird erst geladen,
    /// wenn feststeht, welches Konto angemeldet ist (sonst mischt sich nach einem Kontowechsel der alte Speicher ein).
    func showCached() async { await restore() }

    /// Gespeicherte Zeitleiste: Monatsliste sofort, Monate parallel und Neueste zuerst einlesen –
    /// das Raster steht nach Bruchteilen einer Sekunde, ältere Monate kommen nach.
    private func restore() async {
        guard !restored, let dir = cacheDir else { return }
        restored = true
        guard let raw = try? Data(contentsOf: dir.appendingPathComponent("buckets.json")),
              let b = try? JSONDecoder().decode([TimeBucket].self, from: raw) else { return }
        if buckets.isEmpty { buckets = b.sorted { $0.timeBucket < $1.timeBucket } }
        let files = buckets.reversed().compactMap { t in file(t.timeBucket).map { (t.timeBucket, $0) } }
        let gen = generation
        restoring = true
        // Monate, die beim Speichern noch keine Server-Vorschauen hatten, einmal frisch holen (die neuesten zuerst,
        // höchstens 24 je Start) – sonst bleiben sie ohne Vorschau, bis man sie ansieht (z. B. „Heute vor 3 Jahren“ fehlte)
        var refresh = 24
        Task { [weak self] in
            let stream = AsyncStream<(String, [Asset], [DayGroup])> { cont in
                Task.detached(priority: .userInitiated) {
                    await withTaskGroup(of: Void.self) { g in
                        var running = 0
                        for (k, f) in files {
                            if running >= 4 { await g.next(); running -= 1 }
                            g.addTask {
                                if let d = try? Data(contentsOf: f), let a = ImmichClient.decodeBucket(d) { cont.yield((k, a, BucketData.group(a))) }
                            }
                            running += 1
                        }
                    }
                    cont.finish()
                }
            }
            for await (k, a, days) in stream {
                guard let self, self.generation == gen else { return }
                // Frisch vom Server Geholtes nie mit dem älteren Stand vom iPhone überschreiben
                guard self.bucket(k).assets == nil else { continue }
                // Passt der Monat nicht zur Monatsliste, ist er veraltet oder gehört nicht zu diesem Konto → frisch holen
                if let n = self.buckets.first(where: { $0.timeBucket == k })?.count, n != a.count {
                    self.forget(k); Task { await self.load(k) }; continue
                }
                self.bucket(k).set(a, days: days); self.scheduleRebuild()
                if self.bucket(k).missing > 0, refresh > 0 { refresh -= 1; Task { await self.load(k, force: true) } }
            }
            self?.restoring = false
            PerfLog.mark("aus dem iPhone-Speicher: \(self?.allLoaded.count ?? 0) Objekte")
            OfflineSync.shared.kick()
        }
    }

    func reload() async {
        loading = true; defer { loading = false }
        await restore()
        do {
            let raw = try await ImmichClient.shared.bucketsData()
            let b = try JSONDecoder().decode([TimeBucket].self, from: raw).sorted { $0.timeBucket < $1.timeBucket }
            let old = Dictionary(buckets.map { ($0.timeBucket, $0.count) }, uniquingKeysWith: { a, _ in a })
            if buckets != b { buckets = b }
            let keep = Set(b.map(\.timeBucket))
            for k in data.keys where !keep.contains(k) { forget(k) }
            // auch Monatsdateien, die noch nicht eingelesen sind
            if let dir = cacheDir, let names = try? FileManager.default.contentsOfDirectory(atPath: dir.path) {
                for n in names where n.hasPrefix("b-") && n.hasSuffix(".json") && !keep.contains(String(n.dropFirst(2).dropLast(5))) {
                    try? FileManager.default.removeItem(at: dir.appendingPathComponent(n))
                }
            }
            data = data.filter { keep.contains($0.key) }
            save(raw, to: cacheDir?.appendingPathComponent("buckets.json"))
            // Neu laden, was sich geändert haben kann: andere Anzahl, die 2 neuesten Monate, und einmal am Tag alles.
            // Auch gegen den tatsächlichen Inhalt prüfen (Server-Anzahl = gelieferte Objekte, nachgemessen):
            // ein Monat, der nicht zur Anzahl passt, ist veraltet oder gehört nicht zu diesem Konto.
            let daily = Date().timeIntervalSince(UserDefaults.standard.object(forKey: "timeline.full.\(user)") as? Date ?? .distantPast) > 86_400
            let newest = Set(b.suffix(2).map(\.timeBucket))
            for t in b where data[t.timeBucket]?.assets != nil {
                if daily || old[t.timeBucket] != t.count || data[t.timeBucket]?.assets?.count != t.count || newest.contains(t.timeBucket) {
                    inFlight.remove(t.timeBucket); await load(t.timeBucket, force: true)
                }
            }
            if daily { UserDefaults.standard.set(Date(), forKey: "timeline.full.\(user)") }
            error = nil
            await rebuildNow()
            startWatcher()
            OfflineSync.shared.kick()
        } catch { if buckets.isEmpty { self.error = error.localizedDescription } }
    }

    func load(_ b: String, force: Bool = false) async {
        bucket(b).touched = Date()
        guard force || bucket(b).assets == nil, !inFlight.contains(b) else { return }
        inFlight.insert(b); defer { inFlight.remove(b) }
        let gen = generation
        guard let d = try? await ImmichClient.shared.bucketData(b) else { return }
        let r = await Task.detached(priority: .userInitiated) { ImmichClient.decodeBucket(d).map { ($0, BucketData.group($0)) } }.value
        guard let (a, days) = r, gen == generation else { return }
        save(d, to: file(b))
        // Nur neue Vorschauen (thumbhash) → Kacheln melden sich selbst (.thumbChanged); das 80k-Raster nicht neu bauen
        if let old = bucket(b).assets, old == a { bucket(b).refreshMissing(); return }
        bucket(b).set(a, days: days)
        scheduleRebuild()
    }

    /// Gerade sichtbar (Raster meldet das) – für den Vorschau-Wächter.
    func touch(_ b: String) { data[b]?.touched = Date() }

    /// Solange der Server Vorschauen rechnet: alle 45 s die zuletzt angesehenen Monate mit fehlenden Vorschauen
    /// neu abfragen; neue thumbhashes lösen `.thumbChanged` aus → die Kacheln laden ihr Bild von selbst.
    @ObservationIgnored private var watcher: Task<Void, Never>?
    private func startWatcher() {
        guard watcher == nil else { return }
        watcher = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(45))
                guard let self else { return }
                let due = self.data.filter { $0.value.missing > 0 && Date().timeIntervalSince($0.value.touched) < 600 }
                    .sorted { $0.value.touched > $1.value.touched }.prefix(4).map(\.key)
                for b in due { await self.load(b, force: true) }
            }
        }
    }

    /// Alles laden (für Sammlungen, Reisen, Medienarten).
    /// Mehrere Aufrufer (Sammlungen, Suche, Offline …) teilen sich einen Durchlauf: sonst übersprang der zweite die
    /// gerade ladenden Monate (inFlight) und rechnete mit einer halben Mediathek weiter. Idee aus dem Fork vands2013.
    func loadAll() async {
        // läuft schon einer: mitwarten (ein abgebrochener alter nach Kontowechsel endet sofort → dann selbst laden)
        while let running = loadAllTask { await running.value; if loadAllTask == running { break } }
        guard buckets.contains(where: { bucket($0.timeBucket).assets == nil }) else { return }
        let gen = generation
        let task = Task { @MainActor in
            let t = Date(); defer { PerfLog.mark(String(format: "Alles geladen in %.1f s, %d Objekte", Date().timeIntervalSince(t), allLoaded.count)) }
            await withTaskGroup(of: Void.self) { g in
                var running = 0
                for b in buckets where bucket(b.timeBucket).assets == nil {
                    guard gen == generation else { break }
                    if running >= 6 { await g.next(); running -= 1 }
                    g.addTask { await self.load(b.timeBucket) }
                    running += 1
                }
            }
            // Monate, die schon jemand anderes lädt (Raster), hat load() übersprungen → kurz auf sie warten
            for _ in 0..<200 where gen == generation && buckets.contains(where: { bucket($0.timeBucket).assets == nil && inFlight.contains($0.timeBucket) }) {
                try? await Task.sleep(for: .milliseconds(50))
            }
            if gen == generation { await rebuildNow() }
        }
        loadAllTask = task
        await task.value
        if loadAllTask == task { loadAllTask = nil }
    }
    @ObservationIgnored private var loadAllTask: Task<Void, Never>?

    /// Höchstens alle 0,8 s neu bündeln, solange noch Monate eintreffen.
    private func scheduleRebuild() {
        contentRevision += 1
        guard !rebuildPending else { return }
        rebuildPending = true
        Task { try? await Task.sleep(for: .milliseconds(800)); await rebuildNow() }
    }

    /// Liste und Raster im Hintergrund neu bündeln (80 000 Objekte ≈ 50–150 ms – auf dem Hauptthread ein Ruckler
    /// bei jedem nachkommenden Monat). Nacheinander, damit ein älterer Lauf nie einen neueren überschreibt.
    @ObservationIgnored private var rebuildChain: Task<Void, Never>?
    private func rebuildNow() async {
        rebuildPending = false
        let prev = rebuildChain
        let t = Task { @MainActor in
            await prev?.value
            guard builtRevision != contentRevision else { return }
            let rev = contentRevision
            let bs = buckets, lists = bs.map { data[$0.timeBucket]?.assets }, local = localAssets
            let (all, cells, idx) = await Task.detached(priority: .userInitiated) { Self.build(bs, lists, local) }.value
            allLoaded = all; gridCells = cells; gridIndex = idx
            builtRevision = rev
            version += 1
            if !localAssets.isEmpty { LocalPending.shared.refresh() }
        }
        rebuildChain = t
        await t.value
    }

    private nonisolated static func build(_ bs: [TimeBucket], _ lists: [[Asset]?], _ local: [Asset] = []) -> ([Asset], [GridItemRef], [String: Int]) {
        let total = bs.reduce(0) { $0 + $1.count }
        var all: [Asset] = []; all.reserveCapacity(total)
        var cells: [GridItemRef] = []; cells.reserveCapacity(total)
        for (b, list) in zip(bs, lists) {
            if let list {
                all += list
                cells += list.map { .asset($0, bucket: b.timeBucket) }
            } else {
                cells += (0..<b.count).map { .placeholder(bucket: b.timeBucket, index: $0) }
            }
        }
        // iPhone-Fotos ohne Server-Gegenstück: die neuesten Aufnahmen → ganz unten wie in Fotos
        cells += local.sorted { $0.date < $1.date }.map { .asset($0, bucket: "local") }
        var idx: [String: Int] = [:]; idx.reserveCapacity(cells.count)
        for (i, c) in cells.enumerated() { idx[c.id] = i }
        return (all, cells, idx)
    }

    /// Änderungen aus der App: Monat im Speicher verwerfen, damit der nächste Start ihn frisch holt.
    func update(_ asset: Asset) {
        for (k, d) in data {
            if var list = d.assets, let i = list.firstIndex(where: { $0.id == asset.id }) {
                list[i] = asset; d.set(list); forget(k); scheduleRebuild(); return
            }
        }
    }

    func remove(_ id: String) {
        for (k, d) in data where d.assets?.contains(where: { $0.id == id }) == true {
            d.set(d.assets!.filter { $0.id != id }); forget(k)
        }
        scheduleRebuild()
    }

    /// Abmelden: Speicher auf dem iPhone löschen.
    func clearCache() {
        if let d = cacheDir { try? FileManager.default.removeItem(at: d) }
        user = ""; UserDefaults.standard.removeObject(forKey: "timeline.user")
        generation += 1
        loadAllTask?.cancel(); loadAllTask = nil
        buckets = []; data = [:]; restored = false
        allLoaded = []; gridCells = []; gridIndex = [:]; version += 1
    }
}
