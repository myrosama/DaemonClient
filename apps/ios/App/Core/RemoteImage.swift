import SwiftUI
import UIKit
import ImageIO
import AVFoundation

/// Speicher-Cache für dekodierte Bilder (Platte erledigt URLCache im Client).
final class ImageCache: @unchecked Sendable {
    static let shared = ImageCache()
    private let cache = NSCache<NSString, UIImage>()
    init() { cache.totalCostLimit = 200 << 20 }
    func get(_ k: String) -> UIImage? { cache.object(forKey: k as NSString) }
    /// Abmelden: alle Bilder und Fassungen des Kontos vergessen
    func purge() {
        cache.removeAllObjects()
        lock.withLock { hashes = [:]; missing = []; versions = [:]; videos = []; noFrame = [] }
        UserDefaults.standard.removeObject(forKey: "thumbVersions")
        try? FileManager.default.removeItem(at: Self.frameFolder)
    }
    /// Fingerabdruck der Server-Vorschau (thumbhash). Ändert er sich (Bearbeitung, auch von anderem Gerät),
    /// bekommt die Vorschau eine neue Adresse → Zwischenspeicher wird umgangen.
    /// Fehlt er, hat der Server noch keine Vorschau gerechnet → `missing`: dann gar nicht erst anfragen (404),
    /// sondern warten, bis eine neuere Zeitleisten-Antwort den Hash liefert (→ `.thumbChanged`).
    private var hashes: [String: String] = [:]
    private var missing: Set<String> = []
    /// Videos (für sie gibt es notfalls ein Standbild aus dem Video selbst) und Videos, bei denen auch das scheiterte
    private var videos: Set<String> = []
    private var noFrame: Set<String> = []
    /// Bildfassungen nach dem Bearbeiten (gespiegelt aus UserDefaults – `version` läuft für jede Kachel)
    private var versions = (UserDefaults.standard.dictionary(forKey: "thumbVersions") as? [String: String]) ?? [:]
    private let lock = NSLock()
    func setHash(_ id: String, _ h: String?, video: Bool = false) {
        var h = h
        #if DEBUG
        // Test: Server ohne Video-Vorschauen nachstellen (Standbild aus dem Video, GitHub-Issue #1)
        if video, ProcessInfo.processInfo.environment["FOTOS_TEST_NO_VIDEO_THUMBS"] != nil { h = nil }
        #endif
        lock.lock()
        if video { videos.insert(id) }
        guard let h else {
            if hashes[id] == nil { missing.insert(id) }
            lock.unlock(); return
        }
        let old = hashes[id]; hashes[id] = h
        let arrived = missing.remove(id) != nil
        lock.unlock()
        if let old, old != h {
            for s in ["thumbnail", "preview", "fullsize"] { cache.removeObject(forKey: "\(id)-\(s)" as NSString) }
            cache.removeObject(forKey: "ph-\(id)" as NSString)
        }
        if arrived || (old != nil && old != h) {
            DispatchQueue.main.async { NotificationCenter.default.post(name: .thumbChanged, object: id) }
        }
    }
    func hash(_ id: String) -> String? { lock.lock(); defer { lock.unlock() }; return hashes[id] }
    func isMissing(_ id: String) -> Bool { lock.lock(); defer { lock.unlock() }; return missing.contains(id) }
    /// Lohnt sich das Laden? Ja, wenn der Server eine Vorschau hat – oder bei Videos (dann notfalls Standbild aus dem Video).
    func canLoad(_ id: String) -> Bool {
        lock.withLock { !missing.contains(id) || (videos.contains(id) && (!noFrame.contains(id) || LocalCopy.allowed)) }
    }

    /// Unscharfes Sofortbild aus dem thumbhash (≈ 0,1 ms, im Speicher gemerkt).
    func placeholder(_ id: String) -> UIImage? {
        let key = "ph-\(id)" as NSString
        if let i = cache.object(forKey: key) { return i }
        guard var h = hash(id) else { return nil }
        while h.count % 4 != 0 { h += "=" }          // Immich liefert base64 ohne Auffüllung
        guard let img = ThumbHash.image(base64: h) else { return nil }
        cache.setObject(img, forKey: key, cost: 32 * 32 * 4)
        return img
    }

