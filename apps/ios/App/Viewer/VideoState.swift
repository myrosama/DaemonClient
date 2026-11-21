import SwiftUI
import AVKit

/// Video der Einzelansicht wie bei Apple: eigene Leiste (Filmstreifen zum Spulen, Ton, AirPlay) statt der
/// AVKit-Standardknöpfe. Ein Player für das gerade gezeigte Video; Seite und Leisten lesen denselben Zustand.
@MainActor @Observable
final class VideoState {
    private(set) var id = ""
    private(set) var player: AVPlayer?
    private(set) var playing = false
    var muted = false { didSet {
        player?.isMuted = muted
        if playing { muted ? PlaybackAudioSession.release() : PlaybackAudioSession.activate() }
    } }
    private(set) var time: Double = 0
    private(set) var duration: Double = 0
    /// Standbilder für den Filmstreifen (vom Server-Video, in kleiner Größe)
    private(set) var frames: [UIImage] = []
    /// Zeitlupe (120/240 fps): wird verlangsamt abgespielt wie bei Apple
    private(set) var slowMo: SlowMo?
    /// Weder Wiedergabedatei noch Ausweichweg sind auf dem iPhone abspielbar → Hinweis statt schwarzem Bild
    private(set) var unplayable = false
    /// Beim Ziehen am Filmstreifen nicht vom Player überschreiben lassen
    @ObservationIgnored var scrubbing = false
    @ObservationIgnored private var timeObserver: Any?
    @ObservationIgnored private var endObserver: NSObjectProtocol?
    @ObservationIgnored private var framesTask: Task<Void, Never>?
    /// play() kam, bevor der Player stand (lokale Kopie wird noch gesucht)
    @ObservationIgnored private var pendingPlay = false
    // Video-Diagnose (… → „Video-Diagnose kopieren“, GitHub-Issue #1): was wann passiert ist
    @ObservationIgnored private var started = Date()
    @ObservationIgnored private var log: [String] = []
    @ObservationIgnored private var watchers: [NSKeyValueObservation] = []
    @ObservationIgnored private var stallObserver: NSObjectProtocol?
    @ObservationIgnored private var source = ""

    /// Neues Video zeigen (alter Player wird angehalten und freigegeben).
    func attach(_ asset: Asset) {
        guard asset.id != id else { return }
        stop()
        id = asset.id
        duration = Double(asset.durationMs ?? 0) / 1000
        started = Date(); log = []; source = ""
        note("open video, \(Int(duration)) s")
        // Liegt das Video auch auf diesem iPhone, spielt es von dort (wie die Immich-App und Apple): sofort da,
        // egal ob der Server es umwandeln kann
        guard LocalCopy.allowed else { note("no photo access, using server"); beginServer(asset); return }
        let want = asset.id
        Task { [weak self] in
            let local = await LocalCopy.video(want)
            guard let self, self.id == want else { return }
            if let local { self.source = "local copy on this iPhone"; self.note("source: local copy on this iPhone"); self.begin(asset, av: local, local: true) }
            else { self.note("no local copy on this iPhone"); self.beginServer(asset) }
        }
    }

    private func beginServer(_ asset: Asset) {
        guard let url = ImmichClient.shared.videoURL(asset.id) else { return }
        source = url.path()
        note("source: \(url.path())")
        begin(asset, av: ImmichClient.shared.avAsset(url), local: false)
    }

