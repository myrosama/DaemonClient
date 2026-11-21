import SwiftUI
import AVFoundation

// Rückblick-Player nach dem Aufbau von Apples Fotos (per REA analysiert, siehe API-NOTIZEN.md „Rückblicke“):
// Zeitleiste aus Szenen (1, 2 oder 3 Fotos, Videos), Szenenwechsel im Takt der Musik, eine Uhr für alles
// (Pause friert ein, Play läuft genau dort weiter), Tippen am Rand = Szene vor/zurück, Mitte = Steuerung,
// angehalten seitlich wischen = Rückblick-Mix wechseln, am Ende „Nochmal“ und „Als Nächstes“ mit Countdown.

/// Eine Szene der Zeitleiste.
struct StoryScene: Identifiable {
    enum Kind { case title, one(Asset), two(Asset, Asset), three(Asset, Asset, Asset), video(Asset) }
    enum Transition { case fade, push, zoom }
    let id: Int
    let kind: Kind
    let start: Double
    let duration: Double
    let transition: Transition
    var end: Double { start + duration }
    /// Fotos dieser Szene (für Raster, Vorladen, Sprungleiste)
    var assets: [Asset] {
        switch kind {
        case .title: []
        case .one(let a), .video(let a): [a]
        case .two(let a, let b): [a, b]
        case .three(let a, let b, let c): [a, b, c]
        }
    }
}

/// Rückblick-Mix: Musik + Farbstil, wie Apples „Memory Mixes“.
struct MemoryMix: Hashable {
    let mood: MemoryMood
    let style: MemoryStyle
    static let all: [MemoryMix] = [
        .init(mood: .gentle, style: .natural), .init(mood: .happy, style: .vivid), .init(mood: .thoughtful, style: .cool),
        .init(mood: .epic, style: .contrast), .init(mood: .gentle, style: .warm), .init(mood: .thoughtful, style: .mono),
    ]
    var title: String { "\(mood.title) · \(style.title)" }
}

extension MemoryMood {
    /// Tempo der selbst erzeugten Musik (gleiche Werte wie der Synthesizer)
    var bpm: Double {
        switch self { case .gentle: 72; case .happy: 112; case .thoughtful: 64; case .epic: 80; case .none: 76 }
    }
}

enum StoryTimeline {
    static let fade = 0.7

    /// Szenen bauen: Hochformate oft zu zweit/dritt, Videos als Ausschnitt, Längen auf ganze Takte.
    static func build(_ assets: [Asset], mood: MemoryMood) -> [StoryScene] {
        let beat = 60 / mood.bpm
        let bar = beat * 4
        func bars(_ seconds: Double) -> Double { max(1, (seconds / bar).rounded()) * bar }
        var out: [StoryScene] = [StoryScene(id: 0, kind: .title, start: 0, duration: bars(3.2), transition: .fade)]
        var t = out[0].duration
        var i = 0, n = 1
        let portrait: (Asset) -> Bool = { $0.isImage && $0.ratio < 0.85 }
        func near(_ a: Asset, _ b: Asset) -> Bool { abs(a.date.timeIntervalSince(b.date)) < 6 * 3600 }
        while i < assets.count {
            let a = assets[i]
            let kind: StoryScene.Kind, len: Double
            if a.isVideo {
                kind = .video(a); len = bars(min(Double(a.durationMs ?? 4000) / 1000, 9)); i += 1
            } else if n % 5 == 2, i + 2 < assets.count, portrait(a), portrait(assets[i + 1]), portrait(assets[i + 2]),
                      near(a, assets[i + 2]) {
                kind = .three(a, assets[i + 1], assets[i + 2]); len = bars(4.6); i += 3
            } else if n % 3 != 0, i + 1 < assets.count, portrait(a), portrait(assets[i + 1]), near(a, assets[i + 1]) {
                kind = .two(a, assets[i + 1]); len = bars(4.0); i += 2
            } else {
                kind = .one(a); len = bars(3.2); i += 1
            }
            let tr: StoryScene.Transition = n % 7 == 0 ? .zoom : n % 4 == 0 ? .push : .fade
            out.append(StoryScene(id: n, kind: kind, start: t, duration: len, transition: tr))
            t += len; n += 1
        }
        return out
    }
}

