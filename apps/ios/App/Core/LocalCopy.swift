import Photos
import AVFoundation
import UIKit

/// Liegt ein Server-Objekt auch auf diesem iPhone (Fotos-Mediathek), nimmt HomeRoll von dort Video und Vorschau –
/// wie die Immich-App und Apple: sofort da, auch wenn der Server Vorschau oder Umwandlung nicht hinbekommt
/// (GitHub-Issue #1). Nur mit schon erteiltem Fotozugriff (fürs Backup); fragt nie selbst danach und lädt nichts
/// aus iCloud nach (nur, was wirklich auf dem iPhone liegt).
enum LocalCopy {
    /// Für die Video-Diagnose
    static var accessText: String {
        switch PHPhotoLibrary.authorizationStatus(for: .readWrite) {
        case .authorized: "full"; case .limited: "limited"; case .denied: "denied"; case .restricted: "restricted"
        case .notDetermined: "not asked"; @unknown default: "unknown"
        }
    }
    static var allowed: Bool {
        let s = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        return s == .authorized || s == .limited
    }

    /// Passendes iPhone-Objekt: zuerst aus dem eigenen Backup (genau), sonst über Aufnahmezeit, Dateiname und Länge
    /// (Uploads aus der Immich-App – deren Kennung liefert der Server seit v3 nicht mehr aus).
    static func asset(_ id: String) async -> PHAsset? {
        guard allowed else { return nil }
        if id.hasPrefix(LocalPending.prefix) { return fetch(String(id.dropFirst(LocalPending.prefix.count))) }
        if let hit = await known.get(id) { return hit.flatMap(fetch) }
        if let lid = await MainActor.run(body: { BackupEngine.shared.localID(forRemote: id) }), let a = fetch(lid) {
            await known.set(id, lid)
            return a
        }
        guard let dto = try? await ImmichClient.shared.asset(id) else { return nil }   // Netz weg: später erneut
        let a = match(dto)
        await known.set(id, a?.localIdentifier)
        return a
    }

    /// Video vom iPhone (Original wie auf dem Server – Zeitlupe verlangsamt die Einzelansicht selbst).
    static func video(_ id: String) async -> AVURLAsset? {
        guard let a = await asset(id), a.mediaType == .video else { return nil }
        let o = PHVideoRequestOptions()
        o.version = .original
        o.deliveryMode = .highQualityFormat
        o.isNetworkAccessAllowed = false
        // Original = Datei (AVURLAsset); AVAsset selbst ist nicht Sendable
        final class Box: @unchecked Sendable { let av: AVURLAsset?; init(_ av: AVAsset?) { self.av = av as? AVURLAsset } }
        let box: Box = await withCheckedContinuation { c in
            PHImageManager.default().requestAVAsset(forVideo: a, options: o) { av, _, _ in c.resume(returning: Box(av)) }
        }
        return box.av
    }

    /// Vorschaubild vom iPhone (Kantenlänge in Pixeln).
    static func image(_ id: String, edge: CGFloat) async -> UIImage? {
        guard let a = await asset(id) else { return nil }
        let o = PHImageRequestOptions()
        o.deliveryMode = .highQualityFormat
        o.resizeMode = .fast
        o.isNetworkAccessAllowed = false
        return await withCheckedContinuation { c in
            PHImageManager.default().requestImage(for: a, targetSize: CGSize(width: edge, height: edge),
                                                  contentMode: .aspectFill, options: o) { img, _ in c.resume(returning: img) }
        }
    }

    private static func fetch(_ lid: String) -> PHAsset? {
        PHAsset.fetchAssets(withLocalIdentifiers: [lid], options: nil).firstObject
    }

    private static func match(_ dto: AssetDTO) -> PHAsset? {
        guard let name = dto.originalFileName?.lowercased(), let t = DateParsing.wallClock(dto.fileCreatedAt) else { return nil }
        let video = dto.type == "VIDEO"
        let o = PHFetchOptions()
        o.predicate = NSPredicate(format: "creationDate >= %@ AND creationDate <= %@ AND mediaType == %d",
                                  t.addingTimeInterval(-5) as NSDate, t.addingTimeInterval(5) as NSDate,
                                  (video ? PHAssetMediaType.video : .image).rawValue)
        var found: PHAsset?
        PHAsset.fetchAssets(with: o).enumerateObjects { a, _, stop in
            if video, let ms = dto.duration, abs(a.duration - Double(ms) / 1000) > 1 { return }
            guard PHAssetResource.assetResources(for: a).contains(where: { $0.originalFilename.lowercased() == name }) else { return }
            found = a; stop.pointee = true
        }
        return found
    }

    /// Gemerkte Zuordnungen (auch „liegt nicht auf dem iPhone“), bis zum Abmelden.
    private static let known = Known()
    static func reset() { Task { await known.clear() } }
    private actor Known {
        private var map: [String: String?] = [:]
        func get(_ id: String) -> String?? { map[id] }
        func set(_ id: String, _ lid: String?) { map[id] = .some(lid) }
        func clear() { map = [:] }
    }
}
