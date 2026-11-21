import SwiftUI

/// Ordneransicht (GitHub #42): Fotos so, wie sie auf dem Server in Ordnern liegen – vor allem für externe
/// Bibliotheken mit eigener Ordnerstruktur. Quelle ist Immichs Ordner-Schnittstelle (view/folder).
/// Immichs interne Ablage hochgeladener Fotos (upload/<Benutzer-ID>/ab/cd) ist kein echter Ordner und bleibt weg.
@MainActor @Observable final class FolderStore {
    static let shared = FolderStore()
    /// Alle Ordner mit Fotos (volle Pfade, sortiert)
    private(set) var paths: [String] = []
    /// gemeinsamer Anfang aller Pfade – die oberste Ebene der Ansicht
    private(set) var root = ""
    private(set) var loaded = false
    private var covers: [String: String] = [:]
    private var contents: [String: [Asset]] = [:]

    func load() async {
        guard let all = try? await ImmichClient.shared.folderPaths() else { return }
        #if DEBUG
        let showAll = ProcessInfo.processInfo.environment["FOTOS_FOLDERS_ALL"] != nil
        #else
        let showAll = false
        #endif
        let keep = showAll ? all : all.filter { !Self.isInternal($0) }
        paths = keep.sorted { $0.localizedStandardCompare($1) == .orderedAscending }
        root = Self.commonDirectory(paths)
        covers = [:]; contents = [:]; latestCache = [:]
        loaded = true
    }

    nonisolated static func isInternal(_ p: String) -> Bool {
        let c = p.split(separator: "/")
        if let i = c.lastIndex(of: "upload"), i + 1 < c.count, c[i + 1].count == 36 { return true }
        return c.contains("encoded-video") || c.contains("thumbs")
    }

    /// Längster gemeinsamer Ordner (bei nur einem Ordner dessen übergeordneter, damit er als Eintrag erscheint)
    nonisolated static func commonDirectory(_ paths: [String]) -> String {
        guard let first = paths.first else { return "" }
        var common = first.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        if paths.count == 1 { common.removeLast() }
        for p in paths.dropFirst() {
            let c = p.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
            var n = 0
            while n < common.count, n < c.count, common[n] == c[n] { n += 1 }
            common = Array(common.prefix(n))
        }
        // ein Ordner, der selbst Fotos hat, aber zugleich der Anfang ist, bleibt sichtbar: eine Ebene höher beginnen
        let j = common.joined(separator: "/")
        if paths.count > 1, paths.contains(j), !common.isEmpty { common.removeLast() }
        return common.joined(separator: "/")
    }

    /// Unterordner direkt unter `dir` (volle Pfade)
    func children(of dir: String) -> [String] {
        let prefix = dir.hasSuffix("/") ? dir : dir + "/"
        var seen = Set<String>(), out: [String] = []
        for p in paths where p.hasPrefix(prefix) {
            guard let name = p.dropFirst(prefix.count).split(separator: "/").first else { continue }
            let child = prefix + name
            if seen.insert(child).inserted { out.append(child) }
        }
        return out
    }

    func hasPhotos(_ dir: String) -> Bool { paths.contains(dir) }

    /// Alle Ordner unterhalb der obersten Ebene (auch reine Zwischenordner ohne eigene Fotos) – für die Suche
    var allDirectories: [String] {
        var out = Set<String>()
        let pre = root.isEmpty ? "" : root + "/"
        // vom Pfad aus nach oben bis zur obersten Ebene; der Pfad bleibt dabei unverändert (auch der führende „/“,
        // sonst öffnete ein Treffer bei Ordnern aus mehreren Hauptordnern einen leeren Ordner – GitHub #49)
        for p in paths where p.hasPrefix(pre) {
            var d = p
            while d.count > pre.count, d.hasPrefix(pre) {
                out.insert(d)
                guard let i = d.lastIndex(of: "/") else { break }
                d = String(d[..<i])
            }
        }
        return out.sorted { $0.localizedStandardCompare($1) == .orderedAscending }
    }

    /// Unterzeile wie in Fotos, nur eine Ebene tief: „3 Ordner · 120 Fotos“ (GitHub #46)
    func summary(_ dir: String) async -> String {
        let folders = children(of: dir).count
        let photos = hasPhotos(dir) ? await assets(dir).count : 0
        var parts: [String] = []
        if folders > 0 { parts.append(folders == 1 ? String(localized: "1 Ordner") : String(localized: "\(folders) Ordner")) }
        if photos > 0 || folders == 0 { parts.append(photos == 1 ? String(localized: "1 Objekt") : String(localized: "\(photos) Objekte")) }
        return parts.joined(separator: " · ")
    }

    /// Ordner mit Unterordnern: Mosaik aus bis zu vier Titelbildern der Unterordner (wie Album-Ordner in Fotos)
    func mosaic(_ dir: String) async -> [String] {
        var out: [String] = []
        for c in children(of: dir).prefix(4) { if let id = await cover(c) { out.append(id) } }
        if out.count < 4, hasPhotos(dir) {
            for a in await assets(dir).reversed() where !out.contains(a.id) { out.append(a.id); if out.count == 4 { break } }
        }
        return out
    }