/// Uhr des Players: läuft nur beim Abspielen, Sprünge setzen sie neu (Apples PXStoryPacingClock).
@MainActor @Observable
final class StoryClock {
    private(set) var playing = false
    @ObservationIgnored private var base: Double = 0
    @ObservationIgnored private var started = Date()
    func time(_ now: Date = Date()) -> Double { playing ? base + now.timeIntervalSince(started) : base }
    func play() { guard !playing else { return }; started = Date(); playing = true }
    func pause() { guard playing else { return }; base = time(); playing = false }
    func seek(_ t: Double) { base = max(0, t); started = Date() }
}

/// Videos der Szenen (stumm wie bei Apple; die Musik läuft weiter).
@MainActor
final class StoryVideos {
    private var players: [String: AVPlayer] = [:]
    func player(_ a: Asset) -> AVPlayer? {
        if let p = players[a.id] { return p }
        guard let url = ImmichClient.shared.videoURL(a.id) else { return nil }
        let p = AVPlayer(playerItem: AVPlayerItem(asset: ImmichClient.shared.avAsset(url)))
        p.isMuted = true; p.automaticallyWaitsToMinimizeStalling = false
        players[a.id] = p
        return p
    }
    /// Nur das Video der aktuellen Szene läuft, im Gleichschritt mit der Uhr.
    func sync(current: Asset?, timeInScene: Double, playing: Bool) {
        for (id, p) in players where id != current?.id { p.pause() }
        guard let a = current, let p = player(a) else { return }
        let drift = abs(p.currentTime().seconds - timeInScene)
        if drift > 0.6 { p.seek(to: CMTime(seconds: timeInScene, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero) }
        if playing { if p.rate == 0 { p.play() } } else { p.pause() }
    }
    func stop() { players.values.forEach { $0.pause() }; players = [:] }
}

struct MemoryPlayer: View {
    @State var memory: Memory
    @Environment(\.dismiss) private var dismiss
    @Environment(AppModel.self) private var app
    @State private var clock = StoryClock()
    @State private var mood: MemoryMood
    @State private var style: MemoryStyle
    @State private var length: Int                 // 0 kurz, 1 mittel, 2 lang
    @State private var title: String
    @State private var scenes: [StoryScene] = []
    @State private var chrome = false
    @State private var ended = false
    @State private var muted = false
    @State private var mixSheet = false
    @State private var renaming = false
    @State private var newTitle = ""
    @State private var grid = false
    @State private var viewer: ViewerRequest?
    @State private var music = MemoryMusic()
    @State private var videos = StoryVideos()
    @State private var drag: CGFloat = 0
    @State private var mixDrag: CGFloat = 0
    @State private var countdown: Int?
    @State private var next: Memory?

    init(memory: Memory) {
        _memory = State(initialValue: memory)
        let p = MemoryPrefs.shared
        _mood = State(initialValue: MemoryMood(rawValue: p.mood[memory.id] ?? 1) ?? .gentle)
        _style = State(initialValue: MemoryStyle(rawValue: p.style[memory.id] ?? 0) ?? .natural)
        _length = State(initialValue: p.length[memory.id] ?? 1)
        _title = State(initialValue: memory.title)
    }

    private var total: Double { scenes.last?.end ?? 0 }
    private var mixIndex: Int { MemoryMix.all.firstIndex(of: MemoryMix(mood: mood, style: style)) ?? -1 }

    private var curated: [Asset] {
        let n = [15, 30, 999][length]
        let ready = memory.assets.filter { ImageCache.shared.hash($0.id) != nil }
        let src = ready.isEmpty ? memory.assets : ready
        return src.count > n ? MemoryEngine.curate(src, max: n) : src
    }

