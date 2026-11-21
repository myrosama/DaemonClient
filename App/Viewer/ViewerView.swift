import SwiftUI
import AVKit
import MapKit

struct ViewerView: View {
    @State var assets: [Asset]
    let start: Int
    @State private var selection: String = ""
    @State private var chrome = true
    @State private var showInfo = false
    @State private var editing: Asset?
    @State private var sheet: ActionSheet?
    @State private var video = VideoState()
    @State private var analysis = PhotoAnalysis()
    /// Live-Photo-Effekt je Foto (gemerkt, siehe LiveMode)
    @State private var liveModes: [String: LiveMode] = [:]
    /// Wischen durch die Vorschau-Leiste: Fotos wechseln im Takt, Video und Analyse erst beim Loslassen
    @State private var stripScrubbing = false
    /// Wischen nach unten zum Schließen: Versatz des Fotos (eigene Geste, siehe ViewerDismissGesture)
    @State private var drag: CGSize = .zero
    private var dragProgress: CGFloat { min(1, max(0, drag.height / 400)) }
    @Environment(\.dismiss) private var dismiss
    @Environment(TimelineStore.self) private var timeline
    @Environment(AppModel.self) private var app

    init(assets: [Asset], start: Int) {
        _assets = State(initialValue: assets)
        self.start = start
        _selection = State(initialValue: assets.indices.contains(start) ? assets[start].id : "")
    }

    private var current: Asset? { assets.first { $0.id == selection } }

    var body: some View {
        ZStack {
            Color.black.opacity(1 - dragProgress).ignoresSafeArea()
            TabView(selection: $selection) {
                ForEach(assets) { a in
                    Page(asset: a, isCurrent: a.id == selection, chrome: $chrome, video: video,
                         live: liveModes[a.id] ?? LiveMode.get(a.id), analysis: analysis)
                        .tag(a.id)
                }
            }
            .tabViewStyle(.page(indexDisplayMode: .never))
            .ignoresSafeArea()
            // wie in Fotos: nur das Foto folgt dem Finger und wird kleiner, Leisten und Hintergrund blenden aus
            .scaleEffect(1 - dragProgress * 0.3)
            .offset(drag)
            .background(ViewerDismissGesture(changed: { drag = $0 }, ended: { t, v in
                if t.height > 110 || (t.height > 40 && v.y > 900) { dismiss() }
                else { withAnimation(.spring(duration: 0.3)) { drag = .zero } }
            }))

            if chrome, drag == .zero, let a = current {
                VStack {
                    topBar(a)
                    if a.isLivePhoto && a.isImage { liveMenu(a).frame(maxWidth: .infinity, alignment: .leading).padding(.leading, 18) }
                    Spacer()
                    if a.isVideo, !video.unplayable { VideoControls(video: video).padding(.bottom, 6) }
                    if assets.count > 1 || a.isVideo {
                        ScrubberStrip(assets: assets, selection: $selection, video: video) { on in
                            stripScrubbing = on
                            if !on { settled(selection) }
                        }
                        .frame(height: 30).padding(.bottom, 10)
                    }
                    bottomBar(a)
                }
                .transition(.opacity)
            }
        }
        .statusBarHidden(!chrome)
        .onChange(of: selection, initial: true) { _, id in
            app.zoomID = id   // beim Schließen zur gerade gezeigten Kachel zurückzoomen
            if stripScrubbing { video.stop(); return }
            settled(id)
        }
        // Während ein Video läuft, blenden sich die Leisten nach kurzer Zeit aus; angehalten kommen sie zurück
        .task(id: "\(video.playing)\(chrome)") {
            if video.playing, chrome {
                try? await Task.sleep(for: .seconds(2.5))
                if video.playing, !Task.isCancelled { withAnimation(.easeInOut(duration: 0.25)) { chrome = false } }
            }
        }
        .onChange(of: video.playing) { _, p in if !p { withAnimation(.easeInOut(duration: 0.2)) { chrome = true } } }
        .onDisappear { video.stop(); Orientation.set(.portrait) }
        // Quer drehen nur in der Einzelansicht selbst – Bearbeiten, Info und Teilen bleiben im Hochformat
        .onAppear { Orientation.set(.allButUpsideDown); ViewerZoom.zoomed = false }
        .onChange(of: editing != nil || showInfo || sheet != nil, initial: true) { _, busy in
            Orientation.set(busy ? .portrait : .allButUpsideDown)
        }
        // Text/Objekte im Foto erkennen, sobald es gezeigt wird (VisionKit, auf dem iPhone)
        .task(id: "\(selection)\(stripScrubbing)") {
            analysis.lookUp = false
            if !stripScrubbing, let a = current { await analysis.analyze(a) }
        }
        .overlay(alignment: .top) { VStack { BusyBadge(); ToastBadge() } }
        .actionSheets($sheet)
        .fullScreenCover(item: $editing) { a in
            if a.isVideo { VideoTrimView(asset: a) { result in replace(a, with: result) } }
            else { EditorView(asset: a) { result in replace(a, with: result) } }
        }
        .sheet(isPresented: $showInfo) {
            if let a = current {
                InfoSheet(asset: a, lookUp: analysis.hasLookUp(a.id) ? { showInfo = false; analysis.lookUp = true } : nil)
                    .presentationDetents([.medium, .large])
                    .preferredColorScheme(.dark)   // wie die Fotos-Ansicht immer dunkel (Bögen erben das Fenster-Erscheinungsbild)
            }
        }
    }

    /// Foto steht (nicht nur vorbeigewischt): merken, Video starten (wie Apple sofort), sonst anhalten.
    private func settled(_ id: String) {
        guard !id.isEmpty else { return }
        RecentStore.add(id, to: .recentlyViewed)
        if let a = current, a.isVideo, !Connectivity.shared.serverOffline { video.attach(a); video.play() } else { video.stop() }
    }

