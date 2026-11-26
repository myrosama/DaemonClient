import SwiftUI
import MapKit

/// Lädt die Inhalte einer Sammlung und zeigt sie als Raster.
struct CollectionDetail: View {
    let route: CollectionRoute
    let model: CollectionsModel
    @Environment(TimelineStore.self) private var timeline
    @Environment(AppModel.self) private var app
    @State private var loaded: [Asset]?
    /// Person umbenannt: neuer Titel ohne Neuladen
    @State private var renamed: String?

    var body: some View {
        switch route {
        case .category(.map): MapScreen(markers: model.markers)
        case .category(let c) where c.locked: LockGate(title: c.title) { grid }
        case .allMediaTypes: CategoryListScreen(title: String(localized: "Medienarten"), items: Category.mediaTypes)
        case .allOthers: CategoryListScreen(title: String(localized: "Sonstige"), items: Category.others)
        case .allAlbums: AlbumsListScreen(model: model)
        case .albumFolder(let id): AlbumsListScreen(model: model, folderID: id)
        case .album(let a): AlbumScreen(ref: a)
        default: grid
        }
    }

    private var grid: some View {
        AssetGridScreen(title: title, subtitle: loaded.map { $0.count == 1 ? String(localized: "1 Objekt") : String(localized: "\($0.count) Objekte") } ?? "",
                        assets: loaded ?? [], loading: loaded == nil,
                        menu: historyMenu,
                        onRemove: { id in withAnimation(.snappy) { loaded?.removeAll { $0.id == id } } })
            .task { if loaded == nil { loaded = await load() } }
            // nach Einblenden in der Einzelansicht die Liste auffrischen
            .onChange(of: app.viewer == nil) { _, closed in
                guard closed, case .category(let c) = route, c.locked else { return }
                Task { loaded = await load() }
            }
    }

    private var historyMenu: AnyView? {
        guard case .category(let c) = route, c == .recentlyViewed || c == .recentlyShared else { return nil }
        // wie Apple: Verlauf von „Zuletzt angesehen/geteilt“ löschen
        return AnyView(Menu {
            Button(String(localized: "Verlauf löschen"), systemImage: "clock.badge.xmark", role: .destructive) {
                RecentStore.clear(c); withAnimation(.snappy) { loaded = [] }
            }
        } label: {
            Image(systemName: "ellipsis").font(.system(size: 17, weight: .semibold)).frame(width: 44, height: 44).contentShape(.rect)
        }
        .glassEffect(.regular.interactive(), in: .circle))
    }

    private var title: String {
        switch route {
        case .category(let c): c.title
        case .album(let a): a.name
        case .assets(let t, _): t
        default: ""
        }
    }

    private func load() async -> [Asset] {
        switch route {
        case .category(let cat): return await CategoryLoader.load(cat, timeline: timeline)
        case .album(let a): return (try? await ImmichClient.shared.albumAssets(a.id)) ?? []
        case .assets(_, let ids):
            let set = Set(ids); return timeline.allLoaded.filter { set.contains($0.id) }
        default: return []
        }
    }
}

/// Raster-Seite mit großem Titel (Alben, Personen, Tage, Reisen, Favoriten …) – dasselbe Raster wie die Mediathek:
/// Zoom mit zwei Fingern (1/3/5/Monate/Jahre), Wisch-Auswahl, Vorausladen. Wie Apple: „Neueste zuerst“ oder „Älteste zuerst“.
struct AssetGridScreen: View {
    let title: String
    var subtitle: String = ""
    let assets: [Asset]
    var loading = false
    var menu: AnyView? = nil
    var onRemove: ((String) -> Void)? = nil
    var back = false
    @Environment(AppModel.self) private var app
    @Environment(TimelineStore.self) private var timeline
    @AppStorage("collections.newestFirst") private var newestFirst = true
    @AppStorage("collections.columns") private var columns = 3
    @State private var grid = GridController()

