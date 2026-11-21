import UIKit
import Photos

extension Asset {
    /// Liegt (noch) nur auf diesem iPhone – Kennung „local:<PhotoKit-ID>“, wird nach dem Sichern durch das Server-Objekt ersetzt
    var isLocalOnly: Bool { id.hasPrefix(LocalPending.prefix) }
    var localIdentifier: String? { isLocalOnly ? String(id.dropFirst(LocalPending.prefix.count)) : nil }
}

/// Neue Fotos und Bildschirmfotos bemerken, solange die App offen ist (Fotos-Änderungsmeldung) – dann gleich sichern
/// und in der Mediathek zeigen. Die Immich-App macht das nur beim Öffnen; ein Beobachter weckt keine eingefrorene App.
final class LibraryWatcher: NSObject, PHPhotoLibraryChangeObserver, @unchecked Sendable {
    static let shared = LibraryWatcher()
    private var registered = false
    private var pending: Task<Void, Never>?

    /// Nur mit Fotozugriff anmelden – sonst würde iOS hier nach der Freigabe fragen
    @MainActor func start() {
        let s = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        guard !registered, s == .authorized || s == .limited else { return }
        registered = true
        PHPhotoLibrary.shared().register(self)
    }

    func photoLibraryDidChange(_ changeInstance: PHChange) {
        Task { @MainActor in
            // mehrere Meldungen kurz hintereinander (Serienbild, Live Photo) zusammenfassen
            pending?.cancel()
            pending = Task { @MainActor in
                try? await Task.sleep(for: .seconds(2))
                guard !Task.isCancelled, UIApplication.shared.applicationState == .active else { return }
                LocalPending.shared.refresh()
                BackupEngine.shared.libraryChanged()
            }
        }
    }
}

/// Fotos der letzten Wochen, die noch nicht auf dem Server sind – erscheinen wie in der Immich-App sofort in der
/// Mediathek (Bild direkt vom iPhone) mit durchgestrichener Wolke bzw. Fortschrittsring beim Hochladen.
@MainActor @Observable
final class LocalPending {
    static let shared = LocalPending()
    nonisolated static let prefix = "local:"
    enum Badge: Equatable { case waiting, uploading(Double), processing }

    @ObservationIgnored weak var timeline: TimelineStore?
    /// Zustand je Kachel-Kennung
    private(set) var badges: [String: Badge] = [:]
    @ObservationIgnored private var task: Task<Void, Never>?
    @ObservationIgnored private var reloadTask: Task<Void, Never>?
    /// Nur neuere Fotos zeigen: ältere liegen nach einem eigenen Import oft schon auf dem Server, ohne dass dieses
    /// iPhone sie kennt (keine Prüfsumme ohne Hochladen) – sonst stünden Tausende doppelt in der Mediathek.
    private let window: TimeInterval = 30 * 86400

    func refresh() {
        task?.cancel()
        task = Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(300))
            guard !Task.isCancelled else { return }
            apply(collect())
        }
    }

    private func collect() -> [(Asset, Badge)] {
        let engine = BackupEngine.shared
        let s = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        guard engine.enabled, !engine.needsConsent, s == .authorized || s == .limited, let timeline,
              !timeline.account.isEmpty else { return [] }
        engine.useAccount(timeline.account)
        var since = Date().addingTimeInterval(-window)
        if !engine.fullLibrary, let c = engine.importCutoff, c > since { since = c }
        let o = PHFetchOptions()
        o.predicate = NSPredicate(format: "creationDate >= %@ AND (mediaType == %d OR mediaType == %d)", since as NSDate,
                                  PHAssetMediaType.image.rawValue, PHAssetMediaType.video.rawValue)
        o.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: true)]
        var out: [(Asset, Badge)] = []
        PHAsset.fetchAssets(with: o).enumerateObjects { a, _, _ in
            let lid = a.localIdentifier
            let remote = engine.remoteID(forLocal: lid)
            // schon gesichert und in der Zeitleiste → das Server-Objekt zeigt es. Bei Bearbeiteten zeigt die Zeitleiste
            // nur die Fassung oben auf dem Stapel, das Original selbst nie → auch nach der bearbeiteten Fassung schauen.
            if let remote, timeline.asset(remote) != nil { return }
            if let edited = engine.editedID(forLocal: lid), timeline.asset(edited) != nil { return }
            let badge: Badge = engine.uploading[lid].map { .uploading($0) } ?? (remote != nil ? .processing : .waiting)
            let created = a.creationDate ?? Date()
            let wall = created.addingTimeInterval(TimeInterval(TimeZone.current.secondsFromGMT(for: created)))
            let ratio = a.pixelHeight > 0 ? Double(a.pixelWidth) / Double(a.pixelHeight) : 1
            out.append((Asset(id: Self.prefix + lid, isImage: a.mediaType == .image, isFavorite: a.isFavorite, date: wall, ratio: ratio,
                              durationMs: a.mediaType == .video ? Int(a.duration * 1000) : nil, livePhotoVideoId: nil,
                              city: nil, country: nil), badge))
        }
        return out
    }

    private func apply(_ items: [(Asset, Badge)]) {
        let b = Dictionary(items.map { ($0.0.id, $0.1) }, uniquingKeysWith: { a, _ in a })
        if b != badges { badges = b; NotificationCenter.default.post(name: .localBadgesChanged, object: nil) }
        timeline?.setLocal(items.map(\.0))
        // Hochgeladen, aber noch nicht in der Zeitleiste → kurz danach die neuesten Monate frisch holen
        if b.values.contains(.processing) { reloadSoon() }
    }

    /// Nach einem Upload: der Server braucht ein paar Sekunden (Vorschau, Metadaten) → dann neueste Monate nachladen.
    func reloadSoon() {
        guard reloadTask == nil else { return }
        reloadTask = Task { @MainActor in
            try? await Task.sleep(for: .seconds(6))
            reloadTask = nil
            await timeline?.reload()
            refresh()
        }
    }

    /// Fortschritt während des Hochladens nur am Ring ändern, ohne die Mediathek neu zu bündeln
    func progressChanged(_ lid: String) {
        guard let p = BackupEngine.shared.uploading[lid] else { return }
        let id = Self.prefix + lid
        if badges[id] != nil {
            badges[id] = .uploading(p)
            NotificationCenter.default.post(name: .localBadgesChanged, object: nil)
        }
    }

    /// Vorschau direkt aus der Fotos-Mediathek
    nonisolated static func image(_ lid: String, _ size: ImmichClient.Size) async -> UIImage? {
        guard let a = PHAsset.fetchAssets(withLocalIdentifiers: [lid], options: nil).firstObject else { return nil }
        let px: CGSize = switch size {
        case .thumbnail: CGSize(width: 360, height: 360)
        case .preview: CGSize(width: 1440, height: 1440)
        default: PHImageManagerMaximumSize
        }
        let o = PHImageRequestOptions()
        o.deliveryMode = .highQualityFormat
        o.isNetworkAccessAllowed = true
        o.resizeMode = .fast
        return await withCheckedContinuation { c in
            PHImageManager.default().requestImage(for: a, targetSize: px, contentMode: .aspectFill, options: o) { img, _ in
                c.resume(returning: img)
            }
        }
    }
}

extension Notification.Name { static let localBadgesChanged = Notification.Name("localBadgesChanged") }
