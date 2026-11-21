import UIKit
import WidgetKit

/// Füllt den gemeinsamen Speicher für die Widgets (Rückblicke + ausgewählte Fotos) und gibt den Zugang
/// an die Teilen-Erweiterung weiter. Läuft beim Wechsel in den Hintergrund.
@MainActor
enum WidgetFeeder {
    private static var running = false
    private static var last = Date.distantPast

    /// Höchstens alle 30 min neu; beim Wechsel in den Hintergrund mit Schonfrist von iOS (sonst friert iOS die App mittendrin ein).
    static func update(timeline: TimelineStore, force: Bool = false) async {
        guard !running, force || Date().timeIntervalSince(last) > 1800 else { return }
        running = true; defer { running = false }
        let bg = UIApplication.shared.beginBackgroundTask(withName: "widget") {}
        defer { UIApplication.shared.endBackgroundTask(bg) }
        await fill(timeline)
        last = Date()
    }

    private static func fill(_ timeline: TimelineStore) async {
        guard let dir = WidgetSnapshot.folder else { return }
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let center = MemoryCenter.shared
        if center.items.isEmpty, let server = try? await ImmichClient.shared.memories() {
            await center.rebuild(timeline: timeline, server: server)
        }
        var snap = WidgetSnapshot()
        // Rückblicke: die „Heute vor …“ zuerst, dann die übrigen
        let mems = Array(center.items.prefix(6))
        let memFiles = await files(mems.map(\.key.id), dir)
        for (m, f) in zip(mems, memFiles) {
            if let f { snap.memories.append(.init(id: m.id, title: m.title, subtitle: m.subtitle, file: f, memory: true)) }
        }
        // Ausgewählte Fotos: Favoriten mit Vorschau, sonst zufällige Server-Auswahl
        let favs = timeline.allLoaded.filter { $0.isFavorite && $0.isImage && ImageCache.shared.hash($0.id) != nil }.shuffled()
        var pool = Array(favs.prefix(12))
        if pool.count < 6, let r = try? await ImmichClient.shared.random(size: 12) { pool += r.map(\.asset).filter(\.isImage) }
        let photos = Array(pool.prefix(10))
        let photoFiles = await files(photos.map(\.id), dir)
        for (a, f) in zip(photos, photoFiles) {
            if let f { snap.photos.append(.init(id: a.id, title: Fmt.dayLongMonthYear.string(from: a.date), subtitle: a.city ?? "", file: f, memory: false)) }
        }
        // alte Bilder wegräumen
        let keep = Set((snap.memories + snap.photos).map(\.file) + ["snapshot.json"])
        for f in (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? [] where !keep.contains(f) {
            try? FileManager.default.removeItem(at: dir.appendingPathComponent(f))
        }
        snap.save()
        WidgetCenter.shared.reloadAllTimelines()
    }

    /// Mehrere Bilder gleichzeitig (Reihenfolge bleibt).
    private static func files(_ ids: [String], _ dir: URL) async -> [String?] {
        await withTaskGroup(of: (Int, String?).self) { g in
            for (i, id) in ids.enumerated() { g.addTask { (i, await write(id, to: dir)) } }
            var out = [String?](repeating: nil, count: ids.count)
            for await (i, f) in g { out[i] = f }
            return out
        }
    }

    /// Vorschau verkleinert (≤ 700 px) als JPEG – Widgets haben wenig Arbeitsspeicher.
    private static func write(_ id: String, to dir: URL) async -> String? {
        let version = ImageCache.shared.version(id) ?? "v0"
        let safeVersion = String(version.prefix(24)).replacingOccurrences(of: "/", with: "_")
        let name = "\(id)-\(safeVersion).jpg"
        if FileManager.default.fileExists(atPath: dir.appendingPathComponent(name).path) { return name }
        guard let img = await ImageCache.shared.load(id, .preview) else { return nil }
        // in echten Pixeln (Faktor 1) – Widgets lehnen Bilder über ~1,2 Megapixel ab
        let px = CGSize(width: img.size.width * img.scale, height: img.size.height * img.scale)
        let s = min(1, 700 / max(px.width, px.height))
        let size = CGSize(width: (px.width * s).rounded(), height: (px.height * s).rounded())
        let fmt = UIGraphicsImageRendererFormat(); fmt.scale = 1
        let small = UIGraphicsImageRenderer(size: size, format: fmt).image { _ in img.draw(in: CGRect(origin: .zero, size: size)) }
        guard let d = small.jpegData(compressionQuality: 0.82) else { return nil }
        try? d.write(to: dir.appendingPathComponent(name), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        return name
    }

    /// Zugang für die Teilen-Erweiterung aktuell halten.
    static func syncAccess() {
        let c = ImmichClient.shared
        if let u = c.baseURL, let t = c.token { AppGroup.saveAccess(.init(server: u.absoluteString, token: t)) }
        else { AppGroup.saveAccess(nil) }
    }
}