    private var sorted: [Asset] { assets.sorted { newestFirst ? $0.date > $1.date : $0.date < $1.date } }

    var body: some View {
        let list = sorted
        Group {
            // „Zuletzt gelöscht“ zeigt unter jedem Foto die verbleibenden Tage – dafür das einfache Raster
            if list.contains(where: { $0.trashedAt != nil }) { trashGrid(list) }
            else {
                PhotoGrid(items: list.map { .asset($0, bucket: "") }, columns: columns, topInset: 120, controller: grid,
                          fit: false, selection: app.selecting ? app.selected : nil, highlight: nil, me: app.userID,
                          onTop: { _ in }, onShow: { _ in },
                          onColumns: { columns = $0 },
                          onOpen: { i, _ in app.open(list, at: i) },
                          onToggle: { app.toggle($0) }, onSelect: { app.selected = $0 },
                          menu: { a in AssetMenuUIKit.context(a, app: app, timeline: timeline) { onRemove?(a.id) } },
                          autoplay: app.autoplay && app.viewer == nil, startAtTop: newestFirst)
                    .id(newestFirst)        // Reihenfolge gewechselt → neu aufbauen und oben bzw. unten beginnen
                    .ignoresSafeArea()
            }
        }
        .background(Color.appBackground)
        .overlay(alignment: .top) {
            ScreenHeader(title: title, subtitle: subtitle, menu: AnyView(HStack(spacing: 10) { headerButtons(list) }), back: back)
        }
        .onDisappear { app.endSelection() }
        .overlay {
            if loading { ProgressView() }
            else if assets.isEmpty { ContentUnavailableView(String(localized: "Keine Fotos oder Videos"), systemImage: "photo.on.rectangle") }
        }
        .toolbar(.hidden, for: .navigationBar)
    }

    /// Wie im Album: „Auswählen“ → Mehrfachauswahl mit „…“-Menü (Teilen/Löschen unten in der Auswahlleiste) – GitHub #55
    @ViewBuilder private func headerButtons(_ list: [Asset]) -> some View {
        if app.selecting {
            Menu {
                AssetMenu(assets: list.filter { app.selected.contains($0.id) }, style: .selection, present: { app.sheet = $0 }) {
                    withAnimation(.snappy) { app.endSelection() }
                }
            } label: {
                Image(systemName: "ellipsis").font(.system(size: 16, weight: .semibold)).frame(width: 44, height: 44).contentShape(.rect)
            }
            .glassEffect(.regular.interactive(), in: .circle)
            .disabled(app.selected.isEmpty)
            Button(String(localized: "Fertig")) { withAnimation(.snappy) { app.endSelection() } }
                .font(.system(size: 17, weight: .semibold)).lineLimit(1).fixedSize().padding(.horizontal, 16).frame(height: 44)
                .glassEffect(.regular.interactive(), in: .capsule)
        } else {
            sortMenu
            if let menu { menu }
            // „Zuletzt gelöscht“ hat sein eigenes Raster ohne Auswahl
            if !list.isEmpty, !list.contains(where: { $0.trashedAt != nil }) {
                Button(String(localized: "Auswählen")) { withAnimation(.snappy) { app.selecting = true } }
                    .font(.system(size: 17, weight: .semibold)).lineLimit(1).fixedSize().padding(.horizontal, 16).frame(height: 44)
                    .glassEffect(.regular.interactive(), in: .capsule)
            }
        }
    }

