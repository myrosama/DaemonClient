import SwiftUI

struct RootView: View {
    @State private var backupConsent = false
    @Environment(AppModel.self) private var app
    @Environment(TimelineStore.self) private var timeline
    @Namespace private var zoom
    @Environment(\.scenePhase) private var phase

    var body: some View {
        @Bindable var app = app
        ZStack(alignment: .bottom) {
            Color.appBackground.ignoresSafeArea()
            Group {
                switch app.tab {
                case .library: LibraryView()
                case .collections: CollectionsView()
                }
            }
            .environment(\.zoomNamespace, zoom)
            if app.tab == .library { BottomBlur() }
            Group {
                if app.selecting { SelectionBar() } else { BottomBar() }
            }
            // iPad: Leiste nicht über die ganze Breite ziehen (GitHub #47)
            .frame(maxWidth: 600)
            .padding(.horizontal, 22)
            .padding(.bottom, 4)
        }
        .overlay(alignment: .top) { VStack { BusyBadge(); ToastBadge() } }
        .actionSheets($app.sheet)
        .sheet(isPresented: $app.showSettings) { SettingsView() }
        .sheet(isPresented: Binding(get: { backupConsent }, set: { if !$0 { backupConsent = false } })) { BackupConsentView() }
        .task {
            if timeline.buckets.isEmpty { await timeline.showCached() }
            Task { await ImmichClient.shared.prepareVideo() }
            var reloaded = false
            if let me = try? await ImmichClient.shared.me() {
                app.userID = me.id; app.userName = me.name; reloaded = await timeline.setUser(me.id)
            }
            if !reloaded { await timeline.reload() }
            #if DEBUG
            if ProcessInfo.processInfo.environment["FOTOS_BACKUP_NOW"] != nil, BackupEngine.shared.needsConsent { BackupEngine.shared.consent(true) }
            #endif
            if BackupEngine.shared.needsConsent { backupConsent = true }
            LocalPending.shared.timeline = timeline
            LibraryWatcher.shared.start()
            LocalPending.shared.refresh()
            BackupEngine.shared.runIfDue()
            WidgetFeeder.syncAccess()
            OfflineSync.shared.timeline = timeline
            // Widgets füllen, wenn die Zeitleiste steht (leise im Hintergrund)
            Task { try? await Task.sleep(for: .seconds(12)); await WidgetFeeder.update(timeline: timeline) }
            OfflineSync.shared.kick()
            #if DEBUG
            if ProcessInfo.processInfo.environment["FOTOS_BACKUP_NOW"] != nil { BackupEngine.shared.start() }
            if let d = ProcessInfo.processInfo.environment["FOTOS_BACKUP_DEMO"] { BackupEngine.shared.demo(d) }
            #endif
        }
        .onChange(of: app.tab) { app.endSelection(); app.tabsExpanded = false }
        .onChange(of: perfScreen, initial: true) { _, s in PerfLog.setScreen(s) }
        .onChange(of: phase) { _, p in
            // erst nachladen, wenn das Konto feststeht (beim Start erledigt das .task)
            if p == .active, !app.userID.isEmpty {
                LibraryWatcher.shared.start(); LocalPending.shared.refresh()
                BackupEngine.shared.runIfDue(); Task { await timeline.reload(); OfflineSync.shared.kick() }
            }
            // wie Fotos: geschützte Alben sperren sich wieder, sobald die App in den Hintergrund geht
            guard p == .background else { return }
            BackupEngine.shared.schedule()
            OfflineSync.shared.stop()
            Task { await MemoryNotifications.schedule(timeline: timeline); await WidgetFeeder.update(timeline: timeline) }
            app.privateUnlocked = false
            if app.viewer?.assets.contains(where: { $0.isHidden || $0.trashedAt != nil }) == true { app.viewer = nil }
        }
        .onChange(of: app.tabsExpanded) { _, open in
            // wie bei Apple klappt die Leiste nach kurzer Zeit wieder zu
            guard open else { return }
            Task { try? await Task.sleep(for: .seconds(6)); withAnimation(.snappy) { app.tabsExpanded = false } }
        }
        .fullScreenCover(item: $app.viewer) { req in
            ViewerView(assets: req.assets, start: req.index)
                .navigationTransition(.zoom(sourceID: app.zoomID, in: zoom))
                .preferredColorScheme(.dark)   // Fotos-Ansicht und Editor bleiben auch im hellen Modus dunkel
        }
        .fullScreenCover(isPresented: $app.showSearch) { SearchView() }
        // Tippen aufs Widget: homeroll://memory/<id> bzw. homeroll://asset/<id>
        .onOpenURL { open($0) }
        .onReceive(NotificationCenter.default.publisher(for: .openFotosURL)) { n in if let u = n.object as? URL { open(u) } }
        .fullScreenCover(item: $app.memory) { MemoryPlayer(memory: $0).preferredColorScheme(.dark) }
    }

