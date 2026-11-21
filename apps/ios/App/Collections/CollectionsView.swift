import SwiftUI
import MapKit

enum CollectionRoute: Hashable {
    case assets(title: String, ids: [String])
    case category(Category)
    case album(AlbumRef), person(PersonRef)
    case allAlbums, allPeople, allTrips, allMemories, allMediaTypes, allOthers, allPinned
    case albumFolder(String)
    /// Server-Ordner (GitHub #42): Übersicht eines Ordners bzw. nur seine Fotos
    case folder(String), folderPhotos(String)
    /// intelligentes Album (ID)
    case smart(String)
}
struct AlbumRef: Hashable { let id: String; let name: String }
struct PersonRef: Hashable { let id: String; let name: String }

struct Trip: Identifiable, Hashable {
    let title: String
    let start: Date
    let end: Date
    let assets: [Asset]
    var id: String { title + start.description }
}

@MainActor @Observable
final class CollectionsModel {
    var memories: [MemoryDTO] = []
    var albums: [AlbumDTO] = []
    var people: [PersonDTO] = []
    var featured: [Asset] = []
    var markers: [MapMarkerDTO] = []
    var userName = ""
    var loaded = false

    /// „Aus Empfohlenen entfernen“ (REA: PXPhotoKitRemoveFromFeaturedPhotosActionPerformer) – gemerkt auf dem Gerät.
    func removeFromFeatured(_ id: String) {
        var l = UserDefaults.standard.stringArray(forKey: "featured.removed") ?? []
        if !l.contains(id) { l.append(id) }
        UserDefaults.standard.set(Array(l.suffix(2000)), forKey: "featured.removed")
        featured.removeAll { $0.id == id }
    }

    func reloadAlbums() async {
        guard let a = try? await ImmichClient.shared.albums() else { return }
        albums = a
        AlbumNames.byID = Dictionary(a.map { ($0.id, $0.albumName) }, uniquingKeysWith: { x, _ in x })
    }

    func load() async {
        let c = ImmichClient.shared
        async let m = try? c.memories()
        async let a = try? c.albums()
        async let p = try? c.people()
        async let r = try? c.random(size: 12)
        async let mk = try? c.mapMarkers()
        async let me = try? c.me()
        async let folders: Void = FolderStore.shared.load()
        memories = (await m ?? []).filter { !$0.assets.isEmpty }
        if let a = await a { albums = a; AlbumNames.byID = Dictionary(a.map { ($0.id, $0.albumName) }, uniquingKeysWith: { x, _ in x }) }
        people = (await p ?? []).filter { !$0.name.isEmpty } + (await p ?? []).filter { $0.name.isEmpty }
        let account = (await me)?.id ?? ""
        let random = (await r ?? []).map(\.asset)
        var sensitive = await SensitiveFilter.ids()
        sensitive.formUnion(SensitiveFilter.known(random.map(\.id), account: account))
        var picks: [Asset] = []
        let removed = Set(UserDefaults.standard.stringArray(forKey: "featured.removed") ?? [])
        for a in random where a.isImage && !sensitive.contains(a.id) && !removed.contains(a.id) {
            if await !TextHeavy.check(a) { picks.append(a) }
        }
        featured = picks
        markers = await mk ?? []
        await folders
        userName = (await me)?.name ?? ""
        loaded = true
        // danach einzeln prüfen (Fotos ohne KI-Merkmale fängt die Suche oben nicht)
        let bad = await SensitiveFilter.flagged(picks, account: account)
        if !bad.isEmpty { featured.removeAll { bad.contains($0.id) } }
    }
}