    private var sortMenu: some View {
        Menu {
            Picker(String(localized: "Sortieren"), selection: $newestFirst) {
                Label(String(localized: "Neueste zuerst"), systemImage: "arrow.down").tag(true)
                Label(String(localized: "Älteste zuerst"), systemImage: "arrow.up").tag(false)
            }
            Section {
                Button(String(localized: "Vergrößern"), systemImage: "plus.magnifyingglass") { columns = GridZoom.steps.last { $0 < columns } ?? columns }
                    .disabled(columns == GridZoom.steps.first)
                Button(String(localized: "Verkleinern"), systemImage: "minus.magnifyingglass") { columns = GridZoom.steps.first { $0 > columns } ?? columns }
                    .disabled(columns == GridZoom.steps.last)
            }
        } label: {
            Image(systemName: "arrow.up.arrow.down").font(.system(size: 16, weight: .semibold)).frame(width: 44, height: 44).contentShape(.rect)
        }
        .glassEffect(.regular.interactive(), in: .circle)
        .accessibilityLabel(String(localized: "Sortieren und Zoomen"))
    }

    private func trashGrid(_ list: [Asset]) -> some View {
        ScrollView {
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 2), count: 3), spacing: 2) {
                ForEach(Array(list.enumerated()), id: \.element.id) { i, a in
                    Button { app.open(list, at: i) } label: {
                        GridCell(asset: a)
                            .overlay(alignment: .bottom) {
                                // „Zuletzt gelöscht“: verbleibende Tage wie bei Apple
                                if a.trashedAt != nil {
                                    Text(TrashDays.text(a)).font(.system(size: 12, weight: .semibold))
                                        .foregroundStyle(.white).shadow(color: .black.opacity(0.7), radius: 3)
                                        .padding(.bottom, 5)
                                }
                            }
                    }
                    .buttonStyle(.plain)
                    .assetContextMenu(a) { onRemove?(a.id) }
                }
            }
            .padding(.top, 130)
            .padding(.bottom, 110)
        }
        .defaultScrollAnchor(newestFirst ? .top : .bottom, for: .initialOffset)
        .ignoresSafeArea(edges: .top)
    }
}

struct CardGridScreen: View {
    let title: String
    let items: [(String?, String, CollectionRoute)]
    var body: some View {
        ScrollView {
            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 16) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, it in
                    NavigationLink(value: it.2) {
                        VStack(alignment: .leading, spacing: 6) {
                            Group { if let id = it.0 { AssetThumb(id: id, size: .preview) } else { Color.appFill } }
                                .aspectRatio(1, contentMode: .fit)
                                .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                            Text(it.1).font(.system(size: 16, weight: .semibold)).foregroundStyle(.primary).lineLimit(1)
                        }
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(20)
        }
        .background(Color.appBackground)
        .navigationTitle(title)
    }
}

/// Karte wie in Fotos: Fotos als Vorschaubilder, je nach Zoomstufe zusammengefasst;
/// Tippen öffnet das Raster der Fotos an diesem Ort.
struct MapScreen: View {
    let markers: [MapMarkerDTO]
    @Environment(TimelineStore.self) private var timeline
    @Environment(\.dismiss) private var dismiss
    @State private var position: MapCameraPosition = .automatic
    @State private var groups: [MapGroup] = []
    @State private var clustering: Task<Void, Never>?
    @State private var region: MKCoordinateRegion?
    /// Kartenart wie Fotos: Erkunden / Satellit (mit Beschriftung) – und 2D/3D
    @AppStorage("map.kind") private var kind = 0
    @AppStorage("map.flat") private var flat = false
    @State private var opened: MapGroup?

    struct MapGroup: Identifiable, Hashable {
        let id: String
        let coord: CLLocationCoordinate2D
        let ids: [String]
        let title: String
        static func == (a: MapGroup, b: MapGroup) -> Bool { a.id == b.id }
        func hash(into h: inout Hasher) { h.combine(id) }
    }

