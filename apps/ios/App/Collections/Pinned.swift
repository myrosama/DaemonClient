import SwiftUI

/// Abschnitte der Sammlungen (Reihenfolge per „Neu anordnen“ änderbar).
enum Sec: String, CaseIterable {
    case pinned, albums, recentDays, mediaTypes, others
    var title: String {
        switch self {
        case .pinned: String(localized: "Angepinnt"); case .albums: String(localized: "Alben"); case .recentDays: String(localized: "Letzte Tage")
        case .mediaTypes: String(localized: "Medienarten"); case .others: String(localized: "Sonstige")
        }
    }
}

/// Ein Eintrag unter „Angepinnt“: eine Medienart/Sonstiges oder ein ganzer Abschnitt.
enum PinItem: Hashable {
    case category(Category)
    case section(Sec)
    case album(String)

    static let defaults = "favorites,recentlySaved,map,videos,livePhotos,hidden"
    static let sectionSuggestions: [Sec] = [.albums, .mediaTypes, .others]

    var key: String {
        switch self { case .category(let c): c.rawValue; case .section(let s): "s." + s.rawValue; case .album(let id): "a." + id }
    }
    init?(key: String) {
        if key.hasPrefix("a.") { self = .album(String(key.dropFirst(2))) }
        else if key.hasPrefix("s."), let s = Sec(rawValue: String(key.dropFirst(2))) { self = .section(s) }
        else if let c = Category(rawValue: key) { self = .category(c) }
        else { return nil }
    }
    var title: String {
        switch self { case .category(let c): c.title; case .section(let s): s.title; case .album(let id): AlbumNames.byID[id] ?? String(localized: "Album") }
    }
    var icon: String {
        switch self {
        case .category(let c): c.icon
        case .album: "rectangle.stack"
        case .section(let s):
            switch s {
            case .albums: "rectangle.stack"; case .mediaTypes: "photo.on.rectangle"; case .others: "ellipsis.circle"; default: "square"
            }
        }
    }
    static func parse(_ raw: String) -> [PinItem] {
        raw.split(separator: ",").compactMap { PinItem(key: String($0)) }
            .filter { if case .album(let id) = $0 { AlbumNames.byID.isEmpty || AlbumNames.byID[id] != nil } else { true } }
    }
    static func join(_ items: [PinItem]) -> String { items.map(\.key).joined(separator: ",") }
}

struct CardSideKey: EnvironmentKey { static let defaultValue: CGFloat = 128 }
extension EnvironmentValues {
    var cardSide: CGFloat {
        get { self[CardSideKey.self] }
        set { self[CardSideKey.self] = newValue }
    }
}

/// Karte für einen angepinnten Eintrag.
struct PinCard: View {
    let item: PinItem
    let model: CollectionsModel
    @Environment(TimelineStore.self) private var timeline
    @Environment(\.cardSide) private var side
    @State private var cover: String?

    var body: some View {
        NavigationLink(value: route) { card }
            .buttonStyle(.plain)
            .task(id: item) { cover = await coverID() }
    }

    private var route: CollectionRoute {
        switch item {
        case .category(let c): return .category(c)
        case .album(let id): return .album(AlbumRef(id: id, name: item.title))
        case .section(let s):
            switch s {
            case .mediaTypes: return .allMediaTypes
            case .others: return .allOthers
            default: return .allAlbums
            }
        }
    }

    @ViewBuilder private var card: some View {
        switch item {
        case .category(.recentlySaved):
            MosaicCard(ids: Array(timeline.allLoaded.suffix(4).reversed().map(\.id)), title: item.title)
        case .category(.map):
            MapCard(markers: model.markers)
        case .category(let c) where c.locked:
            RoundedRectangle(cornerRadius: 22, style: .continuous).fill(Color.appFill2)
                .frame(width: side, height: side)
                .overlay { Image(systemName: "lock.fill").font(.system(size: 26)).foregroundStyle(.secondary) }
                .overlay(alignment: .bottomLeading) {
                    Text(item.title).font(.system(size: 17, weight: .semibold)).foregroundStyle(.primary).lineLimit(2).padding(12)
                }
        default:
            SmallCard(assetID: cover, title: item.title,
                      badge: item == .category(.favorites) ? "heart.fill" : item == .category(.videos) ? "video.fill" : nil)
                .overlay {
                    if cover == nil {
                        Image(systemName: item.icon).font(.system(size: 28)).foregroundStyle(.secondary).offset(y: -10)
                    }
                }
        }
    }

    /// Titelbild: neuestes passendes Objekt.
    private func coverID() async -> String? {
        let all = timeline.allLoaded
        switch item {
        case .category(.favorites): return all.last(where: \.isFavorite)?.id
        case .category(.videos): return all.last(where: \.isVideo)?.id
        case .category(let c):
            if c.locked || c == .map || c == .recentlySaved { return nil }
            return await CategoryLoader.load(c, timeline: timeline).last?.id
        case .album(let id): return model.albums.first { $0.id == id }?.albumThumbnailAssetId
        case .section(.albums): return model.albums.first?.albumThumbnailAssetId
        case .section: return all.last(where: \.isImage)?.id
        }
    }
}