struct CollectionsView: View {
    @Environment(AppModel.self) private var app
    @AppStorage("folderSort") private var folderSortRaw = FolderSort.nameAsc.rawValue
    @State private var folderOrder: [String] = []
    @Environment(TimelineStore.self) private var timeline
    @State private var model = CollectionsModel()
    @State private var memories = MemoryCenter.shared
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
    @State private var showShared = false
    @State private var confirmSignOut = false
    @State private var recentDays: [DayGroup] = []
    /// Titelbild je Tag ohne Bildschirmfotos/Dokumente (wie Apple), sonst das erste Foto des Tages
    @State private var dayCovers: [Date: String] = [:]
    @State private var trips: [Trip] = []
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
            .navigationDestination(for: Trip.self) { t in AssetGridScreen(title: t.title, subtitle: tripRange(t), assets: t.assets) }
            .navigationDestination(for: DayGroup.self) { d in AssetGridScreen(title: d.title, subtitle: Fmt.weekdayDay.string(from: d.day), assets: d.assets) }
        }
        .environment(\.cardSide, [100, 128, 160][min(2, max(0, cardSize))])
        .task {
            if !model.loaded { await model.load() }
            await timeline.loadAll()
            await memories.rebuild(timeline: timeline, server: model.memories)
            SpotlightIndex.update(albums: model.albums, people: model.people, memories: memories.items, account: app.userID)
            AlbumFolders.shared.use(app.userID)
            SmartAlbums.shared.use(app.userID)
        }
        // Spotlight / Deep-Link: Album oder Person direkt öffnen
        .onChange(of: app.pendingRoute) { _, r in
            guard let r else { return }
            app.pendingRoute = nil
            path = NavigationPath(); path.append(r)
        }
        .onChange(of: timeline.totalCount) { Task { await memories.rebuild(timeline: timeline, server: model.memories) } }
        .task(id: timeline.version) { await rebuildDerived() }
        .sheet(isPresented: $editPinned) { PinnedEditor(raw: $pinnedRaw) }
        .sheet(isPresented: $reorder) { SectionOrderEditor(raw: $orderRaw) }
        .sheet(isPresented: $newAlbum) { NewAlbumSheet() }
        .sheet(isPresented: $showBackup) { BackupView() }
        .sheet(isPresented: $showShared) { SharedLibraryView() }
        .onReceive(NotificationCenter.default.publisher(for: .albumsChanged)) { _ in Task { await model.reloadAlbums() } }
    }

    @ViewBuilder private func sectionView(_ sec: Sec) -> some View {
        switch sec {
        case .memories: section(String(localized: "Rückblicke"), route: .allMemories) { memoriesRow }
        case .pinned: section(String(localized: "Angepinnt"), route: .allPinned, edit: true) { pinnedRow }
        case .albums: section(String(localized: "Alben"), route: model.albums.isEmpty ? nil : .allAlbums) { albumsRow }
        case .folders:
            if !FolderStore.shared.paths.isEmpty {
                section(String(localized: "Ordner"), route: .folder(FolderStore.shared.root)) { foldersRow }
            }
        case .people: section(String(localized: "Personen"), route: model.people.isEmpty ? nil : .allPeople) { peopleRow }
        case .featured: if !model.featured.isEmpty { section(String(localized: "Empfohlene Fotos")) { featuredRow } }
        case .recentDays: section(String(localized: "Letzte Tage")) { recentDaysRow }
        case .trips: if !trips.isEmpty { section(String(localized: "Reisen"), route: .allTrips) { tripsRow } }
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
                        Button(String(localized: "Geteilte Mediathek"), systemImage: "person.2") { showShared = true }
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
                        Text(verbatim: "HomeRoll \(AppInfo.version)")   // installierte Version (GitHub-Issue #12)
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

    // MARK: Rückblicke

    private var memoriesRow: some View {
        row {
            if memories.items.isEmpty && !memories.settled {
                // wie Fotos: graue Karten, solange die Rückblicke noch berechnet werden
                ForEach(0..<2, id: \.self) { _ in
                    RoundedRectangle(cornerRadius: 26, style: .continuous).fill(Color.appFill)
                        .frame(width: side * 2.1, height: side * 2.1)
                }
            }
            ForEach(memories.items.prefix(12)) { m in
                Button { app.memory = m } label: {
                    BigCard(assetID: m.key.id, title: m.title, subtitle: m.subtitle, play: true)
                        .frame(width: side * 2.1, height: side * 2.1)
                }
                .buttonStyle(.plain)
                .contextMenu { MemoryMenuItems(memory: m) }
            }
        }
        .overlay {
            if memories.items.isEmpty && memories.settled {
                EmptyCard(icon: "clock.arrow.circlepath", title: String(localized: "Keine Rückblicke verfügbar"),
                          text: String(localized: "Rückblicke erscheinen hier, wenn mehr Fotos und Videos zur Mediathek hinzugefügt werden."))
            }
        }
        .frame(minHeight: memories.items.isEmpty ? 160 : nil)
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

    private var foldersRow: some View {
        let top = FolderStore.shared.children(of: FolderStore.shared.root)
        return row {
            ForEach((folderOrder.isEmpty ? top : folderOrder).prefix(30), id: \.self) { f in
                NavigationLink(value: CollectionRoute.folder(f)) { FolderCard(path: f) }.buttonStyle(.plain)
            }
        }
        // gleiche Reihenfolge wie die in der Ordneransicht gewählte Sortierung (GitHub #57)
        .task(id: "\(folderSortRaw)\(top.count)\(FolderStore.shared.root)") {
            folderOrder = await FolderStore.shared.sorted(top, by: FolderSort(rawValue: folderSortRaw) ?? .nameAsc)
        }
    }

    @ViewBuilder private var peopleRow: some View {
        if model.people.isEmpty {
            EmptyCard(icon: "person.crop.circle", title: String(localized: "Noch keine Personen"),
                      text: String(localized: "Personen erscheinen hier, sobald der Server Gesichter in deinen Fotos erkannt hat."))
        } else { peopleList }
    }

    private var peopleList: some View {
        row {
            ForEach(model.people.prefix(20)) { p in
                NavigationLink(value: CollectionRoute.person(PersonRef(id: p.id, name: p.name))) {
                    PersonThumb(id: p.id)
                        .frame(width: side, height: side)
                        .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
                        .overlay(alignment: .bottomLeading) {
                            Text(p.name.isEmpty ? String(localized: "Unbenannt") : p.name).font(.system(size: 17, weight: .semibold))
                                .foregroundStyle(.white).shadow(radius: 6).padding(12)
                        }
                }
                .buttonStyle(.plain)
            }
        }
    }

    private var featuredRow: some View {
        row {
            ForEach(Array(model.featured.enumerated()), id: \.element.id) { i, a in
                Button { app.open(model.featured, at: i) } label: {
                    AssetThumb(id: a.id, size: .preview)
                        .frame(width: side, height: side)
                        .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
                }
                .buttonStyle(.plain)
                // wie Fotos: von überall ziehen – auf ein Album (AlbumDropTarget) oder in andere Apps
                .draggable("homeroll-asset:\(a.id)") {
                    AssetThumb(id: a.id).frame(width: 90, height: 90).clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                }
                .contextMenu {
                    AssetMenu(assets: [a], style: .context, present: { app.sheet = $0 }) { model.featured.removeAll { $0.id == a.id } }
                    Section {
                        Button("Aus Empfohlenen entfernen", systemImage: "hand.thumbsdown") {
                            withAnimation(.snappy) { model.removeFromFeatured(a.id) }
                            app.toast(String(localized: "Wird nicht mehr empfohlen"))
                        }
                    }
                }
            }
        }
    }

    // MARK: Letzte Tage / Reisen

    /// Letzte Tage und Reisen kosten bei 80 000 Objekten spürbar → nur bei neuer Zeitleisten-Version, im Hintergrund.
    /// Kommt eine neuere Version, bricht die Rechnung ab und überschreibt deren Ergebnis nicht (Idee aus dem Fork vands2013).
    private func rebuildDerived() async {
        let all = timeline.allLoaded
        let worker = Task.detached(priority: .userInitiated) { () -> ([DayGroup], [Trip]) in
            let tail = all.suffix(5000)   // die letzten 10 Tage stecken sicher in den neuesten Objekten
            let g = Dictionary(grouping: tail) { Calendar.wall.startOfDay(for: $0.date) }
            let days = g.keys.sorted(by: >).prefix(10).map { DayGroup(day: $0, assets: g[$0]!) }
            return (days, CollectionsView.trips(from: all))
        }
        let (days, t) = await withTaskCancellationHandler { await worker.value } onCancel: { worker.cancel() }
        guard !Task.isCancelled else { return }
        recentDays = days; trips = t
        for d in days where dayCovers[d.day] == nil {
            let pool = [d.keyAsset] + d.assets.filter { $0.isImage && $0.id != d.keyAsset.id && !MemoryEngine.looksLikeScreenshot($0) }
            for c in pool.prefix(8) where !MemoryEngine.looksLikeScreenshot(c) {
                if await !TextHeavy.check(c) { dayCovers[d.day] = c.id; break }
            }
        }
    }

    private var recentDaysRow: some View {
        row {
            ForEach(recentDays) { d in
                NavigationLink(value: d) {
                    SmallCard(assetID: dayCovers[d.day] ?? d.keyAsset.id, title: dayLabel(d.day))
                }
                .buttonStyle(.plain)
            }
        }
    }

    private func dayLabel(_ d: Date) -> String { Fmt.relativeDay(d, fallback: Fmt.dayMonthYear) }


    /// Reisen = zusammenhängende Tage außerhalb des Heimatlandes (häufigstes Land).
    nonisolated static func trips(from input: [Asset]) -> [Trip] {
        let all = input.filter { $0.country != nil }
        guard !all.isEmpty else { return [] }
        let home = Dictionary(grouping: all, by: { $0.country! }).max { $0.value.count < $1.value.count }?.key
        var out: [Trip] = []
        var cur: [Asset] = []
        func flush() {
            guard cur.count >= 3, let f = cur.first, let l = cur.last else { cur = []; return }
            let place = Dictionary(grouping: cur.compactMap(\.city), by: { $0 }).max { $0.value.count < $1.value.count }?.key
            let country = Dictionary(grouping: cur.compactMap(\.country), by: { $0 }).max { $0.value.count < $1.value.count }?.key
            out.append(Trip(title: Self.countryDE(country) ?? place ?? String(localized: "Reise"), start: f.date, end: l.date, assets: cur))
            cur = []
        }
        for (i, a) in all.sorted(by: { $0.date < $1.date }).enumerated() {
            if i & 1023 == 0, Task.isCancelled { return [] }
            if a.country == home { flush(); continue }
            if let last = cur.last, a.date.timeIntervalSince(last.date) > 4 * 86400 || a.country != last.country { flush() }
            cur.append(a)
        }
        flush()
        return out.reversed()
    }

    private func tripRange(_ t: Trip) -> String {
        Fmt.dayMonthYear.string(from: t.start) + (Calendar.wall.isDate(t.start, inSameDayAs: t.end) ? "" : " – " + Fmt.dayMonthYear.string(from: t.end))
    }

    private var tripsRow: some View {
        row {
            ForEach(trips) { t in
                NavigationLink(value: t) {
                    SmallCard(assetID: t.assets.first(where: \.isImage)?.id, title: t.title)
                }
                .buttonStyle(.plain)
            }
        }
    }

    nonisolated static func countryDE(_ c: String?) -> String? {
        guard let c else { return nil }
        guard CountryName.german else { return c }
        let map = ["Germany": "Deutschland", "United Arab Emirates": "Dubai", "Thailand": "Thailand", "Indonesia": "Indonesien",
                   "Turkey": "Türkei", "Türkiye": "Türkei", "Saudi Arabia": "Saudi-Arabien", "United States": "USA"]
        return map[c] ?? c
    }
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
