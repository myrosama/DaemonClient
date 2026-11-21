import SwiftUI
import MapKit

/// Ein Suchbaustein, der wie bei Apple als Kärtchen ins Suchfeld wandert und sich kombinieren lässt.
enum SearchToken: Hashable, Identifiable {
    case person(id: String, name: String)
    case place(String)
    /// Land (Wert wie vom Server, englisch; Anzeige deutsch)
    case country(String)
    /// Ort aus Apple Karten (auch ohne Fotos mit genau diesem Ortsnamen): Fotos im Umkreis
    case area(name: String, lat: Double, lon: Double, km: Double)
    case album(id: String, name: String)
    /// Server-Ordner (GitHub #45): öffnet den Ordner statt zu filtern
    case folder(String)
    case category(Category)
    case year(Int)
    /// gleichnamige Ordner an verschiedenen Stellen sind verschiedene Treffer
    var id: String { if case .folder(let p) = self { "folder:" + p } else { title } }
    var title: String {
        switch self {
        case .person(_, let n): n; case .place(let p): p; case .album(_, let n): n; case .folder(let p): FolderStore.name(p); case .country(let c): CountryName.de(c); case .area(let n, _, _, _): n
        case .category(let c): c.title; case .year(let y): String(y)
        }
    }
    var icon: String {
        switch self {
        case .person: "person.crop.circle"; case .place: "mappin.circle"; case .album: "rectangle.stack"; case .folder: "folder"; case .country: "globe.europe.africa"; case .area: "map"
        case .category(let c): c.icon; case .year: "calendar"
        }
    }
    var kind: String {
        switch self {
        case .person: String(localized: "Person"); case .place: String(localized: "Ort"); case .country: String(localized: "Land"); case .area: String(localized: "Karte"); case .album: String(localized: "Album")
        case .folder(let p): MainActor.assumeIsolated {
            let parent = (p as NSString).deletingLastPathComponent
            let kind = String(localized: "folder.kind", defaultValue: "Ordner")
            return parent == FolderStore.shared.root ? kind : kind + " · " + FolderStore.name(parent)
        }
        case .category: String(localized: "Medienart"); case .year: String(localized: "Jahr")
        }
    }
}

