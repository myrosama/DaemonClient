import Foundation
import Network
import UIKit

/// Vorschaubilder dauerhaft auf dem iPhone – damit die Mediathek auch ohne Verbindung zum Server
/// durchblätterbar ist (wie „Speicher optimieren“ bei Apple: Vorschau da, Original nur mit Netz).
/// Liegt in Application Support (iOS räumt es nicht weg) und ist vom iPhone-Backup ausgenommen.
/// Datei je Objekt: `<id>_<thumbhash-Anfang>` – ändert der Server die Vorschau (Bearbeitung), passt der Name nicht mehr.
final class OfflineStore: @unchecked Sendable {
    static let shared = OfflineStore()
    enum Kind: String, CaseIterable { case thumbnail, preview }

    private let root: URL
    private let lock = NSLock()
    private var keys: [Kind: [String: String]] = [:]     // id → Dateiname
    private var sizes: [Kind: Int] = [:]
    private(set) var ready = false

    init() {
        root = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("offline")
        for k in Kind.allCases { try? FileManager.default.createDirectory(at: root.appendingPathComponent(k.rawValue), withIntermediateDirectories: true) }
        var r = root; var v = URLResourceValues(); v.isExcludedFromBackup = true; try? r.setResourceValues(v)
        Task.detached(priority: .utility) { self.scan() }
    }

    /// Bestand einlesen (81 000 Dateien ≈ 0,3 s, im Hintergrund).
    private func scan() {
        var k: [Kind: [String: String]] = [:], s: [Kind: Int] = [:]
        for kind in Kind.allCases {
            var map: [String: String] = [:], total = 0
            let dir = root.appendingPathComponent(kind.rawValue)
            if let e = FileManager.default.enumerator(at: dir, includingPropertiesForKeys: [.fileSizeKey]) {
                for case let u as URL in e where !u.hasDirectoryPath {
                    let name = u.lastPathComponent
                    guard let us = name.firstIndex(of: "_") else { continue }
                    map[String(name[..<us])] = name
                    total += (try? u.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
                }
            }
            k[kind] = map; s[kind] = total
        }
        lock.lock(); keys = k; sizes = s; ready = true; lock.unlock()
        Task { @MainActor in OfflineSync.shared.kick() }
    }

    private func name(_ id: String) -> String? {
        guard let h = ImageCache.shared.hash(id) else { return nil }
        let safe = String(h.prefix(12)).replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "+", with: "-")
        return "\(id)_\(safe)"
    }
    private func url(_ kind: Kind, _ name: String) -> URL {
        root.appendingPathComponent(kind.rawValue).appendingPathComponent(String(name.prefix(2))).appendingPathComponent(name)
    }

    /// Aktuelle Vorschau liegt auf dem iPhone?
    func has(_ kind: Kind, _ id: String) -> Bool {
        guard let n = name(id) else { return false }
        lock.lock(); defer { lock.unlock() }
        return keys[kind]?[id] == n
    }