/// „Bearbeiten“ bei Angepinnt: entfernen, sortieren, aus Vorschlägen hinzufügen.
struct PinnedEditor: View {
    @Binding var raw: String
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        let pinned = PinItem.parse(raw)
        let albums = AlbumNames.byID.sorted { $0.value.localizedStandardCompare($1.value) == .orderedAscending }.map { PinItem.album($0.key) }
        let suggestions = PinItem.sectionSuggestions.map(PinItem.section) + albums + Category.allCases.map(PinItem.category)
        NavigationStack {
            List {
                Section {
                    ForEach(pinned, id: \.self) { p in
                        Text(p.title).font(.system(size: 19, weight: .semibold))
                    }
                    .onDelete { idx in var l = pinned; l.remove(atOffsets: idx); raw = PinItem.join(l) }
                    .onMove { from, to in var l = pinned; l.move(fromOffsets: from, toOffset: to); raw = PinItem.join(l) }
                }
                Section(String(localized: "Vorschläge")) {
                    ForEach(suggestions.filter { !pinned.contains($0) }, id: \.self) { p in
                        Button { raw = PinItem.join(pinned + [p]) } label: {
                            HStack(spacing: 14) {
                                Image(systemName: "plus.circle.fill").symbolRenderingMode(.palette)
                                    .foregroundStyle(.white, .green).font(.system(size: 22))
                                Text(p.title).font(.system(size: 19, weight: .semibold)).foregroundStyle(.primary)
                            }
                        }
                    }
                }
            }
            .environment(\.editMode, .constant(.active))
            .navigationTitle(String(localized: "Angepinnt"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { dismiss() } label: { Image(systemName: "xmark") }
                }
            }
        }
    }
}

/// „Neu anordnen“ der Abschnitte.
struct SectionOrderEditor: View {
    @Binding var raw: String
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        let saved = raw.split(separator: ",").compactMap { Sec(rawValue: String($0)) }
        let order = saved + Sec.allCases.filter { !saved.contains($0) }
        NavigationStack {
            List {
                ForEach(order, id: \.self) { s in Text(s.title).font(.system(size: 19, weight: .semibold)) }
                    .onMove { from, to in
                        var l = order; l.move(fromOffsets: from, toOffset: to)
                        raw = l.map(\.rawValue).joined(separator: ",")
                    }
            }
            .environment(\.editMode, .constant(.active))
            .navigationTitle(String(localized: "Neu anordnen"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { Button(String(localized: "Standard")) { raw = "" } }
                ToolbarItem(placement: .topBarTrailing) { Button(String(localized: "Fertig")) { dismiss() }.bold() }
            }
        }
    }
}

/// Tippen auf „Angepinnt >“: alle angepinnten Einträge groß.
struct PinnedScreen: View {
    let items: [PinItem]
    let model: CollectionsModel
    @State private var width: CGFloat = 390
    var body: some View {
        // iPad: mehr Spalten statt riesiger Karten; Breite aus dem Fenster, nicht vom Bildschirm (Split View)
        let n = max(2, Int((width - 40) / 200))
        ScrollView {
            LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: n), spacing: 16) {
                ForEach(items, id: \.self) { p in PinCard(item: p, model: model) }
            }
            .padding(20)
        }
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
        .environment(\.cardSide, (width - 40 - CGFloat(n - 1) * 16) / CGFloat(n))
        .background(Color.appBackground)
        .navigationTitle(String(localized: "Angepinnt"))
    }
}

/// Leerer Abschnitt wie bei Apple: Symbol, Titel, Erklärung, optional Knopf rechts oben.
struct EmptyCard: View {
    let icon: String
    let title: String
    let text: String
    var action: (String, () -> Void)? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .top) {
                Image(systemName: icon).font(.system(size: 28)).foregroundStyle(.secondary)
                Spacer()
                if let action {
                    Button(action.0, action: action.1)
                        .font(.system(size: 16, weight: .semibold)).foregroundStyle(.blue)
                        .padding(.horizontal, 14).frame(height: 34)
                        .background(Capsule().fill(Color.appFill2))
                        .buttonStyle(.plain)
                }
            }
            .padding(.bottom, 26)
            Text(title).font(.system(size: 17, weight: .semibold)).foregroundStyle(.secondary)
            Text(text).font(.system(size: 15)).foregroundStyle(.secondary)
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 24, style: .continuous).fill(Color.appFill))
        .padding(.horizontal, 22)
    }
}

struct NewAlbumCard: View {
    @Environment(\.cardSide) private var side
    var body: some View {
        RoundedRectangle(cornerRadius: 22, style: .continuous).fill(Color.appFill)
            .frame(width: side, height: side)
            .overlay { Image(systemName: "plus").font(.system(size: 30, weight: .medium)).foregroundStyle(.blue) }
            .overlay(alignment: .bottomLeading) {
                Text(String(localized: "Neues Album")).font(.system(size: 15, weight: .semibold)).foregroundStyle(.primary).padding(12)
            }
    }
}