/// Suche wie in Fotos (iOS 26): Ergebnisse schon beim Tippen, Vorschläge als Kärtchen (Person, Ort, Album,
/// Medienart, Jahr) kombinierbar, Ergebnisse geteilt in „Fotos“ und „Sammlungen“, mit „Auswählen“.
/// Freitext geht an die Texterkennung und die KI-Suche des Servers (mehrsprachiges Bild-Text-Modell).
struct SearchView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @Environment(TimelineStore.self) private var timeline
    @State private var query = ""
    @State private var tokens: [SearchToken] = []
    @State private var searching = false
    @State private var result = SearchResult()
    @State private var resultKey = ""
    @State private var loadingMore = false
    @State private var cities: [AssetDTO] = []
    @State private var people: [PersonDTO] = []
    @State private var countries: [String] = []
    @State private var places = PlaceCompleter()
    @State private var markers: [MapMarkerDTO] = []
    @State private var model = CollectionsModel()
    @State private var tab = 0                  // 0 = Fotos, 1 = Sammlungen
    @State private var selecting = false
    @State private var selected: Set<String> = []
    @State private var sheet: ActionSheet?
    @State private var path = NavigationPath()
    @State private var confirmDelete = false
    @FocusState private var focused: Bool
    @AppStorage("recentQueries") private var recentRaw = ""

    private var recentQueries: [String] { recentRaw.split(separator: "\n").map(String.init) }
    private var recentViewed: [Asset] {
        RecentStore.ids(.recentlyViewed).prefix(60).compactMap { timeline.asset($0) }
    }
    private var trimmed: String { query.trimmingCharacters(in: .whitespaces) }
    private var active: Bool { !trimmed.isEmpty || !tokens.isEmpty }
    private var key: String { tokens.map(\.title).joined(separator: "|") + "#" + trimmed }

    var body: some View {
        NavigationStack(path: $path) {
            ZStack(alignment: .bottom) {
                Color.appBackground.ignoresSafeArea()
                ScrollView {
                    if active { activeView } else { start }
                }
                .scrollDismissesKeyboard(.immediately)
                .safeAreaPadding(.bottom, 90)
                if selecting { selectionBar } else { searchBar }
            }
            .toolbar(.hidden, for: .navigationBar)
            .navigationDestination(for: CollectionRoute.self) { r in CollectionDetail(route: r, model: model) }
        }
        .actionSheets($sheet)
        .overlay(alignment: .top) { VStack { BusyBadge(); ToastBadge() } }
        .task { if !FolderStore.shared.loaded { await FolderStore.shared.load() } }
        .task {
            focused = true
            async let c = try? ImmichClient.shared.cities()
            async let p = try? ImmichClient.shared.people()
            async let m: Void = model.reloadAlbums()
            async let co = try? ImmichClient.shared.suggestions("country")
            cities = await c ?? []
            people = (await p ?? []).filter { !$0.name.isEmpty }
            countries = await co ?? []
            markers = (try? await ImmichClient.shared.mapMarkers()) ?? []
            await m
            // Siri/Kurzbefehl „Fotos suchen“ hat einen Begriff mitgebracht
            if let q = app.pendingQuery { query = q; app.pendingQuery = nil }
        }
        // live suchen, sobald man kurz aufhört zu tippen
        .onChange(of: trimmed) { _, q in places.query(q) }
        .task(id: key) {
            guard active else { result = SearchResult(); resultKey = ""; return }
            try? await Task.sleep(for: .milliseconds(trimmed.count < 3 && tokens.isEmpty ? 650 : 380))
            if Task.isCancelled { return }
            await run()
        }
    }

    // MARK: Suchleiste

    private var searchBar: some View {
        HStack(spacing: 12) {
            Button { app.tab = .collections; dismiss() } label: {
                Image(systemName: "square.stack.fill").font(.system(size: 20)).foregroundStyle(.primary).frame(width: 54, height: 54).contentShape(.rect)
            }
            .glassEffect(.regular.interactive(), in: .circle)
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                ForEach(tokens) { t in
                    Button { withAnimation(.snappy) { tokens.removeAll { $0 == t } } } label: {
                        HStack(spacing: 4) {
                            Image(systemName: t.icon).font(.system(size: 12))
                            // ab drei Kärtchen nur noch das Symbol, sonst passt das Tippfeld nicht mehr
                            if tokens.count < 3 { Text(t.title).font(.system(size: 15, weight: .semibold)).lineLimit(1) }
                        }
                        .fixedSize()
                        .padding(.horizontal, 9).frame(height: 30)
                        .background(Capsule().fill(Color.blue.opacity(0.35)))
                    }
                    .buttonStyle(.plain)
                }
                TextField(tokens.isEmpty ? String(localized: "Mediathek durchsuchen …") : "", text: $query)
                    .focused($focused)
                    .submitLabel(.search)
                    .autocorrectionDisabled()
                    .frame(minWidth: 50)
                    .onSubmit { remember() }
                    .onKeyPress(.delete) {
                        // wie Apple: Löschen im leeren Feld entfernt das letzte Kärtchen
                        guard query.isEmpty, !tokens.isEmpty else { return .ignored }
                        _ = withAnimation(.snappy) { tokens.removeLast() }; return .handled
                    }
                if active {
                    // Suchbegriff löschen und gleich weitertippen (GitHub #49): große Trefferfläche, sonst nahm auf dem
                    // iPhone die Glasfläche drumherum den Fingertipp
                    Button { query = ""; tokens = []; focused = true } label: {
                        Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
                            .frame(width: 44, height: 54).contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    .padding(.trailing, -12)
                    .accessibilityLabel(String(localized: "Löschen"))
                }
            }
            .padding(.horizontal, 16).frame(height: 54)
            .glassEffect(.regular.interactive(), in: .capsule)
            Button { dismiss() } label: {
                Image(systemName: "xmark").font(.system(size: 18, weight: .semibold)).foregroundStyle(.primary).frame(width: 54, height: 54).contentShape(.rect)
            }
            .glassEffect(.regular.interactive(), in: .circle)
        }
        .padding(.horizontal, 20).padding(.bottom, 6)
    }

    // MARK: Startseite (leeres Feld)

    private var start: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(String(localized: "Suchen")).font(.system(size: 34, weight: .bold)).padding(.horizontal, 20).padding(.top, 20)
            if !recentViewed.isEmpty || !recentQueries.isEmpty {
                heading(String(localized: "Zuletzt"))
                ScrollView(.horizontal) {
                    HStack(spacing: 12) {
                        if !recentViewed.isEmpty {
                            Button { app.open(recentViewed, at: 0) } label: {
                                SmallCard(assetID: recentViewed.first?.id, title: String(localized: "Zuletzt angesehen"))
                            }
                            .buttonStyle(.plain)
                        }
                        ForEach(recentQueries, id: \.self) { q in
                            Button { query = q } label: {
                                RoundedRectangle(cornerRadius: 22, style: .continuous).fill(Color.appFill)
                                    .frame(width: 128, height: 128)
                                    .overlay(alignment: .topLeading) {
                                        Image(systemName: "magnifyingglass").font(.system(size: 20)).foregroundStyle(.secondary).padding(12)
                                    }
                                    .overlay(alignment: .bottomLeading) {
                                        Text(q).font(.system(size: 17, weight: .semibold)).foregroundStyle(.primary).lineLimit(2).padding(12)
                                    }
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(.horizontal, 20)
                }
                .scrollIndicators(.hidden)
            }
            if !people.isEmpty {
                heading(String(localized: "Personen"))
                ScrollView(.horizontal) {
                    HStack(spacing: 14) {
                        ForEach(people.prefix(15)) { p in
                            Button { add(.person(id: p.id, name: p.name)) } label: {
                                VStack(spacing: 6) {
                                    PersonThumb(id: p.id).frame(width: 76, height: 76).clipShape(Circle())
                                    Text(p.name).font(.system(size: 13, weight: .medium)).foregroundStyle(.primary).lineLimit(1)
                                }
                                .frame(width: 80)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(.horizontal, 20)
                }
                .scrollIndicators(.hidden)
            }
            if !cities.isEmpty {
                heading(String(localized: "Orte"))
                ScrollView(.horizontal) {
                    HStack(spacing: 12) {
                        ForEach(cities, id: \.id) { c in
                            Button { add(.place(c.exifInfo?.city ?? "")) } label: { SmallCard(assetID: c.id, title: c.exifInfo?.city ?? "") }
                                .buttonStyle(.plain)
                        }
                    }
                    .padding(.horizontal, 20)
                }
                .scrollIndicators(.hidden)
            }
            heading(String(localized: "Medienarten"))
            FlowChips(items: [.receipts, .documents, .handwriting, .qrCodes, .screenshots, .selfies, .videos, .panoramas]) { c in
                add(.category(c))
            }
            .padding(.horizontal, 20)
            heading(String(localized: "Vorschläge"))
            ForEach([String(localized: "Strand"), String(localized: "Essen"), String(localized: "Auto"), String(localized: "Berge"), String(localized: "Moschee"), String(localized: "Sonnenuntergang"), String(localized: "Hund")], id: \.self) { s in
                row(icon: "magnifyingglass", s) { query = s }
            }
        }
    }

    // MARK: Beim Tippen: Vorschläge + Ergebnisse

    /// Passende Personen, Orte, Alben, Medienarten und Jahre zum gerade getippten Wort.
    private var suggestions: [SearchToken] {
        let q = trimmed.lowercased()
        guard !q.isEmpty else { return [] }
        func hit(_ s: String) -> Bool {
            s.lowercased().hasPrefix(q) || s.lowercased().split(separator: " ").contains { $0.hasPrefix(q) }
        }
        var out: [SearchToken] = []
        out += people.filter { hit($0.name) }.prefix(3).map { .person(id: $0.id, name: $0.name) }
        out += Array(Set(cities.compactMap { $0.exifInfo?.city })).filter(hit).sorted().prefix(3).map { .place($0) }
        out += countries.filter { hit(CountryName.de($0)) || hit($0) }.prefix(2).map { .country($0) }
        // Orte aus Apple Karten, für die es Fotos in der Nähe gibt
        // (nur Orte mit Fotos im Umkreis, jeder Name einmal)
        var names = Set(out.map { $0.title.lowercased() })
        for r in places.results where names.insert(r.name.lowercased()).inserted {
            if markers.contains(where: { PlaceCompleter.distanceKm(r.lat, r.lon, $0.lat, $0.lon) <= r.km }) {
                out.append(.area(name: r.name, lat: r.lat, lon: r.lon, km: r.km))
            }
        }
        out += model.albums.filter { hit($0.albumName) }.prefix(3).map { .album(id: $0.id, name: $0.albumName) }
        out += FolderStore.shared.allDirectories.filter { hit(FolderStore.name($0)) }.prefix(3).map { .folder($0) }
        out += Category.allCases.filter { c in c != .map && (hit(c.title) || c.synonyms.contains { $0.hasPrefix(q) }) }
            .prefix(3).map { .category($0) }
        if q.allSatisfy(\.isNumber), q.count >= 2 {
            out += timeline.years.reversed().filter { String($0).hasPrefix(q) }.prefix(4).map { .year($0) }
        }
        return out.filter { !tokens.contains($0) }
    }

    /// Passende Alben, Personen und Medienarten für „Sammlungen (n)“.
    private var collectionHits: [(SearchToken, CollectionRoute?)] {
        var out: [(SearchToken, CollectionRoute?)] = []
        let q = trimmed.lowercased()
        let words = tokens.map { $0.title.lowercased() } + (q.isEmpty ? [] : [q])
        func hit(_ s: String) -> Bool { words.contains { s.lowercased().contains($0) } }
        for a in model.albums where hit(a.albumName) {
            out.append((.album(id: a.id, name: a.albumName), .album(AlbumRef(id: a.id, name: a.albumName))))
        }
        for p in people where hit(p.name) {
            out.append((.person(id: p.id, name: p.name), .person(PersonRef(id: p.id, name: p.name))))
        }
        for f in FolderStore.shared.allDirectories where hit(FolderStore.name(f)) { out.append((.folder(f), .folder(f))) }
        for c in Category.allCases where c != .map && hit(c.title) { out.append((.category(c), .category(c))) }
        return out
    }

    private var activeView: some View {
        let sugg = suggestions, cols = collectionHits
        let photos = result.text + result.photos
        return VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .firstTextBaseline) {
                Text(String(localized: "Suchen")).font(.system(size: 34, weight: .bold))
                Spacer()
                if tab == 0 && !photos.isEmpty {
                    Button(selecting ? String(localized: "Fertig") : String(localized: "Auswählen")) {
                        withAnimation(.snappy) { selecting.toggle(); selected = [] }
                    }
                    .font(.system(size: 17, weight: .semibold)).foregroundStyle(.primary)
                    .padding(.horizontal, 18).frame(height: 44)
                    .glassEffect(.regular.interactive(), in: .capsule)
                }
            }
            .padding(.horizontal, 20).padding(.top, 20)

            if !sugg.isEmpty && !selecting {
                VStack(spacing: 0) {
                    ForEach(sugg) { t in
                        row(icon: t.icon, t.title, sub: t.kind) {
                            if case .folder(let f) = t { remember(); path.append(CollectionRoute.folder(f)) } else { add(t) }
                        }
                    }
                }
            }

            Picker("", selection: $tab) {
                Text(String(localized: "Fotos (\(resultKey == key ? String(photos.count) : "…"))")).tag(0)
                Text(String(localized: "Sammlungen (\(cols.count))")).tag(1)
            }
            .pickerStyle(.segmented)
            .padding(.horizontal, 20)

            if tab == 0 {
                if !result.text.isEmpty {
                    heading(String(localized: "Text in Fotos"))
                    grid(result.text, all: photos)
                }
                if !result.photos.isEmpty {
                    if !result.text.isEmpty { heading(String(localized: "Weitere Fotos")) }
                    grid(result.photos, all: photos)
                }
                if resultKey == key, result.next != nil {
                    Button { Task { await loadMore() } } label: {
                        if loadingMore { ProgressView() }
                        else { Text(String(localized: "Mehr laden")).font(.headline) }
                    }
                    .buttonStyle(.glass).disabled(loadingMore).padding(.vertical, 16).frame(maxWidth: .infinity)
                }
                if photos.isEmpty && resultKey == key && !searching {
                    ContentUnavailableView(String(localized: "Keine Treffer"), systemImage: "magnifyingglass",
                                           description: Text(String(localized: "Probier einen anderen Begriff oder entferne ein Kärtchen.")))
                        .padding(.top, 60)
                }
            } else {
                if cols.isEmpty {
                    ContentUnavailableView(String(localized: "Keine Sammlungen"), systemImage: "rectangle.stack").padding(.top, 60)
                }
                ForEach(cols, id: \.0) { t, route in
                    row(icon: t.icon, t.title, sub: t.kind) {
                        if let route { remember(); path.append(route) } else { add(t) }
                    }
                }
            }
        }
        .overlay(alignment: .top) { if searching && resultKey != key { ProgressView().padding(.top, 240) } }
    }

    private func grid(_ list: [Asset], all: [Asset]) -> some View {
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 2), count: 3), spacing: 2) {
            ForEach(list) { a in
                Button {
                    if selecting { if selected.contains(a.id) { selected.remove(a.id) } else { selected.insert(a.id) } }
                    else { remember(); app.open(all, at: all.firstIndex(of: a) ?? 0) }
                } label: { GridCell(asset: a, selected: selecting ? selected.contains(a.id) : nil) }
                .buttonStyle(.plain)
            }
        }
    }

    // MARK: Auswahl in den Ergebnissen

    private var chosen: [Asset] { (result.text + result.photos).filter { selected.contains($0.id) } }

    private var selectionBar: some View {
        HStack(spacing: 12) {
            Button { Task { await ShareService.share(Array(selected), app: app) } } label: {
                Image(systemName: "square.and.arrow.up").frame(width: 54, height: 54).contentShape(.rect)
            }
            .glassEffect(.regular.interactive(), in: .circle)
            .disabled(selected.isEmpty)
            Menu {
                AssetMenu(assets: chosen, style: .selection, present: { sheet = $0 }) { endSelection() }
            } label: {
                Text(SelectionText.make(chosen, count: selected.count))
                    .font(.system(size: 17, weight: .semibold)).frame(maxWidth: .infinity).frame(height: 54)
            }
            .disabled(selected.isEmpty)
            Button { confirmDelete = true } label: { Image(systemName: "trash").frame(width: 54, height: 54) }
                .glassEffect(.regular.interactive(), in: .circle)
                .disabled(selected.isEmpty)
        }
        .font(.system(size: 20, weight: .medium))
        .foregroundStyle(.primary)
        .buttonStyle(.plain)
        .padding(.horizontal, 20).padding(.bottom, 6)
        .confirmationDialog("", isPresented: $confirmDelete) {
            Button(String(localized: "\(AssetActions.noun(chosen)) löschen"), role: .destructive) {
                AssetActions.delete(Array(selected), timeline: timeline); endSelection()
            }
        } message: { Text(String(localized: "Diese Objekte kommen in „Zuletzt gelöscht“ und bleiben dort 30 Tage wiederherstellbar.")) }
    }

    private func endSelection() {
        let gone = selected
        withAnimation(.snappy) { selecting = false; selected = [] }
        // ausgeblendete/gelöschte Objekte sofort aus den Ergebnissen nehmen
        Task { try? await Task.sleep(for: .milliseconds(300)); if !gone.isEmpty { resultKey = ""; await run() } }
    }

    // MARK: Hilfen

    private func heading(_ t: String) -> some View {
        Text(t).font(.system(size: 22, weight: .bold)).padding(.horizontal, 20).padding(.top, 6)
    }

    private func row(icon: String, _ title: String, sub: String? = nil, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 14) {
                Image(systemName: icon).font(.system(size: 18)).frame(width: 26).foregroundStyle(.secondary)
                Text(title).font(.system(size: 18))
                Spacer()
                if let sub { Text(sub).font(.system(size: 14)).foregroundStyle(.secondary) }
            }
            .foregroundStyle(.primary).padding(.horizontal, 20).frame(height: 46)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    /// Vorschlag als Kärtchen übernehmen (wie Apple), Tippen geht danach weiter.
    private func add(_ t: SearchToken) {
        withAnimation(.snappy) {
            if !tokens.contains(t) { tokens.append(t) }
            query = ""
        }
        tab = 0
    }

    private func remember() {
        let q = (tokens.map(\.title) + (trimmed.isEmpty ? [] : [trimmed])).joined(separator: " ")
        guard !q.isEmpty else { return }
        recentRaw = ([q] + recentQueries.filter { $0.caseInsensitiveCompare(q) != .orderedSame }).prefix(8).joined(separator: "\n")
    }

    // MARK: Suchlogik

    private func run() async {
        let k = key
        searching = true
        defer { searching = false }
        var plan = await SearchPlan.make(trimmed, cities: cities.compactMap { $0.exifInfo?.city }, people: people, forced: nil,
                                         countries: countries)
        await plan.apply(tokens)
        var r = await plan.execute(smart: trimmed.count >= 3 || plan.freeText.count >= 3)
        // Kartenort: nur Fotos im Umkreis (Immich-Suche kennt keinen Umkreis → über die Kartenpunkte)
        for case .area(_, let lat, let lon, let km) in tokens {
            let near = Set(markers.filter { PlaceCompleter.distanceKm(lat, lon, $0.lat, $0.lon) <= km }.map(\.id))
            if plan.filter.isEmpty && plan.freeText.isEmpty && tokens.count == 1 {
                await timeline.loadAll()
                r.photos = timeline.allLoaded.filter { near.contains($0.id) }
                r.text = []
            } else {
                r.photos = r.photos.filter { near.contains($0.id) }; r.text = r.text.filter { near.contains($0.id) }
            }
            r.next = nil   // Umkreis wird hier auf dem iPhone gefiltert – Nachladen kennt ihn nicht
        }
        guard k == key else { return }   // inzwischen weitergetippt
        result = r; resultKey = k
    }

    /// Nächste Seite einer großen Filtersuche anhängen (Idee „Load more“ aus dem Fork vands2013).
    private func loadMore() async {
        guard let cursor = result.next, !loadingMore else { return }
        let k = key
        loadingMore = true; defer { loadingMore = false }
        guard let page = try? await ImmichClient.shared.searchPage(filter: result.filter, size: 2000, cursor: cursor),
              k == key, result.next == cursor else { return }
        let have = Set(result.photos.map(\.id))
        result.photos += page.items.map(\.asset).filter { !have.contains($0.id) }
        result.next = page.next
    }
}

