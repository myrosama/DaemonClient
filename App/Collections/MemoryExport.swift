import AVFoundation
import CoreImage
import UIKit

/// Rückblick als Video sichern/teilen wie bei Apple: Titelbild, langsamer Zoom/Schwenk, Überblenden,
/// gewählter Stil und Musik – gerendert auf dem iPhone (1080 × 1920, 30 Bilder/s, H.264 + AAC).
@MainActor
enum MemoryExport {
    nonisolated static let size = CGSize(width: 1080, height: 1920)
    nonisolated static let fps: Int32 = 30
    nonisolated static let perPhoto = 3.2, titleTime = 3.0, fade = 0.9

    static func share(_ memory: Memory, slides: [Asset], title: String, style: MemoryStyle, mood: MemoryMood, app: AppModel) async {
        app.busy = String(localized: "Video wird erstellt …")
        defer { app.busy = nil }
        guard let url = await render(memory, slides: slides, title: title, style: style, mood: mood, progress: { p in
            app.busy = String(localized: "Video wird erstellt … \(Int(p * 100)) %")
        }) else { app.toast(String(localized: "Video konnte nicht erstellt werden")); return }
        ShareService.present([url])
    }

    static func render(_ memory: Memory, slides: [Asset], title: String, style: MemoryStyle, mood: MemoryMood,
                       progress: @escaping @MainActor @Sendable (Double) -> Void) async -> URL? {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("rueckblick", isDirectory: true)
        try? FileManager.default.removeItem(at: dir)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let safe = title.components(separatedBy: CharacterSet(charactersIn: "/:\\?%*|\"<>")).joined()
        let videoOnly = dir.appendingPathComponent("bild.mp4"), audio = dir.appendingPathComponent("ton.m4a")
        let out = dir.appendingPathComponent("\(safe.isEmpty ? "Rückblick" : safe).mp4")

        // Bilder laden (große Vorschau reicht für 1080p)
        var images: [CIImage] = []
        for (i, a) in slides.enumerated() {
            progress(Double(i) / Double(slides.count) * 0.15)
            if let img = await ImageCache.shared.load(a.id, .preview), let ci = CIImage(image: img) { images.append(ci) }
        }
        guard !images.isEmpty else { return nil }
        let keyImage = await ImageCache.shared.load(memory.key.id, .preview).flatMap { CIImage(image: $0) } ?? images[0]
        let titleCard = titleOverlay(title, memory.subtitle)
        let duration = titleTime + Double(images.count) * perPhoto + fade

        let ok = await Task.detached(priority: .userInitiated) {
            await writeVideo(to: videoOnly, images: images, key: keyImage, titleCard: titleCard, style: style,
                             duration: duration) { p in Task { @MainActor in progress(0.15 + p * 0.75) } }
        }.value
        guard ok else { return nil }
        progress(0.92)
        var withMusic = false
        if mood != .none { withMusic = await Task.detached { writeAudio(to: audio, mood: mood, duration: duration) }.value }
        guard withMusic else { try? FileManager.default.moveItem(at: videoOnly, to: out); return out }
        let merged = await merge(video: videoOnly, audio: audio, to: out)
        progress(1)
        return merged ? out : nil
    }

    // MARK: Bild

