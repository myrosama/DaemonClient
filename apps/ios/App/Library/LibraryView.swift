import SwiftUI

struct LibraryView: View {
    @Environment(AppModel.self) private var app
    @Environment(TimelineStore.self) private var timeline
    @State private var monthsSubtitle = ""
    @State private var gridSubtitle = ""
    /// Monate/Jahre werden beim ersten Öffnen gebaut und danach wie das Raster nur ausgeblendet (GitHub #44)
    @State private var monthsBuilt = false
    @State private var yearsBuilt = false

    var body: some View {
        ZStack(alignment: .top) {
            // Das Raster bleibt bestehen und wird nur ausgeblendet: es jedes Mal neu aufzubauen (80 000 Kacheln) ließ
            // das Umschalten Jahre/Monate/Alle ruckeln (GitHub #37) – und so bleibt auch die Scrollposition erhalten
            AllGrid(subtitle: $gridSubtitle)
                .opacity(app.scale == .all ? 1 : 0)
                .allowsHitTesting(app.scale == .all)
                .accessibilityHidden(app.scale != .all)
            if monthsBuilt || app.scale == .months {
                MonthsList(subtitle: $monthsSubtitle)
                    .opacity(app.scale == .months ? 1 : 0)
                    .allowsHitTesting(app.scale == .months)
                    .accessibilityHidden(app.scale != .months)
                    .onAppear { monthsBuilt = true }
            }
            if yearsBuilt || app.scale == .years {
                YearsList()
                    .opacity(app.scale == .years ? 1 : 0)
                    .allowsHitTesting(app.scale == .years)
                    .accessibilityHidden(app.scale != .years)
                    .onAppear { yearsBuilt = true }
            }
            LibraryHeader(subtitle: app.scale == .all ? gridSubtitle : app.scale == .months ? monthsSubtitle : "")
        }
        .overlay {
            if timeline.buckets.isEmpty {
                if timeline.loading { ProgressView().tint(Color.primary) }
                else if let e = timeline.error {
                    ContentUnavailableView {
                        Label(String(localized: "Server nicht erreichbar"), systemImage: "wifi.exclamationmark")
                    } description: { Text(e) } actions: {
                        Button(String(localized: "Erneut versuchen")) { Task { await timeline.reload() } }
                            .buttonStyle(.glassProminent)
                        // Ausweg statt Neuinstallation, wenn die Adresse nicht (mehr) stimmt
                        Button(String(localized: "Abmelden / anderer Server")) { app.signOut(timeline) }
                    }
                } else {
                    ContentUnavailableView(String(localized: "Noch keine Fotos"), systemImage: "photo.on.rectangle")
                }
            }
        }
        .sheet(isPresented: Binding(get: { app.showBackup }, set: { app.showBackup = $0 })) { BackupView() }
    }
}

/// Großer Titel über den Fotos mit weichem Verlauf – wie in Apple Fotos (iOS 26).
struct LibraryHeader: View {
    let subtitle: String
    @Environment(AppModel.self) private var app
    @Environment(TimelineStore.self) private var timeline
    @State private var confirmSignOut = false

    /// Wie Apple („2 Objekte synchronisieren …“): Backup bzw. fehlende Verbindung statt Datum.
    private var status: String? {
        let b = BackupEngine.shared
        if b.phase == .uploading, b.total > 0 { return String(localized: "\(b.total - b.finished) Objekte werden gesichert …") }
        if Connectivity.shared.serverOffline { return String(localized: "Offline – nur Vorschauen") }
        return nil
    }