struct SearchResult {
    var labels: [String] = []
    var text: [Asset] = []     // Treffer über Texterkennung
    var photos: [Asset] = []   // KI-Suche bzw. reine Filter
    /// Reine Filtersuche mit mehr Treffern als eine Seite (z. B. eine Person mit 5000 Fotos): Cursor + Filter fürs Nachladen
    var next: String?
    var filter: [String: Any] = [:]
}

/// Zerlegt die Eingabe in feste Filter + Freitext.
@MainActor
struct SearchPlan {
    var filter: [String: Any] = [:]
    var labels: [String] = []
    var freeText = ""

    private static let months: [String: Int] = [
        "januar": 1, "jan": 1, "februar": 2, "feb": 2, "märz": 3, "maerz": 3, "mär": 3, "april": 4, "apr": 4, "mai": 5,
        "juni": 6, "jun": 6, "juli": 7, "jul": 7, "august": 8, "aug": 8, "september": 9, "sep": 9, "sept": 9,
        "oktober": 10, "okt": 10, "november": 11, "nov": 11, "dezember": 12, "dez": 12]

    static func make(_ q: String, cities: [String], people: [PersonDTO], forced: Category?, countries: [String] = []) async -> SearchPlan {
        var p = SearchPlan()
        var rest = q
        func take(_ word: String) { rest = rest.replacingOccurrences(of: word, with: " ", options: [.caseInsensitive]) }

        // Kategorie (Belege, Screenshots, Selfies …)
        // nur Kategorien mit Server-Filter; „Hund“ (Haustiere) usw. bleibt Freitext für die KI-Suche,
        // sonst wären Filter und Text leer und es kämen einfach die neuesten Fotos
        let cat = forced ?? Category.allCases.first { c in
            c != .map && (c == .videos || c == .favorites || c.tag != nil) && ([c.title.lowercased()] + c.synonyms).contains { w in
                q.lowercased().range(of: "\\b\(NSRegularExpression.escapedPattern(for: w))\\b", options: .regularExpression) != nil }
        }
        if let cat {
            if forced != nil { rest = "" } else { take(cat.title); cat.synonyms.forEach(take) }
            switch cat {
            case .videos: p.filter["type"] = ["eq": "VIDEO"]
            case .favorites: p.filter["isFavorite"] = ["eq": true]
            // Live Photos haben oft kein Tag, nur das verknüpfte Video → Server-Filter isMotion
            case .livePhotos: p.filter["isMotion"] = ["eq": true]
            default:
                if let tag = cat.tag, let id = await CategoryLoader.tagID(tag) { p.filter["tagIds"] = ["any": [id]] }
                else if cat.tag != nil { p.filter["tagIds"] = ["any": ["00000000-0000-4000-8000-000000000000"]] } // noch leer
            }
            p.labels.append(cat.title)
        }
        // Ort (längster Treffer zuerst, damit „Bad Boll“ vor „Boll“ greift)
        if let city = cities.sorted(by: { $0.count > $1.count }).first(where: { rest.range(of: $0, options: .caseInsensitive) != nil }) {
            p.filter["city"] = ["eq": city]; p.labels.append(city); take(city)
        }
        // Land, deutsch oder wie vom Server („Türkei“ / „Turkey“)
        if p.filter["city"] == nil,
           let c = countries.first(where: { rest.range(of: CountryName.de($0), options: .caseInsensitive) != nil
                                            || rest.range(of: $0, options: .caseInsensitive) != nil }) {
            p.filter["country"] = ["eq": c]; p.labels.append(CountryName.de(c)); take(CountryName.de(c)); take(c)
        }
        // Personen
        let found = people.filter { rest.range(of: $0.name, options: .caseInsensitive) != nil }
        if !found.isEmpty {
            p.filter["personIds"] = ["all": found.map(\.id)]; p.labels += found.map(\.name); found.forEach { take($0.name) }
        }
        // Jahr und Monat
        let words = rest.lowercased().split(whereSeparator: { !$0.isLetter && !$0.isNumber }).map(String.init)
        if let y = words.compactMap(Int.init).first(where: { (1990...2100).contains($0) }) {
            var from = DateComponents(year: y, month: 1, day: 1), to = DateComponents(year: y + 1, month: 1, day: 1)
            var label = "\(y)"
            if let mw = words.first(where: { months[$0] != nil }), let m = months[mw] {
                from.month = m; to = DateComponents(year: m == 12 ? y + 1 : y, month: m == 12 ? 1 : m + 1, day: 1)
                label = "\(mw.capitalized) \(y)"; take(mw)
            }
            let iso = ISO8601DateFormatter(); var cal = Calendar(identifier: .gregorian); cal.timeZone = .gmt
            p.filter["takenAt"] = ["gte": iso.string(from: cal.date(from: from)!), "lt": iso.string(from: cal.date(from: to)!)]
            p.labels.append(label); take(String(y))
        }
        p.freeText = rest.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        return p
    }