    var body: some View {
        GeometryReader { geo in
            ZStack {
                Color.black.ignoresSafeArea()
                TimelineView(.animation(minimumInterval: nil, paused: !clock.playing)) { ctx in
                    let t = clock.time(ctx.date)
                    stage(t: t, size: geo.size)
                        .memoryStyle(style)
                        .onChange(of: Int(t * 10)) { tick(t) }
                }
                .ignoresSafeArea()
                .offset(y: max(0, drag))
                .scaleEffect(1 - min(0.15, max(0, drag) / 2500))
                if ended { endOverlay(size: geo.size) }
                else if chrome { controls(size: geo.size) }
            }
            .contentShape(Rectangle())
            .gesture(SpatialTapGesture().onEnded { v in tap(at: v.location, width: geo.size.width) })
            .simultaneousGesture(DragGesture(minimumDistance: 20)
                .onChanged { v in
                    if abs(v.translation.height) > abs(v.translation.width) { drag = v.translation.height }
                    else if chrome && !ended { mixDrag = v.translation.width }
                }
                .onEnded { v in
                    if drag > 140 || v.predictedEndTranslation.height > 400 { close() }
                    else if chrome && !ended && abs(mixDrag) > 70 { switchMix(mixDrag < 0 ? 1 : -1) }
                    withAnimation(.snappy) { drag = 0; mixDrag = 0 }
                })
        }
        .ignoresSafeArea()
        .statusBarHidden(!chrome)
        .preferredColorScheme(.dark)
        .overlay(alignment: .top) { BusyBadge().padding(.top, 50) }
        .onAppear {
            scenes = StoryTimeline.build(curated, mood: mood)
            music.play(mood); clock.play()
            MemoryRecent.add(memory)
            preload(from: 0)
            next = MemoryCenter.shared.items.drop(while: { $0.id != memory.id }).dropFirst().first
        }
        .onDisappear { music.stop(); videos.stop() }
        .onChange(of: mood) { _, m in
            save { $0.mood[memory.id] = m.rawValue }
            // neues Tempo → Szenen neu auf den Takt legen, an derselben Stelle (Anteil) weiter
            let f = total > 0 ? clock.time() / total : 0
            scenes = StoryTimeline.build(curated, mood: m)
            clock.seek(f * total)
            music.play(m); if muted || !clock.playing { music.pause() }
        }
        .onChange(of: style) { _, s in save { $0.style[memory.id] = s.rawValue } }
        .onChange(of: length) { _, l in
            save { $0.length[memory.id] = l }
            scenes = StoryTimeline.build(curated, mood: mood); restart()
        }
        .onChange(of: muted) { _, m in if m { music.pause() } else if clock.playing { music.resume() } }
        .task(id: countdown) {
            // „Als Nächstes“: nach 5 s den nächsten Rückblick starten (Apples Up-Next-Countdown)
            guard let c = countdown else { return }
            try? await Task.sleep(for: .seconds(1))
            guard countdown == c, !Task.isCancelled else { return }
            if c <= 1 { playNext() } else { countdown = c - 1 }
        }
        .sheet(isPresented: $mixSheet, onDismiss: { if !chrome && !ended { resume() } }) { mixPicker.presentationDetents([.height(330)]).preferredColorScheme(.dark) }
        .sheet(isPresented: $grid) {
            MemoryGrid(assets: memory.assets, open: { i in grid = false; viewer = ViewerRequest(assets: memory.assets, index: i) },
                       remove: { a in
                MemoryCenter.shared.remove(a.id, from: memory.id)
                let rest = memory.assets.filter { $0.id != a.id }
                guard rest.count >= 3 else { grid = false; app.toast(String(localized: "Rückblick entfernt – zu wenige Fotos")); close(); return }
                memory = Memory(id: memory.id, title: memory.title, subtitle: MemoryEngine.range(rest), assets: rest,
                                key: memory.key.id == a.id ? (MemoryEngine.keyPhoto(rest) ?? rest[0]) : memory.key, date: memory.date,
                                custom: memory.custom, place: memory.place, personID: memory.personID, personName: memory.personName)
                scenes = StoryTimeline.build(curated, mood: mood)
                app.toast(String(localized: "Aus Rückblick entfernt"))
            }, makeKey: { a in
                MemoryCenter.shared.setKey(a.id, for: memory.id)
                memory = Memory(id: memory.id, title: memory.title, subtitle: memory.subtitle, assets: memory.assets, key: a,
                                date: memory.date, custom: memory.custom, place: memory.place, personID: memory.personID, personName: memory.personName)
                app.toast(String(localized: "Titelbild festgelegt"))
            })
            .overlay(alignment: .top) { ToastBadge() }
        }
        .overlay(alignment: .top) { ToastBadge() }
        .fullScreenCover(item: $viewer) { r in ViewerView(assets: r.assets, start: r.index).preferredColorScheme(.dark) }
        .alert(String(localized: "Titel bearbeiten"), isPresented: $renaming) {
            TextField(String(localized: "Titel"), text: $newTitle)
            Button(String(localized: "Sichern")) {
                let t = newTitle.trimmingCharacters(in: .whitespaces)
                guard !t.isEmpty else { return }
                title = t; MemoryCenter.shared.update { $0.titles[memory.id] = t }
            }
            Button(String(localized: "Abbrechen"), role: .cancel) {}
        }
    }