    private func begin(_ asset: Asset, av: AVURLAsset, local: Bool) {
        let p = AVPlayer(playerItem: AVPlayerItem(asset: av))
        p.isMuted = muted
        player = p
        timeObserver = p.addPeriodicTimeObserver(forInterval: CMTime(value: 1, timescale: 30), queue: .main) { [weak self] t in
            MainActor.assumeIsolated {
                guard let self, !self.scrubbing else { return }
                self.time = t.seconds
                if let d = p.currentItem?.duration.seconds, d.isFinite, d > 0 { self.duration = d }
            }
        }
        observeEnd(p)
        watch(p)
        loadFrames(av)
        let want = asset.id
        Task { [weak self] in
            // Normalfall sofort abspielen; erst wenn iOS die Datei nicht dekodieren kann, Ausweichweg suchen
            let playable = try? await av.load(.isPlayable)
            self?.note("playable: \(playable.map { String($0) } ?? "unknown")")
            guard !local, playable == false else { return }
            let alt = await ImmichClient.shared.playableFallback(for: want)
            guard let self, self.id == want, let p = self.player else { return }
            self.note("fallback: \(alt?.url.path() ?? "none found")")
            if let alt { self.source = alt.url.path() }
            guard let alt else { self.unplayable = true; self.pause(); return }
            p.replaceCurrentItem(with: AVPlayerItem(asset: alt))
            self.observeEnd(p)
            self.framesTask?.cancel(); self.frames = []; self.loadFrames(alt)
            if self.playing { p.play() }
        }
        Task { [weak self] in
            guard (try? await av.load(.isPlayable)) == true,
                  let s = await SlowMo.detect(av), let comp = try? await s.composition(av) else { return }
            guard let self, self.id == want, let p = self.player else { return }
            let resume = self.playing
            let original = p.currentItem
            let slow = SlowMo.item(comp)
            p.replaceCurrentItem(with: slow)
            self.note("slo-mo x\(s.factor)")
            self.slowMo = s
            self.duration = (try? await comp.load(.duration).seconds) ?? self.duration
            self.observeEnd(p)
            if resume { p.play() }
            // Scheitert die Zeitlupen-Wiedergabe (z. B. unbekannte Tonspur), lieber normal abspielen als schwarz bleiben
            for _ in 0..<50 where slow.status == .unknown { try? await Task.sleep(for: .milliseconds(100)) }
            guard slow.status == .failed, self.id == want, p.currentItem === slow, let original else { return }
            PerfLog.mark("Zeitlupe fehlgeschlagen, normale Wiedergabe: \(slow.error?.localizedDescription ?? "")")
            p.replaceCurrentItem(with: AVPlayerItem(asset: original.asset))
            self.slowMo = nil
            self.duration = (try? await original.asset.load(.duration).seconds) ?? self.duration
            self.observeEnd(p)
            if self.playing { p.play() }
        }
        if pendingPlay { pendingPlay = false; play() }
    }