    var body: some View {
        @Bindable var app = app
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 2) {
                Text(String(localized: "Mediathek"))
                    .font(.system(size: 34, weight: .bold))
                Text(app.filter != .all ? app.filter.title : status ?? subtitle)
                    .font(.system(size: 17, weight: .semibold))
                    .contentTransition(.numericText())
                    .animation(.default, value: subtitle)
            }
            .foregroundStyle(.primary)
            .shadow(color: Color.appBackground.opacity(0.35), radius: 6)
            Spacer()
            GlassEffectContainer {
                HStack(spacing: 10) {
                    if app.selecting {
                        HStack(spacing: 0) {
                            Menu { libraryMenu } label: {
                                Image(systemName: "line.3.horizontal.decrease").font(.system(size: 18, weight: .semibold))
                                    .foregroundStyle(.primary).frame(width: 50, height: 46).contentShape(.rect)
                            }
                            SelectionMenuButton()
                        }
                        .padding(.horizontal, 4)
                        .glassEffect(.regular.interactive(), in: .capsule)
                        Button { withAnimation(.snappy) { app.endSelection() } } label: {
                            Image(systemName: "xmark").font(.system(size: 18, weight: .semibold))
                                .foregroundStyle(.primary).frame(width: 46, height: 46).contentShape(.rect)
                        }
                        .glassEffect(.regular.interactive(), in: .circle)
                    } else {
                        Menu { libraryMenu } label: {
                            Image(systemName: "line.3.horizontal.decrease")
                                .accessibilityLabel(String(localized: "Mehr"))
                                .font(.system(size: 18, weight: .semibold))
                                .foregroundStyle(app.libraryCustomized ? Color.black : Color.primary)
                                .frame(width: 46, height: 46)
                                .background { if app.libraryCustomized { Circle().fill(.blue).padding(3) } }
                        }
                        .glassEffect(.regular.interactive(), in: .circle)
                        Button { withAnimation(.snappy) { app.selecting = true } } label: {
                            Text(String(localized: "Auswählen"))
                                .font(.system(size: 17, weight: .semibold))
                                .foregroundStyle(.primary)
                                .padding(.horizontal, 18)
                                .frame(height: 46)
                        }
                        .glassEffect(.regular.interactive(), in: .capsule)
                    }
                }
            }
        }
        .padding(.horizontal, 20)
        .padding(.top, 2)
        .padding(.bottom, 30)
        .background(alignment: .top) { TopBlur() }
        // Abmelden löscht Offline-Vorschauen und Zwischenspeicher → vorher nachfragen
        .confirmationDialog(String(localized: "Abmelden"), isPresented: $confirmSignOut, titleVisibility: .visible) {
            Button(String(localized: "Abmelden"), role: .destructive) { app.signOut(timeline) }
            Button(String(localized: "Abbrechen"), role: .cancel) {}
        }
    }

    /// Aufbau wie das Fotos-Menü: Sortierung, Darstellungsoptionen, Filter.
    @ViewBuilder private var libraryMenu: some View {
        @Bindable var app = app
        Picker(String(localized: "Sortierung"), selection: $app.sortByAdded) {
            Text(String(localized: "Nach zuletzt hinzugefügten Inhalten sortieren")).tag(true)
            Text(String(localized: "Nach Aufnahmedatum sortieren")).tag(false)
        }
        .pickerStyle(.inline)
        Menu {
            Button(String(localized: "Vergrößern"), systemImage: "plus.magnifyingglass") { step(-1) }.disabled(app.columns <= 1)
            Button(String(localized: "Verkleinern"), systemImage: "minus.magnifyingglass") { step(1) }.disabled(app.columns >= GridZoom.steps.last!)
            Toggle(isOn: $app.aspectGrid) { Label(String(localized: "Seitenverhältnisraster"), systemImage: "aspectratio") }
            Toggle(isOn: $app.autoplay) { Label(String(localized: "Videos & Live Photos automatisch abspielen"), systemImage: "play.square") }
            Toggle(isOn: $app.alwaysOriginal) { Label(String(localized: "Original immer anzeigen (HDR)"), systemImage: "sun.max") }
            Section(String(localized: "Anzeigen:")) {
                Toggle(isOn: $app.showScreenshots) { Label(String(localized: "Bildschirmfotos"), systemImage: "camera.viewfinder") }
                Toggle(isOn: $app.showShared) { Label(String(localized: "Mit dir geteilt"), systemImage: "person.2") }
            }
        } label: { Label(String(localized: "Darstellungsoptionen"), systemImage: "eye") }
        Menu {
            Picker(String(localized: "Filter"), selection: $app.filter) {
                ForEach(LibraryFilter.allCases) { f in Label(L(f.title), systemImage: f.icon).tag(f) }
            }
            .pickerStyle(.inline)
        } label: { Label(String(localized: "Filter"), systemImage: "line.3.horizontal.decrease.circle") }
        Divider()
        Button(String(localized: "Einstellungen", table: "Theme"), systemImage: "gearshape") { app.showSettings = true }
        Button(String(localized: "Aktualisieren"), systemImage: "arrow.clockwise") { Task { await timeline.reload() } }
        Button(String(localized: "Abmelden"), systemImage: "rectangle.portrait.and.arrow.right", role: .destructive) { confirmSignOut = true }
    }

    private func step(_ dir: Int) {
        let steps = GridZoom.steps
        let i = steps.firstIndex(of: app.columns) ?? 1
        withAnimation(.snappy) { app.columns = steps[max(0, min(steps.count - 1, i + dir))] }
    }
}