    private func topBar(_ a: Asset) -> some View {
        HStack {
            Button { dismiss() } label: {
                Image(systemName: "chevron.left").font(.system(size: 19, weight: .semibold))
                    .foregroundStyle(.white).frame(width: 46, height: 46).contentShape(.rect)
            }
            .glassEffect(.regular.interactive(), in: .circle)
            Spacer()
            VStack(spacing: 1) {
                Text(Fmt.relativeDay(a.date)).font(.system(size: 16, weight: .semibold))
                Text(Fmt.time.string(from: a.date) + (a.city.map { " · \($0)" } ?? ""))
                    .font(.system(size: 12)).opacity(0.8)
            }
            .foregroundStyle(.white)
            .padding(.horizontal, 16).padding(.vertical, 6)
            .glassEffect(.regular, in: .capsule)
            Spacer()
            if a.isVideo {
                Button { video.muted.toggle() } label: {
                    Image(systemName: video.muted ? "speaker.slash.fill" : "speaker.wave.2.fill")
                        .font(.system(size: 16, weight: .semibold)).foregroundStyle(.white).frame(width: 46, height: 46).contentShape(.rect)
                }
                .glassEffect(.regular.interactive(), in: .circle)
                .accessibilityLabel(video.muted ? String(localized: "Ton an") : String(localized: "Ton aus"))
                AirPlayButton().frame(width: 46, height: 46).glassEffect(.regular.interactive(), in: .circle)
            }
            if !a.isLocalOnly {
            Menu {
                AssetMenu(assets: [a], style: .viewer, present: { sheet = $0 }) { removeLocal(a) }
                if a.isVideo {
                    Button(String(localized: "Videobild als Foto sichern"), systemImage: "photo.badge.plus") {
                        let t = video.time
                        Task { await AssetActions.saveVideoFrame(a, at: t, app: app, timeline: timeline) }
                    }
                }
                if a.isLivePhoto && a.isImage {
                    Button(String(localized: "Als Video sichern"), systemImage: "video.badge.plus") {
                        Task { await AssetActions.saveLiveAsVideo(a, app: app, timeline: timeline) }
                    }
                }
                if a.isVideo {
                    // Für Fehlerberichte (GitHub-Issue #1): was die App angefragt hat, Antworten, Codec, Zeiten
                    Button(String(localized: "Video-Diagnose kopieren"), systemImage: "stethoscope") {
                        Task {
                            UIPasteboard.general.string = await video.diagnostics(a)
                            app.toast(String(localized: "Diagnose kopiert"))
                        }
                    }
                }
            } label: {
                Image(systemName: "ellipsis").font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(.white).frame(width: 46, height: 46).contentShape(.rect)
            }
            .glassEffect(.regular.interactive(), in: .circle)
            }
        }
        .padding(.horizontal, 16)
    }

    /// „LIVE ⌄“ oben links wie bei Apple: Effekt wählen.
    private func liveMenu(_ a: Asset) -> some View {
        let mode = liveModes[a.id] ?? LiveMode.get(a.id)
        return Menu {
            Picker(String(localized: "Effekt"), selection: Binding(get: { mode }, set: { m in liveModes[a.id] = m; LiveMode.set(m, for: a.id) })) {
                ForEach(LiveMode.allCases) { m in Label(m.title, systemImage: m.icon).tag(m) }
            }
        } label: {
            HStack(spacing: 5) {
                Image(systemName: mode.icon).font(.system(size: 13, weight: .semibold))
                Text(mode == .live ? "LIVE" : mode.title.uppercased()).font(.system(size: 12, weight: .bold))
                Image(systemName: "chevron.down").font(.system(size: 10, weight: .bold))
            }
            .foregroundStyle(.white)
            .padding(.horizontal, 12).frame(height: 30)
            .glassEffect(.regular.interactive(), in: .capsule)
        }
        .padding(.top, 4)
    }

    @ViewBuilder private func bottomBar(_ a: Asset) -> some View {
        if a.isLocalOnly { localBar(a) } else if a.trashedAt != nil { trashBar(a) } else { normalBar(a) }
    }

    /// Noch nicht gesichert: Bearbeiten, Favorit usw. gehen erst, wenn das Foto auf dem Server ist
    private func localBar(_ a: Asset) -> some View {
        HStack(spacing: 8) {
            if case .uploading(let p) = LocalPending.shared.badges[a.id] {
                ProgressView(value: p).progressViewStyle(.circular).controlSize(.small).tint(.white)
                Text(String(localized: "Wird gesichert …"))
            } else if LocalPending.shared.badges[a.id] == .processing {
                Image(systemName: "checkmark.icloud")
                Text(String(localized: "Gesichert, wird verarbeitet …"))
            } else {
                Image(systemName: "icloud.slash")
                Text(String(localized: "Noch nicht gesichert"))
            }
        }
        .font(.system(size: 15, weight: .medium)).foregroundStyle(.white)
        .padding(.horizontal, 18).frame(height: 46)
        .glassEffect(.regular, in: .capsule)
        .padding(.bottom, 6)
    }

    /// In „Zuletzt gelöscht“ wie bei Apple: Löschen · verbleibende Tage · Wiederherstellen.
    private func trashBar(_ a: Asset) -> some View {
        HStack {
            Button(String(localized: "Löschen")) { sheet = .confirmDeleteForever([a]) { removeLocal(a) } }
                .foregroundStyle(.red)
                .padding(.horizontal, 18).frame(height: 48)
                .glassEffect(.regular.interactive(), in: .capsule)
            Spacer()
            Text(TrashDays.text(a)).font(.system(size: 13)).foregroundStyle(.secondary)
            Spacer()
            Button(String(localized: "Wiederherstellen")) {
                AssetActions.restore([a.id], app: app, timeline: timeline); removeLocal(a)
            }
            .padding(.horizontal, 18).frame(height: 48)
            .glassEffect(.regular.interactive(), in: .capsule)
        }
        .font(.system(size: 17, weight: .semibold))
        .foregroundStyle(.white)
        .buttonStyle(.plain)
        .padding(.horizontal, 20)
        .padding(.bottom, 6)
    }