    /// Kärtchen als feste Filter übernehmen.
    mutating func apply(_ tokens: [SearchToken]) async {
        var personIDs = (filter["personIds"] as? [String: [String]])?["all"] ?? []
        for t in tokens {
            switch t {
            case .person(let id, _): personIDs.append(id)
            case .place(let c): filter["city"] = ["eq": c]
            case .country(let c): filter["country"] = ["eq": c]
            case .area: break   // wird nach der Suche über die Kartenpunkte gefiltert
            case .folder: break   // öffnet den Ordner, kein Filter
            case .album(let id, _): filter["albumIds"] = ["any": [id]]
            case .year(let y):
                let iso = ISO8601DateFormatter(); var cal = Calendar(identifier: .gregorian); cal.timeZone = .gmt
                filter["takenAt"] = ["gte": iso.string(from: cal.date(from: DateComponents(year: y, month: 1, day: 1))!),
                                     "lt": iso.string(from: cal.date(from: DateComponents(year: y + 1, month: 1, day: 1))!)]
            case .category(let c):
                switch c {
                case .videos: filter["type"] = ["eq": "VIDEO"]
                case .favorites: filter["isFavorite"] = ["eq": true]
                case .livePhotos: filter["isMotion"] = ["eq": true]
                case .hidden: filter["visibility"] = ["eq": "archive"]
                default:
                    if let tag = c.tag, let id = await CategoryLoader.tagID(tag) { filter["tagIds"] = ["any": [id]] }
                    else if c.tag != nil { filter["tagIds"] = ["any": ["00000000-0000-4000-8000-000000000000"]] }
                }
            }
        }
        if !personIDs.isEmpty { filter["personIds"] = ["all": personIDs] }
    }

