import SwiftUI
import MapKit

enum CollectionRoute: Hashable {
    case assets(title: String, ids: [String])
    case category(Category)
    case album(AlbumRef)
    case allAlbums, allMediaTypes, allOthers, allPinned
    case albumFolder(String)
}
struct AlbumRef: Hashable { let id: String; let name: String }
struct PersonRef: Hashable { let id: String; let name: String }

@MainActor @Observable
final class CollectionsModel {
    var albums: [AlbumDTO] = []
    var markers: [MapMarkerDTO] = []
    var userName = ""
    var loaded = false

    func reloadAlbums() async {
        guard let a = try? await ImmichClient.shared.albums() else { return }
        albums = a
        AlbumNames.byID = Dictionary(a.map { ($0.id, $0.albumName) }, uniquingKeysWith: { x, _ in x })
    }

    func load() async {
        let c = ImmichClient.shared
        async let a = try? c.albums()
        async let mk = try? c.mapMarkers()
        async let me = try? c.me()
        if let a = await a { albums = a; AlbumNames.byID = Dictionary(a.map { ($0.id, $0.albumName) }, uniquingKeysWith: { x, _ in x }) }
        markers = await mk ?? []
        userName = (await me)?.name ?? ""
        loaded = true
    }
}

struct CollectionsView: View {
    @Environment(AppModel.self) private var app
    @Environment(TimelineStore.self) private var timeline
    @State private var model = CollectionsModel()
    @State private var path = NavigationPath()
    private var side: CGFloat { [100, 128, 160][min(2, max(0, cardSize))] }
    @AppStorage("collapsedSections") private var collapsedRaw = ""
    @AppStorage("sectionOrder") private var orderRaw = ""
    @AppStorage("pinned") private var pinnedRaw = PinItem.defaults
    @AppStorage("cardSize") private var cardSize = 1
    @AppStorage("albumSort") private var albumSortRaw = AlbumSort.modified.rawValue
    @State private var editPinned = false
    @State private var reorder = false
    @State private var newAlbum = false
    @State private var showBackup = false
    @State private var confirmSignOut = false
    @State private var recentDays: [DayGroup] = []
    @State private var albumName = ""

    private var order: [Sec] {
        let saved = orderRaw.split(separator: ",").compactMap { Sec(rawValue: String($0)) }
        return saved + Sec.allCases.filter { !saved.contains($0) }
    }

    var body: some View {
        NavigationStack(path: $path) {
            ScrollView {
                VStack(alignment: .leading, spacing: 30) {
                    Color.clear.frame(height: 64)
                    ForEach(order, id: \.self) { sec in sectionView(sec) }
                }
                .padding(.bottom, 120)
            }
            .scrollIndicators(.hidden)
            .background(Color.appBackground)
            .overlay(alignment: .top) {
                header.padding(.bottom, 26).background(alignment: .top) { TopBlur() }
            }
            .toolbar(.hidden, for: .navigationBar)
            .navigationDestination(for: CollectionRoute.self) { r in
                if r == .allPinned { PinnedScreen(items: PinItem.parse(pinnedRaw), model: model) }
                else { CollectionDetail(route: r, model: model) }
            }
            .navigationDestination(for: DayGroup.self) { d in AssetGridScreen(title: d.title, subtitle: Fmt.weekdayDay.string(from: d.day), assets: d.assets) }
        }
        .environment(\.cardSide, [100, 128, 160][min(2, max(0, cardSize))])
        .task {
            if !model.loaded { await model.load() }
            await timeline.loadAll()
            AlbumFolders.shared.use(app.userID)
        }
        .task(id: timeline.version) { await rebuildDerived() }
        .sheet(isPresented: $editPinned) { PinnedEditor(raw: $pinnedRaw) }
        .sheet(isPresented: $reorder) { SectionOrderEditor(raw: $orderRaw) }
        .sheet(isPresented: $newAlbum) { NewAlbumSheet() }
        .sheet(isPresented: $showBackup) { BackupView() }
        .onReceive(NotificationCenter.default.publisher(for: .albumsChanged)) { _ in Task { await model.reloadAlbums() } }
    }