    private func normalBar(_ a: Asset) -> some View {
        GlassEffectContainer {
            HStack(spacing: 12) {
                // Tippen teilt die Datei wie in Fotos, langes Drücken bietet zusätzlich „Als Link teilen“
                Menu {
                    Button(String(localized: "Datei senden"), systemImage: "doc") { Task { await ShareService.share([a.id], app: app) } }
                    Button(String(localized: "Link teilen (Heimnetz/VPN)"), systemImage: "link") { sheet = .shareLink([a.id]) }
                    Button(String(localized: "Teilen-Optionen …"), systemImage: "slider.horizontal.3") { sheet = .shareOptions([a.id]) }
                } label: {
                    Image(systemName: "square.and.arrow.up").frame(width: 52, height: 52).contentShape(.rect)
                } primaryAction: { Task { await ShareService.share([a.id], app: app) } }
                .glassEffect(.regular.interactive(), in: .circle)
                Spacer()
                HStack(spacing: 2) {
                    // Tippfläche 44 × 52 (Apple: mindestens 44 pt), sonst traf man nur das 20-pt-Symbol
                    Button { toggleFavorite(a) } label: {
                        Image(systemName: a.isFavorite ? "heart.fill" : "heart").frame(width: 44, height: 52).contentShape(.rect)
                    }
                    Button { showInfo = true } label: {
                        // wie Apple: Sterne am „i“, wenn sich etwas im Foto nachschlagen lässt
                        Image(systemName: "info.circle")
                            .overlay(alignment: .topTrailing) {
                                if analysis.hasLookUp(a.id) {
                                    Image(systemName: "sparkle").font(.system(size: 9, weight: .bold)).offset(x: 5, y: -4)
                                }
                            }
                            .frame(width: 44, height: 52).contentShape(.rect)
                    }
                    .accessibilityLabel(analysis.hasLookUp(a.id) ? String(localized: "Info, Nachschlagen verfügbar") : String(localized: "Info"))
                    Button { editing = a } label: { Image(systemName: "slider.horizontal.3").frame(width: 44, height: 52).contentShape(.rect) }
                        .accessibilityLabel(String(localized: "Bearbeiten"))
                }
                .padding(.horizontal, 12).frame(height: 52)
                .glassEffect(.regular.interactive(), in: .capsule)
                Spacer()
                Button(role: .destructive) { trash(a) } label: {
                    Image(systemName: "trash").frame(width: 52, height: 52).contentShape(.rect)
                }
                .glassEffect(.regular.interactive(), in: .circle)
            }
            .font(.system(size: 20, weight: .medium))
            .foregroundStyle(.white)
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 20)
        .padding(.bottom, 6)
    }

    private func toggleFavorite(_ a: Asset) {
        guard let i = assets.firstIndex(of: a) else { return }
        var b = a; b.isFavorite.toggle()
        assets[i] = b; timeline.update(b)
        Task { try? await ImmichClient.shared.setFavorite(a.id, b.isFavorite) }
    }

    /// Nach dem Bearbeiten: gleiche ID (Server-Zuschnitt) oder neue bearbeitete Fassung.
    private func replace(_ old: Asset, with new: Asset) {
        guard let i = assets.firstIndex(where: { $0.id == old.id }) else { return }
        assets[i] = new
        selection = new.id
        Task { await timeline.reload() }
    }

    private func trash(_ a: Asset) {
        Task { try? await ImmichClient.shared.trash([a.id]) }
        timeline.remove(a.id)
        removeLocal(a)
    }

    /// Nach Löschen/Ausblenden zum nächsten Objekt springen.
    private func removeLocal(_ a: Asset) {
        guard let i = assets.firstIndex(where: { $0.id == a.id }) else { return }
        assets.remove(at: i)
        if assets.isEmpty { dismiss(); return }
        selection = assets[min(i, assets.count - 1)].id
    }
}

private struct Page: View {
    let asset: Asset
    let isCurrent: Bool
    @Binding var chrome: Bool
    let video: VideoState
    let live: LiveMode
    let analysis: PhotoAnalysis

    var body: some View {
        Group {
            if asset.isVideo {
                VideoPage(asset: asset, video: video, chrome: $chrome)
            } else {
                ZoomableImage(asset: asset, chrome: $chrome, live: isCurrent ? live : .live,
                              analysis: isCurrent ? analysis : nil)
            }
        }
    }
}

/// Originale der zuletzt angesehenen Fotos (HDR, bis 4096 px) – wenige im Speicher, sie sind groß.
@MainActor
final class OriginalImages {
    static let shared = OriginalImages()
    private var cache: [(String, UIImage)] = []
    private var running: [String: Task<UIImage?, Never>] = [:]
    /// Originaldaten von Fotos mit Tiefenkarte (für die räumliche Szene)
    private var depthData: [(String, Data)] = []
    func hasDepth(_ id: String) -> Bool { depthData.contains { $0.0 == id } }

    /// Vorder-/Hintergrund für die räumliche Szene (auf 2048 px verkleinert).
    func spatialLayers(_ id: String) async -> SpatialLayers? {
        guard let data = depthData.first(where: { $0.0 == id })?.1 else { return nil }
        return await Task.detached(priority: .userInitiated) { () -> SpatialLayers? in
            guard let img = CIImage(data: data, options: [.applyOrientationProperty: true]), let depth = DepthMaps(data: data) else { return nil }
            let s = min(1, 2048 / max(img.extent.width, img.extent.height))
            return SpatialLayers.make(image: img.transformed(by: CGAffineTransform(scaleX: s, y: s)), depth: depth)
        }.value
    }

    func load(_ id: String) async -> UIImage? {
        if let hit = cache.first(where: { $0.0 == id })?.1 { return hit }
        if Connectivity.shared.serverOffline { return nil }
        let t = running[id] ?? Task {
            guard let url = ImmichClient.shared.originalURL(id), let data = try? await ImmichClient.shared.data(url) else { return nil }
            if await Task.detached(priority: .utility, operation: { DepthMaps(data: data) != nil }).value {
                depthData.removeAll { $0.0 == id }; depthData.append((id, data)); if depthData.count > 2 { depthData.removeFirst() }
            }
            return await Task.detached(priority: .userInitiated) { () -> UIImage? in
                var c = UIImageReader.Configuration()
                #if targetEnvironment(simulator)
                c.prefersHighDynamicRange = false           // der Simulator zeichnet HDR-Bilder schwarz
                #else
                c.prefersHighDynamicRange = true            // Gain-Map/HDR erhalten
                #endif
                c.preparesImagesForDisplay = true
                c.preferredThumbnailSize = CGSize(width: 4096, height: 4096)
                return UIImageReader(configuration: c).image(data: data)
            }.value
        }
        running[id] = t
        let img = await t.value
        running[id] = nil
        if let img { cache.removeAll { $0.0 == id }; cache.append((id, img)); if cache.count > 3 { cache.removeFirst() } }
        return img
    }
}