    /// smart = false: nur Texterkennung + Dateiname (bei 1–2 Buchstaben liefert die KI-Suche nur Zufall).
    func execute(smart: Bool = true) async -> SearchResult {
        let api = ImmichClient.shared
        var r = SearchResult(labels: labels)
        if freeText.isEmpty {
            let page = try? await api.searchPage(filter: filter, size: 2000)
            r.photos = (page?.items ?? []).map(\.asset)
            r.next = page?.next; r.filter = filter
            return r
        }
        var ocrFilter = filter; ocrFilter["ocr"] = ["matches": freeText]
        r.text = ((try? await api.search(filter: ocrFilter, size: 60)) ?? []).map(\.asset)
        let seen = Set(r.text.map(\.id))
        guard smart else { return r }
        // Die KI-Suche sortiert nach Ähnlichkeit und liefert immer etwas – bei Text-Treffern nur die nächsten zeigen.
        let found = ((try? await api.smartSearch(freeText, filter: filter, size: 200)) ?? []).map(\.asset)
        // Nur echte Treffer zeigen (wie Apple „Keine Treffer“), Dienst weg → wie bisher begrenzt
        if let keep = await api.relevant(freeText, ids: found.map(\.id)) {
            r.photos = found.filter { keep.contains($0.id) && !seen.contains($0.id) }
        } else {
            r.photos = Array(found.filter { !seen.contains($0.id) }.prefix(r.text.isEmpty ? 150 : 30))
        }
        return r
    }
}