    @ViewBuilder private func sectionView(_ sec: Sec) -> some View {
        switch sec {
        case .pinned: section(String(localized: "Angepinnt"), route: .allPinned, edit: true) { pinnedRow }
        case .albums: section(String(localized: "Alben"), route: model.albums.isEmpty ? nil : .allAlbums) { albumsRow }
        case .recentDays: section(String(localized: "Letzte Tage")) { recentDaysRow }
        case .mediaTypes: section(String(localized: "Medienarten"), route: .allMediaTypes) { CategoryRows(items: Category.mediaTypes) }
        case .others: section(String(localized: "Sonstige"), route: .allOthers) { CategoryRows(items: Category.others) }
        }
    }

    // MARK: Kopf

    private var header: some View {
        HStack(alignment: .top) {
            Text(String(localized: "Sammlungen")).font(.system(size: 34, weight: .bold))
            Spacer()
            HStack(spacing: 12) {
                Menu {
                    Section {
                        ControlGroup {
                            ForEach([2, 1, 0], id: \.self) { i in
                                Button { withAnimation(.snappy) { cardSize = i } } label: {
                                    Label([String(localized: "Klein"), String(localized: "Mittel"), String(localized: "Groß")][i],
                                          systemImage: [cardSize == 0 ? "square.grid.4x3.fill" : "square.grid.4x3.fill",
                                                        "square.grid.3x3.fill", "square.grid.2x2.fill"][i])
                                }
                            }
                        }
                        .controlGroupStyle(.compactMenu)
                    }
                    Button(String(localized: "Alle einblenden")) { withAnimation(.snappy) { collapsedRaw = "" } }
                    Button(String(localized: "Alle reduzieren")) {
                        withAnimation(.snappy) { collapsedRaw = Sec.allCases.map(\.title).joined(separator: "|") }
                    }
                    Divider()
                    Button(String(localized: "Neu anordnen")) { reorder = true }
                } label: {
                    Image(systemName: "ellipsis").font(.system(size: 18, weight: .bold))
                        .foregroundStyle(.primary).frame(width: 46, height: 46).contentShape(.rect)
                }
                .glassEffect(.regular.interactive(), in: .circle)
                Menu {
                    Section(model.userName) {
                        Button(String(localized: "Backup"), systemImage: "arrow.triangle.2.circlepath.icloud") { showBackup = true }
                        Button(String(localized: "Einstellungen", table: "Theme"), systemImage: "gearshape") { app.showSettings = true }
                        Button(String(localized: "Aktualisieren"), systemImage: "arrow.clockwise") {
                            Task { await model.load(); await timeline.reload(); await timeline.loadAll() }
                        }
                        // Abmelden löscht Offline-Vorschauen und Zwischenspeicher → vorher nachfragen (wie im Mediathek-Menü)
                        Button(String(localized: "Abmelden"), systemImage: "rectangle.portrait.and.arrow.right", role: .destructive) {
                            confirmSignOut = true
                        }
                    }
                    // leere Abschnitte zeigt das Menü nicht an → als Textzeilen (nicht antippbar)
                    Section {
                        Text(String(localized: "\(timeline.totalCount.formatted()) Objekte auf deinem Server"))
                        Text(verbatim: "Phosphor Photos \(AppInfo.version)")   // installierte Version (GitHub-Issue #12)
                    }
                } label: {
                    Circle().fill(LinearGradient(colors: [.blue, .purple], startPoint: .topLeading, endPoint: .bottomTrailing))
                        .frame(width: 46, height: 46)
                        .overlay { Text(String(model.userName.prefix(1))).font(.system(size: 20, weight: .semibold)).foregroundStyle(.white) }
                }
                .confirmationDialog(String(localized: "Abmelden"), isPresented: $confirmSignOut, titleVisibility: .visible) {
                    Button(String(localized: "Abmelden"), role: .destructive) { app.signOut(timeline) }
                    Button(String(localized: "Abbrechen"), role: .cancel) {}
                }
            }
        }
        .padding(.horizontal, 22)
        .padding(.top, 8)
    }

    // MARK: Abschnitts-Gerüst (einklappbar wie in Fotos)

