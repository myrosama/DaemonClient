import SwiftUI
import AVKit
import CryptoKit

/// Video bearbeiten wie in Fotos (PUTrimToolController): Anfang/Ende mit gelben Griffen am Filmstreifen,
/// Ton aus, bei Zeitlupen der verlangsamte Bereich (Strichleiste darüber, weite Striche = langsam). Immich kann Videos nicht verändern → gekürzte Fassung wird auf dem iPhone geschnitten (ohne neu zu
/// kodieren, volle Qualität), als neues Video hochgeladen und mit dem Original gestapelt (wie bei Fotos).
struct VideoTrimView: View {
    let asset: Asset
    let onDone: (Asset) -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(AppModel.self) private var app
    @State private var player: AVPlayer?
    @State private var frames: [UIImage] = []
    @State private var duration: Double = 0
    @State private var start: Double = 0
    @State private var end: Double = 0
    @State private var time: Double = 0
    @State private var playing = false
    @State private var muted = false
    @State private var saving: String?
    @State private var observer: Any?
    @State private var source: AVURLAsset?
    @State private var slow: SlowMo?
    @State private var slowDefault: SlowMo?

    private var changed: Bool { duration > 0 && (start > 0.05 || end < duration - 0.05 || muted || slow != slowDefault) }
    /// Länge beim Abspielen (Zeitlupe dehnt)
    private var playLength: Double { slow.map { $0.play(end) - $0.play(start) } ?? (end - start) }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                circle("xmark") { player?.pause(); dismiss() }
                Spacer()
                Text(Fmt.duration(Int(playLength * 1000))).font(.system(size: 15, weight: .semibold).monospacedDigit())
                    .padding(.horizontal, 14).frame(height: 36).glassEffect(.regular, in: .capsule)
                Spacer()
                Button { Task { await save() } } label: {
                    Image(systemName: "checkmark").font(.system(size: 18, weight: .bold))
                        .foregroundStyle(changed ? Color.black : .white.opacity(0.4)).frame(width: 46, height: 46).contentShape(.rect)
                        .background { if changed { Circle().fill(Color.yellow) } }
                }
                .glassEffect(.regular.interactive(), in: .circle)
                .disabled(!changed || saving != nil)
            }
            .foregroundStyle(.white)
            .padding(.horizontal, 16).padding(.top, 6).padding(.bottom, 8)
            ZStack {
                if let player { PlayerSurface(player: player) } else { ProgressView().tint(.white) }
                if let s = saving {
                    VStack(spacing: 10) { ProgressView().tint(.white); Text(s).font(.headline) }
                        .padding(24).glassEffect(.regular, in: .rect(cornerRadius: 22))
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .contentShape(Rectangle())
            .onTapGesture { toggle() }
            VStack(spacing: 14) {
                if slow != nil { slowBar.frame(height: 30).padding(.horizontal, 20) }
                trimBar.frame(height: 56).padding(.horizontal, 20)
                HStack(spacing: 26) {
                    circle(muted ? "speaker.slash.fill" : "speaker.wave.2.fill") { muted.toggle(); player?.isMuted = muted }
                        .accessibilityLabel(muted ? String(localized: "Ton ist aus") : String(localized: "Ton ist an"))
                    circle(playing ? "pause.fill" : "play.fill") { toggle() }
                    circle("arrow.counterclockwise") {
                        start = 0; end = duration; muted = false; player?.isMuted = false
                        if slow != slowDefault { slow = slowDefault; rebuild() }
                    }
                        .disabled(!changed)
                }
                Text(slow == nil ? String(localized: "Gelbe Griffe ziehen, um Anfang und Ende festzulegen. Das Original bleibt erhalten.")
                     : String(localized: "Weiße Griffe oben legen die Zeitlupe fest, gelbe unten Anfang und Ende. Das Original bleibt erhalten."))
                    .font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center).padding(.horizontal, 30)
            }
            .padding(.vertical, 14)
        }
        .background(Color.black.ignoresSafeArea())
        .preferredColorScheme(.dark)
        .task { await load() }
        .onDisappear { player?.pause(); if let observer { player?.removeTimeObserver(observer) } }
    }

    // MARK: Leiste mit Griffen

    private var trimBar: some View {
        GeometryReader { g in
            let w = g.size.width
            let x0 = duration > 0 ? CGFloat(start / duration) * w : 0
            let x1 = duration > 0 ? CGFloat(end / duration) * w : w
            ZStack(alignment: .leading) {
                HStack(spacing: 0) {
                    ForEach(Array(frames.enumerated()), id: \.offset) { _, f in
                        Image(uiImage: f).resizable().scaledToFill().frame(width: w / CGFloat(max(1, frames.count)), height: 48).clipped()
                    }
                }
                .frame(width: w, height: 48)
                .clipShape(RoundedRectangle(cornerRadius: 6))
                // außerhalb des Ausschnitts abdunkeln
                Rectangle().fill(.black.opacity(0.6)).frame(width: x0, height: 48)
                Rectangle().fill(.black.opacity(0.6)).frame(width: max(0, w - x1), height: 48).offset(x: x1)
                // gelber Rahmen mit Griffen
                RoundedRectangle(cornerRadius: 6).stroke(Color.yellow, lineWidth: 3)
                    .frame(width: max(24, x1 - x0), height: 52).offset(x: x0)
                handle(left: true).offset(x: x0 - 12)
                    .gesture(DragGesture().onChanged { v in
                        start = max(0, min(end - 0.5, Double(v.location.x / w) * duration)); seek(start)
                    })
                handle(left: false).offset(x: x1 - 12)
                    .gesture(DragGesture().onChanged { v in
                        end = min(duration, max(start + 0.5, Double(v.location.x / w) * duration)); seek(end)
                    })
                // Abspielkopf
                Capsule().fill(.white).frame(width: 3, height: 58)
                    .offset(x: duration > 0 ? CGFloat(time / duration) * w - 1.5 : 0)
                    .allowsHitTesting(false)
            }
            .frame(height: 56)
        }
    }

    /// Zeitlupen-Leiste wie Apple: dichte Striche = normal, weite Striche = verlangsamt, zwei weiße Griffe.
    private var slowBar: some View {
        GeometryReader { g in
            let w = g.size.width
            let r = slow?.range ?? 0...0
            let x0 = duration > 0 ? CGFloat(r.lowerBound / duration) * w : 0
            let x1 = duration > 0 ? CGFloat(r.upperBound / duration) * w : w
            ZStack(alignment: .leading) {
                Canvas { ctx, size in
                    var x: CGFloat = 0
                    while x < size.width {
                        let inSlow = x >= x0 && x <= x1
                        ctx.fill(Path(CGRect(x: x, y: inSlow ? 4 : 8, width: 1.5, height: inSlow ? size.height - 8 : size.height - 16)),
                                 with: .color(.white.opacity(inSlow ? 0.9 : 0.45)))
                        x += inSlow ? 9 : 3
                    }
                }
                slowHandle.offset(x: x0 - 7)
                    .gesture(DragGesture().onChanged { v in
                        guard var s = slow else { return }
                        s.range = max(0, min(r.upperBound - 0.2, Double(v.location.x / w) * duration))...r.upperBound
                        slow = s
                    }.onEnded { _ in rebuild() })
                slowHandle.offset(x: x1 - 7)
                    .gesture(DragGesture().onChanged { v in
                        guard var s = slow else { return }
                        s.range = r.lowerBound...min(duration, max(r.lowerBound + 0.2, Double(v.location.x / w) * duration))
                        slow = s
                    }.onEnded { _ in rebuild() })
            }
        }
        .accessibilityElement(children: .contain).accessibilityLabel(String(localized: "Zeitlupe"))
    }

    private var slowHandle: some View {
        Capsule().fill(.white).frame(width: 14, height: 30)
            .contentShape(Rectangle().inset(by: -12))
            .accessibilityLabel(String(localized: "Zeitlupe Griff"))
    }

    private func handle(left: Bool) -> some View {
        RoundedRectangle(cornerRadius: 4).fill(Color.yellow).frame(width: 24, height: 56)
            .overlay { Image(systemName: left ? "chevron.left" : "chevron.right").font(.system(size: 12, weight: .bold)).foregroundStyle(.black) }
            .contentShape(Rectangle().inset(by: -10))
            .accessibilityLabel(left ? String(localized: "Anfang") : String(localized: "Ende"))
    }

    private func circle(_ icon: String, _ action: @escaping () -> Void) -> some View {
        Button(action: action) { Image(systemName: icon).font(.system(size: 18, weight: .semibold)).frame(width: 50, height: 50) }
            .foregroundStyle(.white)
            .glassEffect(.regular.interactive(), in: .circle)
    }

    // MARK: Ablauf

    private func load() async {
        guard let url = ImmichClient.shared.videoURL(asset.id) else { return }
        let av = ImmichClient.shared.avAsset(url)
        source = av
        let s = await SlowMo.detect(av)
        slow = s; slowDefault = s
        let comp = s == nil ? nil : try? await s!.composition(av)
        let p = AVPlayer(playerItem: comp.map(SlowMo.item) ?? AVPlayerItem(asset: av))
        player = p
        let d = (try? await av.load(.duration).seconds) ?? Double(asset.durationMs ?? 0) / 1000
        duration = d.isFinite ? d : 0; end = duration
        observer = p.addPeriodicTimeObserver(forInterval: CMTime(value: 1, timescale: 30), queue: .main) { t in
            MainActor.assumeIsolated {
                time = slow.map { $0.source(t.seconds) } ?? t.seconds
                // nur den Ausschnitt abspielen
                if playing, t.seconds >= end { p.pause(); playing = false; seek(start) }
            }
        }
        let gen = AVAssetImageGenerator(asset: av)
        gen.appliesPreferredTrackTransform = true; gen.maximumSize = CGSize(width: 160, height: 160)
        let n = 12
        let times = (0..<n).map { CMTime(seconds: duration * (Double($0) + 0.5) / Double(n), preferredTimescale: 600) }
        var out: [UIImage] = []
        for await r in gen.images(for: times) { if let cg = try? r.image { out.append(UIImage(cgImage: cg)); frames = out } }
    }

    private func toggle() {
        guard let p = player else { return }
        if playing { p.pause(); playing = false; return }
        if time < start || time >= end - 0.1 { seek(start) }
        p.play(); playing = true
    }

    private func seek(_ t: Double) {
        let p = slow.map { $0.play(t) } ?? t
        player?.seek(to: CMTime(seconds: p, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero)
        time = t
    }

    /// Nach Ändern der Zeitlupe das Abspiel-Element neu bauen (Position bleibt).
    private func rebuild() {
        guard let source, let slow else { return }
        let at = time
        Task {
            guard let comp = try? await slow.composition(source) else { return }
            player?.replaceCurrentItem(with: SlowMo.item(comp))
            seek(min(max(at, start), end))
        }
    }

    /// Original laden, schneiden (Passthrough, ohne Qualitätsverlust), hochladen, mit Original stapeln.
    private func save() async {
        player?.pause(); playing = false
        let api = ImmichClient.shared
        do {
            saving = String(localized: "Original wird geladen …")
            guard let ourl = api.originalURL(asset.id, edited: false) else { return }
            let dto = try await api.asset(asset.id)
            let ext = ((dto.originalFileName ?? "video.mov") as NSString).pathExtension.lowercased()
            let dir = FileManager.default.temporaryDirectory.appendingPathComponent("kuerzen", isDirectory: true)
            try? FileManager.default.removeItem(at: dir)
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            let src = dir.appendingPathComponent("original.\(ext.isEmpty ? "mov" : ext)")
            try await api.data(ourl).write(to: src)
            saving = String(localized: "Video wird geschnitten …")
            let source = AVURLAsset(url: src)
            let meta = (try? await source.load(.metadata)) ?? []
            let out = dir.appendingPathComponent("gekuerzt.mov")
            if let slow {
                // Zeitlupe einrechnen: neu kodieren mit 30 Bildern/s, sonst würde das Ergebnis erneut als Zeitlupe gelten
                let comp = try await slow.composition(source, trim: start...end, audio: !muted)
                guard let ex = AVAssetExportSession(asset: comp, presetName: AVAssetExportPresetHEVCHighestQuality) else { throw APIError.badURL }
                let vc = try await AVMutableVideoComposition.videoComposition(withPropertiesOf: comp)
                vc.frameDuration = CMTime(value: 1, timescale: 30)
                vc.sourceTrackIDForFrameTiming = kCMPersistentTrackID_Invalid   // sonst übernimmt der Export die 240-fps-Bildzeiten
                ex.videoComposition = vc
                ex.audioTimePitchAlgorithm = .varispeed
                ex.metadata = meta
                try await ex.export(to: out, as: .mov)
            } else {
            let comp = AVMutableComposition()
            let range = CMTimeRange(start: CMTime(seconds: start, preferredTimescale: 600),
                                    end: CMTime(seconds: end, preferredTimescale: 600))
            for track in try await source.loadTracks(withMediaType: .video) {
                let t = comp.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid)
                try t?.insertTimeRange(range, of: track, at: .zero)
                t?.preferredTransform = try await track.load(.preferredTransform)
            }
            if !muted {
                for track in try await source.loadTracks(withMediaType: .audio) {
                    let t = comp.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid)
                    try t?.insertTimeRange(range, of: track, at: .zero)
                }
            }
            // Ort, Kamera, Aufnahmedatum vom Original mitnehmen
            guard let ex = AVAssetExportSession(asset: comp, presetName: AVAssetExportPresetPassthrough) else { throw APIError.badURL }
            ex.metadata = meta
            try await ex.export(to: out, as: .mov)
            }
            saving = String(localized: "Wird gesichert …")
            let name = ((dto.originalFileName ?? "VIDEO") as NSString).deletingPathExtension + Category.editedSuffix + ".mov"
            let sum = try Self.sha1(out)
            let iso = ISO8601DateFormatter().string(from: Date())
            let r = try await api.uploadAsset(file: out, filename: name, uti: "com.apple.quicktime-movie",
                                              fields: ["fileCreatedAt": dto.fileCreatedAt, "fileModifiedAt": iso, "filename": name,
                                                       "deviceAssetId": "fotos-trim-\(UUID().uuidString)", "deviceId": "fotos-app"],
                                              checksum: sum, expensive: true)
            try? await api.raw("assets/copy", method: "PUT",
                               body: api.json(["sourceId": asset.id, "targetId": r.id, "albums": true, "favorite": true] as [String: Any]))
            try? await api.createStack([r.id, asset.id])
            // Server liest das Datum aus der neuen Datei (= heute) → Aufnahmezeit des Originals setzen
            // (mit Zeitzone wie im Original, sonst rechnet der Server die Uhrzeit um)
            let when = dto.captureTimeWithZone ?? dto.exifInfo?.dateTimeOriginal ?? dto.fileCreatedAt
            api.setCaptureTime(r.id, when)
            try? await api.tag([r.id], with: "Kategorie/Bearbeitet")
            try? FileManager.default.removeItem(at: dir)
            saving = nil
            app.toast(slow != nil ? String(localized: "Zeitlupe gesichert") : String(localized: "Gekürztes Video gesichert"))
            let new = Asset(id: r.id, isImage: false, isFavorite: asset.isFavorite, date: asset.date, ratio: asset.ratio,
                            durationMs: Int(playLength * 1000), livePhotoVideoId: nil, city: asset.city, country: asset.country)
            onDone(new)
            dismiss()
        } catch {
            saving = nil
            app.toast(String(localized: "Sichern fehlgeschlagen"))
        }
    }

    private static func sha1(_ url: URL) throws -> String {
        var h = Insecure.SHA1()
        let f = try FileHandle(forReadingFrom: url)
        try f.forEachChunk { h.update(data: $0) }
        try f.close()
        return h.finalize().map { String(format: "%02x", $0) }.joined()
    }
}