    var body: some View {
        Map(position: $position) {
            ForEach(groups) { g in
                Annotation("", coordinate: g.coord, anchor: .bottom) {
                    Button { opened = g } label: { pin(g) }.buttonStyle(.plain)
                }
            }
        }
        .mapStyle(kind == 1 ? .imagery(elevation: flat ? .flat : .realistic)
                  : kind == 2 ? .hybrid(elevation: flat ? .flat : .realistic, pointsOfInterest: .excludingAll)
                  : .standard(elevation: flat ? .flat : .realistic, pointsOfInterest: .excludingAll))
        .mapControls { MapCompass() }
        .onMapCameraChange(frequency: .onEnd) { ctx in recluster(ctx.region) }
        .ignoresSafeArea()
        .overlay(alignment: .top) {
            HStack {
                Button { dismiss() } label: {
                    Image(systemName: "chevron.left").font(.system(size: 18, weight: .semibold)).frame(width: 46, height: 46).contentShape(.rect)
                }
                .glassEffect(.regular.interactive(), in: .circle)
                Spacer()
                Text(String(localized: "Karte")).font(.system(size: 17, weight: .semibold))
                    .padding(.horizontal, 16).frame(height: 40).glassEffect(.regular, in: .capsule)
                Spacer()
                Menu {
                    Picker(String(localized: "Kartenart"), selection: $kind) {
                        Label(String(localized: "Erkunden"), systemImage: "map").tag(0)
                        Label(String(localized: "Satellit"), systemImage: "globe.europe.africa").tag(1)
                        Label(String(localized: "Hybrid"), systemImage: "globe.europe.africa.fill").tag(2)
                    }
                    Picker(String(localized: "Ansicht"), selection: $flat) {
                        Text("3D").tag(false)
                        Text("2D").tag(true)
                    }
                } label: {
                    Image(systemName: kind == 0 ? "map" : "globe.europe.africa").font(.system(size: 18)).frame(width: 46, height: 46).contentShape(.rect)
                }
                .glassEffect(.regular.interactive(), in: .circle)
            }
            .foregroundStyle(.primary)
            .padding(.horizontal, 16)
        }
        .toolbar(.hidden, for: .navigationBar)
        .onAppear { let r = startRegion; position = .region(r); recluster(r) }
        .onChange(of: markers.count) { if let region { recluster(region) } }
        .navigationDestination(item: $opened) { g in
            AssetGridScreen(title: g.title, subtitle: String(localized: "\(g.ids.count) Objekte"), assets: assets(for: g.ids))
        }
    }