/// Umbrechende Knöpfe (Medienarten auf der Such-Startseite).
struct FlowChips: View {
    let items: [Category]
    let action: (Category) -> Void
    var body: some View {
        FlowLayout(spacing: 8) {
            ForEach(items) { c in
                Button { action(c) } label: {
                    Label(c.title, systemImage: c.icon).font(.system(size: 15, weight: .medium))
                        .foregroundStyle(.primary).padding(.horizontal, 14).frame(height: 36)
                        .background(Capsule().fill(Color.appFill2))
                }
                .buttonStyle(.plain)
            }
        }
    }
}

struct FlowLayout: Layout {
    var spacing: CGFloat = 8
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        arrange(proposal.width ?? .infinity, subviews).size
    }
    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        for (i, p) in arrange(bounds.width, subviews).points.enumerated() {
            subviews[i].place(at: CGPoint(x: bounds.minX + p.x, y: bounds.minY + p.y), proposal: .unspecified)
        }
    }
    private func arrange(_ width: CGFloat, _ subviews: Subviews) -> (points: [CGPoint], size: CGSize) {
        var pts: [CGPoint] = []; var x: CGFloat = 0; var y: CGFloat = 0; var rowH: CGFloat = 0; var maxX: CGFloat = 0
        for s in subviews {
            let sz = s.sizeThatFits(.unspecified)
            if x > 0 && x + sz.width > width { x = 0; y += rowH + spacing; rowH = 0 }
            pts.append(CGPoint(x: x, y: y)); x += sz.width + spacing; rowH = max(rowH, sz.height); maxX = max(maxX, x)
        }
        return (pts, CGSize(width: maxX - spacing, height: y + rowH))
    }
}