/// Bild mit Pinch-Zoom, Doppeltipp und Verschieben.
private struct ZoomableImage: View {
    let asset: Asset
    @Binding var chrome: Bool
    var live: LiveMode = .live
    var analysis: PhotoAnalysis? = nil
    @State private var exposure: UIImage?
    @State private var scale: CGFloat = 1
    @State private var playLive = false
    @State private var full: UIImage?
    @State private var spatialAvailable = false
    @State private var spatial: SpatialLayers?
    @Environment(AppModel.self) private var app
    /// Apples „Vitality“: beim Hinwischen bewegt sich ein Live Photo einmal kurz (stumm), dann steht das Foto
    /// Der Clip wird vorher geladen (sonst ist das feste Zeitfenster beim Streamen oft vorbei, bevor ein Bild kommt).
    @State private var vitality: URL?
    @State private var vitalityShown = false

    var body: some View {
        // Zoom wie in Fotos über eine UIScrollView (GitHub #52): Pinch am Fingerpunkt, gezoomt frei schieben mit
        // Schwung und Abfedern am Rand, Doppeltipp zoomt an die getippte Stelle. Ungezoomt ist das Schieben aus,
        // damit Blättern (TabView) und Wischen zum Schließen wie bisher gehen.
        ZoomScroll(ratio: asset.ratio, pixelWidth: full.map { $0.size.width * $0.scale } ?? 0, scale: $scale, active: analysis != nil,
                   onTap: { withAnimation(.easeInOut(duration: 0.2)) { chrome.toggle() } }) {
            layers.environment(app)
        }
        .ignoresSafeArea()
        .overlay(alignment: .bottom) {
            // ohne Server: gespeicherte Vorschau statt Original (wie Apple bei „Speicher optimieren“)
            if Connectivity.shared.serverOffline && chrome && scale <= 1.01 {
                OfflineBadge(text: String(localized: "Offline – Vorschau, Original nicht verfügbar")).padding(.bottom, 170)
            }
        }
        .task(id: live) {
            guard live == .longExposure, exposure == nil, let v = asset.livePhotoVideoId else { return }
            exposure = await LiveClip.longExposure(v)
        }
        .task(id: analysis != nil) {
            guard analysis != nil, asset.isLivePhoto, live == .live, !vitalityShown, let v = asset.livePhotoVideoId else { return }
            try? await Task.sleep(for: .milliseconds(250))
            guard !Task.isCancelled, let f = await LiveClip.file(v), !Task.isCancelled else { return }
            vitalityShown = true
            withAnimation(.easeIn(duration: 0.15)) { vitality = f }
            // falls das Ende-Signal ausbleibt
            try? await Task.sleep(for: .seconds(3))
            if vitality != nil { withAnimation(.easeOut(duration: 0.3)) { vitality = nil } }
        }
        .task(id: "\(analysis != nil)\(app.alwaysOriginal || scale > 1.01)") {
            // nur das gerade gezeigte Foto, kurz verzögert (beim schnellen Wischen nichts laden);
            // „Original immer anzeigen“ aus → erst beim Hineinzoomen (Immichs Vorschau ist ohne HDR)
            guard analysis != nil, full == nil, app.alwaysOriginal || scale > 1.01 else { return }
            try? await Task.sleep(for: .milliseconds(app.alwaysOriginal ? 200 : 0))
            guard !Task.isCancelled, let img = await OriginalImages.shared.load(asset.id) else { return }
            withAnimation(.easeOut(duration: 0.2)) { full = img; spatialAvailable = OriginalImages.shared.hasDepth(asset.id) }
        }
        .overlay(alignment: .topTrailing) {
            // Apple: Knopf für die räumliche Szene oben rechts bei geeigneten Fotos
            if spatialAvailable && chrome && scale <= 1.01 {
                Button {
                    Task { spatial = await OriginalImages.shared.spatialLayers(asset.id); if spatial == nil { app.toast(String(localized: "Räumliche Szene nicht möglich")) } }
                } label: {
                    Image(systemName: "cube.transparent").font(.system(size: 17, weight: .semibold)).foregroundStyle(.white).frame(width: 44, height: 44).contentShape(.rect)
                }
                .glassEffect(.regular.interactive(), in: .circle)
                .padding(.trailing, 16).padding(.top, 120)
                .accessibilityLabel(String(localized: "Räumliche Szene"))
            }
        }
        .fullScreenCover(isPresented: Binding(get: { spatial != nil }, set: { if !$0 { spatial = nil } })) {
            if let spatial { SpatialSceneView(layers: spatial) { self.spatial = nil } }
        }
    }

    /// Alle Ebenen eines Fotos in der Größe des eingepassten Bildes (Vorschau, Original, Live-Text, Live Photo)
    private var layers: some View {
        ZStack {
            AssetThumb(id: asset.id, size: .preview)
            // Original über der Vorschau: scharf beim Zoomen und mit HDR (Gain-Map) wie bei Apple
            if let full {
                Image(uiImage: full).resizable()
                    .allowedDynamicRange(.high)
                    .transition(.opacity)
            }
            if let analysis, PhotoAnalysis.supported, !playLive, live != .loop, live != .bounce {
                AnalysisOverlay(analysis: analysis.analysis(asset.id), chrome: chrome, lookUp: analysis.lookUp)
            }
            if let v = asset.livePhotoVideoId {
                switch live {
                case .loop, .bounce:
                    LiveEffectPlayer(videoID: v, bounce: live == .bounce).id("\(v)\(live.rawValue)")
                case .longExposure:
                    if let exposure { Image(uiImage: exposure).resizable() }
                    else { ProgressView().tint(.white) }
                case .live:
                    if playLive { LoopingVideo(id: v) }
                    else if let f = vitality {
                        VitalityVideo(url: f) { withAnimation(.easeOut(duration: 0.3)) { vitality = nil } }.transition(.opacity)
                    }
                case .off: EmptyView()
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .clipped()
        .contentShape(.rect)
        .onLongPressGesture(minimumDuration: 0.3, perform: {}, onPressingChanged: { p in
            if asset.isLivePhoto, live == .live, scale <= 1.01 { playLive = p }
        })
    }
}

private struct VideoPage: View {
    let asset: Asset
    let video: VideoState
    @Binding var chrome: Bool

    var body: some View {
        ZStack {
            AssetThumb(id: asset.id, size: .preview).aspectRatio(asset.ratio, contentMode: .fit)
            if video.id == asset.id, video.unplayable { UnplayableVideoNote() }
            else if video.id == asset.id, let p = video.player { PlayerSurface(player: p) }
            else if Connectivity.shared.serverOffline {
                VStack(spacing: 10) {
                    Image(systemName: "play.slash.fill").font(.system(size: 40))
                    Text(String(localized: "Video braucht Verbindung zum Server")).font(.headline)
                }
                .foregroundStyle(.white).shadow(radius: 6)
            }
        }
        .contentShape(Rectangle())
        .onTapGesture { withAnimation(.easeInOut(duration: 0.2)) { chrome.toggle() } }
        .onChange(of: Connectivity.shared.serverOffline) { _, off in
            if !off, video.id.isEmpty || video.id == asset.id { video.attach(asset); video.play() }
        }
    }
}

struct OfflineBadge: View {
    let text: String
    var body: some View {
        Label(text, systemImage: "wifi.slash")
            .font(.system(size: 13, weight: .semibold)).foregroundStyle(.white)
            .padding(.horizontal, 14).padding(.vertical, 8)
            .glassEffect(.regular, in: .capsule)
    }
}

/// Statt schwarzem Bild: Video ist auf dem iPhone nicht abspielbar – und wie der Server-Admin es lösen kann.
private struct UnplayableVideoNote: View {
    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: "play.slash.fill").font(.system(size: 40))
            Text(String(localized: "Dieses Video kann das iPhone nicht abspielen")).font(.headline)
            Text(String(localized: "Das Dateiformat wird von iOS nicht unterstützt (z. B. HEVC mit Kennung „hev1“, VP9 oder AV1). Abhilfe in Immich unter Verwaltung → Einstellungen → Video-Transkodierung: Echtzeit-Transkodierung einschalten oder solche Videos in H.264 umwandeln lassen."))
                .font(.footnote).multilineTextAlignment(.center).foregroundStyle(.white.opacity(0.85))
        }
        .foregroundStyle(.white).shadow(radius: 6)
        .padding(24)
        .frame(maxWidth: 420)
        .background(.black.opacity(0.55), in: .rect(cornerRadius: 22))
        .padding(20)
    }
}