    private func section<C: View>(_ title: String, route: CollectionRoute? = nil, edit: Bool = false,
                                  @ViewBuilder content: () -> C) -> some View {
        let collapsed = collapsedRaw.split(separator: "|").contains(Substring(title))
        return VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 10) {
                Button {
                    if let route { path.append(route) }
                } label: {
                    HStack(spacing: 6) {
                        Text(title).font(.system(size: 26, weight: .bold))
                        if route != nil { Image(systemName: "chevron.right").font(.system(size: 20, weight: .bold)).foregroundStyle(.secondary) }
                    }
                    .foregroundStyle(.primary)
                }
                .buttonStyle(.plain)
                Spacer()
                if edit {
                    Button { editPinned = true } label: {
                        Text(String(localized: "Bearbeiten")).font(.system(size: 16, weight: .semibold)).foregroundStyle(.blue)
                            .padding(.horizontal, 14).frame(height: 34)
                            .background(Capsule().fill(Color.appFill2))
                    }
                    .buttonStyle(.plain)
                }
                Button {
                    withAnimation(.snappy) { toggle(title) }
                } label: {
                    Image(systemName: "chevron.down")
                        .font(.system(size: 15, weight: .bold))
                        .rotationEffect(.degrees(collapsed ? -90 : 0))
                        .foregroundStyle(.blue)
                        .frame(width: 34, height: 34)
                        .background(Circle().fill(Color.appFill2))
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 22)
            if !collapsed { content() }
        }
    }

    private func toggle(_ t: String) {
        var s = Set(collapsedRaw.split(separator: "|").map(String.init))
        if s.contains(t) { s.remove(t) } else { s.insert(t) }
        collapsedRaw = s.sorted().joined(separator: "|")
    }

    private func row<C: View>(@ViewBuilder _ c: () -> C) -> some View {
        ScrollView(.horizontal) {
            LazyHStack(spacing: 12) { c() }
                .padding(.horizontal, 22)
        }
        .scrollIndicators(.hidden)
    }

    // MARK: Angepinnt

    private var pinnedRow: some View {
        row {
            ForEach(PinItem.parse(pinnedRaw), id: \.self) { p in PinCard(item: p, model: model) }
        }
        .buttonStyle(.plain)
    }

    // MARK: Alben / Personen / Empfohlen

    @ViewBuilder private var albumsRow: some View {
        if model.albums.isEmpty {
            EmptyCard(icon: "rectangle.stack", title: String(localized: "Keine Alben verfügbar"),
                      text: String(localized: "Hier werden Alben angezeigt, sobald du eines erstellst oder Fotos hinzufügst."),
                      action: (String(localized: "Erstellen"), { albumName = ""; newAlbum = true }))
        } else { albumsList }
    }

    private var albumsList: some View {
        row {
            Button { albumName = ""; newAlbum = true } label: { NewAlbumCard() }.buttonStyle(.plain)
            ForEach((AlbumSort(rawValue: albumSortRaw) ?? .modified).apply(model.albums)) { a in
                NavigationLink(value: CollectionRoute.album(AlbumRef(id: a.id, name: a.albumName))) {
                    SmallCard(assetID: a.albumThumbnailAssetId, title: a.albumName)
                }
                .buttonStyle(.plain)
                .albumContextMenu(a)
            }
        }
    }

    // MARK: Letzte Tage

    /// Letzte Tage kosten bei 80 000 Objekten spürbar → nur bei neuer Zeitleisten-Version, im Hintergrund.
    private func rebuildDerived() async {
        let all = timeline.allLoaded
        let worker = Task.detached(priority: .userInitiated) { () -> [DayGroup] in
            let tail = all.suffix(5000)   // die letzten 10 Tage stecken sicher in den neuesten Objekten
            let g = Dictionary(grouping: tail) { Calendar.wall.startOfDay(for: $0.date) }
            return g.keys.sorted(by: >).prefix(10).map { DayGroup(day: $0, assets: g[$0]!) }
        }
        let days = await withTaskCancellationHandler { await worker.value } onCancel: { worker.cancel() }
        guard !Task.isCancelled else { return }
        recentDays = days
    }

    private var recentDaysRow: some View {
        row {
            ForEach(recentDays) { d in
                NavigationLink(value: d) {
                    SmallCard(assetID: d.keyAsset.id, title: dayLabel(d.day))
                }
                .buttonStyle(.plain)
            }
        }
    }

    private func dayLabel(_ d: Date) -> String { Fmt.relativeDay(d, fallback: Fmt.dayMonthYear) }



}

// MARK: - Karten-Bausteine