    // MARK: Bild

    @ViewBuilder private func stage(t: Double, size: CGSize) -> some View {
        let i = scenes.lastIndex { $0.start <= t } ?? 0
        ZStack {
            if scenes.indices.contains(i) {
                let s = scenes[i]
                // vorige Szene bleibt darunter, bis die neue ganz eingeblendet ist (keine schwarze Lücke)
                if i > 0, t - s.start < StoryTimeline.fade {
                    sceneView(scenes[i - 1], t: t, size: size)
                }
                let f = min(1, (t - s.start) / StoryTimeline.fade)
                sceneView(s, t: t, size: size)
                    .opacity(s.transition == .push ? 1 : f)
                    .offset(x: s.transition == .push ? (1 - ease(f)) * size.width : 0)
                    .scaleEffect(s.transition == .zoom ? 1.12 - 0.12 * ease(f) : 1)
            }
        }
        .frame(width: size.width, height: size.height)
        .clipped()
    }

    private func ease(_ x: Double) -> Double { 1 - pow(1 - x, 3) }

    @ViewBuilder private func sceneView(_ s: StoryScene, t: Double, size: CGSize) -> some View {
        let p = max(0, min(1, (t - s.start) / (s.duration + StoryTimeline.fade)))
        switch s.kind {
        case .title:
            ZStack(alignment: .bottomLeading) {
                kenBurns(memory.key, seed: 99, p: p, size: size)
                LinearGradient(colors: [.clear, .black.opacity(0.7)], startPoint: .center, endPoint: .bottom)
                // Titel blendet ein und wächst leicht (wie Apples Titelkarte)
                let a = min(1, max(0, (t - 0.3) / 0.9))
                VStack(alignment: .leading, spacing: 6) {
                    Text(title).font(.system(size: 42, weight: .bold)).lineLimit(3)
                    Text(memory.subtitle).font(.system(size: 15, weight: .semibold)).opacity(0.85)
                }
                .foregroundStyle(.white).shadow(radius: 10)
                .opacity(a).scaleEffect(1.06 - 0.06 * a, anchor: .bottomLeading)
                .padding(.horizontal, 28).padding(.bottom, 90)
            }
        case .one(let a):
            kenBurns(a, seed: s.id, p: p, size: size)
        case .two(let a, let b):
            HStack(spacing: 3) {
                kenBurns(a, seed: s.id, p: p, size: CGSize(width: (size.width - 3) / 2, height: size.height))
                kenBurns(b, seed: s.id + 1, p: p, size: CGSize(width: (size.width - 3) / 2, height: size.height))
            }
        case .three(let a, let b, let c):
            HStack(spacing: 3) {
                kenBurns(a, seed: s.id, p: p, size: CGSize(width: (size.width - 3) * 0.55, height: size.height))
                VStack(spacing: 3) {
                    let w = (size.width - 3) * 0.45, h = (size.height - 3) / 2
                    kenBurns(b, seed: s.id + 1, p: p, size: CGSize(width: w, height: h))
                    kenBurns(c, seed: s.id + 2, p: p, size: CGSize(width: w, height: h))
                }
            }
        case .video(let a):
            ZStack {
                kenBurns(a, seed: s.id, p: 0, size: size)
                if let player = videos.player(a) { PlayerSurface(player: player).allowsHitTesting(false) }
            }
            .frame(width: size.width, height: size.height)
        }
    }

    /// Langsamer Zoom und Schwenk, aus der Uhr berechnet: steht bei Pause, läuft danach weiter.
    private func kenBurns(_ a: Asset, seed: Int, p: Double, size: CGSize) -> some View {
        let dirs: [CGSize] = [.init(width: -18, height: -10), .init(width: 16, height: 12), .init(width: -12, height: 14), .init(width: 14, height: -12)]
        let d = dirs[abs(seed) % dirs.count]
        let zoomIn = seed % 2 == 0
        let scale = zoomIn ? 1.04 + 0.12 * p : 1.16 - 0.12 * p
        return AssetThumb(id: a.id, size: .preview)
            .scaledToFill()
            .frame(width: size.width, height: size.height)
            .scaleEffect(scale)
            .offset(x: d.width * p, y: d.height * p)
            .frame(width: size.width, height: size.height)
            .clipped()
    }