/// Live-Photo-Video stumm in Schleife (beim Gedrückthalten).
private struct LoopingVideo: UIViewRepresentable {
    let id: String
    var muted = false
    func makeUIView(context: Context) -> PlayerView {
        let v = PlayerView()
        if let url = ImmichClient.shared.videoURL(id) {
            let item = AVPlayerItem(asset: ImmichClient.shared.avAsset(url))
            let p = AVQueuePlayer(); p.isMuted = muted
            context.coordinator.looper = AVPlayerLooper(player: p, templateItem: item)
            v.layer0.player = p; v.layer0.videoGravity = .resizeAspect
            p.play()
        }
        return v
    }
    func updateUIView(_ uiView: PlayerView, context: Context) {}
    func makeCoordinator() -> Coord { Coord() }
    final class Coord { var looper: AVPlayerLooper? }
    final class PlayerView: UIView {
        override class var layerClass: AnyClass { AVPlayerLayer.self }
        var layer0: AVPlayerLayer { layer as! AVPlayerLayer }
    }
}

/// Apples „Vitality“: einmal die Bewegung bis zum Foto-Zeitpunkt (Mitte des Live-Clips), stumm, dann `done`.
private struct VitalityVideo: UIViewRepresentable {
    let url: URL
    // @MainActor: der Beobachter läuft auf der Hauptwarteschlange; so gilt der Abschluss als sicher weitergebbar (Swift 6 / neues SDK)
    let done: @MainActor () -> Void
    func makeUIView(context: Context) -> LoopingVideo.PlayerView {
        let v = LoopingVideo.PlayerView()
        let item = AVPlayerItem(url: url)
        let p = AVPlayer(playerItem: item); p.isMuted = true
        v.layer0.player = p; v.layer0.videoGravity = .resizeAspect
        let c = context.coordinator, done = done
        c.player = p
        c.end = NotificationCenter.default.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main) { _ in
            MainActor.assumeIsolated { done() }
        }
        Task { @MainActor in
            let d = (try? await item.asset.load(.duration).seconds) ?? 0
            let mid = d > 0.5 ? d / 2 : max(d, 0.1)
            item.forwardPlaybackEndTime = CMTime(seconds: mid, preferredTimescale: 600)
            await p.seek(to: CMTime(seconds: max(0, mid - 1.3), preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero)
            p.play()
        }
        return v
    }
    func updateUIView(_ uiView: LoopingVideo.PlayerView, context: Context) {}
    static func dismantleUIView(_ uiView: LoopingVideo.PlayerView, coordinator: Coord) {
        coordinator.player?.pause()
        if let e = coordinator.end { NotificationCenter.default.removeObserver(e) }
    }
    func makeCoordinator() -> Coord { Coord() }
    final class Coord { var player: AVPlayer?; var end: NSObjectProtocol? }
}

/// Geteiltes Album wie bei Apple: „Gefällt mir“ und Kommentare zum Foto (Immich-Aktivitäten).
private struct AlbumActivityView: View {
    let album: AlbumDTO
    let assetId: String
    @Environment(AppModel.self) private var app
    @State private var items: [ActivityDTO] = []
    @State private var draft = ""
    @State private var sending = false

    private var likes: [ActivityDTO] { items.filter { $0.type == "like" } }
    private var comments: [ActivityDTO] { items.filter { $0.type == "comment" } }
    private var myLike: ActivityDTO? { likes.first { $0.user.id == app.userID } }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("„\(album.albumName)“").font(.system(size: 15, weight: .semibold)).foregroundStyle(.secondary)
                Spacer()
                Button { Task { await toggleLike() } } label: {
                    Label(likes.isEmpty ? String(localized: "Gefällt mir") : "\(likes.count)", systemImage: myLike == nil ? "hand.thumbsup" : "hand.thumbsup.fill")
                        .font(.system(size: 15, weight: .medium))
                }
                .accessibilityLabel(myLike == nil ? String(localized: "Gefällt mir") : String(localized: "Gefällt mir nicht mehr"))
            }
            ForEach(comments) { c in
                VStack(alignment: .leading, spacing: 2) {
                    Text(c.user.name).font(.system(size: 13, weight: .semibold))
                    Text(c.comment ?? "").font(.system(size: 15))
                }
                .contextMenu {
                    if c.user.id == app.userID {
                        Button(String(localized: "Kommentar löschen"), systemImage: "trash", role: .destructive) { Task { await remove(c) } }
                    }
                }
            }
            HStack {
                TextField(String(localized: "Kommentar hinzufügen"), text: $draft, axis: .vertical).textFieldStyle(.roundedBorder)
                Button(String(localized: "Senden")) { Task { await send() } }
                    .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || sending)
            }
        }
        .padding(14)
        .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(Color(white: 0.12)))
        .task { items = (try? await ImmichClient.shared.activities(album: album.id, asset: assetId)) ?? [] }
    }

    private func toggleLike() async {
        if let l = myLike {
            try? await ImmichClient.shared.deleteActivity(l.id); items.removeAll { $0.id == l.id }
        } else if let a = try? await ImmichClient.shared.addActivity(album: album.id, asset: assetId, comment: nil) {
            items.append(a)
        }
    }
    private func send() async {
        let t = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return }
        sending = true; defer { sending = false }
        if let a = try? await ImmichClient.shared.addActivity(album: album.id, asset: assetId, comment: t) { items.append(a); draft = "" }
        else { app.toast(String(localized: "Kommentar nicht gesendet")) }
    }
    private func remove(_ c: ActivityDTO) async {
        try? await ImmichClient.shared.deleteActivity(c.id); items.removeAll { $0.id == c.id }
    }
}

