import UIKit
import ImageIO
import AVFoundation
import UniformTypeIdentifiers

/// Teilen-Optionen wie in Fotos (gemerkt fürs nächste Teilen): Ort, Bildunterschriften, Format, unbearbeitetes Original.
struct ShareOptions: Codable, Equatable {
    var location = true
    var captions = true
    /// „Kompatibelstes“: Fotos als JPEG, Videos als H.264 statt HEIC/HEVC
    var compatible = false
    var unedited = false

    static var saved: ShareOptions {
        get { UserDefaults.standard.data(forKey: "shareOptions").flatMap { try? JSONDecoder().decode(ShareOptions.self, from: $0) } ?? ShareOptions() }
        set { UserDefaults.standard.set(try? JSONEncoder().encode(newValue), forKey: "shareOptions") }
    }
    var needsProcessing: Bool { !location || !captions || compatible }
}

/// Teilen wie in Fotos: lädt die Originale (inkl. Bearbeitung) als Dateien und öffnet das System-Teilen-Fenster.
/// Ein reiner Link ginge nicht – der Server verlangt Anmeldung.
@MainActor
enum ShareService {
    static func share(_ ids: [String], app: AppModel) async {
        guard !ids.isEmpty else { return }
        let api = ImmichClient.shared
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("teilen", isDirectory: true)
        try? FileManager.default.removeItem(at: dir)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        var files: [URL] = []
        for (n, id) in ids.enumerated() {
            app.busy = ids.count > 1 ? String(localized: "Wird vorbereitet … \(n + 1) von \(ids.count)") : String(localized: "Wird vorbereitet …")
            let o = ShareOptions.saved
            guard let url = api.originalURL(id, edited: !o.unedited), let data = try? await api.data(url) else { continue }
            let name = safeFilename((try? await api.asset(id))?.originalFileName ?? "", fallback: "\(id).jpg")
            var file = dir.appendingPathComponent(name)
            if FileManager.default.fileExists(atPath: file.path) { file = dir.appendingPathComponent("\(n)-\(name)") }
            guard (try? data.write(to: file)) != nil else { continue }
            if o.needsProcessing, let done = await prepare(file, o) { file = done }
            files.append(file)
            RecentStore.add(id, to: .recentlyShared)
        }
        app.busy = nil
        present(files)
    }

    /// Datei nach den Optionen umschreiben: Ort/Bildunterschrift entfernen, Fotos als JPEG, Videos als H.264 (MP4).
    static func prepare(_ file: URL, _ o: ShareOptions) async -> URL? {
        let type = UTType(filenameExtension: file.pathExtension.lowercased())
        if type?.conforms(to: .movie) == true || type?.conforms(to: .video) == true {
            return await prepareVideo(file, o)
        }
        guard let src = CGImageSourceCreateWithURL(file as CFURL, nil), let srcType = CGImageSourceGetType(src) else { return nil }
        var props = (CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any]) ?? [:]
        if !o.location { props[kCGImagePropertyGPSDictionary] = nil }
        if !o.captions {
            if var t = props[kCGImagePropertyTIFFDictionary] as? [CFString: Any] { t[kCGImagePropertyTIFFImageDescription] = nil; props[kCGImagePropertyTIFFDictionary] = t }
            if var i = props[kCGImagePropertyIPTCDictionary] as? [CFString: Any] { i[kCGImagePropertyIPTCCaptionAbstract] = nil; props[kCGImagePropertyIPTCDictionary] = i }
            if var e = props[kCGImagePropertyExifDictionary] as? [CFString: Any] { e[kCGImagePropertyExifUserComment] = nil; props[kCGImagePropertyExifDictionary] = e }
        }
        let outType = o.compatible ? UTType.jpeg.identifier as CFString : srcType
        let ext = o.compatible ? "jpg" : file.pathExtension
        let out = file.deletingPathExtension().appendingPathExtension("geteilt").appendingPathExtension(ext)
        guard let dst = CGImageDestinationCreateWithURL(out as CFURL, outType, 1, nil),
              let img = CGImageSourceCreateImageAtIndex(src, 0, nil) else { return nil }
        props[kCGImageDestinationLossyCompressionQuality] = 0.92
        CGImageDestinationAddImage(dst, img, props as CFDictionary)
        // XMP wird nicht übernommen – so rutscht kein Ort über den Metadaten-Baum mit
        guard CGImageDestinationFinalize(dst) else { return nil }
        try? FileManager.default.removeItem(at: file)
        return out
    }

    private static func prepareVideo(_ file: URL, _ o: ShareOptions) async -> URL? {
        let asset = AVURLAsset(url: file)
        let preset = o.compatible ? AVAssetExportPresetHighestQuality : AVAssetExportPresetPassthrough   // HighestQuality = H.264
        guard let ex = AVAssetExportSession(asset: asset, presetName: preset) else { return nil }
        let out = file.deletingPathExtension().appendingPathExtension("geteilt").appendingPathExtension(o.compatible ? "mp4" : file.pathExtension)
        var meta = (try? await asset.load(.metadata)) ?? []
        if !o.location {
            meta = meta.filter { $0.commonKey != .commonKeyLocation && $0.identifier != .quickTimeMetadataLocationISO6709 && $0.identifier != .commonIdentifierLocation }
        }
        if !o.captions { meta = meta.filter { $0.commonKey != .commonKeyDescription } }
        ex.metadata = meta
        do { try await ex.export(to: out, as: o.compatible ? .mp4 : (UTType(filenameExtension: file.pathExtension).flatMap { AVFileType(rawValue: $0.identifier) } ?? .mov)) }
        catch { return nil }
        try? FileManager.default.removeItem(at: file)
        return out
    }

    /// Teilen-Fenster für fertige Dateien (z. B. Rückblick-Video).
    static func present(_ files: [URL]) {
        guard !files.isEmpty, let top = topController() else { return }
        let vc = UIActivityViewController(activityItems: files, applicationActivities: nil)
        vc.popoverPresentationController?.sourceView = top.view
        top.present(vc, animated: true)
    }

    private static func topController() -> UIViewController? {
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        var c = scene?.windows.first(where: \.isKeyWindow)?.rootViewController
        while let p = c?.presentedViewController { c = p }
        return c
    }
}