/// Weicher Unschärfe-Verlauf hinter Kopfzeilen wie bei Apple: oben dicht, nach unten ausblendend.
struct TopBlur: View {
    var body: some View {
        ZStack {
            Rectangle().fill(.ultraThinMaterial)
                .mask(LinearGradient(stops: [.init(color: .black, location: 0), .init(color: .black, location: 0.45),
                                             .init(color: .clear, location: 1)], startPoint: .top, endPoint: .bottom))
            LinearGradient(colors: [Color.appBackground.opacity(0.7), Color.appBackground.opacity(0.3), .clear], startPoint: .top, endPoint: .bottom)
        }
        .ignoresSafeArea(edges: .top)
        .allowsHitTesting(false)
    }
}

/// Gegenstück unten: Verlauf hinter der schwebenden Leiste, damit Text darauf lesbar bleibt.
struct BottomBlur: View {
    var body: some View {
        ZStack {
            Rectangle().fill(.ultraThinMaterial)
                .mask(LinearGradient(stops: [.init(color: .clear, location: 0), .init(color: .black, location: 0.55),
                                             .init(color: .black, location: 1)], startPoint: .top, endPoint: .bottom))
            LinearGradient(colors: [.clear, Color.appBackground.opacity(0.35), Color.appBackground.opacity(0.75)], startPoint: .top, endPoint: .bottom)
        }
        .frame(height: 190)
        .frame(maxHeight: .infinity, alignment: .bottom)
        .ignoresSafeArea()
        .allowsHitTesting(false)
    }
}

// MARK: - Alle

struct AllGrid: View {
    @Binding var subtitle: String
    @Environment(AppModel.self) private var app
    @Environment(TimelineStore.self) private var timeline
    @State private var query = LibraryQuery()
    @State private var highlight: String?
    @State private var capsule = ""

    /// Durchgehendes Raster über alle Monate (wie Apple): geladene Fotos oder Platzhalter je Monat.
    /// Mit Filter/Sortierung: die gefilterte Liste (dafür wird alles geladen). Beides ist vorberechnet –
    /// bei 80 000 Objekten darf `body` keine Liste neu bauen.
    private var cells: [GridItemRef] { app.libraryCustomized ? query.cells : timeline.gridCells }
    private var cellIndex: [String: Int] { app.libraryCustomized ? query.index : timeline.gridIndex }

    /// Springt zu `app.revealID` und lässt die Kachel kurz aufleuchten.
    private func reveal() {
        guard let id = app.revealID else { return }
        Task { @MainActor in
            // Monat evtl. noch nicht geladen → kurz nachladen lassen
            for _ in 0..<20 where cellIndex[id] == nil {
                await timeline.loadAll()
                try? await Task.sleep(for: .milliseconds(100))
            }
            // Objekt liegt in einem Stapel und ist nicht die sichtbare Fassung → zur sichtbaren springen
            var target = id
            if cellIndex[id] == nil, let p = (try? await ImmichClient.shared.asset(id))?.stack?.primaryAssetId { target = p }
            guard let i = cellIndex[target] else { app.revealID = nil; return }
            try? await Task.sleep(for: .milliseconds(120))
            grid.scroll(to: i, anchor: .center)
            highlight = target
            app.revealID = nil
            try? await Task.sleep(for: .seconds(1.2))
            withAnimation(.easeOut(duration: 0.5)) { highlight = nil }
        }
    }

    @State private var grid = GridController()
    /// Rahmen der Kachel, aus der die Einzelansicht aufzoomt (und in die sie beim Schließen zurückzoomt)
    @State private var zoomRect: CGRect?
    @Environment(\.zoomNamespace) private var zoomNS