    func data(_ kind: Kind, _ id: String) -> Data? {
        guard has(kind, id), let n = name(id) else { return nil }
        let u = url(kind, n)
        if kind == .preview { try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: u.path) }   // für „älteste zuerst löschen“
        return try? Data(contentsOf: u)
    }

    func store(_ kind: Kind, _ id: String, _ d: Data) {
        guard let n = name(id) else { return }
        let u = url(kind, n)
        lock.lock(); let oldName = keys[kind]?[id]; lock.unlock()
        let oldSize = oldName.flatMap { (try? url(kind, $0).resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0 } ?? 0
        try? FileManager.default.createDirectory(at: u.deletingLastPathComponent(), withIntermediateDirectories: true)
        guard (try? d.write(to: u, options: .atomic)) != nil else { return }
        lock.lock()
        keys[kind, default: [:]][id] = n
        sizes[kind, default: 0] += d.count - oldSize
        lock.unlock()
        if let oldName, oldName != n {
            let ou = url(kind, oldName)
            try? FileManager.default.removeItem(at: ou)
        }
    }

    func count(_ kind: Kind) -> Int { lock.lock(); defer { lock.unlock() }; return keys[kind]?.count ?? 0 }
    /// Nur Vorschauen von Objekten, die noch in der Mediathek sind (gelöschte/fremde zählen nicht mit – sonst
    /// stand dort „89 760 von 56 885“, GitHub #51)
    func count(_ kind: Kind, among ids: Set<String>) -> Int {
        lock.lock(); defer { lock.unlock() }
        return keys[kind]?.keys.reduce(0) { ids.contains($1) ? $0 + 1 : $0 } ?? 0
    }
    func bytes(_ kind: Kind) -> Int { lock.lock(); defer { lock.unlock() }; return sizes[kind] ?? 0 }

    /// Große Vorschauen über der Grenze: die am längsten nicht angesehenen zuerst löschen.
    func evict(_ kind: Kind, limit: Int) {
        guard bytes(kind) > limit else { return }
        let dir = root.appendingPathComponent(kind.rawValue)
        var files: [(URL, Date, Int)] = []
        if let e = FileManager.default.enumerator(at: dir, includingPropertiesForKeys: [.contentModificationDateKey, .fileSizeKey]) {
            for case let u as URL in e where !u.hasDirectoryPath {
                let v = try? u.resourceValues(forKeys: [.contentModificationDateKey, .fileSizeKey])
                files.append((u, v?.contentModificationDate ?? .distantPast, v?.fileSize ?? 0))
            }
        }
        var total = files.reduce(0) { $0 + $1.2 }
        for (u, _, s) in files.sorted(by: { $0.1 < $1.1 }) where total > limit {
            try? FileManager.default.removeItem(at: u); total -= s
            let name = u.lastPathComponent
            if let us = name.firstIndex(of: "_") { lock.lock(); keys[kind]?[String(name[..<us])] = nil; lock.unlock() }
        }
        lock.lock(); sizes[kind] = total; lock.unlock()
    }

    func clear() {
        for k in Kind.allCases {
            let d = root.appendingPathComponent(k.rawValue)
            try? FileManager.default.removeItem(at: d)
            try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        }
        lock.lock(); keys = [:]; sizes = [:]; lock.unlock()
    }
}

/// Ist der eigene Server gerade erreichbar? (aus den echten Anfragen, nicht geraten) + WLAN ja/nein.
@MainActor @Observable
final class Connectivity {
    static let shared = Connectivity()
    private(set) var serverOffline = false
    private(set) var onWiFi = false
    private let monitor = NWPathMonitor()

    init() {
        monitor.pathUpdateHandler = { p in
            let wifi = p.status == .satisfied && !p.isExpensive && !p.isConstrained
            Task { @MainActor in
                Connectivity.shared.onWiFi = wifi
                if p.status != .satisfied { Connectivity.shared.serverOffline = true }
                OfflineSync.shared.kick()
            }
        }
        monitor.start(queue: .global(qos: .utility))
    }

    nonisolated static func report(_ error: Error?) {
        let offline: Bool
        if let e = error as? URLError {
            switch e.code {
            case .notConnectedToInternet, .cannotConnectToHost, .cannotFindHost, .timedOut, .networkConnectionLost, .dnsLookupFailed,
                 .secureConnectionFailed, .internationalRoamingOff, .dataNotAllowed: offline = true
            default: return
            }
        } else if error == nil { offline = false } else { return }
        Task { @MainActor in
            if Connectivity.shared.serverOffline != offline { Connectivity.shared.serverOffline = offline }
        }
    }
}

/// Füllt den Offline-Speicher im Hintergrund: erst alle kleinen Vorschauen (~1 GB), dann die großen.
/// Nur im WLAN, nur solange die App offen ist oder der nächtliche Hintergrund-Auftrag läuft.
@MainActor @Observable
final class OfflineSync {
    static let shared = OfflineSync()
    var enabled = UserDefaults.standard.object(forKey: "offline.enabled") as? Bool ?? true {
        didSet { UserDefaults.standard.set(enabled, forKey: "offline.enabled"); kick() }
    }
    /// Für Nicht-MainActor-Code (Bild-Cache): Offline-Speicher eingeschaltet?
    nonisolated static var enabledFlag: Bool { UserDefaults.standard.object(forKey: "offline.enabled") as? Bool ?? true }
    /// Grenze für große Vorschauen in GB, 0 = alle
    var previewLimitGB = UserDefaults.standard.object(forKey: "offline.previewGB") as? Int ?? 0 {
        didSet { UserDefaults.standard.set(previewLimitGB, forKey: "offline.previewGB"); kick() }
    }
    private(set) var running = false
    private(set) var note = ""
    /// Beim Scrollen/Zoomen keine Hintergrund-Downloads (Verbindungen und Rechenzeit gehören dann den Kacheln)
    @ObservationIgnored private var busyUntil = Date.distantPast
    func userBusy(_ on: Bool) { busyUntil = on ? .distantFuture : Date().addingTimeInterval(1) }
    /// Statistik für die Einstellungen (wird beim Laufen nachgeführt)
    private(set) var thumbs = 0
    private(set) var previews = 0
    private(set) var thumbBytes = 0
    private(set) var previewBytes = 0
    private(set) var total = 0
    @ObservationIgnored weak var timeline: TimelineStore?
    @ObservationIgnored private var task: Task<Void, Never>?
    /// iPhone muss mindestens so viel frei behalten
    static let minFree: Int64 = 10 << 30