    /// Nach dem Bearbeiten: neue Bildfassung erzwingen (bleibt über Neustarts gemerkt).
    func version(_ id: String) -> String? {
        lock.lock(); let h = hashes[id], v = versions[id]; lock.unlock()
        let parts = [v, h.map { String($0.prefix(10)) }].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: "-")
    }
    func bump(_ id: String) {
        let d = lock.withLock { versions[id] = String(Int(Date().timeIntervalSince1970)); return versions }
        UserDefaults.standard.set(d, forKey: "thumbVersions")
        for s in ["thumbnail", "preview", "fullsize"] {
            cache.removeObject(forKey: "\(id)-\(s)" as NSString)
            try? FileManager.default.removeItem(at: Self.frameFolder.appendingPathComponent("\(id)-\(s).jpg"))
        }
        NotificationCenter.default.post(name: .thumbChanged, object: id)
    }

    func set(_ k: String, _ img: UIImage) {
        cache.setObject(img, forKey: k as NSString, cost: Int(img.size.width * img.size.height * img.scale * img.scale * 4))
    }

    private func kind(_ size: ImmichClient.Size) -> OfflineStore.Kind? {
        size == .thumbnail ? .thumbnail : size == .preview ? .preview : nil
    }

    /// Speicher → iPhone (Offline-Speicher) → Server; vom Server Geholtes landet auch im Offline-Speicher.
    /// Gleichzeitige Anfragen für dasselbe Bild teilen sich Laden und Entpacken (Kachel + Vorausladen; vorher las
    /// jede das Bild einzeln vom iPhone – Idee aus dem Fork vands2013); bricht der
    /// letzte Wartende ab (Kachel weggescrollt), wird auch der Download abgebrochen – wie Apple: Verbindungen
    /// gehören den Kacheln, die man gleich sieht, nicht denen, an denen man vorbeigewischt ist.
    func load(_ id: String, _ size: ImmichClient.Size) async -> UIImage? {
        let key = "\(id)-\(size.rawValue)"
        if let i = get(key) { return i }
        let entry: (task: Task<UIImage?, Never>, token: UUID) = lock.withLock {
            if let e = inflight[key] { inflight[key]!.waiters += 1; return (e.task, e.token) }
            let token = UUID()
            let t = Task<UIImage?, Never> { [weak self] in
                // nur den eigenen Eintrag entfernen (nach einem Abbruch kann schon ein neuer Download laufen)
                defer { self?.lock.withLock { if self?.inflight[key]?.token == token { self?.inflight.removeValue(forKey: key) } } }
                if id.hasPrefix(LocalPending.prefix) {
                    let img = await LocalPending.image(String(id.dropFirst(LocalPending.prefix.count)), size)
                    if let img { self?.set(key, img) }
                    return img
                }
                if let i = await self?.loadStored(id, size) { return i }
                guard !Task.isCancelled, let self else { return nil }
                if !self.isMissing(id), let url = ImmichClient.shared.thumbnailURL(id, size),
                   let data = try? await ImmichClient.shared.data(url) {
                    if let k = self.kind(size), OfflineSync.enabledFlag { OfflineStore.shared.store(k, id, data) }
                    guard let ready = await Task.detached(priority: .userInitiated, operation: { Self.decode(data) }).value else { return nil }
                    self.set(key, ready)
                    return ready
                }
                guard !Task.isCancelled, size != .fullsize, let frame = await self.videoFrame(id, size) else { return nil }
                self.set(key, frame)
                return frame
            }
            inflight[key] = (t, 1, token)
            return (t, token)
        }
        return await withTaskCancellationHandler {
            await entry.task.value
        } onCancel: { [weak self] in
            self?.lock.withLock {
                guard var e = self?.inflight[key], e.token == entry.token else { return }
                e.waiters -= 1
                if e.waiters <= 0 { e.task.cancel(); self?.inflight.removeValue(forKey: key) } else { self?.inflight[key] = e }
            }
        }
    }
    private var inflight: [String: (task: Task<UIImage?, Never>, waiters: Int, token: UUID)] = [:]

    /// Server hat für ein Video kein Vorschaubild (z. B. scheitert dort die Umwandlung, GitHub-Issue #1):
    /// 1. vom iPhone, wenn das Video auch dort liegt (wie die Immich-App), 2. Standbild selbst aus dem Video holen –
    /// Wiedergabedatei, sonst Original; Bereichsanfragen, nicht das ganze Video – und auf dem iPhone merken.
    /// Höchstens zwei Server-Abrufe gleichzeitig, damit ein Raster voller 4K-Videos die Leitung nicht verstopft.
    private func videoFrame(_ id: String, _ size: ImmichClient.Size) async -> UIImage? {
        guard lock.withLock({ videos.contains(id) }) else { return nil }
        let edge: CGFloat = size == .thumbnail ? 360 : 1440
        if let img = await LocalCopy.image(id, edge: edge) { return img }
        guard lock.withLock({ !noFrame.contains(id) }) else { return nil }
        let file = Self.frameFolder.appendingPathComponent("\(id)-\(size.rawValue).jpg")
        if let d = try? Data(contentsOf: file), let img = UIImage(data: d) { return img }
        await Self.frameGate.enter()
        defer { Task { await Self.frameGate.leave() } }
        var cg: CGImage?, unreadable = true
        for url in [ImmichClient.shared.videoURL(id), ImmichClient.shared.originalURL(id)].compactMap({ $0 }) {
            guard !Task.isCancelled else { return nil }
            let gen = AVAssetImageGenerator(asset: ImmichClient.shared.avAsset(url))
            gen.appliesPreferredTrackTransform = true
            gen.maximumSize = CGSize(width: edge, height: edge)
            gen.requestedTimeToleranceBefore = .zero
            gen.requestedTimeToleranceAfter = CMTime(seconds: 2, preferredTimescale: 600)
            do { cg = try await gen.image(at: CMTime(seconds: 0.5, preferredTimescale: 600)).image; break } catch {
                let ns = error as NSError
                if ns.domain == NSURLErrorDomain || (ns.userInfo[NSUnderlyingErrorKey] as? NSError)?.domain == NSURLErrorDomain {
                    unreadable = false
                }
            }
        }
        guard let cg else {
            // iOS kann das Video nicht lesen → in dieser Sitzung nicht bei jedem Scrollen erneut versuchen
            // (nur bei Formatfehlern, nicht wenn bloß das Netz weg war)
            if !Task.isCancelled, unreadable { _ = lock.withLock { noFrame.insert(id) } }
            return nil
        }
        let img = UIImage(cgImage: cg)
        if let d = img.jpegData(compressionQuality: 0.8) {
            try? FileManager.default.createDirectory(at: Self.frameFolder, withIntermediateDirectories: true)
            try? d.write(to: file, options: .atomic)
        }
        return img
    }
    private static let frameFolder = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("videoframes", isDirectory: true)
    private static let frameGate = FrameGate()

    /// Sofort entpacken (im Hintergrund). `byPreparingForDisplay` greift bei WebP-Vorschauen nicht –
    /// dann dekodierte der Hauptthread beim Anzeigen (Profiler: VP8 auf dem Main-Thread).
    /// (`CGImageSourceCreateImageAtIndex` + ShouldCacheImmediately entpackt WebP trotzdem erst beim Zeichnen –
    /// die Thumbnail-Funktion liefert immer ein fertiges Bitmap, hier in Originalgröße.)
    nonisolated static func decode(_ data: Data) -> UIImage? {
        guard let src = CGImageSourceCreateWithData(data as CFData, nil) else { return UIImage(data: data) }
        let props = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any]
        let w = props?[kCGImagePropertyPixelWidth] as? Int ?? 0, h = props?[kCGImagePropertyPixelHeight] as? Int ?? 0
        let opts: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true,
                                     kCGImageSourceShouldCacheImmediately: true,
                                     kCGImageSourceCreateThumbnailWithTransform: true,
                                     kCGImageSourceThumbnailMaxPixelSize: max(w, h, 1)]
        guard let cg = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary) else { return UIImage(data: data) }
        return UIImage(cgImage: cg)
    }

    /// Nur Speicher und iPhone – nie das Netz (dichte Zoom-Stufen, offline).
    func loadStored(_ id: String, _ size: ImmichClient.Size) async -> UIImage? {
        let key = "\(id)-\(size.rawValue)"
        if let i = get(key) { return i }
        guard let k = kind(size) else { return nil }
        let img = await Task.detached(priority: .userInitiated) { () -> UIImage? in
            guard let d = OfflineStore.shared.data(k, id) else { return nil }
            return ImageCache.decode(d)
        }.value
        if let img { set(key, img) }
        return img
    }

    /// Hintergrund-Füllung des Offline-Speichers: nur laden und ablegen, nicht dekodieren.
    func fetchToStore(_ id: String, _ k: OfflineStore.Kind) async {
        guard !OfflineStore.shared.has(k, id),
              let url = ImmichClient.shared.thumbnailURL(id, k == .thumbnail ? .thumbnail : .preview),
              let data = try? await ImmichClient.shared.data(url) else { return }
        OfflineStore.shared.store(k, id, data)
    }
}