    var body: some View {
        let items = cells
        let app = self.app, timeline = self.timeline, query = self.query
        PhotoGrid(items: items, columns: app.columns,
                  topInset: 120, controller: grid,
                  fit: app.aspectGrid, selection: app.selecting ? app.selected : nil, highlight: highlight, me: app.userID,
                  onTop: { i in
                      guard i < items.count else { return }
                      let date: Date
                      switch items[i] {
                      case .asset(let a, _): date = app.sortByAdded ? (a.addedAt ?? a.date) : a.date
                      case .placeholder(let b, _): date = timeline.buckets.first(where: { $0.timeBucket == b })?.monthDate ?? .distantPast
                      }
                      // wie Apple: 5 Spalten = Tag, Monats-Stufe = „Okt 2026“, Jahres-Stufe = „2026“ (als Kapsel)
                      switch app.columns {
                      case GridZoom.steps.last!: subtitle = ""; capsule = String(Calendar.wall.component(.year, from: date))
                      case GridZoom.dense: subtitle = ""; capsule = Fmt.monthShortYear.string(from: date)
                      case 5: subtitle = Fmt.dayMonthYearShort.string(from: date); capsule = ""
                      default: subtitle = Fmt.monthYear.string(from: date); capsule = ""
                      }
                  },
                  onShow: { item in
                      switch item {
                      case .placeholder(let b, _): Task { await timeline.load(b) }
                      case .asset(_, let b): if !b.isEmpty { timeline.touch(b) }
                      }
                  },
                  onColumns: { c in app.columns = c },
                  onOpen: { i, rect in
                      guard i < items.count, case .asset(let a, _) = items[i] else { return }
                      zoomRect = rect
                      // noch nicht gesicherte iPhone-Fotos stehen hinter der Server-Zeitleiste
                      let all = app.libraryCustomized ? (query.list ?? []) : timeline.allLoaded + timeline.localAssets.sorted { $0.date < $1.date }
                      app.open(all, at: all.firstIndex { $0.id == a.id } ?? 0)
                  },
                  onToggle: { app.toggle($0) },
                  onSelect: { app.selected = $0.filter { !$0.hasPrefix(LocalPending.prefix) } },
                  menu: { a in AssetMenuUIKit.context(a, app: app, timeline: timeline) },
                  // nicht hinter der Einzelansicht oder in anderen Tabs weiterspielen (Akku, Leitung fürs Video vorn)
                  autoplay: app.autoplay && app.tab == .library && app.scale == .all && app.viewer == nil && app.memory == nil,
                  showsScrollIndicator: true,
                  scrubLabel: { i in
                      guard i < items.count else { return nil }
                      switch items[i] {
                      case .asset(let a, _): return Fmt.monthYear.string(from: app.sortByAdded ? (a.addedAt ?? a.date) : a.date)
                      case .placeholder(let b, _): return timeline.buckets.first { $0.timeBucket == b }.map { Fmt.monthYear.string(from: $0.monthDate) }
                      }
                  },
                  footer: app.libraryCustomized ? nil : AnyView(LibraryFooter(refresh: timeline.totalCount) { app.showBackup = true }))
            .ignoresSafeArea()
            .overlay {
                // Quelle des Zoom-Übergangs: unsichtbar über der Kachel (UIKit-Kacheln können selbst keine sein)
                ZStack(alignment: .topLeading) {
                    if let r = zoomRect, !app.zoomID.isEmpty {
                        Color.clear.frame(width: r.width, height: r.height)
                            .zoomSource(app.zoomID, zoomNS)
                            .offset(x: r.minX, y: r.minY)
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                .ignoresSafeArea()
                .allowsHitTesting(false)
            }
            .overlay {
                if app.libraryCustomized {
                    if query.list == nil { ProgressView().tint(Color.primary) }
                    else if query.list?.isEmpty == true {
                        ContentUnavailableView(String(localized: "Keine Objekte"), systemImage: app.filter.icon,
                                               description: Text(String(localized: "Für „\(app.filter.title)“ gibt es nichts.")))
                    }
                }
            }
            .overlay(alignment: .bottom) {
                // wie Apples Filterleiste: sichtbar machen, dass nicht alles gezeigt wird, mit Ausschalter
                if app.filter != .all && !app.selecting {
                    Button { withAnimation(.snappy) { app.filter = .all } } label: {
                        HStack(spacing: 8) {
                            Image(systemName: app.filter.icon)
                            Text(String(localized: "Gefiltert: \(app.filter.title)")).font(.system(size: 15, weight: .semibold))
                            Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
                        }
                        .foregroundStyle(.primary)
                        .padding(.horizontal, 16).frame(height: 40)
                        .glassEffect(.regular.interactive(), in: .capsule)
                    }
                    .buttonStyle(.plain)
                    .padding(.bottom, 118)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                }
            }
            .overlay(alignment: .topLeading) {
                if !capsule.isEmpty {
                    Text(capsule).font(.system(size: 30, weight: .bold)).foregroundStyle(.primary)
                        .padding(.horizontal, 16).padding(.vertical, 6)
                        .glassEffect(.regular, in: .capsule)
                        .padding(.leading, 14).padding(.top, 118)
                        .allowsHitTesting(false)
                        .transition(.opacity)
                }
            }
            .onAppear {
                if let t = app.scrollTarget, let first = items.firstIndex(where: { $0.bucket == t }) {
                    grid.scroll(to: first, anchor: .top); app.scrollTarget = nil
                }
                reveal()
            }
            // Raster bleibt im Hintergrund bestehen → Sprungziel aus Jahre/Monate beim Zurückwechseln anwenden
            .onChange(of: app.scale) { _, s in
                guard s == .all, let t = app.scrollTarget, let first = items.firstIndex(where: { $0.bucket == t }) else { return }
                grid.scroll(to: first, anchor: .top); app.scrollTarget = nil
            }
            .onChange(of: app.revealID) { reveal() }
            // In der Einzelansicht weitergewischt → Kachel dieses Fotos ins Bild holen, dorthin zurückzoomen
            .onChange(of: app.zoomID) { _, id in
                guard app.viewer != nil, let i = cellIndex[id] else { return }
                zoomRect = grid.frame(of: i, reveal: true)
            }
            .onReceive(NotificationCenter.default.publisher(for: .scrollToNewest)) { _ in grid.scrollToEnd() }
            .task(id: query.key(app, timeline)) {
                if app.libraryCustomized { await query.refresh(app: app, timeline: timeline) }
            }
    }

}

/// Gefilterte/umsortierte Mediathek (Menü neben „Auswählen“).
@MainActor @Observable
final class LibraryQuery {
    var list: [Asset]? { didSet {
        cells = (list ?? []).map { .asset($0, bucket: "") }
        index = Dictionary(cells.enumerated().map { ($1.id, $0) }, uniquingKeysWith: { a, _ in a })
    } }
    private(set) var cells: [GridItemRef] = []
    @ObservationIgnored private(set) var index: [String: Int] = [:]

    func key(_ app: AppModel, _ t: TimelineStore) -> String {
        "\(app.sortByAdded)|\(app.filter.rawValue)|\(app.showScreenshots)|\(app.showShared)|\(t.totalCount)|\(t.allLoaded.count)"
    }

    func refresh(app: AppModel, timeline: TimelineStore) async {
        await timeline.loadAll()
        var all = timeline.allLoaded
        func ids(_ c: Category) async -> Set<String> { Set(await CategoryLoader.load(c, timeline: timeline).map(\.id)) }
        if !app.showScreenshots { let shots = await ids(.screenshots); all.removeAll { shots.contains($0.id) } }
        if !app.showShared, !app.userID.isEmpty { all.removeAll { ($0.ownerId ?? app.userID) != app.userID } }
        switch app.filter {
        case .all: break
        case .favorites: all = all.filter(\.isFavorite)
        case .photos: all = all.filter(\.isImage)
        case .videos: all = all.filter(\.isVideo)
        // wie Fotos (REA: PhotosGridToggleLiveFilter / TogglePortraitFilter)
        case .livePhotos: let s = await ids(.livePhotos); all = all.filter { $0.isLivePhoto || s.contains($0.id) }
        case .portrait: let s = await ids(.portrait); all = all.filter { s.contains($0.id) }
        case .screenshots: let s = await ids(.screenshots); all = all.filter { s.contains($0.id) }
        case .edited: let s = await ids(.recentlyEdited); all = all.filter { s.contains($0.id) }
        case .shared: all = all.filter { $0.ownerId != nil && $0.ownerId != app.userID }
        case .notInAlbum:
            let inAlbum = Set(((try? await ImmichClient.shared.search(filter: ["hasAlbums": ["eq": true]], size: 100_000)) ?? []).map(\.id))
            all.removeAll { inAlbum.contains($0.id) }
        }
        if app.sortByAdded { all.sort { ($0.addedAt ?? $0.date) < ($1.addedAt ?? $1.date) } }
        list = all
    }
}

enum GridItemRef: Identifiable, Sendable {
    case asset(Asset, bucket: String)
    case placeholder(bucket: String, index: Int)
    var id: String {
        switch self {
        case .asset(let a, _): a.id
        case .placeholder(let b, let i): "\(b)#\(i)"
        }
    }
    var bucket: String {
        switch self {
        case .asset(_, let b), .placeholder(let b, _): b
        }
    }
}

struct GridCell: View {
    let asset: Asset
    var square = true
    /// Seitenverhältnisraster: ganzes Bild in der quadratischen Kachel (wie Apple).
    var fit = false
    /// nil = keine Auswahl aktiv
    var selected: Bool? = nil
    @Environment(\.zoomNamespace) private var zoomNS

    var body: some View {
        Color.clear
            .aspectRatio(square ? 1 : asset.ratio, contentMode: .fit)
            .overlay {
                if fit && square {
                    AssetThumb(id: asset.id, size: .thumbnail)
                        .aspectRatio(asset.ratio, contentMode: .fit)
                } else {
                    AssetThumb(id: asset.id, size: square ? .thumbnail : .preview)
                }
            }
            .clipped()
            .overlay(alignment: .bottomTrailing) {
                if asset.isVideo {
                    Text(Fmt.duration(asset.durationMs))
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(.white)
                        .shadow(radius: 3)
                        .padding(5)
                }
            }
            .overlay(alignment: .bottomLeading) {
                if asset.isFavorite {
                    Image(systemName: "heart.fill").font(.system(size: 11)).foregroundStyle(.white)
                        .shadow(radius: 3).padding(5)
                }
            }
            .overlay {
                if selected == true { Color.white.opacity(0.25) }
            }
            .overlay(alignment: .bottomTrailing) {
                if selected == true {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.system(size: 22, weight: .semibold))
                        .symbolRenderingMode(.palette)
                        .foregroundStyle(.white, Color.blue)
                        .shadow(radius: 2).padding(5)
                }
            }
            .contentShape(Rectangle())
            // wie die Mediathek (AssetCell): VoiceOver liest „Foto, 13. September 2026“ statt nur „Favorit“
            .accessibilityElement(children: .ignore)
            .accessibilityLabel((asset.isVideo ? String(localized: "Video, ") : String(localized: "Foto, ")) + Fmt.dayLongMonthYear.string(from: asset.date))
            .accessibilityValue(asset.isFavorite ? String(localized: "Favorit") : "")
            .accessibilityAddTraits(selected == true ? [.isImage, .isSelected] : .isImage)
            .zoomSource(asset.id, zoomNS)
    }
}

/// Zoom-Übergang Raster → Einzelansicht (iOS 18+ Navigation-Transition).
private struct ZoomNamespaceKey: EnvironmentKey { static let defaultValue: Namespace.ID? = nil }
extension EnvironmentValues {
    var zoomNamespace: Namespace.ID? {
        get { self[ZoomNamespaceKey.self] }
        set { self[ZoomNamespaceKey.self] = newValue }
    }
}
extension View {
    @ViewBuilder func zoomSource(_ id: String, _ ns: Namespace.ID?) -> some View {
        if let ns { matchedTransitionSource(id: id, in: ns) } else { self }
    }
}

// MARK: - Monate

struct MonthsList: View {
    @Binding var subtitle: String
    @Environment(AppModel.self) private var app
    @Environment(TimelineStore.self) private var timeline

