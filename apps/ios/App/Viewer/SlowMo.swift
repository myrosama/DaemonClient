import AVFoundation

/// Slo-Mo wie Apple: iPhone-Zeitlupen liegen als 120/240-fps-Video vor und laufen ohne Bearbeitung im Zeitraffer.
/// Apple spielt einen Bereich (Standard: Mitte) verlangsamt ab, Anfang und Ende in normaler Geschwindigkeit.
/// Hier dasselbe über eine Komposition: Bereich per scaleTimeRange gedehnt (240 fps → 1/8, 120 fps → 1/4).
struct SlowMo: Equatable {
    /// Zeitlupen-Bereich in Sekunden des Originals
    var range: ClosedRange<Double>
    /// Dehnung (8 = achtfach langsamer)
    let factor: Double

    /// Ab 100 fps gilt ein Video als Zeitlupe (Wiedergabe mit 30 fps wie Apple).
    static func factor(fps: Float) -> Double? { fps >= 100 ? Double(min(8, max(2, (fps / 30).rounded()))) : nil }

    /// Apple lässt am Anfang und Ende ein kurzes Stück normal laufen.
    static func defaultRange(_ duration: Double) -> ClosedRange<Double> {
        let lead = min(0.6, duration * 0.12)
        return lead...max(lead, duration - lead)
    }

    /// Zeitlupe für ein Video erkennen (lädt nur die Spur-Infos, nicht das Video).
    static func detect(_ asset: AVAsset) async -> SlowMo? {
        guard let track = try? await asset.loadTracks(withMediaType: .video).first,
              let fps = try? await track.load(.nominalFrameRate), let k = factor(fps: fps),
              let d = try? await asset.load(.duration).seconds, d.isFinite, d > 0.5 else { return nil }
        return SlowMo(range: defaultRange(d), factor: k)
    }

    // Umrechnung Original-Zeit ↔ Wiedergabe-Zeit (ab Ausschnittsanfang `start`)
    func play(_ t: Double, start: Double = 0) -> Double {
        let a = max(range.lowerBound, start), b = max(a, range.upperBound)
        if t <= a { return t - start }
        if t <= b { return a - start + (t - a) * factor }
        return a - start + (b - a) * factor + (t - b)
    }
    func source(_ p: Double, start: Double = 0) -> Double {
        let a = max(range.lowerBound, start), b = max(a, range.upperBound)
        let pa = a - start, pb = pa + (b - a) * factor
        if p <= pa { return p + start }
        if p <= pb { return a + (p - pa) / factor }
        return b + (p - pb)
    }

    /// Komposition: Ausschnitt `trim` (Original-Sekunden) mit gedehntem Zeitlupen-Bereich.
    func composition(_ asset: AVAsset, trim: ClosedRange<Double>? = nil, audio: Bool = true) async throws -> AVMutableComposition {
        let d = try await asset.load(.duration).seconds
        let cut = trim ?? 0...d
        let comp = AVMutableComposition()
        let src = CMTimeRange(start: CMTime(seconds: cut.lowerBound, preferredTimescale: 600),
                              end: CMTime(seconds: cut.upperBound, preferredTimescale: 600))
        for track in try await asset.loadTracks(withMediaType: .video) {
            let t = comp.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid)
            try t?.insertTimeRange(src, of: track, at: .zero)
            t?.preferredTransform = try await track.load(.preferredTransform)
        }
        if audio {
            // Nur die eingeschaltete Tonspur: iPhone 16+ legt zusätzlich räumlichen Ton (APAC, 4 Kanäle) als
            // ausgeschaltete Zweitspur ab – mit in der Komposition blieb das Bild schwarz (GitHub-Issue #1)
            var tracks: [AVAssetTrack] = []
            for track in try await asset.loadTracks(withMediaType: .audio) where (try? await track.load(.isEnabled)) != false {
                if (try? await track.load(.isPlayable)) != false { tracks.append(track) }
            }
            for track in tracks.prefix(1) {
                let t = comp.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid)
                try t?.insertTimeRange(src, of: track, at: .zero)
            }
        }
        let a = max(range.lowerBound, cut.lowerBound), b = min(range.upperBound, cut.upperBound)
        if b - a > 0.05 {
            let r = CMTimeRange(start: CMTime(seconds: a - cut.lowerBound, preferredTimescale: 600),
                                duration: CMTime(seconds: b - a, preferredTimescale: 600))
            comp.scaleTimeRange(r, toDuration: CMTime(seconds: (b - a) * factor, preferredTimescale: 600))
        }
        return comp
    }

    /// Abspiel-Element: Ton verlangsamt mit tieferer Stimme wie bei Apple (varispeed statt Tonhöhe halten).
    @MainActor static func item(_ comp: AVComposition) -> AVPlayerItem {
        let item = AVPlayerItem(asset: comp)
        item.audioTimePitchAlgorithm = .varispeed
        return item
    }
}