/// Quadratische/gefüllte Kachel für ein Asset.
struct AssetThumb: View {
    let id: String
    var size: ImmichClient.Size = .thumbnail
    @State private var image: UIImage?
    @State private var blur: UIImage?
    @State private var reload = 0

    var body: some View {
        Rectangle()
            .fill(Color.appFill)
            .overlay {
                if let image {
                    Image(uiImage: image).resizable().scaledToFill()
                        .transition(.opacity)
                } else if let blur {
                    Image(uiImage: blur).resizable().interpolation(.medium).scaledToFill()
                }
            }
            .clipped()
            .onReceive(NotificationCenter.default.publisher(for: .thumbChanged)) { n in
                if n.object as? String == id { image = nil; reload += 1 }
            }
            .task(id: "\(id)\(size.rawValue)\(reload)") {
                let cache = ImageCache.shared
                if let cached = cache.get("\(id)-\(size.rawValue)") { image = cached; return }
                if size != .thumbnail { image = await cache.loadStored(id, .thumbnail) }
                if image == nil { blur = cache.placeholder(id) }
                // Noch keine Vorschau auf dem Server → nicht anfragen (außer Videos: Standbild aus dem Video);
                // `.thumbChanged` meldet, wenn sie da ist.
                if !cache.canLoad(id) { return }
                for attempt in 0..<2 {
                    if let img = await cache.load(id, size) {
                        withAnimation(.easeOut(duration: 0.15)) { image = img }
                        return
                    }
                    if attempt == 0 { try? await Task.sleep(for: .seconds(3)) }
                    if Task.isCancelled { return }
                }
            }
    }
}