    private nonisolated static func writeVideo(to url: URL, images: [CIImage], key: CIImage, titleCard: CIImage?, style: MemoryStyle,
                                               duration: Double, progress: @escaping @Sendable (Double) -> Void) async -> Bool {
        guard let w = try? AVAssetWriter(outputURL: url, fileType: .mp4) else { return false }
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: Int(size.width), AVVideoHeightKey: Int(size.height),
            AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: 8_000_000, AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel]])
        input.expectsMediaDataInRealTime = false
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferWidthKey as String: Int(size.width), kCVPixelBufferHeightKey as String: Int(size.height)])
        w.add(input)
        guard w.startWriting() else { return false }
        w.startSession(atSourceTime: .zero)
        let ctx = CIContext(options: [.cacheIntermediates: false])
        let frames = Int(duration * Double(fps))
        let black = CIImage(color: .black).cropped(to: CGRect(origin: .zero, size: size))
        for f in 0..<frames {
            while !input.isReadyForMoreMediaData { try? await Task.sleep(for: .milliseconds(5)) }
            let t = Double(f) / Double(fps)
            var frame = black
            if t < titleTime + fade {
                // Titelbild: Schlüsselfoto mit Verlauf und Titel
                var title = kenBurns(key, seed: 99, progress: t / (titleTime + fade))
                if let titleCard { title = titleCard.composited(over: title) }
                frame = alpha(title, t < titleTime ? 1 : 1 - (t - titleTime) / fade).composited(over: frame)
            }
            let s = t - titleTime
            if s > 0 {
                let i = Int(s / perPhoto)
                for k in [i - 1, i] where k >= 0 && k < images.count {
                    let local = s - Double(k) * perPhoto           // Zeit seit Beginn dieses Fotos
                    guard local >= 0, local < perPhoto + fade else { continue }
                    let a = local < fade ? local / fade : (local > perPhoto ? 1 - (local - perPhoto) / fade : 1)
                    let img = kenBurns(images[k], seed: k, progress: local / (perPhoto + fade))
                    frame = alpha(img, a).composited(over: frame)
                }
            }
            frame = styled(frame, style).cropped(to: CGRect(origin: .zero, size: size))
            guard let pool = adaptor.pixelBufferPool else { return false }
            var pb: CVPixelBuffer?
            CVPixelBufferPoolCreatePixelBuffer(nil, pool, &pb)
            guard let pb else { return false }
            ctx.render(frame, to: pb)
            adaptor.append(pb, withPresentationTime: CMTime(value: CMTimeValue(f), timescale: fps))
            if f % 15 == 0 { progress(Double(f) / Double(frames)) }
        }
        input.markAsFinished()
        await w.finishWriting()
        return w.status == .completed
    }

    /// Bild füllend zuschneiden, langsam zoomen und schwenken (Richtung je Foto verschieden).
    private nonisolated static func kenBurns(_ img: CIImage, seed: Int, progress p: Double) -> CIImage {
        let e = img.extent
        let fill = max(size.width / e.width, size.height / e.height)
        let zoomIn = seed % 2 == 0
        let z = zoomIn ? 1.04 + 0.12 * p : 1.16 - 0.12 * p
        let dirs: [CGPoint] = [.init(x: -1, y: 1), .init(x: 1, y: -1), .init(x: -1, y: -1), .init(x: 1, y: 1)]
        let d = dirs[abs(seed) % dirs.count]
        let sc = fill * z
        let w = e.width * sc, h = e.height * sc
        let tx = (size.width - w) / 2 + d.x * 40 * p, ty = (size.height - h) / 2 + d.y * 24 * p
        return img.transformed(by: CGAffineTransform(translationX: -e.minX, y: -e.minY).scaledBy(x: sc, y: sc))
            .transformed(by: CGAffineTransform(translationX: tx, y: ty))
    }

    private nonisolated static func alpha(_ img: CIImage, _ a: Double) -> CIImage {
        guard a < 1 else { return img }
        return img.applyingFilter("CIColorMatrix", parameters: ["inputAVector": CIVector(x: 0, y: 0, z: 0, w: max(0, a))])
    }

    /// Dieselben Stile wie im Player (MemoryStyle), hier als Core-Image-Filter.
    private nonisolated static func styled(_ img: CIImage, _ s: MemoryStyle) -> CIImage {
        switch s {
        case .natural: return img
        case .warm: return img.applyingFilter("CIColorControls", parameters: [kCIInputSaturationKey: 1.08])
            .applyingFilter("CIColorMatrix", parameters: ["inputRVector": CIVector(x: 1, y: 0, z: 0, w: 0), "inputGVector": CIVector(x: 0, y: 0.93, z: 0, w: 0),
                                                           "inputBVector": CIVector(x: 0, y: 0, z: 0.84, w: 0)])
        case .cool: return img.applyingFilter("CIColorControls", parameters: [kCIInputSaturationKey: 0.95])
            .applyingFilter("CIColorMatrix", parameters: ["inputRVector": CIVector(x: 0.86, y: 0, z: 0, w: 0), "inputGVector": CIVector(x: 0, y: 0.94, z: 0, w: 0),
                                                           "inputBVector": CIVector(x: 0, y: 0, z: 1, w: 0)])
        case .vivid: return img.applyingFilter("CIColorControls", parameters: [kCIInputSaturationKey: 1.35, kCIInputContrastKey: 1.06])
        case .contrast: return img.applyingFilter("CIColorControls", parameters: [kCIInputSaturationKey: 0.9, kCIInputContrastKey: 1.3])
        case .mono: return img.applyingFilter("CIColorControls", parameters: [kCIInputSaturationKey: 0, kCIInputContrastKey: 1.15])
        }
    }

    /// Titel unten links mit dunklem Verlauf (wie das Titelbild im Player).
    private static func titleOverlay(_ title: String, _ subtitle: String) -> CIImage? {
        let r = UIGraphicsImageRenderer(size: size, format: { let f = UIGraphicsImageRendererFormat(); f.scale = 1; return f }())
        let img = r.image { c in
            let g = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(),
                               colors: [UIColor.clear.cgColor, UIColor.black.withAlphaComponent(0.65).cgColor] as CFArray, locations: [0, 1])!
            c.cgContext.drawLinearGradient(g, start: CGPoint(x: 0, y: size.height * 0.5), end: CGPoint(x: 0, y: size.height), options: [])
            let shadow = NSShadow(); shadow.shadowBlurRadius = 18; shadow.shadowColor = UIColor.black.withAlphaComponent(0.5)
            let t = NSAttributedString(string: title, attributes: [.font: UIFont.systemFont(ofSize: 92, weight: .bold),
                                                                  .foregroundColor: UIColor.white, .shadow: shadow])
            let st = NSAttributedString(string: subtitle, attributes: [.font: UIFont.systemFont(ofSize: 36, weight: .semibold),
                                                                      .foregroundColor: UIColor.white.withAlphaComponent(0.85), .shadow: shadow])
            let box = CGRect(x: 70, y: 0, width: size.width - 140, height: 600)
            let th = t.boundingRect(with: box.size, options: [.usesLineFragmentOrigin], context: nil).height
            t.draw(with: CGRect(x: 70, y: size.height - 260 - th, width: box.width, height: th), options: [.usesLineFragmentOrigin], context: nil)
            st.draw(at: CGPoint(x: 70, y: size.height - 230))
        }
        return CIImage(image: img)
    }

    // MARK: Ton

    /// Dieselbe selbst erzeugte Musik wie im Player, offline in eine AAC-Datei (am Ende ausblenden).
    private nonisolated static func writeAudio(to url: URL, mood: MemoryMood, duration: Double) -> Bool {
        let sr = 44100.0
        let synth = Synth(); synth.configure(mood, sampleRate: sr)
        guard let fmt = AVAudioFormat(standardFormatWithSampleRate: sr, channels: 2),
              let file = try? AVAudioFile(forWriting: url, settings: [AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: sr,
                                                                      AVNumberOfChannelsKey: 2, AVEncoderBitRateKey: 160_000],
                                          commonFormat: .pcmFormatFloat32, interleaved: false) else { return false }
        let total = Int(duration * sr), chunk = 4096
        var done = 0
        while done < total {
            let n = min(chunk, total - done)
            guard let buf = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: AVAudioFrameCount(n)) else { return false }
            buf.frameLength = AVAudioFrameCount(n)
            synth.render(n, UnsafeMutableAudioBufferListPointer(buf.mutableAudioBufferList))
            // letzte 2 s ausblenden
            let fadeStart = total - Int(2 * sr)
            if done + n > fadeStart, let ch = buf.floatChannelData {
                for i in 0..<n {
                    let g = Float(max(0, min(1, Double(total - (done + i)) / (2 * sr))))
                    for c in 0..<2 { ch[c][i] *= g }
                }
            }
            do { try file.write(from: buf) } catch { return false }
            done += n
        }
        return true
    }

    private static func merge(video: URL, audio: URL, to out: URL) async -> Bool {
        let comp = AVMutableComposition()
        let v = AVURLAsset(url: video), a = AVURLAsset(url: audio)
        guard let vt = try? await v.loadTracks(withMediaType: .video).first,
              let at = try? await a.loadTracks(withMediaType: .audio).first,
              let dur = try? await v.load(.duration),
              let cv = comp.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid),
              let ca = comp.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) else { return false }
        let range = CMTimeRange(start: .zero, duration: dur)
        try? cv.insertTimeRange(range, of: vt, at: .zero)
        try? ca.insertTimeRange(range, of: at, at: .zero)
        guard let ex = AVAssetExportSession(asset: comp, presetName: AVAssetExportPresetPassthrough) else { return false }
        do { try await ex.export(to: out, as: .mp4) } catch { return false }
        return true
    }
}