    private func open(_ url: URL) {
            guard url.scheme == "homeroll", let id = url.pathComponents.dropFirst().first else { return }
            app.viewer = nil; app.showSearch = false
            if url.host == "album" || url.host == "person" {
                let name = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "name" }?.value ?? ""
                app.tab = .collections
                Task {
                    var title = name
                    if url.host == "album", title.isEmpty { title = (try? await ImmichClient.shared.albums())?.first { $0.id == id }?.albumName ?? "" }
                    app.pendingRoute = url.host == "album" ? .album(AlbumRef(id: id, name: title)) : .person(PersonRef(id: id, name: title))
                }
                return
            }
            if url.host == "memory", let m = MemoryCenter.shared.items.first(where: { $0.id == id }) { app.memory = m }
            else if url.host == "asset" {
                // wie Apple: Foto direkt öffnen (mit den Nachbarn aus der Mediathek zum Weiterwischen)
                Task {
                    await timeline.loadAll()
                    // war schon ein Foto offen: erst schließen lassen, sonst bleibt die alte Einzelansicht stehen
                    try? await Task.sleep(for: .milliseconds(450))
                    let all = timeline.allLoaded
                    if let i = all.firstIndex(where: { $0.id == id }) { app.open(all, at: i) }
                    else if let dto = try? await ImmichClient.shared.asset(id) { app.open([dto.asset], at: 0) }
                }
            }
    }
}

extension RootView {
    /// Für das Leistungsprotokoll: wo man gerade ist.
    private var perfScreen: String {
        if app.viewer != nil { return "Einzelansicht" }
        if app.showSearch { return "Suche" }
        if app.memory != nil { return "Rückblick" }
        if app.tab == .collections { return "Sammlungen" }
        return app.scale == .all ? "Mediathek \(app.columns) Spalten" : "Mediathek \(app.scale.rawValue)"
    }
}

private extension View {
    /// Während ein Foto darüber gezogen wird, nach 0,6 s zum Tab `to` wechseln (Ablegen selbst passiert nicht hier).
    func springLoaded(to tab: Tab, hovering: Binding<Tab?>) -> some View {
        modifier(SpringLoad(tab: tab, hovering: hovering))
    }
}

private struct SpringLoad: ViewModifier {
    let tab: Tab
    @Binding var hovering: Tab?
    @Environment(AppModel.self) private var app
    func body(content: Content) -> some View {
        content
            .background { GeometryReader { g in Color.clear.preference(key: SpringFrames.self, value: [tab: g.frame(in: .global)]) } }
            .onPreferenceChange(SpringFrames.self) { f in SpringLoadWindow.shared.frames.merge(f) { $1 } }
            .background { SpringLoadWindow.Attach() }
            .onAppear {
                SpringLoadWindow.shared.onHover = { t in
                    hovering = t
                    guard let t else { return }
                    Task {
                        try? await Task.sleep(for: .milliseconds(600))
                        guard hovering == t, app.tab != t else { return }
                        UISelectionFeedbackGenerator().selectionChanged()
                        withAnimation(.snappy) { app.tab = t; app.tabsExpanded = false }
                    }
                }
            }
    }
}