/// Lädt Vorschaubilder für Kacheln, die gleich ins Bild scrollen (höchstens 6 gleichzeitig, Neueste zuerst).
/// `cancel` nimmt Kacheln wieder heraus, an denen man schon vorbei ist (bricht laufende Downloads ab).
@MainActor
final class ThumbPrefetcher {
    static let shared = ThumbPrefetcher()
    private var queue: [(String, ImmichClient.Size)] = []
    private var running: [String: Task<Void, Never>] = [:]
    func prefetch(_ ids: [String], size: ImmichClient.Size = .thumbnail) {
        let c = ImageCache.shared
        let fresh = ids.filter { c.hash($0) != nil && c.get("\($0)-\(size.rawValue)") == nil && running[$0] == nil }
        guard !fresh.isEmpty else { return }
        let set = Set(fresh)
        queue.removeAll { set.contains($0.0) }
        queue = Array((fresh.map { ($0, size) } + queue).prefix(240))
        pump()
    }
    /// Schwung endet bei `ids`: diese zuerst, alles andere Wartende verwerfen, laufende Fremde abbrechen.
    func focus(on ids: [String], size: ImmichClient.Size) {
        let keep = Set(ids)
        queue.removeAll { !keep.contains($0.0) }
        for (id, t) in running where !keep.contains(id) { t.cancel(); running[id] = nil }
        prefetch(ids, size: size)
    }
    func cancel(_ ids: [String]) {
        let set = Set(ids)
        queue.removeAll { set.contains($0.0) }
        for id in ids { running.removeValue(forKey: id)?.cancel() }
        pump()
    }
    private func pump() {
        while running.count < 6, !queue.isEmpty {
            let (id, size) = queue.removeFirst()
            running[id] = Task {
                _ = await ImageCache.shared.load(id, size)
                running[id] = nil; pump()
            }
        }
    }
}

extension Notification.Name {
    static let thumbChanged = Notification.Name("thumbChanged")
}

/// Zählt gleichzeitige Standbild-Abrufe aus Videos (höchstens zwei).
private actor FrameGate {
    private var free = 2
    private var waiting: [CheckedContinuation<Void, Never>] = []
    func enter() async {
        if free > 0 { free -= 1; return }
        await withCheckedContinuation { waiting.append($0) }
    }
    func leave() {
        if waiting.isEmpty { free += 1 } else { waiting.removeFirst().resume() }
    }
}