    // MARK: Ablauf

    private func tick(_ t: Double) {
        if total > 0, t >= total, !ended { finish(); return }
        let i = scenes.lastIndex { $0.start <= t } ?? 0
        if scenes.indices.contains(i), case .video(let a) = scenes[i].kind {
            videos.sync(current: a, timeInScene: t - scenes[i].start, playing: clock.playing)
        } else { videos.sync(current: nil, timeInScene: 0, playing: false) }
        if Int(t * 10) % 10 == 0 { preload(from: i + 1) }
    }

    private func preload(from i: Int) {
        for s in scenes.dropFirst(max(0, i)).prefix(2) {
            for a in s.assets { Task { _ = await ImageCache.shared.load(a.id, .preview) } }
            if case .video(let a) = s.kind { _ = videos.player(a) }
        }
    }

    /// Tippen: Rand = Szene vor/zurück (Apple: skipToSegmentWithOffset:byTappingEdge:), Mitte = Steuerung + Pause.
    private func tap(at p: CGPoint, width: CGFloat) {
        #if DEBUG
        if ProcessInfo.processInfo.environment["FOTOS_DIAG_TAP"] != nil { print("DIAG tap", p.x, chrome, ended) }
        #endif
        if ended { return }
        if chrome { resume(); return }
        if p.x < width * 0.25 { skip(-1) }
        else if p.x > width * 0.75 { skip(1) }
        else { pause(); withAnimation(.easeInOut(duration: 0.2)) { chrome = true } }
    }

    private func skip(_ d: Int) {
        let t = clock.time()
        let i = scenes.lastIndex { $0.start <= t } ?? 0
        if d < 0 {
            // erst an den Anfang der Szene, erneutes Tippen eine zurück (Apple: rewindToBeginningOfCurrentSegment)
            let target = t - scenes[i].start > 1.2 || i == 0 ? scenes[i].start : scenes[i - 1].start
            clock.seek(target + 0.01)
        } else if i + 1 < scenes.count {
            clock.seek(scenes[i + 1].start + StoryTimeline.fade)    // ohne Überblenden direkt die nächste
        } else { finish() }
    }

    /// Schließen (X oder nach unten wischen) – auch über die App, falls dismiss nicht greift.
    private func close() { music.stop(); videos.stop(); dismiss(); app.memory = nil }

    private func pause() { clock.pause(); music.pause(); videos.sync(current: nil, timeInScene: 0, playing: false) }
    private func resume() {
        withAnimation(.easeInOut(duration: 0.2)) { chrome = false }
        clock.play(); if !muted { music.resume() }
    }
    private func restart() {
        ended = false; countdown = nil
        clock.seek(0); music.play(mood); if muted { music.pause() }
        withAnimation(.easeInOut(duration: 0.2)) { chrome = false }
        clock.play()
    }
    private func finish() {
        clock.pause(); clock.seek(max(0, total - 0.01)); music.pause()
        withAnimation(.easeInOut(duration: 0.4)) { ended = true; chrome = false }
        if next != nil { countdown = 5 }
    }
    private func playNext() {
        guard let n = next else { return }
        countdown = nil
        app.memory = nil
        Task { try? await Task.sleep(for: .milliseconds(450)); app.memory = n }
    }

    private func switchMix(_ d: Int) {
        let all = MemoryMix.all
        let i = mixIndex < 0 ? 0 : (mixIndex + d + all.count) % all.count
        withAnimation(.easeInOut(duration: 0.3)) { mood = all[i].mood; style = all[i].style }
        UISelectionFeedbackGenerator().selectionChanged()
    }

    private func save(_ change: (inout MemoryPrefs) -> Void) { var p = MemoryPrefs.shared; change(&p); MemoryPrefs.shared = p }

    // MARK: Steuerung (angehalten)