/// Ländernamen vom Server (englisch) in der Sprache der App (Deutsch: feste Kurzformen wie „USA“).
enum CountryName {
    /// Sprache, in der die App gerade läuft (nicht die Systemsprache – die App kann nur Deutsch und Englisch)
    static var german: Bool { Bundle.main.preferredLocalizations.first == "de" }
    private static let fixed = ["Turkey": "Türkei", "Türkiye": "Türkei", "United Arab Emirates": "Vereinigte Arabische Emirate",
                                "United States": "USA", "United Kingdom": "Großbritannien", "Czechia": "Tschechien"]
    private static let byName: [String: String] = {
        let en = Locale(identifier: "en_US"), de = Locale.autoupdatingCurrent
        var m: [String: String] = [:]
        for r in Locale.Region.isoRegions {
            if let e = en.localizedString(forRegionCode: r.identifier), let d = de.localizedString(forRegionCode: r.identifier) { m[e] = d }
        }
        return m
    }()
    static func de(_ en: String) -> String { (german ? fixed[en] : nil) ?? byName[en] ?? en }
}


/// Vorschläge aus Apple Karten beim Tippen (wie Apples Orte-Suche): Name + Umkreis für die Fotosuche.
@MainActor @Observable
final class PlaceCompleter: NSObject, MKLocalSearchCompleterDelegate {
    struct Place: Hashable { let name: String; let lat: Double; let lon: Double; let km: Double }
    private(set) var results: [Place] = []
    @ObservationIgnored private let completer = MKLocalSearchCompleter()
    @ObservationIgnored private var resolving: Task<Void, Never>?