private struct SpringFrames: PreferenceKey {
    static let defaultValue: [Tab: CGRect] = [:]
    static func reduce(value: inout [Tab: CGRect], nextValue: () -> [Tab: CGRect]) { value.merge(nextValue()) { $1 } }
}

/// Ablegeziel am Fenster: UIKit nimmt es nur, wenn unter dem Finger kein anderes Ziel annimmt (Alben bleiben
/// Ziele). Liegt der Finger über einem Tab-Knopf, meldet es den Tab – abgelegt wird hier nie.
@MainActor
final class SpringLoadWindow: NSObject, UIDropInteractionDelegate {
    static let shared = SpringLoadWindow()
    var frames: [Tab: CGRect] = [:]
    var onHover: (Tab?) -> Void = { _ in }
    private weak var window: UIWindow?
    private var current: Tab?

    func attach(to w: UIWindow) {
        guard window !== w else { return }
        window = w
        w.addInteraction(UIDropInteraction(delegate: self))
    }
    private func report(_ t: Tab?) { guard t != current else { return }; current = t; onHover(t) }

    nonisolated func dropInteraction(_ i: UIDropInteraction, canHandle s: UIDropSession) -> Bool { s.localDragSession != nil }
    nonisolated func dropInteraction(_ i: UIDropInteraction, sessionDidUpdate s: UIDropSession) -> UIDropProposal {
        // UIDropProposal.init ist im neuen SDK auf den Main Actor beschränkt → hier drinnen erzeugen
        MainActor.assumeIsolated {
            if let w = window {
                let p = s.location(in: w)
                report(frames.first { $0.value.insetBy(dx: -8, dy: -8).contains(p) }?.key)
            }
            return UIDropProposal(operation: .cancel)
        }
    }
    nonisolated func dropInteraction(_ i: UIDropInteraction, sessionDidExit s: UIDropSession) { MainActor.assumeIsolated { report(nil) } }
    nonisolated func dropInteraction(_ i: UIDropInteraction, sessionDidEnd s: UIDropSession) { MainActor.assumeIsolated { report(nil) } }

    struct Attach: UIViewRepresentable {
        func makeUIView(context: Context) -> V { V() }
        func updateUIView(_ v: V, context: Context) {}
        final class V: UIView {
            override func didMoveToWindow() { super.didMoveToWindow(); if let window { SpringLoadWindow.shared.attach(to: window) } }
        }
    }
}

/// Schwebende Glasleiste unten – in der Mediathek mit Jahre/Monate/Alle, sonst Tabs.
struct BottomBar: View {
    @Environment(AppModel.self) private var app
    @Namespace private var ns
    /// Federnde Tabs wie bei Apple (UITabBar springLoaded): gezogenes Foto kurz über dem Tab halten → Tab wechselt,
    /// so landet ein Foto aus der Mediathek mit einem Finger auf einem Album in den Sammlungen.
    @State private var hovering: Tab?

    var body: some View {
        GlassEffectContainer(spacing: 14) {
            HStack(spacing: 12) {
                if app.tab == .library && !app.tabsExpanded {
                    Button { withAnimation(.snappy) { app.tabsExpanded = true } } label: {
                        Image(systemName: "photo.on.rectangle.angled")
                            .font(.system(size: 22, weight: .medium))
                            .symbolRenderingMode(.multicolor)
                            .foregroundStyle(.blue)
                            .frame(width: 58, height: 58)
                    }
                    .glassEffect(.regular.interactive(), in: .circle)
                    .glassEffectID("tab", in: ns)
                    .springLoaded(to: .collections, hovering: $hovering)

                    ScaleSwitcher()
                        .glassEffect(.regular.interactive(), in: .capsule)
                } else {
                    TabSwitcher()
                        .glassEffect(.regular.interactive(), in: .capsule)
                        .glassEffectID("tab", in: ns)
                        .springLoaded(to: app.tab == .library ? .collections : .library, hovering: $hovering)
                    Spacer(minLength: 0)
                }
                Button { app.showSearch = true } label: {
                    Image(systemName: "magnifyingglass")
                        .font(.system(size: 22, weight: .medium))
                        .foregroundStyle(.primary)
                        .frame(width: 58, height: 58)
                }
                .glassEffect(.regular.interactive(), in: .circle)
            }
        }
    }
}