    private func observeEnd(_ p: AVPlayer) {
        if let e = endObserver { NotificationCenter.default.removeObserver(e) }
        endObserver = NotificationCenter.default.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: p.currentItem, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.playing = false; PlaybackAudioSession.release() }
        }
    }

    func play() {
        guard let p = player else { pendingPlay = true; return }
        if !muted { PlaybackAudioSession.activate() }
        // am Ende: von vorn (wie Apple)
        if duration > 0, time >= duration - 0.15 { p.seek(to: .zero); time = 0 }
        p.play(); playing = true
    }
    func pause() { player?.pause(); playing = false; PlaybackAudioSession.release() }
    func toggle() { playing ? pause() : play() }

    func seek(fraction f: Double) {
        guard let p = player, duration > 0 else { return }
        let t = max(0, min(1, f)) * duration
        time = t
        p.seek(to: CMTime(seconds: t, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero)
    }

    // MARK: Spulen aus der Vorschau-Leiste (wie PXVideoScrubberController: höchstens eine Suche läuft,
    // neuere warten und nur die letzte zählt – sonst stauen sich Bereichsanfragen ans Server-Video und es hängt)

    @ObservationIgnored private var seeking = false
    @ObservationIgnored private var pendingSeek: Double?

    func beginScrub() {
        guard player != nil else { return }
        scrubbing = true
        player?.pause()
        playing = false
    }

    func scrub(to fraction: Double) {
        guard duration > 0 else { return }
        let t = max(0, min(1, fraction)) * duration
        time = t
        if seeking { pendingSeek = t } else { startSeek(t, exact: false) }
    }

    func endScrub(resume: Bool) {
        guard scrubbing else { return }
        scrubbing = false
        let t = pendingSeek ?? time
        pendingSeek = nil
        startSeek(t, exact: true)
        if resume { player?.play(); playing = true }
    }

    private func startSeek(_ t: Double, exact: Bool) {
        guard let p = player else { return }
        seeking = true
        // beim Ziehen reicht das nächste Schlüsselbild in der Nähe (schnell), am Ende genau
        let tol = exact ? CMTime.zero : CMTime(seconds: 0.15, preferredTimescale: 600)
        p.seek(to: CMTime(seconds: t, preferredTimescale: 600), toleranceBefore: tol, toleranceAfter: tol) { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                self.seeking = false
                if let next = self.pendingSeek { self.pendingSeek = nil; self.startSeek(next, exact: !self.scrubbing) }
            }
        }
    }

    func stop() {
        player?.pause(); PlaybackAudioSession.release()
        if let o = timeObserver { player?.removeTimeObserver(o) }
        if let e = endObserver { NotificationCenter.default.removeObserver(e) }
        timeObserver = nil; endObserver = nil
        framesTask?.cancel(); framesTask = nil
        player = nil; playing = false; time = 0; frames = []; id = ""; slowMo = nil; unplayable = false; pendingPlay = false
        seeking = false; pendingSeek = nil; scrubbing = false
        watchers = []
        if let o = stallObserver { NotificationCenter.default.removeObserver(o) }
        stallObserver = nil
    }

    // MARK: Video-Diagnose

    private func note(_ s: String) {
        log.append(String(format: "%6.1fs  ", Date().timeIntervalSince(started)) + s)
        if log.count > 200 { log.removeFirst() }
    }

    /// Mitschreiben, wann der Player bereit ist, wartet, spielt oder hängt.
    private func watch(_ p: AVPlayer) {
        watchers = [
            p.observe(\.timeControlStatus, options: [.new]) { [weak self] p, _ in
                let s = p.timeControlStatus, why = p.reasonForWaitingToPlay?.rawValue ?? "-"
                MainActor.assumeIsolated {
                    self?.note(s == .playing ? "player: playing" : s == .paused ? "player: paused" : "player: waiting (\(why))")
                }
            },
            p.observe(\.currentItem?.status, options: [.new]) { [weak self] p, _ in
                let st = p.currentItem?.status, err = p.currentItem?.error?.localizedDescription
                MainActor.assumeIsolated {
                    if st == .readyToPlay { self?.note("item: ready to play") }
                    if st == .failed { self?.note("item: failed \(err ?? "")") }
                }
            },
        ]
        if let o = stallObserver { NotificationCenter.default.removeObserver(o) }
        stallObserver = NotificationCenter.default.addObserver(forName: .AVPlayerItemPlaybackStalled, object: nil, queue: .main) { [weak self, weak p] n in
            let stalled = (n.object as AnyObject?).map { ObjectIdentifier($0) }
            MainActor.assumeIsolated {
                guard let p, let item = p.currentItem, stalled == ObjectIdentifier(item) else { return }
                self?.note("stalled at \(String(format: "%.1f", p.currentTime().seconds)) s")
            }
        }
    }

    /// Bericht zum Einfügen ins GitHub-Issue: App/Gerät, Server, Antworten der Adressen (nur Pfade, keine Serveradresse,
    /// kein Token), Videospur und was beim Abspielen passiert ist.
    func diagnostics(_ asset: Asset) async -> String {
        let api = ImmichClient.shared
        let info = Bundle.main.infoDictionary
        var u = utsname(); uname(&u)
        let model = withUnsafeBytes(of: &u.machine) { String(decoding: $0.prefix { $0 != 0 }, as: UTF8.self) }
        var out = ["HomeRoll \(info?["CFBundleShortVersionString"] ?? "?") (\(info?["CFBundleVersion"] ?? "?")), iOS \(UIDevice.current.systemVersion), \(model)"]
        struct Version: Decodable { let major: Int; let minor: Int; let patch: Int }
        if let v: Version = try? await api.request("server/version") { out.append("server: immich \(v.major).\(v.minor).\(v.patch)") }
        out.append("realtime transcoding: \(await api.serverRealtime() ? "on" : "off")")
        out.append("photo access: \(LocalCopy.accessText), local copy: \(await LocalCopy.asset(asset.id) != nil ? "found" : "not found")")
        if let d = try? await api.asset(asset.id) {
            let size = d.exifInfo?.fileSizeInByte.map { String(format: "%.1f MB", Double($0) / 1_000_000) } ?? "?"
            out.append("asset: \(d.originalMimeType ?? "?"), \(size), \((d.duration ?? 0) / 1000) s, thumbhash \(d.thumbhash == nil ? "missing" : "ok")")
        }
        out.append("")
        var probes: [(String, URL?)] = [("thumbnail", api.thumbnailURL(asset.id, .thumbnail)), ("preview", api.thumbnailURL(asset.id, .preview)),
                                        ("playback", try? api.url("assets/\(asset.id)/video/playback")), ("original", api.originalURL(asset.id))]
        if await api.serverRealtime() { probes.append(("hls main", try? api.url("assets/\(asset.id)/video/stream/main.m3u8"))) }
        for (name, url) in probes {
            guard let url else { continue }
            out.append("\(name): \(await api.probe(url))")
        }
        if let a = player?.currentItem?.asset, let t = try? await a.loadTracks(withMediaType: .video).first {
            let fmt = (try? await t.load(.formatDescriptions))?.first.map { d -> String in
                let c = CMFormatDescriptionGetMediaSubType(d).bigEndian
                return withUnsafeBytes(of: c) { String(decoding: $0, as: UTF8.self) }
            } ?? "?"
            let sz = (try? await t.load(.naturalSize)) ?? .zero, fps = (try? await t.load(.nominalFrameRate)) ?? 0
            let hdr = (try? await t.load(.mediaCharacteristics))?.contains(.containsHDRVideo) == true
            out.append("video track: \(fmt) \(Int(sz.width))x\(Int(sz.height)) \(Int(fps.rounded())) fps\(hdr ? " hdr" : "")")
        }
        out.append("playing from: \(source.isEmpty ? "-" : source)")
        out.append("")
        out += log
        // Pfade enthalten nur die Objekt-ID; trotzdem keine Serveradresse mitgeben
        return "```\n" + out.joined(separator: "\n") + "\n```"
    }

    /// ~14 Standbilder gleichmäßig über das Video (Bereichsanfragen an den Server, nicht das ganze Video).
    private func loadFrames(_ av: AVURLAsset) {
        let want = id, count = 14
        framesTask = Task { [weak self] in
            let gen = AVAssetImageGenerator(asset: av)
            gen.appliesPreferredTrackTransform = true
            gen.maximumSize = CGSize(width: 160, height: 160)
            gen.requestedTimeToleranceBefore = CMTime(seconds: 0.5, preferredTimescale: 600)
            gen.requestedTimeToleranceAfter = CMTime(seconds: 0.5, preferredTimescale: 600)
            guard let d = try? await av.load(.duration).seconds, d.isFinite, d > 0 else { return }
            let times = (0..<count).map { CMTime(seconds: d * (Double($0) + 0.5) / Double(count), preferredTimescale: 600) }
            var out: [UIImage] = []
            for await r in gen.images(for: times) {
                if Task.isCancelled { return }
                if let img = try? r.image { out.append(UIImage(cgImage: img)) }
                if out.count % 4 == 0 || out.count == count {
                    guard let self, self.id == want else { return }
                    self.frames = out
                }
            }
            // keine Standbilder (z. B. HLS-Ausweichweg, daraus liest AVAssetImageGenerator nichts): wenigstens das
            // Vorschaubild zeigen statt leerem Streifen (GitHub-Issue #1)
            if out.isEmpty, let img = await ImageCache.shared.load(want, .preview) {
                out = Array(repeating: img, count: count)
                if let self, self.id == want { self.frames = out }
            }
            if let self, self.id == want { self.frames = out }
        }
    }
}