    /// List (UICollectionView darunter) statt LazyVStack: springt auch bei 116 unterschiedlich hohen Monaten genau
    /// (LazyVStack verschätzte sich → schwarzer Schirm nach „Jahr antippen“). Jeder Tag ist eine eigene Zeile.
    var body: some View {
        ScrollViewReader { proxy in
            List {
                Color.clear.frame(height: 110).plainRow()
                ForEach(timeline.buckets) { b in
                    MonthHeader(bucket: b).id(b.timeBucket).plainRow()
                    MonthDays(bucket: b, subtitle: $subtitle)
                }
                Color.clear.frame(height: 100).id("ende").plainRow()
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .scrollIndicators(.hidden)
            .environment(\.defaultMinListRowHeight, 0)
            .ignoresSafeArea(edges: .top)
            .task { await arrive(proxy, first: true) }
            // bleibt im Hintergrund bestehen: beim Zurückkommen nur noch zum gewählten Jahr springen
            .onChange(of: app.scale) { _, s in
                guard s == .months, app.scrollTarget != nil else { return }
                Task { await arrive(proxy, first: false) }
            }
        }
    }
}

extension MonthsList {
    func arrive(_ proxy: ScrollViewProxy, first: Bool) async {
        if let t = app.scrollTarget {
            app.scrollTarget = nil
            await timeline.load(t)
            try? await Task.sleep(for: .milliseconds(50))
            proxy.scrollTo(t, anchor: .top)
            if let b = timeline.buckets.first(where: { $0.timeBucket == t }) {
                subtitle = String(Calendar.wall.component(.year, from: b.monthDate))
            }
            return
        }
        guard first, !timeline.buckets.isEmpty else { return }
        for b in timeline.buckets.suffix(2) { await timeline.load(b.timeBucket) }
        try? await Task.sleep(for: .milliseconds(50))
        proxy.scrollTo("ende", anchor: .bottom)
    }
}

private extension View {
    func plainRow() -> some View {
        listRowInsets(EdgeInsets()).listRowSeparator(.hidden).listRowBackground(Color.clear)
    }
}

struct MonthHeader: View {
    let bucket: TimeBucket
    var body: some View {
        Text(Fmt.monthYear.string(from: bucket.monthDate))
            .font(.system(size: 24, weight: .bold))
            .padding(.horizontal, 20)
            .padding(.top, 14)
            .padding(.bottom, 4)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Die Tageskarten eines Monats als einzelne Zeilen (Platzhalter, bis der Monat geladen ist).
struct MonthDays: View {
    let bucket: TimeBucket
    @Binding var subtitle: String
    @Environment(AppModel.self) private var app
    @Environment(TimelineStore.self) private var timeline
    @Environment(\.horizontalSizeClass) private var sizeClass
    private var wide: Bool { sizeClass == .regular }

    private func dayButton(_ d: DayGroup) -> some View {
        Button {
            app.scrollTarget = bucket.timeBucket
            withAnimation(.snappy) { app.scale = .all }
        } label: { DayCard(group: d) }
        .buttonStyle(.plain)
    }

    var body: some View {
        let days = timeline.days(in: bucket.timeBucket)
        if days.isEmpty {
            RoundedRectangle(cornerRadius: 24).fill(Color.appFill)
                .frame(height: 230).padding(.horizontal, 16).padding(.vertical, 5)
                .listRowInsets(EdgeInsets()).listRowSeparator(.hidden).listRowBackground(Color.clear)
                .task { await timeline.load(bucket.timeBucket) }
        } else if wide {
            // iPad: zwei Tage nebeneinander statt bildschirmbreiter Karten (GitHub #47)
            ForEach(Array(stride(from: 0, to: days.count, by: 2)), id: \.self) { i in
                HStack(spacing: 12) {
                    ForEach(days[i..<min(i + 2, days.count)]) { d in dayButton(d) }
                    if i + 1 >= days.count { Color.clear.frame(maxWidth: .infinity) }
                }
                .padding(.horizontal, 16).padding(.vertical, 5)
                .listRowInsets(EdgeInsets()).listRowSeparator(.hidden).listRowBackground(Color.clear)
                .onAppear { timeline.touch(bucket.timeBucket); subtitle = String(Calendar.wall.component(.year, from: days[i].day)) }
            }
        } else {
            ForEach(days) { d in
                dayButton(d)
                .padding(.horizontal, 16).padding(.vertical, 5)
                .listRowInsets(EdgeInsets()).listRowSeparator(.hidden).listRowBackground(Color.clear)
                .onAppear { timeline.touch(bucket.timeBucket); subtitle = String(Calendar.wall.component(.year, from: d.day)) }
            }
        }
    }
}

struct DayCard: View {
    let group: DayGroup
    var body: some View {
        let others = Array(group.assets.filter { $0.id != group.keyAsset.id }.prefix(2))
        HStack(spacing: 2) {
            AssetThumb(id: group.keyAsset.id, size: .preview)
            if others.count == 2 {
                VStack(spacing: 2) {
                    ForEach(others) { a in AssetThumb(id: a.id) }
                }
                .frame(width: 118)
            }
        }
        .frame(height: 230)
        .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
        .overlay(alignment: .bottomLeading) {
            VStack(alignment: .leading, spacing: 2) {
                Text(group.title).font(.system(size: 22, weight: .bold))
                Text(group.subtitle)
                    .font(.system(size: 13, weight: .semibold)).opacity(0.85)
            }
            .foregroundStyle(.white)
            .shadow(color: .black.opacity(0.5), radius: 8)
            .padding(18)
        }
        .overlay(alignment: .topTrailing) {
            if group.assets.count > 3 {
                Text("\(group.assets.count)")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 10).padding(.vertical, 5)
                    .glassEffect(.regular, in: .capsule)
                    .padding(12)
            }
        }
    }
}

// MARK: - Jahre

struct YearsList: View {
    @Environment(AppModel.self) private var app
    @Environment(TimelineStore.self) private var timeline
    @State private var width: CGFloat = 390