struct BigCard: View {
    let assetID: String?
    let title: String
    let subtitle: String
    var play = false
    var body: some View {
        ZStack {
            if let assetID { AssetThumb(id: assetID, size: .preview) } else { Color.appFill }
        }
        .clipShape(RoundedRectangle(cornerRadius: 26, style: .continuous))
        .overlay {
            LinearGradient(colors: [.clear, .clear, .black.opacity(0.55)], startPoint: .top, endPoint: .bottom)
                .clipShape(RoundedRectangle(cornerRadius: 26, style: .continuous))
        }
        .overlay(alignment: .bottomLeading) {
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.system(size: 26, weight: .bold)).lineLimit(2)
                Text(subtitle).font(.system(size: 14, weight: .semibold)).opacity(0.9)
            }
            .foregroundStyle(.white).padding(20)
        }
        .overlay(alignment: .bottomTrailing) {
            if play {
                Image(systemName: "play.fill").font(.system(size: 18)).foregroundStyle(.white)
                    .frame(width: 44, height: 44).glassEffect(.regular, in: .circle).padding(16)
            }
        }
    }
}

struct SmallCard: View {
    let assetID: String?
    let title: String
    var badge: String? = nil
    @Environment(\.cardSide) private var side
    var body: some View {
        ZStack {
            if let assetID { AssetThumb(id: assetID, size: .preview) } else { Color.appFill }
        }
        .frame(width: side, height: side)
        .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
        .overlay {
            LinearGradient(colors: [.clear, .black.opacity(0.45)], startPoint: .center, endPoint: .bottom)
                .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
        }
        .overlay(alignment: .bottomLeading) {
            Text(title).font(.system(size: 17, weight: .semibold)).foregroundStyle(.white)
                .lineLimit(2).shadow(radius: 4).padding(12)
        }
        .overlay(alignment: .topTrailing) {
            if let badge { Image(systemName: badge).font(.system(size: 16)).foregroundStyle(.white).shadow(radius: 3).padding(12) }
        }
    }
}

struct MosaicCard: View {
    let ids: [String]
    let title: String
    @Environment(\.cardSide) private var side
    var body: some View {
        let g = [GridItem(.flexible(), spacing: 2), GridItem(.flexible(), spacing: 2)]
        LazyVGrid(columns: g, spacing: 2) {
            ForEach(0..<4, id: \.self) { i in
                Group { if i < ids.count { AssetThumb(id: ids[i]) } else { Color.appFill } }
                    .frame(height: side / 2 - 1)
            }
        }
        .frame(width: side, height: side)
        .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
        .overlay {
            LinearGradient(colors: [.clear, .black.opacity(0.5)], startPoint: .center, endPoint: .bottom)
                .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
        }
        .overlay(alignment: .bottomLeading) {
            Text(title).font(.system(size: 17, weight: .semibold)).foregroundStyle(.white).lineLimit(2).padding(12)
        }
    }
}

/// Statisches Kartenbild (MKMapSnapshotter) – ohne „Legal“-Hinweis, wie die Karten-Kachel in Fotos.
struct MapCard: View {
    let markers: [MapMarkerDTO]
    @State private var image: UIImage?
    @Environment(\.cardSide) private var side

    var body: some View {
        ZStack(alignment: .top) {
            // Bild ist höher als die Kachel: Karten-Logo unten links liegt außerhalb und wird abgeschnitten
            if let image { Image(uiImage: image).resizable().frame(width: side, height: side * 1.375) } else { Color.appFill }
        }
        .frame(width: side, height: side, alignment: .top)
        .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
        .overlay(alignment: .bottomLeading) {
            Text(String(localized: "Karte")).font(.system(size: 17, weight: .semibold)).foregroundStyle(.white).shadow(radius: 4).padding(12)
        }
        .task(id: markers.count) { image = await snapshot() }
    }

    private func snapshot() async -> UIImage? {
        // Mittelpunkt = Ort mit den meisten Fotos (meist Zuhause), kleiner Ausschnitt wie bei Apple
        let home = Dictionary(grouping: markers) { "\(Int($0.lat))/\(Int($0.lon))" }.max { $0.value.count < $1.value.count }?.value.first
        // ohne Orte: Weltkarte statt eines festen Ortes
        let center = CLLocationCoordinate2D(latitude: home?.lat ?? 20, longitude: home?.lon ?? 0)
        let o = MKMapSnapshotter.Options()
        let d = home == nil ? 120.0 : 1.2
        o.region = MKCoordinateRegion(center: center, span: .init(latitudeDelta: d, longitudeDelta: d))
        o.size = CGSize(width: 128, height: 176)
        o.traitCollection = UITraitCollection(userInterfaceStyle: .dark)
        o.pointOfInterestFilter = .excludingAll
        return try? await MKMapSnapshotter(options: o).start().image
    }
}