    /// Neuestes Foto im Ordner oder darunter (für „Neueste zuerst“)
    func latest(_ dir: String) async -> Date {
        if let d = latestCache[dir] { return d }
        var best = Date.distantPast
        if hasPhotos(dir), let d = await assets(dir).last?.date { best = d }
        for c in children(of: dir) { best = max(best, await latest(c)) }
        latestCache[dir] = best
        return best
    }
    private var latestCache: [String: Date] = [:]

    /// Ordner sortieren wie in der Ordneransicht gewählt – gilt auch für die Ordner-Reihe in den Sammlungen (GitHub #57)
    func sorted(_ subs: [String], by sort: FolderSort) async -> [String] {
        switch sort {
        case .nameAsc: return subs.sorted { Self.name($0).localizedStandardCompare(Self.name($1)) == .orderedAscending }
        case .nameDesc: return subs.sorted { Self.name($0).localizedStandardCompare(Self.name($1)) == .orderedDescending }
        case .newest, .oldest:
            var d: [String: Date] = [:]
            for s in subs { d[s] = await latest(s) }
            return subs.sorted { sort == .newest ? d[$0]! > d[$1]! : d[$0]! < d[$1]! }
        }
    }

    nonisolated static func name(_ dir: String) -> String { dir.split(separator: "/").last.map(String.init) ?? dir }

    /// Fotos direkt im Ordner. Nur Erfolge werden gemerkt: früher blieb ein Ordner nach einer abgebrochenen Anfrage
    /// bis zum nächsten Start „leer“ (leere Kacheln und Ordner auf dem iPhone, GitHub #60). Höchstens 3 Ordner
    /// gleichzeitig, mit zwei Wiederholungen – jede Kachel lädt dafür den ganzen Ordnerinhalt.
    func assets(_ dir: String) async -> [Asset] {
        if let c = contents[dir] { return c }
        if let t = loading[dir] { return await t.value ?? [] }
        let t = Task { () -> [Asset]? in
            await acquire()
            defer { release() }
            for attempt in 0..<3 {
                if Task.isCancelled { return nil }
                if let r = try? await ImmichClient.shared.folderAssets(dir) {
                    return r.map(\.asset).sorted { $0.date < $1.date }
                }
                try? await Task.sleep(for: .seconds(attempt == 0 ? 1 : 3))
            }
            return nil
        }
        loading[dir] = t
        let r = await t.value
        loading[dir] = nil
        if let r { contents[dir] = r }
        return r ?? []
    }
    private var loading: [String: Task<[Asset]?, Never>] = [:]
    private var active = 0
    private var waiting: [CheckedContinuation<Void, Never>] = []
    private func acquire() async {
        if active < 3 { active += 1; return }
        await withCheckedContinuation { waiting.append($0) }
    }
    private func release() {
        if waiting.isEmpty { active -= 1 } else { waiting.removeFirst().resume() }
    }

    /// Titelbild: neuestes Foto im Ordner selbst, sonst im ersten Unterordner mit Fotos
    func cover(_ dir: String) async -> String? {
        if let c = covers[dir] { return c }
        let source = hasPhotos(dir) ? dir : paths.first { $0.hasPrefix(dir + "/") }
        guard let source else { return nil }
        let list = await assets(source)
        guard let id = list.last(where: { $0.trashedAt == nil })?.id else { return nil }
        covers[dir] = id
        return id
    }
}

/// Sortierung der Ordner (GitHub #46)
enum FolderSort: String, CaseIterable, Identifiable {
    case nameAsc, nameDesc, newest, oldest
    var id: String { rawValue }
    var title: String {
        switch self {
        case .nameAsc: String(localized: "Name (A–Z)"); case .nameDesc: String(localized: "Name (Z–A)")
        case .newest: String(localized: "Neueste zuerst"); case .oldest: String(localized: "Älteste zuerst")
        }
    }
}

/// Kachel eines Ordners: mit Unterordnern als Mosaik + Ordnersymbol, der letzte Ordner einer Kette wie ein Album
/// (ein Titelbild) – so wie Fotos Album-Ordner und Alben zeigt (GitHub #42/#46).
struct FolderTile: View {
    let path: String
    private var store: FolderStore { .shared }
    @State private var covers: [String] = []
    @State private var summary = ""