    private func pin(_ g: MapGroup) -> some View {
        AssetThumb(id: g.ids[0])
            .frame(width: 58, height: 58)
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(.white, lineWidth: 2.5))
            .shadow(color: .black.opacity(0.35), radius: 5, y: 2)
            .overlay(alignment: .topTrailing) {
                if g.ids.count > 1 {
                    Text("\(g.ids.count)").font(.system(size: 12, weight: .bold)).foregroundStyle(.white)
                        .padding(.horizontal, 7).frame(minWidth: 22, minHeight: 22)
                        .background(Capsule().fill(.blue)).offset(x: 9, y: -9)
                }
            }
    }

    /// Start wie Apple: um den Ort mit den meisten Fotos, nicht die ganze Welt.
    private var startRegion: MKCoordinateRegion {
        let cell = Dictionary(grouping: markers) { "\(Int($0.lat))/\(Int($0.lon))" }.max { $0.value.count < $1.value.count }?.value ?? []
        // ohne Orte: Weltkarte statt eines festen Ortes
        guard !cell.isEmpty else { return MKCoordinateRegion(center: .init(latitude: 20, longitude: 0), span: .init(latitudeDelta: 120, longitudeDelta: 120)) }
        let c = CLLocationCoordinate2D(latitude: cell.map(\.lat).reduce(0, +) / Double(cell.count), longitude: cell.map(\.lon).reduce(0, +) / Double(cell.count))
        return MKCoordinateRegion(center: c, span: MKCoordinateSpan(latitudeDelta: 6, longitudeDelta: 6))
    }

    /// Im Hintergrund neu zusammenfassen, sobald die Karte steht; ältere Rechnungen verwerfen.
    private func recluster(_ r: MKCoordinateRegion) {
        region = r
        clustering?.cancel()
        let markers = markers
        clustering = Task {
            let g = await Task.detached(priority: .userInitiated) { Self.cluster(markers, r) }.value
            guard !Task.isCancelled else { return }
            groups = g
        }
    }

    /// Zusammenfassen auf ein Raster, das mit der Zoomstufe mitwächst (~6 Felder über die Bildhöhe). Nur der sichtbare
    /// Bereich mit etwas Rand, Zahlen statt Text als Zellschlüssel, Überlappende (≈ 1/8 der Höhe) nur mit Nachbarzellen
    /// verschmelzen: 85 000 Orte in < 10 ms statt Sekunden auf dem Hauptthread (Anstoß: Fork vands2013).
    nonisolated static func cluster(_ markers: [MapMarkerDTO], _ r: MKCoordinateRegion) -> [MapGroup] {
        let span = max(r.span.latitudeDelta, 0.002)
        let cellSize = span / 6, near = span / 8
        let all = span >= 30 || r.span.longitudeDelta >= 90          // Weltansicht: nichts wegfiltern
        let latHalf = span, lonHalf = max(r.span.longitudeDelta, span)   // eine Bildschirmhälfte Rand: Ziehen zeigt keine leeren Ränder
        func key(_ y: Int, _ x: Int) -> Int64 { Int64(y) << 32 | Int64(UInt32(truncatingIfNeeded: x)) }
        struct Cell { var idx: [Int] = []; var lat = 0.0; var lon = 0.0 }
        var cells: [Int64: Cell] = [:]
        for (i, m) in markers.enumerated() {
            if !all {
                var dl = m.lon - r.center.longitude
                if dl > 180 { dl -= 360 } else if dl < -180 { dl += 360 }
                guard abs(m.lat - r.center.latitude) <= latHalf, abs(dl) <= lonHalf else { continue }
            }
            let k = key(Int(floor(m.lat / cellSize)), Int(floor(m.lon / cellSize)))
            cells[k, default: Cell()].idx.append(i)
            cells[k]!.lat += m.lat; cells[k]!.lon += m.lon
        }
        let keys = Array(cells.keys)
        var pos: [Int64: Int] = [:]
        for (n, k) in keys.enumerated() { pos[k] = n }
        var parent = Array(keys.indices)
        func find(_ x: Int) -> Int { var x = x; while parent[x] != x { parent[x] = parent[parent[x]]; x = parent[x] }; return x }
        func center(_ c: Cell) -> (Double, Double) { (c.lat / Double(c.idx.count), c.lon / Double(c.idx.count)) }
        for (n, k) in keys.enumerated() {
            let a = center(cells[k]!)
            let y = Int(Int32(truncatingIfNeeded: k >> 32)), x = Int(Int32(truncatingIfNeeded: k))
            for dy in -1...1 { for dx in -1...1 where dy != 0 || dx != 0 {
                let nk = key(y + dy, x + dx)
                guard let m = pos[nk], let c = cells[nk] else { continue }
                let b = center(c)
                if abs(a.0 - b.0) < near && abs(a.1 - b.1) < near { parent[find(n)] = find(m) }
            } }
        }
        var merged: [Int: [Int]] = [:]
        for (n, k) in keys.enumerated() { merged[find(n), default: []] += cells[k]!.idx }
        return merged.values.map { idx in
            var lat = 0.0, lon = 0.0, first = markers[idx[0]].id
            var places: [String: Int] = [:]
            for i in idx {
                let m = markers[i]
                lat += m.lat; lon += m.lon
                if m.id < first { first = m.id }
                if let c = m.city { places[c, default: 0] += 1 }
            }
            return MapGroup(id: "\(first)@\(cellSize)",
                            coord: CLLocationCoordinate2D(latitude: lat / Double(idx.count), longitude: lon / Double(idx.count)),
                            ids: idx.map { markers[$0].id },
                            title: places.max { $0.value < $1.value }?.key ?? String(localized: "Fotos"))
        }
    }

    private func assets(for ids: [String]) -> [Asset] {
        timeline.assets(ids)
    }
}