/// Info wie in Fotos: Untertitel, Datum + Dateiname, Kamera-Karte, Karte mit „Anpassen“.
private struct InfoSheet: View {
    let asset: Asset
    /// nil = nichts zum Nachschlagen im Foto
    var lookUp: (() -> Void)? = nil
    @Environment(AppModel.self) private var app
    @State private var dto: AssetDTO?
    @State private var nearby: [MapMarkerDTO] = []
    /// „Mit Bereinigen bearbeitet“: alle so bearbeiteten Fotos (für den Tipp auf den Hinweis)
    @State private var cleanedIDs: [String]?
    @State private var nearbyChecked = false
    @State private var albums: [AlbumDTO] = []
    @State private var sharedAlbums: Set<String> = []
    @State private var naming: PersonDTO?
    @State private var newName = ""
    @State private var caption = ""
    @State private var sheet: ActionSheet?
    @FocusState private var editingCaption: Bool

    var body: some View {
        NavigationStack {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                if let lookUp {
                    Button(action: lookUp) {
                        HStack(spacing: 12) {
                            Image(systemName: "sparkle.magnifyingglass").font(.system(size: 20)).foregroundStyle(.blue)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(String(localized: "Nachschlagen")).font(.system(size: 16, weight: .semibold))
                                Text(String(localized: "Pflanze, Tier, Sehenswürdigkeit oder Kunstwerk im Foto")).font(.system(size: 13)).foregroundStyle(.secondary)
                            }
                            Spacer()
                            Image(systemName: "chevron.right").foregroundStyle(.tertiary)
                        }
                        .padding(14)
                        .background(Color(white: 0.14), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                    }
                    .buttonStyle(.plain)
                    .padding(.top, 6)
                }
                TextField(String(localized: "Untertitel hinzufügen"), text: $caption, axis: .vertical)
                    .font(.system(size: 17))
                    .focused($editingCaption)
                    .submitLabel(.done)
                    .onChange(of: editingCaption) { _, f in if !f { saveCaption() } }
                    .padding(.top, lookUp == nil ? 16 : 6)   // mittig zwischen Blattkante und Trennlinie
                Divider()
                HStack(alignment: .firstTextBaseline) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(Fmt.fullDateTime.string(from: asset.date))
                            .font(.system(size: 16, weight: .semibold))
                        Text(fileName).font(.system(size: 15)).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button(String(localized: "Anpassen")) { sheet = .dateTime([asset]) }
                }
                if let ids = cleanedIDs {
                    NavigationLink(value: CollectionRoute.assets(title: String(localized: "Mit Bereinigen bearbeitet"), ids: ids)) {
                        Label(String(localized: "Mit Bereinigen bearbeitet"), systemImage: "eraser")
                            .font(.system(size: 15)).foregroundStyle(.secondary)
                    }
                    .buttonStyle(.plain)
                }
                if let src = Provenance.source(dto?.originalFileName, make: dto?.exifInfo?.make) {
                    Label(src, systemImage: Provenance.isScreen(src) ? "camera.viewfinder" : "square.and.arrow.down")
                        .font(.system(size: 15)).foregroundStyle(.secondary)
                }
                peopleRow
                albumsRow
                ForEach(albums.filter { sharedAlbums.contains($0.id) }) { AlbumActivityView(album: $0, assetId: asset.id) }
                cameraCard
                mapCard
            }
            .padding(.horizontal, 20).padding(.bottom, 30)
        }
        .scrollDismissesKeyboard(.immediately)
        .toolbar(.hidden, for: .navigationBar)
        .navigationDestination(for: CollectionRoute.self) { r in CollectionDetail(route: r, model: CollectionsModel()) }
        }
        .task {
            dto = try? await ImmichClient.shared.asset(asset.id)
            caption = dto?.exifInfo?.description ?? ""
            await loadCleaned()
            albums = (try? await ImmichClient.shared.albums(containing: asset.id)) ?? []
            if !albums.isEmpty { sharedAlbums = await ImmichClient.shared.sharedAlbumIDs() }
        }
        .actionSheets($sheet)
        .alert(String(localized: "Name"), isPresented: Binding(get: { naming != nil }, set: { if !$0 { naming = nil } })) {
            TextField(String(localized: "Name"), text: $newName)
            Button(String(localized: "Abbrechen"), role: .cancel) {}
            Button(String(localized: "Sichern")) {
                guard let p = naming else { return }
                let name = newName.trimmingCharacters(in: .whitespaces)
                Task {
                    try? await ImmichClient.shared.updatePerson(p.id, ["name": name])
                    dto = try? await ImmichClient.shared.asset(asset.id)
                }
            }
        } message: { Text(String(localized: "Wie heißt diese Person?")) }
    }

    /// Personen auf dem Foto (wie Apple: Gesichter mit Namen, unbenannte mit „Name hinzufügen“).
    @ViewBuilder private var peopleRow: some View {
        let people = (dto?.people ?? []).filter { $0.isHidden != true }
        if !people.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                Text(String(localized: "Personen")).font(.system(size: 15, weight: .semibold)).foregroundStyle(.secondary)
                ScrollView(.horizontal) {
                    HStack(spacing: 16) {
                        ForEach(people) { p in
                            if p.name.isEmpty {
                                Button { newName = ""; naming = p } label: { face(p, String(localized: "Name hinzufügen")) }.buttonStyle(.plain)
                            } else {
                                NavigationLink(value: CollectionRoute.person(PersonRef(id: p.id, name: p.name))) { face(p, p.name) }
                                    .buttonStyle(.plain)
                                    .contextMenu {
                                        // wie Fotos (REA: PXPhotoKitPersonMakeKeyPhotoActionPerformer)
                                        Button("Als Titelbild für \(p.name)", systemImage: "person.crop.square") {
                                            Task {
                                                do {
                                                    let api = ImmichClient.shared
                                                    func fetch() async -> Data? {
                                                        guard let base = api.personThumbURL(p.id) else { return nil }
                                                        // eigene Adresse je Abfrage, sonst antwortet der URL-Cache mit dem alten Bild
                                                        return try? await api.data(base.appending(queryItems: [URLQueryItem(name: "t", value: UUID().uuidString)]))
                                                    }
                                                    let before = await fetch()
                                                    try await api.updatePerson(p.id, ["featureFaceAssetId": asset.id])
                                                    app.toast(String(localized: "Titelbild festgelegt"))
                                                    // Server rechnet das Personenbild im Hintergrund neu – erst neu zeigen, wenn es da ist
                                                    for _ in 0..<20 {
                                                        try? await Task.sleep(for: .milliseconds(600))
                                                        if let now = await fetch(), now != before { break }
                                                    }
                                                    ImageCache.shared.bumpPerson(p.id)
                                                } catch { app.toast("Hat nicht geklappt") }
                                            }
                                        }
                                        Button("Das ist nicht \(p.name)", systemImage: "person.crop.circle.badge.xmark") {
                                            Task {
                                                do {
                                                    try await ImmichClient.shared.notThisPerson(asset: asset.id, person: p.id)
                                                    app.toast(String(localized: "Aus „\(p.name)“ entfernt"))
                                                } catch { app.toast(String(localized: "Hat nicht geklappt")) }
                                                dto = try? await ImmichClient.shared.asset(asset.id)
                                            }
                                        }
                                    }
                            }
                        }
                    }
                }
                .scrollIndicators(.hidden)
            }
        }
    }

    private func face(_ p: PersonDTO, _ title: String) -> some View {
        VStack(spacing: 6) {
            PersonThumb(id: p.id).frame(width: 60, height: 60).clipShape(Circle())
            Text(title).font(.system(size: 12, weight: .medium)).lineLimit(1).frame(width: 76)
                .foregroundStyle(p.name.isEmpty ? Color.blue : .primary)
        }
    }

    /// In welchen Alben das Foto liegt (Apple: „In Alben“).
    @ViewBuilder private var albumsRow: some View {
        if !albums.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                Text(albums.count == 1 ? String(localized: "In Album") : String(localized: "In \(albums.count) Alben")).font(.system(size: 15, weight: .semibold)).foregroundStyle(.secondary)
                ScrollView(.horizontal) {
                    HStack(spacing: 12) {
                        ForEach(albums) { al in
                            NavigationLink(value: CollectionRoute.album(AlbumRef(id: al.id, name: al.albumName))) {
                                VStack(alignment: .leading, spacing: 5) {
                                    Group { if let t = al.albumThumbnailAssetId { AssetThumb(id: t) } else { Color(white: 0.16) } }
                                        .frame(width: 86, height: 86).clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                                    Text(al.albumName).font(.system(size: 12, weight: .medium)).lineLimit(1).frame(width: 86, alignment: .leading)
                                }
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
                .scrollIndicators(.hidden)
            }
        }
    }

    private var fileName: String { ((dto?.originalFileName ?? "") as NSString).deletingPathExtension }

    private var cameraCard: some View {
        let e = dto?.exifInfo
        let ext = ((dto?.originalFileName ?? "") as NSString).pathExtension.uppercased()
        let format = ["HEIC": "HEIF", "JPG": "JPEG", "JPEG": "JPEG", "PNG": "PNG", "MOV": "MOV", "MP4": "MP4", "DNG": "RAW"][ext] ?? ext
        let w = e?.exifImageWidth ?? 0, h = e?.exifImageHeight ?? 0
        let mp = Int((w * h / 1_000_000).rounded())
        let size = e?.fileSizeInByte.map { ByteCountFormatter.string(fromByteCount: Int64($0), countStyle: .file) } ?? ""
        let line = [mp > 0 ? "\(mp) MP" : nil, w > 0 ? "\(Int(w)) × \(Int(h))" : nil, size.isEmpty ? nil : size].compactMap { $0 }.joined(separator: " • ")
        return VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text([e?.make, e?.model].compactMap { $0 }.joined(separator: " ").nonEmpty ?? String(localized: "Unbekannte Kamera"))
                    .font(.system(size: 16, weight: .semibold))
                Spacer()
                if !format.isEmpty {
                    Text(format).font(.system(size: 12, weight: .semibold)).foregroundStyle(.secondary)
                        .padding(.horizontal, 7).padding(.vertical, 3)
                        .background(RoundedRectangle(cornerRadius: 5).fill(Color(white: 0.3)))
                }
            }
            .padding(14)
            .background(Color(white: 0.2))
            VStack(alignment: .leading, spacing: 4) {
                Text(e?.lensModel ?? String(localized: "Keine Objektivinformationen")).font(.system(size: 15))
                    .foregroundStyle(e?.lensModel == nil ? .secondary : .primary)
                Text(line).font(.system(size: 15)).foregroundStyle(.secondary)
            }
            .padding(14)
            Divider()
            HStack(spacing: 0) {
                exif(e?.iso.map { "ISO \(Int($0))" })
                exif(e?.focalLength.map { "\(Int($0)) mm" })
                exif(nil)
                exif(e?.fNumber.map { String(format: "ƒ%.1f", $0) })
                exif(e?.exposureTime.map { "\($0) s" })
            }
            .padding(.vertical, 12)
        }
        .background(Color(white: 0.14))
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    private func exif(_ v: String?) -> some View {
        Text(v ?? "–").font(.system(size: 13)).foregroundStyle(.secondary).frame(maxWidth: .infinity)
            .overlay(alignment: .trailing) { Rectangle().fill(Color(white: 0.3)).frame(width: 1, height: 16) }
    }

    /// War es eine Bereinigen-Bearbeitung? (gespeicherter Bearbeitungsstand mit Strichen) → Hinweis + Liste aller bereinigten Fotos
    private func loadCleaned() async {
        let api = ImmichClient.shared
        guard let meta = await api.metadata(asset.id, key: "fotos.edit"), let json = meta["state"] as? String,
              let st = try? JSONDecoder().decode(EditState.self, from: Data(json.utf8)), !st.cleanup.isEmpty else { return }
        var ids = [asset.id]
        if let t = (try? await api.tags())?.first(where: { $0.value == "Kategorie/Bereinigt" }),
           let found = try? await api.search(filter: ["tagIds": ["any": [t.id]]], size: 1000) {
            ids = Array(Set(ids + found.map(\.id)))
        }
        cleanedIDs = ids
    }

    /// Fotos im Umkreis von ~1 km (Immich-Kartenpunkte), ohne dieses Foto
    private func loadNearby(_ lat: Double, _ lon: Double) async {
        let all = (try? await ImmichClient.shared.mapMarkers()) ?? []
        let here = CLLocation(latitude: lat, longitude: lon)
        nearby = all.filter { $0.id != asset.id && here.distance(from: CLLocation(latitude: $0.lat, longitude: $0.lon)) < 1000 }
        nearbyChecked = true
        if nearby.isEmpty { app.toast(String(localized: "Keine anderen Fotos in der Nähe")) }
    }

    @ViewBuilder private var mapCard: some View {
        if let lat = dto?.exifInfo?.latitude, let lon = dto?.exifInfo?.longitude, !(lat == 0 && lon == 0) {
            VStack(spacing: 0) {
                Map(initialPosition: .region(MKCoordinateRegion(center: .init(latitude: lat, longitude: lon),
                                                                latitudinalMeters: 1500, longitudinalMeters: 1500)),
                    interactionModes: []) {
                    // „Fotos in der Nähe zeigen“: andere Fotos im Umkreis von ~1 km als kleine Vorschauen
                    ForEach(nearby.prefix(25)) { m in
                        Annotation("", coordinate: .init(latitude: m.lat, longitude: m.lon), anchor: .bottom) {
                            AssetThumb(id: m.id).frame(width: 30, height: 30)
                                .clipShape(RoundedRectangle(cornerRadius: 6))
                                .overlay(RoundedRectangle(cornerRadius: 6).stroke(.white, lineWidth: 2))
                        }
                    }
                    Annotation("", coordinate: .init(latitude: lat, longitude: lon), anchor: .bottom) {
                        AssetThumb(id: asset.id).frame(width: 48, height: 48)
                            .clipShape(RoundedRectangle(cornerRadius: 8))
                            .overlay(RoundedRectangle(cornerRadius: 8).stroke(.white, lineWidth: 3))
                    }
                }
                .frame(height: 170)
                HStack {
                    Text([dto?.exifInfo?.city, dto?.exifInfo?.country].compactMap { $0 }.joined(separator: ", "))
                        .font(.system(size: 15)).foregroundStyle(.secondary)
                    Spacer()
                    Button(String(localized: "Anpassen")) { sheet = .location([asset]) }
                }
                .padding(14)
                if !nearby.isEmpty {
                    NavigationLink(value: CollectionRoute.assets(title: String(localized: "In der Nähe"), ids: nearby.map(\.id))) {
                        HStack {
                            Label(String(localized: "\(nearby.count) Fotos in der Nähe"), systemImage: "mappin.and.ellipse")
                            Spacer()
                            Image(systemName: "chevron.right").foregroundStyle(.tertiary)
                        }
                        .font(.system(size: 15)).padding(.horizontal, 14).padding(.bottom, 14)
                    }
                    .buttonStyle(.plain)
                } else if !nearbyChecked {
                    Button(String(localized: "Fotos in der Nähe zeigen")) { Task { await loadNearby(lat, lon) } }
                        .font(.system(size: 15)).padding(.horizontal, 14).padding(.bottom, 14)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .background(Color(white: 0.14))
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        } else {
            Button { sheet = .location([asset]) } label: {
                Label(String(localized: "Ort hinzufügen"), systemImage: "mappin.and.ellipse").frame(maxWidth: .infinity).padding(14)
            }
            .background(Color(white: 0.14))
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
    }

    private func saveCaption() {
        let text = caption.trimmingCharacters(in: .whitespacesAndNewlines)
        guard text != (dto?.exifInfo?.description ?? "") else { return }
        Task { try? await ImmichClient.shared.raw("assets/\(asset.id)", method: "PUT", body: ImmichClient.shared.json(["description": text])) }
    }
}

extension String { var nonEmpty: String? { isEmpty ? nil : self } }

/// Woher ein Foto stammt – aus dem Dateinamen, wie ihn Apps beim Speichern vergeben (Apple: „Gespeichert aus …“).
enum Provenance {
    /// Bildschirmfoto/-aufnahme statt gespeicherter Datei (Symbol)
    static func isScreen(_ s: String) -> Bool { s == String(localized: "Bildschirmfoto") || s == String(localized: "Bildschirmaufnahme") }
    static func source(_ fileName: String?, make: String?) -> String? {
        guard let n = fileName?.lowercased(), !n.isEmpty else { return nil }
        let app: String?
        if n.contains("-wa") || n.hasPrefix("whatsapp") { app = "WhatsApp" }
        else if n.hasPrefix("screenshot") || n.hasPrefix("bildschirmfoto") || n.hasPrefix("simulator screenshot") { return String(localized: "Bildschirmfoto") }
        else if n.hasPrefix("rpreplay") || n.hasPrefix("screenrecording") || n.hasPrefix("bildschirmaufnahme") { return String(localized: "Bildschirmaufnahme") }
        else if n.hasPrefix("fb_img") || n.hasPrefix("fb_vid") { app = "Facebook" }
        else if n.hasPrefix("received_") { app = "Messenger" }
        else if n.hasPrefix("snapchat-") { app = "Snapchat" }
        else if n.hasPrefix("signal-") { app = "Signal" }
        else if n.hasPrefix("telegram") || (n.hasPrefix("photo_") && n.contains("_20")) { app = "Telegram" }
        else if n.contains("instagram") { app = "Instagram" }
        else if n.contains("tiktok") || n.hasPrefix("snaptik") || n.hasPrefix("ssstik") { app = "TikTok" }
        else if n.hasPrefix("threema") { app = "Threema" }
        else if make == nil, n.hasSuffix(".png"), n.hasPrefix("img_") { return String(localized: "Bildschirmfoto") }
        else { app = nil }
        return app.map { String(localized: "Gespeichert aus \($0)") }
    }
}