    var body: some View {
        let isFolder = !store.children(of: path).isEmpty
        VStack(alignment: .leading, spacing: 4) {
            RoundedRectangle(cornerRadius: 18, style: .continuous).fill(Color.appFill)
                .aspectRatio(1, contentMode: .fit)
                .overlay {
                    if isFolder && covers.count > 1 {
                        // immer vier feste Felder (leere grau) wie bei Album-Ordnern in Fotos
                        Grid(horizontalSpacing: 4, verticalSpacing: 4) {
                            ForEach(0..<2, id: \.self) { r in
                                GridRow {
                                    ForEach(0..<2, id: \.self) { c in
                                        let i = r * 2 + c
                                        Group {
                                            if i < covers.count { AssetThumb(id: covers[i]) } else { Color.appFill2 }
                                        }
                                        .aspectRatio(1, contentMode: .fill)
                                        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                                    }
                                }
                            }
                        }
                        .padding(8)
                    } else if let c = covers.first {
                        AssetThumb(id: c, size: .preview).clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                    } else {
                        Image(systemName: isFolder ? "folder" : "photo.on.rectangle").font(.system(size: 40)).foregroundStyle(.secondary)
                    }
                }
                .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
            Group {
                if isFolder { Label(FolderStore.name(path), systemImage: "folder") } else { Text(FolderStore.name(path)) }
            }
            .font(.system(size: 16, weight: .semibold)).foregroundStyle(.primary).lineLimit(1)
            Text(summary.isEmpty ? " " : summary).font(.system(size: 14)).foregroundStyle(.secondary).lineLimit(1)
        }
        .task(id: path) {
            covers = isFolder ? await store.mosaic(path) : [await store.cover(path)].compactMap { $0 }
            summary = await store.summary(path)
        }
    }
}

/// Karte in der Sammlungen-Übersicht (Reihe „Ordner“): Mosaik bei Ordnern mit Unterordnern, sonst Titelbild
struct FolderCard: View {
    let path: String
    @State private var covers: [String] = []
    var body: some View {
        let isFolder = !FolderStore.shared.children(of: path).isEmpty
        Group {
            if isFolder && covers.count > 1 {
                MosaicCard(ids: covers, title: FolderStore.name(path))
            } else {
                SmallCard(assetID: covers.first, title: FolderStore.name(path), badge: isFolder ? "folder.fill" : nil)
            }
        }
        .task(id: path) {
            covers = isFolder ? await FolderStore.shared.mosaic(path) : [await FolderStore.shared.cover(path)].compactMap { $0 }
        }
    }
}

/// Ein Ordner wie ein Album-Ordner in Fotos: Unterordner als Kacheln (2 Spalten), sortierbar.
/// Der letzte Ordner einer Kette öffnet sich direkt als Fotoraster – wie ein Album.
struct FolderScreen: View {
    let path: String
    private var store: FolderStore { .shared }
    @AppStorage("folderSort") private var sortRaw = FolderSort.nameAsc.rawValue
    @State private var assets: [Asset]?
    @State private var order: [String] = []

    var body: some View {
        let subs = store.children(of: path)
        let title = path == store.root ? String(localized: "Ordner") : FolderStore.name(path)
        if subs.isEmpty {
            AssetGridScreen(title: title, subtitle: subtitle, assets: assets ?? [], loading: assets == nil, back: true)
                .task { if assets == nil { assets = await store.assets(path) } }
        } else {
            ScrollView {
                LazyVGrid(columns: [GridItem(.flexible(), spacing: 16), GridItem(.flexible(), spacing: 16)], spacing: 18) {
                    if store.hasPhotos(path) {
                        NavigationLink(value: CollectionRoute.folderPhotos(path)) { OwnPhotosTile(path: path) }.buttonStyle(.plain)
                    }
                    ForEach(order.isEmpty ? subs : order, id: \.self) { s in
                        NavigationLink(value: CollectionRoute.folder(s)) { FolderTile(path: s) }.buttonStyle(.plain)
                    }
                }
                .padding(20)
                .padding(.bottom, 90)
            }
            .background(Color.appBackground)
            .navigationTitle(title)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Picker(String(localized: "Sortieren"), selection: $sortRaw) {
                            ForEach(FolderSort.allCases) { Text($0.title).tag($0.rawValue) }
                        }
                    } label: { Image(systemName: "arrow.up.arrow.down") }
                    .accessibilityLabel(String(localized: "Sortieren"))
                }
            }
            .task(id: sortRaw) { order = await store.sorted(subs, by: FolderSort(rawValue: sortRaw) ?? .nameAsc) }
        }
    }

    private var subtitle: String {
        guard let assets else { return "" }
        return assets.count == 1 ? String(localized: "1 Objekt") : String(localized: "\(assets.count) Objekte")
    }
}

/// Kachel „Fotos in diesem Ordner“, wenn ein Ordner selbst Fotos UND Unterordner hat
private struct OwnPhotosTile: View {
    let path: String
    @State private var cover: String?
    @State private var count = 0
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            RoundedRectangle(cornerRadius: 18, style: .continuous).fill(Color.appFill)
                .aspectRatio(1, contentMode: .fit)
                .overlay { if let cover { AssetThumb(id: cover, size: .preview) } }
                .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
            Text(String(localized: "Fotos in diesem Ordner")).font(.system(size: 16, weight: .semibold)).foregroundStyle(.primary).lineLimit(1)
            Text(count == 1 ? String(localized: "1 Objekt") : String(localized: "\(count) Objekte")).font(.system(size: 14)).foregroundStyle(.secondary)
        }
        .task(id: path) {
            let a = await FolderStore.shared.assets(path)
            count = a.count; cover = a.last?.id
        }
    }
}
