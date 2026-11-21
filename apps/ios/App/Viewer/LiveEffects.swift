import SwiftUI
import AVKit
import CoreImage
import Vision

/// Live-Photo-Effekte wie bei Apple (Live · Endlosschleife · Abpraller · Langzeitbelichtung · Aus).
/// Nur Anzeige in dieser App, das Foto auf dem Server bleibt unverändert; die Wahl wird je Foto gemerkt.
enum LiveMode: String, CaseIterable, Identifiable {
    case live, loop, bounce, longExposure, off
    var id: String { rawValue }
    var title: String {
        switch self {
        case .live: String(localized: "Live"); case .loop: String(localized: "Endlosschleife"); case .bounce: String(localized: "Abpraller")
        case .longExposure: String(localized: "Langzeitbelichtung"); case .off: String(localized: "Aus")
        }
    }
    var icon: String {
        switch self {
        case .live: "livephoto"; case .loop: "repeat"; case .bounce: "arrow.left.arrow.right"
        case .longExposure: "camera.aperture"; case .off: "livephoto.slash"
        }
    }
    private static let key = "liveModes"
    static func get(_ id: String) -> LiveMode {
        (UserDefaults.standard.dictionary(forKey: key) as? [String: String])?[id].flatMap(LiveMode.init) ?? .live
    }
    static func set(_ m: LiveMode, for id: String) {
        var d = (UserDefaults.standard.dictionary(forKey: key) as? [String: String]) ?? [:]
        d[id] = m == .live ? nil : m.rawValue
        UserDefaults.standard.set(d, forKey: key)
    }
}

/// Lädt das kurze Video eines Live Photos einmal auf das iPhone (Abpraller braucht eine lokale Datei zum Rückwärtsspielen).
enum LiveClip {
    static func file(_ videoID: String) async -> URL? {
        let dir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("live")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let f = dir.appendingPathComponent("\(videoID).mov")
        if FileManager.default.fileExists(atPath: f.path) { return f }
        guard let url = ImmichClient.shared.videoURL(videoID), let d = try? await ImmichClient.shared.data(url) else { return nil }
        try? d.write(to: f, options: .atomic)
        return f
    }

    /// Langzeitbelichtung: alle Bilder des Clips gemittelt (fließendes Wasser wird weich, Lichter ziehen Spuren).
    /// Wie Apple werden die Bilder vorher aufeinander ausgerichtet (Vision), sonst verwischt das Verwackeln der Hand alles.
    static func longExposure(_ videoID: String) async -> UIImage? {
        guard let f = await file(videoID) else { return nil }
        return await Task.detached(priority: .userInitiated) { () -> UIImage? in
            let av = AVURLAsset(url: f)
            let gen = AVAssetImageGenerator(asset: av)
            gen.appliesPreferredTrackTransform = true
            gen.maximumSize = CGSize(width: 1440, height: 1440)
            gen.requestedTimeToleranceBefore = .zero; gen.requestedTimeToleranceAfter = .zero
            guard let d = try? await av.load(.duration).seconds, d > 0 else { return nil }
            let n = 30
            let times = (0..<n).map { CMTime(seconds: d * Double($0) / Double(n), preferredTimescale: 600) }
            var sum: CIImage?, count = 0
            var reference: CGImage?
            for await r in gen.images(for: times) {
                guard let cg = try? r.image else { continue }
                var img = CIImage(cgImage: cg)
                if let ref = reference {
                    // Verschiebung dieses Bildes gegenüber dem ersten bestimmen und ausgleichen
                    let req = VNTranslationalImageRegistrationRequest(targetedCGImage: cg)
                    if (try? VNImageRequestHandler(cgImage: ref).perform([req])) != nil,
                       let t = (req.results?.first as? VNImageTranslationAlignmentObservation)?.alignmentTransform {
                        img = img.transformed(by: t).cropped(to: CGRect(x: 0, y: 0, width: ref.width, height: ref.height))
                        img = img.composited(over: CIImage(cgImage: ref))   // Ränder mit dem Bezugsbild füllen
                    }
                } else { reference = cg }
                // laufender Mittelwert: neues Bild mit Gewicht 1/(k+1) über das bisherige legen
                count += 1
                if let s = sum {
                    let a = CGFloat(1) / CGFloat(count)
                    let top = img.applyingFilter("CIColorMatrix", parameters: ["inputAVector": CIVector(x: 0, y: 0, z: 0, w: a)])
                    sum = top.composited(over: s)
                } else { sum = img }
            }
            guard let sum else { return nil }
            let ctx = CIContext()
            guard let cg = ctx.createCGImage(sum, from: sum.extent) else { return nil }
            return UIImage(cgImage: cg)
        }.value
    }
}

/// Spielt das Live-Video ohne Ton in Schleife oder als Abpraller (vor/zurück).
struct LiveEffectPlayer: UIViewRepresentable {
    let videoID: String
    let bounce: Bool
    func makeCoordinator() -> Coord { Coord() }
    func makeUIView(context: Context) -> PlayerSurface.PlayerLayerView {
        let v = PlayerSurface.PlayerLayerView()
        v.playerLayer.videoGravity = .resizeAspect
        context.coordinator.start(videoID, bounce: bounce, in: v)
        return v
    }
    func updateUIView(_ uiView: PlayerSurface.PlayerLayerView, context: Context) {}
    static func dismantleUIView(_ uiView: PlayerSurface.PlayerLayerView, coordinator: Coord) { coordinator.stop() }

    @MainActor final class Coord {
        private var player: AVQueuePlayer?
        private var looper: AVPlayerLooper?
        private var obs: NSObjectProtocol?
        private var task: Task<Void, Never>?
        func start(_ id: String, bounce: Bool, in v: PlayerSurface.PlayerLayerView) {
            task = Task { [weak self, weak v] in
                guard let f = await LiveClip.file(id), let self, let v else { return }
                let item = AVPlayerItem(url: f)
                let p = AVQueuePlayer(); p.isMuted = true
                if bounce {
                    p.insert(item, after: nil)
                    p.actionAtItemEnd = .pause
                    // am Ende rückwärts, am Anfang wieder vorwärts
                    self.obs = NotificationCenter.default.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main) { [weak p] _ in
                        MainActor.assumeIsolated { if item.canPlayReverse { p?.rate = -1 } else { p?.seek(to: .zero); p?.play() } }
                    }
                    Task { @MainActor [weak p] in
                        while let p, !Task.isCancelled {
                            try? await Task.sleep(for: .milliseconds(100))
                            if p.rate < 0, p.currentTime().seconds <= 0.05 { p.rate = 1 }
                        }
                    }
                } else {
                    self.looper = AVPlayerLooper(player: p, templateItem: item)
                }
                v.playerLayer.player = p
                self.player = p
                p.play()
            }
        }
        func stop() {
            task?.cancel(); player?.pause(); player = nil; looper = nil
            if let obs { NotificationCenter.default.removeObserver(obs) }
        }
    }
}