private struct ScaleSwitcher: View {
    @Environment(AppModel.self) private var app
    @Namespace private var sel
    var body: some View {
        HStack(spacing: 0) {
            ForEach(LibraryScale.allCases) { s in
                Button {
                    // wie Apple: „Alle“ erneut antippen springt zum Neuesten ganz unten
                    if s == .all && app.scale == .all { NotificationCenter.default.post(name: .scrollToNewest, object: nil) }
                    withAnimation(.snappy(duration: 0.25)) { app.scale = s }
                } label: {
                    Text(L(s.rawValue))
                        .font(.system(size: 17, weight: app.scale == s ? .semibold : .regular))
                        .foregroundStyle(.primary)
                        .lineLimit(1).minimumScaleFactor(0.7)
                        // Text mit Innenabstand IN der Zelle: so passt das fette „Months“ immer in die Markierung
                        // (vorher füllte der Text die ganze Zelle, die Markierung war 4 pt schmaler – GitHub #44)
                        .padding(.horizontal, 10)
                        // minWidth 0: alle drei gleich breit (GitHub #37)
                        .frame(minWidth: 0, maxWidth: .infinity, minHeight: 50)
                        .background {
                            if app.scale == s {
                                Capsule().fill(Color.primary.opacity(0.16))
                                    .matchedGeometryEffect(id: "sel", in: sel)
                                    .padding(.vertical, 4).padding(.horizontal, 2)
                            }
                        }
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 4)
        .frame(height: 58)
    }
}

private struct TabSwitcher: View {
    @Environment(AppModel.self) private var app
    @Namespace private var sel
    var body: some View {
        HStack(spacing: 0) {
            item(.library, "photo.on.rectangle.angled", String(localized: "Mediathek"))
            item(.collections, "square.stack.fill", String(localized: "Sammlungen"))
        }
        .padding(4)
    }

    private func item(_ t: Tab, _ icon: String, _ title: String) -> some View {
        let on = app.tab == t
        return Button { withAnimation(.snappy) { app.tab = t; app.tabsExpanded = false } } label: {
            VStack(spacing: 3) {
                Image(systemName: icon).font(.system(size: 21, weight: .medium))
                Text(title).font(.system(size: 11, weight: .medium))
            }
            .foregroundStyle(on ? Color.blue : Color.primary)
            .frame(width: 100, height: 54)
            .background {
                if on { Capsule().fill(Color.primary.opacity(0.14)).matchedGeometryEffect(id: "tabsel", in: sel) }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

/// Kleine Glas-Kapsel oben, solange etwas vorbereitet wird (Teilen, Sichern …).
struct BusyBadge: View {
    @Environment(AppModel.self) private var app
    var body: some View {
        if let text = app.busy {
            HStack(spacing: 10) {
                ProgressView().tint(.white)
                Text(text).font(.system(size: 15, weight: .semibold)).foregroundStyle(.white)
            }
            .padding(.horizontal, 18).frame(height: 44)
            .glassEffect(.regular.tint(.black.opacity(0.45)), in: .capsule)   // auf hellen Fotos lesbar
            .padding(.top, 8)
            .transition(.move(edge: .top).combined(with: .opacity))
        }
    }
}


extension Notification.Name {
    static let scrollToNewest = Notification.Name("scrollToNewest")
    static let openFotosURL = Notification.Name("openFotosURL")
    static let personThumbChanged = Notification.Name("personThumbChanged")
}