    var body: some View {
        // iPad: zwei Spalten statt bildschirmbreiter Karten (GitHub #47); Reihen von oben, das neueste Jahr unten rechts
        let n = width > 700 ? 2 : 1
        let years = timeline.years
        let rows = stride(from: 0, to: years.count, by: n).map { Array(years[$0..<min($0 + n, years.count)]) }
        ScrollView {
            // nur ~12 Karten → normaler VStack: LazyVStack + Anker unten landete hinter dem Inhalt (schwarzer Schirm)
            VStack(spacing: 16) {
                Color.clear.frame(height: 100)
                ForEach(rows, id: \.self) { row in
                    HStack(spacing: 16) {
                        ForEach(row, id: \.self) { y in
                            Button {
                                app.scrollTarget = timeline.buckets(inYear: y).first?.timeBucket
                                withAnimation(.snappy) { app.scale = .months }
                            } label: { YearCard(year: y) }
                            .buttonStyle(.plain)
                        }
                        if row.count < n { Color.clear.frame(maxWidth: .infinity) }
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 100)
        }
        .defaultScrollAnchor(.bottom)
        .scrollIndicators(.hidden)
        .ignoresSafeArea(edges: .top)
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
    }
}

struct YearCard: View {
    let year: Int
    @Environment(TimelineStore.self) private var timeline

    var body: some View {
        let months = timeline.buckets(inYear: year)
        // Titelbild: neuestes Foto mit Vorschau (fehlt sie noch auf dem Server oder offline, wäre die Karte grau)
        let key = months.reversed().lazy.compactMap { timeline.assets($0.timeBucket)?.last(where: { $0.isImage && ImageCache.shared.hash($0.id) != nil }) }.first
            ?? months.reversed().lazy.compactMap { timeline.assets($0.timeBucket)?.last(where: \.isImage) }.first
        ZStack {
            if let key { AssetThumb(id: key.id, size: .preview) } else { Color.appFill }
        }
        .frame(height: 300)
        .clipShape(RoundedRectangle(cornerRadius: 28, style: .continuous))
        .overlay(alignment: .topLeading) {
            Text(String(year))
                .font(.system(size: 30, weight: .bold))
                .foregroundStyle(.white)
                .shadow(color: .black.opacity(0.5), radius: 8)
                .padding(20)
        }
        .task {
            for m in months.reversed() {
                await timeline.load(m.timeBucket)
                if timeline.assets(m.timeBucket)?.contains(where: { $0.isImage && ImageCache.shared.hash($0.id) != nil }) == true { break }
            }
        }
    }
}

extension View {
    /// Langes Drücken: große Vorschau + Menü wie in Fotos.
    func assetContextMenu(_ a: Asset, enabled: Bool = true, onRemove: @escaping () -> Void = {}) -> some View {
        modifier(AssetContextMenu(asset: a, enabled: enabled, onRemove: onRemove))
    }
}

private struct AssetContextMenu: ViewModifier {
    let asset: Asset
    let enabled: Bool
    let onRemove: () -> Void
    @Environment(AppModel.self) private var app
    func body(content: Content) -> some View {
        if enabled {
            content.contextMenu {
                AssetMenu(assets: [asset], style: .context, present: { app.sheet = $0 }, onDelete: onRemove)
            } preview: {
                AssetThumb(id: asset.id, size: .preview)
                    .aspectRatio(asset.ratio, contentMode: .fit)
                    .frame(width: 360, height: 360 / max(0.5, min(2, asset.ratio)))
            }
        } else { content }
    }
}