    func refreshStats() {
        let s = OfflineStore.shared
        let all = timeline?.allLoaded ?? []
        if all.count != idSet.count { idSet = Set(all.map(\.id)) }
        thumbs = s.count(.thumbnail, among: idSet); previews = s.count(.preview, among: idSet)
        thumbBytes = s.bytes(.thumbnail); previewBytes = s.bytes(.preview)
        total = all.count
    }
    @ObservationIgnored private var idSet: Set<String> = []

    /// Bei Bedarf starten (WLAN da, eingeschaltet, Zeitleiste geladen); stoppt selbst ohne WLAN.
    func kick() {
        guard enabled, Connectivity.shared.onWiFi, !Connectivity.shared.serverOffline, task == nil,
              let t = timeline, !t.allLoaded.isEmpty, !t.restoring, OfflineStore.shared.ready else { return }
        task = Task { await run(t); task = nil; running = false }
    }
    func stop() { task?.cancel(); task = nil; running = false }

    private func freeSpace() -> Int64 {
        let u = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return (try? u.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]).volumeAvailableCapacityForImportantUsage) ?? 0
    }

    /// Nachts im Hintergrund-Auftrag (nach dem Backup): laufen lassen, bis fertig oder iOS abbricht.
    func runAndWait() async {
        kick()
        while let t = task { await t.value }
    }

    private func run(_ t: TimelineStore) async {
        running = true
        await t.loadAll()                     // Offline braucht die ganze Zeitleiste, nicht nur Angesehenes
        let s = OfflineStore.shared
        // Neueste zuerst – das schaut man am häufigsten an
        let all = t.allLoaded.reversed().map(\.id)
        for kind in OfflineStore.Kind.allCases {
            // 80 000 Prüfungen im Hintergrund (auf dem Hauptthread ≈ 1 s Hänger)
            let todo = await Task.detached(priority: .utility) {
                all.filter { ImageCache.shared.hash($0) != nil && !s.has(kind, $0) }
            }.value
            // „Keine“ große Vorschauen: nur die kleinen fürs Raster behalten (GitHub #51)
            if kind == .preview, previewLimitGB < 0 { s.evict(.preview, limit: 0); refreshStats(); continue }
            if kind == .preview {
                let limit = previewLimitGB == 0 ? Int.max : previewLimitGB << 30
                if s.bytes(.preview) >= limit { s.evict(.preview, limit: limit); refreshStats(); continue }
            }
            note = kind == .thumbnail ? String(localized: "Kleine Vorschauen") : String(localized: "Große Vorschauen")
            var i = 0
            while i < todo.count {
                while Date() < busyUntil, !Task.isCancelled { try? await Task.sleep(for: .milliseconds(300)) }
                if Task.isCancelled || !enabled || !Connectivity.shared.onWiFi || Connectivity.shared.serverOffline { note = ""; return }
                if freeSpace() < Self.minFree { note = String(localized: "iPhone-Speicher fast voll – pausiert"); return }
                if kind == .preview, previewLimitGB > 0, s.bytes(.preview) >= previewLimitGB << 30 { break }
                let batch = Array(todo[i..<min(todo.count, i + 8)]); i += batch.count
                await withTaskGroup(of: Void.self) { g in
                    for id in batch { g.addTask { await ImageCache.shared.fetchToStore(id, kind) } }
                }
                if i % 200 < 8 { refreshStats() }
            }
            refreshStats()
        }
        note = ""
    }
}