    private func controls(size: CGSize) -> some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                circle("xmark") { close() }
                Spacer()
                VStack(spacing: 2) {
                    Text(title).font(.system(size: 16, weight: .semibold)).lineLimit(1)
                    // wie Apple: beim Pausieren das Lied im Titel
                    Label(mood == .none ? String(localized: "Ohne Musik") : String(localized: "Musik: \(mood.title)"), systemImage: "music.note")
                        .font(.system(size: 12, weight: .medium)).opacity(0.85)
                }
                .padding(.horizontal, 14).padding(.vertical, 6)
                .glassEffect(.regular.tint(.black.opacity(0.35)), in: .capsule)
                Spacer()
                Menu {
                    Button(String(localized: "Titel bearbeiten"), systemImage: "pencil") { newTitle = title; renaming = true }
                    Picker(selection: $length) {
                        Text(String(localized: "Kurz")).tag(0); Text(String(localized: "Mittel")).tag(1); Text(String(localized: "Lang")).tag(2)
                    } label: { Label(String(localized: "Dauer"), systemImage: "timer") }
                    .pickerStyle(.menu)
                    Button(String(localized: "Alle Fotos anzeigen"), systemImage: "square.grid.3x3") { grid = true }
                    Button(String(localized: "Als Video teilen"), systemImage: "square.and.arrow.up") {
                        let s = curated, t = title, st = style, m = mood
                        Task { await MemoryExport.share(memory, slides: s, title: t, style: st, mood: m, app: app) }
                    }
                    Divider()
                    MemoryMenuItems(memory: memory) { close() }
                } label: { Image(systemName: "ellipsis").frame(width: 46, height: 46) }
                    .glassEffect(.regular.tint(.black.opacity(0.35)).interactive(), in: .circle)
            }
            .padding(.horizontal, 16).padding(.top, 58)
            progress.padding(.horizontal, 20).padding(.top, 14)
            Spacer()
            // Rückblick-Mix: seitlich wischen (Punkte zeigen, welcher Mix aktiv ist)
            VStack(spacing: 8) {
                Text(mixIndex >= 0 ? MemoryMix.all[mixIndex].title : String(localized: "Eigener Mix")).font(.system(size: 15, weight: .semibold))
                HStack(spacing: 6) {
                    ForEach(MemoryMix.all.indices, id: \.self) { i in
                        Circle().fill(.white.opacity(i == mixIndex ? 1 : 0.35)).frame(width: 7, height: 7)
                    }
                }
                Text(String(localized: "Zum Ändern seitlich wischen")).font(.system(size: 12)).opacity(0.7)
            }
            .offset(x: mixDrag / 3)
            .padding(.bottom, 26)
            HStack(spacing: 22) {
                circle(muted ? "speaker.slash.fill" : "speaker.wave.2.fill", size: 54) { muted.toggle() }
                circle("music.note.list", size: 54) { mixSheet = true }
                Button { resume() } label: {
                    Image(systemName: "play.fill").font(.system(size: 28)).frame(width: 76, height: 76).contentShape(.rect)
                }
                .glassEffect(.regular.tint(.black.opacity(0.35)).interactive(), in: .circle)
                circle("square.grid.3x3", size: 54) { grid = true }
                circle("arrow.counterclockwise", size: 54) { restart() }
            }
            .padding(.bottom, 50)
        }
        .font(.system(size: 19, weight: .semibold))
        .foregroundStyle(.white)
        .buttonStyle(.plain)
        .background {
            VStack {
                LinearGradient(colors: [.black.opacity(0.55), .clear], startPoint: .top, endPoint: .bottom).frame(height: 190)
                Spacer()
                LinearGradient(colors: [.clear, .black.opacity(0.6)], startPoint: .top, endPoint: .bottom).frame(height: 300)
            }
            .ignoresSafeArea().allowsHitTesting(false)
        }
        .transition(.opacity)
    }

    /// Fortschritt in Szenen-Abschnitten (Tippen springt zur Szene).
    private var progress: some View {
        let t = clock.time()
        return GeometryReader { g in
            HStack(spacing: 2) {
                ForEach(scenes) { s in
                    let w = max(2, (g.size.width - CGFloat(scenes.count - 1) * 2) * CGFloat(s.duration / max(total, 1)))
                    let f = max(0, min(1, (t - s.start) / s.duration))
                    Capsule().fill(.white.opacity(0.3))
                        .overlay(alignment: .leading) { Capsule().fill(.white).frame(width: w * CGFloat(f)) }
                        .frame(width: w)
                        .contentShape(Rectangle().inset(by: -8))
                        .onTapGesture { clock.seek(s.start + 0.01) }
                }
            }
        }
        .frame(height: 3)
    }

    private func circle(_ icon: String, size: CGFloat = 46, _ action: @escaping () -> Void) -> some View {
        Button(action: action) { Image(systemName: icon).frame(width: size, height: size) }
            .glassEffect(.regular.tint(.black.opacity(0.35)).interactive(), in: .circle)
    }

    // MARK: Ende (Apple: PlaybackEnd + Up Next)

    private func endOverlay(size: CGSize) -> some View {
        ZStack {
            Color.black.opacity(0.55).ignoresSafeArea()
            VStack(spacing: 18) {
                HStack {
                    circle("xmark") { close() }
                    Spacer()
                }
                .padding(.horizontal, 16).padding(.top, 58)
                Spacer()
                Text(title).font(.system(size: 34, weight: .bold)).multilineTextAlignment(.center)
                Text(memory.subtitle).font(.system(size: 15, weight: .semibold)).opacity(0.8)
                HStack(spacing: 28) {
                    VStack(spacing: 6) { circle("arrow.counterclockwise", size: 60) { restart() }; Text(String(localized: "Nochmal")).font(.footnote) }
                    VStack(spacing: 6) {
                        circle("square.and.arrow.up", size: 60) {
                            countdown = nil
                            let s = curated, t = title, st = style, m = mood
                            Task { await MemoryExport.share(memory, slides: s, title: t, style: st, mood: m, app: app) }
                        }
                        Text(String(localized: "Teilen")).font(.footnote)
                    }
                }
                .padding(.top, 10)
                Spacer()
                if let n = next {
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            Text(String(localized: "Als Nächstes")).font(.system(size: 15, weight: .semibold))
                            Spacer()
                            if let c = countdown {
                                Button { countdown = nil } label: {
                                    Text(String(localized: "in \(c) s · Abbrechen")).font(.system(size: 13, weight: .medium)).opacity(0.8)
                                }
                            }
                        }
                        Button { playNext() } label: {
                            HStack(spacing: 12) {
                                AssetThumb(id: n.key.id, size: .thumbnail).frame(width: 64, height: 64)
                                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(n.title).font(.system(size: 17, weight: .semibold)).lineLimit(1)
                                    Text(n.subtitle).font(.system(size: 13)).opacity(0.75)
                                }
                                Spacer()
                                Image(systemName: "play.fill")
                            }
                            .padding(12)
                            .glassEffect(.regular.tint(.black.opacity(0.35)).interactive(), in: .rect(cornerRadius: 20))
                        }
                    }
                    .padding(.horizontal, 20).padding(.bottom, 50)
                }
            }
            .foregroundStyle(.white)
            .buttonStyle(.plain)
        }
        .transition(.opacity)
    }

    /// „Rückblick-Mix“ im Detail: Musik und Stil einzeln wählen.
    private var mixPicker: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text(String(localized: "Rückblick-Mix")).font(.system(size: 20, weight: .bold)).padding(.top, 22)
            Text(String(localized: "Musik")).font(.system(size: 15, weight: .semibold)).foregroundStyle(.secondary)
            ScrollView(.horizontal) {
                HStack(spacing: 10) {
                    ForEach(MemoryMood.allCases) { m in
                        Button { mood = m } label: {
                            Label(m.title, systemImage: m.icon).font(.system(size: 15, weight: .semibold))
                                .padding(.horizontal, 14).frame(height: 40)
                                .background(Capsule().fill(mood == m ? Color.white : Color(white: 0.18)))
                                .foregroundStyle(mood == m ? .black : .white)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            .scrollIndicators(.hidden)
            Text(String(localized: "Stil")).font(.system(size: 15, weight: .semibold)).foregroundStyle(.secondary)
            ScrollView(.horizontal) {
                HStack(spacing: 10) {
                    ForEach(MemoryStyle.allCases) { s in
                        Button { style = s } label: {
                            VStack(spacing: 6) {
                                AssetThumb(id: memory.key.id, size: .thumbnail).scaledToFill()
                                    .frame(width: 70, height: 70).memoryStyle(s)
                                    .clipShape(RoundedRectangle(cornerRadius: 12))
                                    .overlay(RoundedRectangle(cornerRadius: 12).stroke(style == s ? Color.white : .clear, lineWidth: 2.5))
                                Text(s.title).font(.system(size: 12, weight: .medium)).foregroundStyle(style == s ? .white : .secondary)
                            }
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            .scrollIndicators(.hidden)
            Spacer()
        }
        .padding(.horizontal, 20)
        .preferredColorScheme(.dark)
    }
}