/// Bildfläche für den Player (ohne AVKit-Knöpfe).
struct PlayerSurface: UIViewRepresentable {
    let player: AVPlayer?
    func makeUIView(context: Context) -> PlayerLayerView { PlayerLayerView() }
    func updateUIView(_ v: PlayerLayerView, context: Context) {
        if v.playerLayer.player !== player { v.playerLayer.player = player }
        v.playerLayer.videoGravity = .resizeAspect
    }
    final class PlayerLayerView: UIView {
        override class var layerClass: AnyClass { AVPlayerLayer.self }
        var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }
    }
}

/// Über der Vorschau-Leiste beim Video: Wiedergabe/Pause und Restzeit. Gespult wird in der Leiste selbst
/// (das Video ist dort eingebettet, die Mitte ist der Abspielkopf – siehe ScrubberStrip).
struct VideoControls: View {
    @Bindable var video: VideoState

    var body: some View {
        HStack {
            Button { video.toggle() } label: {
                Image(systemName: video.playing ? "pause.fill" : "play.fill")
                    .font(.system(size: 17, weight: .semibold)).foregroundStyle(.white)
                    .frame(width: 40, height: 40).contentShape(.rect)
            }
            .glassEffect(.regular.interactive(), in: .circle)
            .accessibilityLabel(video.playing ? String(localized: "Pause") : String(localized: "Wiedergabe"))
            Spacer()
            Text(Fmt.duration(Int(max(0, video.duration - video.time) * 1000)))
                .font(.system(size: 13, weight: .semibold).monospacedDigit()).foregroundStyle(.white)
                .padding(.horizontal, 10).frame(height: 28)
                .glassEffect(.regular, in: .capsule)
        }
        .padding(.horizontal, 16)
    }
}

/// AirPlay-Knopf (Video auf Fernseher/Lautsprecher).
struct AirPlayButton: UIViewRepresentable {
    func makeUIView(context: Context) -> AVRoutePickerView {
        let v = AVRoutePickerView()
        v.tintColor = .white; v.activeTintColor = .systemBlue
        v.prioritizesVideoDevices = true
        return v
    }
    func updateUIView(_ uiView: AVRoutePickerView, context: Context) {}
}