    override init() {
        super.init()
        completer.delegate = self
        completer.resultTypes = .address
    }

    func query(_ q: String) {
        guard q.count >= 3 else { results = []; completer.cancel(); return }
        completer.queryFragment = q
    }

    nonisolated func completerDidUpdateResults(_ c: MKLocalSearchCompleter) {
        // Rückruf kommt auf dem Hauptthread (Completer wurde dort angelegt)
        nonisolated(unsafe) let list = Array(c.results.prefix(3))
        MainActor.assumeIsolated { self.resolve(list) }
    }
    nonisolated func completer(_ c: MKLocalSearchCompleter, didFailWithError error: Error) {}

    /// Vorschlag → Koordinate und Größe (Stadt ≈ 15 km, Land größer).
    private func resolve(_ list: [MKLocalSearchCompletion]) {
        resolving?.cancel()
        resolving = Task {
            var out: [Place] = []
            for c in list {
                guard let item = try? await MKLocalSearch(request: MKLocalSearch.Request(completion: c)).start(), !Task.isCancelled else { continue }
                let region = item.boundingRegion
                let km = max(8, min(400, region.span.latitudeDelta * 111 / 2))
                if let m = item.mapItems.first {
                    out.append(Place(name: c.title, lat: m.location.coordinate.latitude, lon: m.location.coordinate.longitude, km: km))
                }
            }
            if !Task.isCancelled { results = out }
        }
    }

    nonisolated static func distanceKm(_ a1: Double, _ o1: Double, _ a2: Double, _ o2: Double) -> Double {
        let r = 6371.0, p = Double.pi / 180
        let x = (o2 - o1) * p * cos((a1 + a2) / 2 * p), y = (a2 - a1) * p
        return sqrt(x * x + y * y) * r
    }
}
