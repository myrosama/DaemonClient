import SwiftUI

extension Notification.Name {
    /// Nach jeder Album-Änderung (anlegen, umbenennen, löschen, Fotos rein/raus) – Sammlungen laden neu.
    static let albumsChanged = Notification.Name("albumsChanged")
}

/// Albumnamen für angepinnte Alben (PinItem kennt nur die ID).
enum AlbumNames { nonisolated(unsafe) static var byID: [String: String] = [:] }

/// Sortierung der Albenliste („…“ in „Alben“), wie in Fotos.
enum AlbumSort: String, CaseIterable, Identifiable {
    case modified, name, newest, oldest
    var id: String { rawValue }
    var title: String {
        switch self {
        case .modified: String(localized: "Zuletzt geändert"); case .name: String(localized: "Name")
        case .newest: String(localized: "Neueste zuerst"); case .oldest: String(localized: "Älteste zuerst")
        }
    }
    func apply(_ l: [AlbumDTO]) -> [AlbumDTO] {
        switch self {
        case .modified: l.sorted { ($0.updatedAt ?? "") > ($1.updatedAt ?? "") }
        case .name: l.sorted { $0.albumName.localizedStandardCompare($1.albumName) == .orderedAscending }
        case .newest: l.sorted { ($0.endDate ?? "") > ($1.endDate ?? "") }
        case .oldest: l.sorted { ($0.endDate ?? "") < ($1.endDate ?? "") }
        }
    }
}

@MainActor
enum AlbumActions {
    static func changed() { NotificationCenter.default.post(name: .albumsChanged, object: nil) }

    static func rename(_ id: String, _ name: String) async {
        try? await ImmichClient.shared.updateAlbum(id, ["albumName": name]); changed()
    }
    static func delete(_ id: String) async {
        try? await ImmichClient.shared.deleteAlbum(id); changed()
    }
    static func setCover(_ id: String, _ asset: String) async {
        try? await ImmichClient.shared.updateAlbum(id, ["albumThumbnailAssetId": asset]); changed()
    }
    static func add(_ id: String, _ ids: [String]) async {
        try? await ImmichClient.shared.addToAlbum(id, ids); changed()
    }
    static func remove(_ id: String, _ ids: [String]) async {
        try? await ImmichClient.shared.removeFromAlbum(id, ids); changed()
    }
    static func share(_ id: String, app: AppModel) async {
        let ids = ((try? await ImmichClient.shared.albumAssets(id)) ?? []).map(\.id)
        await ShareService.share(ids, app: app)
    }
}

// MARK: - Album-Ansicht

/// Ein Album wie in Fotos: großes Schlüsselfoto mit Titel, Raster mit „+“, „…“-Menü und Auswählen.
struct AlbumScreen: View {
    let ref: AlbumRef
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var assets: [Asset]?
    @State private var info: AlbumDTO?
    @State private var picker = false
    @State private var renaming = false
    @State private var newName = ""
    @State private var confirmDelete = false
    @State private var showMap = false
    @State private var markers: [MapMarkerDTO] = []
    /// Zoom mit zwei Fingern wie in der Mediathek (1/3/5/7 Spalten)
    @AppStorage("album.columns") private var columns = 3
    /// Fensterbreite (iPad, Split View) statt Bildschirmbreite
    @State private var width: CGFloat = 390
    private static let zoomSteps = [1, 3, 5, 7]

    private var name: String { info?.albumName ?? ref.name }
    private var ascending: Bool { (info?.order ?? "asc") == "asc" }
    private var sorted: [Asset] {
        (assets ?? []).sorted { ascending ? $0.date < $1.date : $0.date > $1.date }
    }
    private var cover: String? { info?.albumThumbnailAssetId ?? sorted.first(where: \.isImage)?.id }
    private var countText: String {
        let n = assets?.count ?? 0
        return n == 1 ? String(localized: "1 Objekt") : String(localized: "\(n) Objekte")
    }

    var body: some View {
        let list = sorted
        ScrollView {
            VStack(spacing: 0) {
                if !list.isEmpty { hero(list) } else { Color.clear.frame(height: 150) }
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: columns > 5 ? 1 : 2), count: GridLayout.effective(columns, width: width)), spacing: columns > 5 ? 1 : 2) {
                    ForEach(Array(list.enumerated()), id: \.element.id) { i, a in
                        Button {
                            // beim Zoomen mit zwei Fingern nicht versehentlich ein Foto öffnen (wie in der Mediathek)
                            guard GridZoom.tapsAllowed else { return }
                            if app.selecting { app.toggle(a.id) } else { app.open(list, at: i) }
                        } label: {
                            GridCell(asset: a, square: columns != 1, selected: app.selecting ? app.selected.contains(a.id) : nil)
                        }
                        .buttonStyle(.plain)
                        .contextMenu { if !app.selecting { photoMenu(a) } } preview: {
                            AssetThumb(id: a.id, size: .preview)
                                .aspectRatio(a.ratio, contentMode: .fit)
                                .frame(width: 360, height: 360 / max(0.5, min(2, a.ratio)))
                        }
                    }
                    if !app.selecting && assets != nil {
                        Button { picker = true } label: {
                            Color.appFill.aspectRatio(1, contentMode: .fit)
                                .overlay { Image(systemName: "plus").font(.system(size: 30, weight: .medium)).foregroundStyle(.blue) }
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            .padding(.bottom, 110)
        }
        .simultaneousGesture(MagnifyGesture()
            .onChanged { _ in GridZoom.tapsBlockedUntil = Date().addingTimeInterval(0.6) }
            .onEnded { v in
            GridZoom.tapsBlockedUntil = Date().addingTimeInterval(0.6)
            let i = Self.zoomSteps.firstIndex(of: columns) ?? 1
            // auseinanderziehen = größer (weniger Spalten), zusammenziehen = kleiner
            let next = v.magnification > 1.15 ? max(0, i - 1) : v.magnification < 0.87 ? min(Self.zoomSteps.count - 1, i + 1) : i
            if next != i { withAnimation(.snappy) { columns = Self.zoomSteps[next] } }
        })
        .ignoresSafeArea(edges: .top)
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
        .background(Color.appBackground)
        .overlay(alignment: .top) { topBar(list) }
        .overlay {
            if assets == nil { ProgressView() }
            else if list.isEmpty {
                ContentUnavailableView {
                    Label(name, systemImage: "rectangle.stack")
                } description: { Text(String(localized: "Dieses Album ist leer.")) } actions: {
                    Button(String(localized: "Fotos hinzufügen")) { picker = true }.buttonStyle(.glassProminent)
                }
            }
        }
        .toolbar(.hidden, for: .navigationBar)
        .task { await load() }
        .onReceive(NotificationCenter.default.publisher(for: .albumsChanged)) { _ in Task { await load() } }
        .onChange(of: app.selecting) { _, on in if !on { Task { await load() } } }
        .onChange(of: app.viewer == nil) { _, closed in if closed { Task { await load() } } }
        .onDisappear { app.endSelection() }
        .sheet(isPresented: $picker) {
            PhotoPicker(exclude: Set((assets ?? []).map(\.id))) { ids in
                Task { await AlbumActions.add(ref.id, ids) }
                app.toast(ids.count == 1 ? String(localized: "1 Objekt hinzugefügt") : String(localized: "\(ids.count) Objekte hinzugefügt"))
            }
        }
        .alert(String(localized: "Album umbenennen"), isPresented: $renaming) {
            TextField(String(localized: "Titel"), text: $newName)
            Button(String(localized: "Sichern")) { let n = newName; Task { await AlbumActions.rename(ref.id, n) } }
            Button(String(localized: "Abbrechen"), role: .cancel) {}
        }
        .confirmationDialog(String(localized: "Möchtest du das Album „\(name)“ wirklich löschen?"), isPresented: $confirmDelete, titleVisibility: .visible) {
            Button(String(localized: "Album löschen"), role: .destructive) {
                Task { await AlbumActions.delete(ref.id) }
                app.toast(String(localized: "Album gelöscht")); dismiss()
            }
        } message: { Text(String(localized: "Die Fotos und Videos bleiben in deiner Mediathek.")) }
        .navigationDestination(isPresented: $showMap) { MapScreen(markers: markers) }
    }

    private func load() async {
        async let a = try? ImmichClient.shared.albumAssets(ref.id)
        async let l = try? ImmichClient.shared.albums()
        let list = await a, all = await l
        if let list { assets = list.map(\.asset) } else if assets == nil { assets = [] }
        if let found = all?.first(where: { $0.id == ref.id }) { info = found }
    }

    // MARK: Kopf

    private func hero(_ list: [Asset]) -> some View {
        let w = width, h = min(width * 1.12, 560)
        return ZStack(alignment: .bottomLeading) {
            Group { if let cover { AssetThumb(id: cover, size: .preview).scaledToFill() } else { Color.appFill } }
                .frame(width: w, height: h).clipped()
            LinearGradient(colors: [.black.opacity(0.35), .clear, .clear, .black.opacity(0.55)], startPoint: .top, endPoint: .bottom)
            HStack(alignment: .bottom) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(name).font(.system(size: 36, weight: .bold)).lineLimit(2)
                    Label(countText, systemImage: "rectangle.stack").font(.system(size: 17, weight: .semibold))
                }
                .foregroundStyle(.white).shadow(color: .black.opacity(0.4), radius: 8)
                Spacer()
                Button { app.sheet = .slideshow(list) } label: {
                    Image(systemName: "play.fill").font(.system(size: 22)).foregroundStyle(.white).frame(width: 56, height: 56).contentShape(.rect)
                }
                .glassEffect(.regular.interactive(), in: .circle)
            }
            .padding(20)
        }
        .frame(width: w, height: h)
        .padding(.bottom, 2)
    }

    private func topBar(_ list: [Asset]) -> some View {
        HStack(spacing: 12) {
            Button { app.endSelection(); dismiss() } label: {
                Image(systemName: "chevron.left").font(.system(size: 18, weight: .semibold)).frame(width: 46, height: 46).contentShape(.rect)
            }
            .glassEffect(.regular.interactive(), in: .circle)
            Spacer()
            if app.selecting {
                Menu { selectionMenu(list) } label: {
                    Image(systemName: "ellipsis").font(.system(size: 18, weight: .semibold)).frame(width: 46, height: 46).contentShape(.rect)
                }
                .glassEffect(.regular.interactive(), in: .circle)
                .disabled(app.selected.isEmpty)
                Button(String(localized: "Fertig")) { withAnimation(.snappy) { app.endSelection() } }
                    .font(.system(size: 17, weight: .semibold)).padding(.horizontal, 18).frame(height: 46)
                    .glassEffect(.regular.interactive(), in: .capsule)
            } else {
                Menu { albumMenu } label: {
                    Image(systemName: "ellipsis").font(.system(size: 18, weight: .semibold)).frame(width: 46, height: 46).contentShape(.rect)
                }
                .glassEffect(.regular.interactive(), in: .circle)
                if !list.isEmpty {
                    Button(String(localized: "Auswählen")) { withAnimation(.snappy) { app.selecting = true } }
                        .font(.system(size: 17, weight: .semibold)).padding(.horizontal, 18).frame(height: 46)
                        .glassEffect(.regular.interactive(), in: .capsule)
                }
            }
        }
        .foregroundStyle(.primary)
        .buttonStyle(.plain)
        .padding(.horizontal, 16)
        .padding(.top, 4)
    }

    // MARK: Menüs

    @ViewBuilder private var albumMenu: some View {
        Section(name + " · " + countText) {
            Button(String(localized: "Titel bearbeiten"), systemImage: "pencil") { newName = name; renaming = true }
        }
        Button(String(localized: "Teilen"), systemImage: "square.and.arrow.up") { Task { await ShareService.share(sorted.map(\.id), app: app) } }
            .disabled(sorted.isEmpty)
        Button(String(localized: "Album als Link teilen"), systemImage: "link") { app.sheet = .albumLink(ref.id) }
        Button(String(localized: "Fotos hinzufügen"), systemImage: "plus") { picker = true }
        // wie Fotos (REA: PXPhotoKitAssetCollectionPlayMovieActionPerformer): Album im Rückblick-Player
        Button("Als Rückblick abspielen", systemImage: "play.rectangle.on.rectangle") {
            let picked = MemoryEngine.curate(sorted, max: 60)
            if let key = info?.albumThumbnailAssetId.flatMap({ id in picked.first { $0.id == id } }) ?? MemoryEngine.keyPhoto(picked) {
                app.memory = Memory(id: "album-\(ref.id)", title: name, subtitle: MemoryEngine.range(picked), assets: picked,
                                    key: key, date: picked.last?.date ?? Date())
            } else { app.toast(String(localized: "Zu wenige Fotos für einen Rückblick")) }
        }
        .disabled(sorted.filter(\.isImage).count < 3)
        Button(String(localized: "Karte einblenden"), systemImage: "map") {
            Task {
                markers = (try? await ImmichClient.shared.albumMarkers(ref.id)) ?? []
                if markers.isEmpty { app.toast(String(localized: "Keine Fotos mit Ort in diesem Album")) } else { showMap = true }
            }
        }
        Menu {
            Picker(String(localized: "Sortieren"), selection: Binding(get: { ascending }, set: { asc in
                Task { try? await ImmichClient.shared.updateAlbum(ref.id, ["order": asc ? "asc" : "desc"]); await load() }
            })) {
                Text(String(localized: "Älteste zuerst")).tag(true)
                Text(String(localized: "Neueste zuerst")).tag(false)
            }
        } label: { Label(String(localized: "Sortieren"), systemImage: "arrow.up.arrow.down") }
        Divider()
        Button(String(localized: "Album löschen"), systemImage: "trash", role: .destructive) { confirmDelete = true }
    }

    @ViewBuilder private func photoMenu(_ a: Asset) -> some View {
        AssetMenu(assets: [a], style: .context, present: { app.sheet = $0 }) { assets?.removeAll { $0.id == a.id } }
        Section {
            Button(String(localized: "Als Schlüsselfoto festlegen"), systemImage: "photo") {
                Task { await AlbumActions.setCover(ref.id, a.id) }
                app.toast(String(localized: "Schlüsselfoto festgelegt"))
            }
            Button(String(localized: "Aus Album entfernen"), systemImage: "rectangle.stack.badge.minus") {
                withAnimation(.snappy) { assets?.removeAll { $0.id == a.id } }
                Task { await AlbumActions.remove(ref.id, [a.id]) }
            }
        }
    }

    @ViewBuilder private func selectionMenu(_ list: [Asset]) -> some View {
        let chosen = list.filter { app.selected.contains($0.id) }
        AssetMenu(assets: chosen, style: .selection, present: { app.sheet = $0 }) {
            withAnimation(.snappy) { app.endSelection() }
        }
        Section {
            if chosen.count == 1, let a = chosen.first {
                Button(String(localized: "Als Schlüsselfoto festlegen"), systemImage: "photo") {
                    Task { await AlbumActions.setCover(ref.id, a.id) }
                    app.toast(String(localized: "Schlüsselfoto festgelegt")); app.endSelection()
                }
            }
            Button(String(localized: "Aus Album entfernen"), systemImage: "rectangle.stack.badge.minus") {
                let ids = chosen.map(\.id)
                withAnimation(.snappy) { assets?.removeAll { ids.contains($0.id) }; app.endSelection() }
                Task { await AlbumActions.remove(ref.id, ids) }
                app.toast(ids.count == 1 ? String(localized: "Aus Album entfernt") : String(localized: "\(ids.count) aus Album entfernt"))
            }
        }
    }
}

// MARK: - Album-Karten (Sammlungen, Albenliste)

extension View {
    /// Langes Drücken auf ein Album wie in Fotos: Fotos teilen, Fotos hinzufügen, Titel bearbeiten, löschen, anpinnen.
    func albumContextMenu(_ album: AlbumDTO) -> some View { modifier(AlbumContextMenu(album: album)).modifier(AlbumDropTarget(album: album)) }
}

/// Fotos auf ein Album ziehen (REA: PXPhotoKitAssetCollectionDropAssetsActionPerformer): aus dem Raster gezogene
/// Objekte tragen „phosphor-asset:<id>“ (nur innerhalb der App) und landen im Album.
private struct AlbumDropTarget: ViewModifier {
    let album: AlbumDTO
    @Environment(AppModel.self) private var app
    @State private var over = false
    func body(content: Content) -> some View {
        content
            .overlay {
                if over { RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(Color.accentColor, lineWidth: 3) }
            }
            // onDrop statt dropDestination: nimmt auch die NSString-Kennung der UIKit-Rasterzellen an
            .onDrop(of: [.plainText], isTargeted: $over) { providers in
                let name = album.albumName, id = album.id
                Task { @MainActor in
                    var ids: [String] = []
                    for p in providers {
                        let s: String? = await withCheckedContinuation { c in
                            _ = p.loadObject(ofClass: NSString.self) { obj, _ in c.resume(returning: (obj as? NSString) as String?) }
                        }
                        guard let s, s.hasPrefix("phosphor-asset:") else { continue }
                        ids.append(String(s.dropFirst(15)))
                    }
                    guard !ids.isEmpty else { return }
                    await AlbumActions.add(id, ids)
                    app.toast(ids.count == 1 ? String(localized: "Zu „\(name)“ hinzugefügt") : String(localized: "\(ids.count) Objekte zu „\(name)“ hinzugefügt"))
                }
                return true
            }
    }
}

private struct AlbumContextMenu: ViewModifier {
    let album: AlbumDTO
    @Environment(AppModel.self) private var app
    @AppStorage("pinned") private var pinnedRaw = PinItem.defaults
    @State private var picker = false
    @State private var renaming = false
    @State private var newName = ""
    @State private var confirmDelete = false

    private var pinned: Bool { PinItem.parse(pinnedRaw).contains(.album(album.id)) }

    func body(content: Content) -> some View {
        content
            .contextMenu {
                Button(String(localized: "Fotos teilen"), systemImage: "square.and.arrow.up") { Task { await AlbumActions.share(album.id, app: app) } }
                    .disabled(album.assetCount == 0)
                Button(String(localized: "Album als Link teilen"), systemImage: "link") { app.sheet = .albumLink(album.id) }
                Button(String(localized: "Fotos hinzufügen"), systemImage: "plus") { picker = true }
                Divider()
                Button(String(localized: "Titel bearbeiten"), systemImage: "pencil") { newName = album.albumName; renaming = true }
                let folders = AlbumFolders.shared
                let current = folders.folder(of: album.id)
                if !folders.folders.isEmpty {
                    Menu {
                        ForEach(folders.folders.filter { $0.id != current?.id }) { f in
                            Button(f.name, systemImage: "folder") { withAnimation(.snappy) { folders.move(album.id, to: f.id) } }
                        }
                    } label: { Label("In Ordner bewegen", systemImage: "folder") }
                }
                if let current {
                    Button("Aus „\(current.name)“ entfernen", systemImage: "folder.badge.minus") {
                        withAnimation(.snappy) { folders.move(album.id, to: nil) }
                    }
                }
                Button(String(localized: "Album löschen"), systemImage: "trash", role: .destructive) { confirmDelete = true }
                Divider()
                Button(pinned ? String(localized: "Nicht mehr anpinnen") : String(localized: "Anpinnen"), systemImage: pinned ? "pin.slash" : "pin") {
                    var l = PinItem.parse(pinnedRaw)
                    if pinned { l.removeAll { $0 == .album(album.id) } } else { l.append(.album(album.id)) }
                    pinnedRaw = PinItem.join(l)
                }
            }
            .sheet(isPresented: $picker) {
                PhotoPicker(exclude: []) { ids in
                    Task { await AlbumActions.add(album.id, ids) }
                    app.toast(String(localized: "Zu „\(album.albumName)“ hinzugefügt"))
                }
            }
            .alert(String(localized: "Album umbenennen"), isPresented: $renaming) {
                TextField(String(localized: "Titel"), text: $newName)
                Button(String(localized: "Sichern")) { let n = newName, id = album.id; Task { await AlbumActions.rename(id, n) } }
                Button(String(localized: "Abbrechen"), role: .cancel) {}
            }
            .confirmationDialog(String(localized: "Möchtest du das Album „\(album.albumName)“ wirklich löschen?"), isPresented: $confirmDelete,
                                titleVisibility: .visible) {
                Button(String(localized: "Album löschen"), role: .destructive) {
                    let id = album.id
                    Task { await AlbumActions.delete(id) }
                    pinnedRaw = PinItem.join(PinItem.parse(pinnedRaw).filter { $0 != .album(id) })
                }
            } message: { Text(String(localized: "Die Fotos und Videos bleiben in deiner Mediathek.")) }
    }
}

/// Tippen auf „Alben >“: alle Alben groß mit Anzahl, Sortierung und „Neues Album“.
/// Album-Ordner wie in Fotos (REA: PXPhotoKitCollectionListCreateCollection / Move / MoveOut / Rename / Delete).
/// Immich kennt keine Ordner (Alben haben kein Eltern-Feld) → die Einteilung lebt auf diesem Gerät, je Konto;
/// Alben auf dem Server bleiben unverändert, ein gelöschter Ordner gibt seine Alben wieder frei.
@MainActor @Observable
final class AlbumFolders {
    static let shared = AlbumFolders()
    struct Folder: Codable, Identifiable, Hashable { let id: String; var name: String; var albums: [String] }
    private(set) var folders: [Folder] = []
    private var account = ""

    private var key: String { "albumFolders.\(account)" }
    func use(_ account: String) {
        guard account != self.account else { return }
        self.account = account
        folders = UserDefaults.standard.data(forKey: key).flatMap { try? JSONDecoder().decode([Folder].self, from: $0) } ?? []
    }
    private func save() { UserDefaults.standard.set(try? JSONEncoder().encode(folders), forKey: key) }

    func folder(of album: String) -> Folder? { folders.first { $0.albums.contains(album) } }
    func create(_ name: String) -> Folder {
        let f = Folder(id: UUID().uuidString, name: name, albums: [])
        folders.append(f); save(); return f
    }
    func rename(_ id: String, _ name: String) {
        guard let i = folders.firstIndex(where: { $0.id == id }) else { return }
        folders[i].name = name; save()
    }
    func delete(_ id: String) { folders.removeAll { $0.id == id }; save() }
    /// nil = aus jedem Ordner nehmen (zurück nach „Alben“)
    func move(_ album: String, to folder: String?) {
        for i in folders.indices { folders[i].albums.removeAll { $0 == album } }
        if let folder, let i = folders.firstIndex(where: { $0.id == folder }) { folders[i].albums.append(album) }
        save()
    }
}

struct AlbumsListScreen: View {
    let model: CollectionsModel
    /// nil = oberste Ebene (Ordner + Alben ohne Ordner), sonst Inhalt dieses Ordners
    var folderID: String? = nil
    @Environment(AppModel.self) private var app
    @AppStorage("albumSort") private var sortRaw = AlbumSort.modified.rawValue
    @State private var newAlbum = false
    @State private var naming: (id: String?, name: String)?
    @State private var folders = AlbumFolders.shared
    @State private var smart = SmartAlbums.shared
    @State private var editingSmart: SmartAlbum?

    private var folder: AlbumFolders.Folder? { folderID.flatMap { id in folders.folders.first { $0.id == id } } }
    private func visible(_ sort: AlbumSort) -> [AlbumDTO] {
        let all = sort.apply(model.albums)
        if let folder { return all.filter { folder.albums.contains($0.id) } }
        let filed = Set(folders.folders.flatMap(\.albums))
        return all.filter { !filed.contains($0.id) }
    }

    var body: some View {
        let sort = AlbumSort(rawValue: sortRaw) ?? .modified
        ScrollView {
            LazyVGrid(columns: [GridItem(.flexible(), spacing: 16), GridItem(.flexible(), spacing: 16)], spacing: 18) {
                if folderID == nil {
                    ForEach(folders.folders) { f in folderTile(f) }
                    ForEach(smart.albums) { s in smartTile(s) }
                }
                ForEach(visible(sort)) { a in
                    NavigationLink(value: CollectionRoute.album(AlbumRef(id: a.id, name: a.albumName))) {
                        VStack(alignment: .leading, spacing: 4) {
                            Group { if let t = a.albumThumbnailAssetId { AssetThumb(id: t, size: .preview) } else { Color.appFill } }
                                .aspectRatio(1, contentMode: .fit)
                                .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                            Text(a.albumName).font(.system(size: 16, weight: .semibold)).foregroundStyle(.primary).lineLimit(1)
                            Text("\(a.assetCount)").font(.system(size: 14)).foregroundStyle(.secondary)
                        }
                    }
                    .buttonStyle(.plain)
                    .albumContextMenu(a)
                }
            }
            .padding(20)
            .padding(.bottom, 90)
        }
        .background(Color.appBackground)
        .navigationTitle(folder?.name ?? String(localized: "Alben"))
        .onAppear { folders.use(app.userID); smart.use(app.userID) }
        .sheet(item: $editingSmart) { s in SmartAlbumEditor(album: s) { smart.save($0) } }
        .overlay {
            if folderID != nil, visible(sort).isEmpty {
                ContentUnavailableView("Ordner ist leer", systemImage: "folder",
                                       description: Text("Alben lange drücken → „In Ordner bewegen“."))
            }
        }
        .alert(naming?.id == nil ? "Neuer Ordner" : "Ordner umbenennen",
               isPresented: Binding(get: { naming != nil }, set: { if !$0 { naming = nil } })) {
            TextField("Name", text: Binding(get: { naming?.name ?? "" }, set: { naming?.name = $0 }))
            Button("Abbrechen", role: .cancel) {}
            Button("Sichern") {
                guard let n = naming else { return }
                let name = n.name.trimmingCharacters(in: .whitespaces)
                guard !name.isEmpty else { return }
                if let id = n.id { folders.rename(id, name) } else { _ = folders.create(name) }
            }
        }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button(String(localized: "Neues Album"), systemImage: "plus") { newAlbum = true }
                    if folderID == nil {
                        Button("Neuer Ordner", systemImage: "folder.badge.plus") { naming = (nil, "") }
                        Button(String(localized: "Neues intelligentes Album"), systemImage: "gearshape") { editingSmart = SmartAlbum() }
                    }
                    Picker(String(localized: "Sortieren"), selection: $sortRaw) {
                        ForEach(AlbumSort.allCases) { Text($0.title).tag($0.rawValue) }
                    }
                    .pickerStyle(.menu)
                } label: { Image(systemName: "ellipsis") }
            }
        }
        .sheet(isPresented: $newAlbum) {
            NewAlbumSheet { created in if let folderID { folders.move(created.id, to: folderID) } }
        }
    }

    /// Kachel eines intelligenten Albums (Zahnrad wie in Fotos)
    private func smartTile(_ s: SmartAlbum) -> some View {
        NavigationLink(value: CollectionRoute.smart(s.id)) {
            VStack(alignment: .leading, spacing: 4) {
                RoundedRectangle(cornerRadius: 18, style: .continuous).fill(Color.appFill)
                    .aspectRatio(1, contentMode: .fit)
                    .overlay { Image(systemName: "gearshape").font(.system(size: 44)).foregroundStyle(.secondary) }
                Text(s.name).font(.system(size: 16, weight: .semibold)).foregroundStyle(.primary).lineLimit(1)
                Text(String(localized: "Intelligentes Album")).font(.system(size: 14)).foregroundStyle(.secondary)
            }
        }
        .buttonStyle(.plain)
        .contextMenu {
            Button(String(localized: "Regeln bearbeiten"), systemImage: "slider.horizontal.3") { editingSmart = s }
            Button(String(localized: "Intelligentes Album löschen"), systemImage: "trash", role: .destructive) { smart.delete(s.id) }
        }
    }

    /// Ordner-Kachel: bis zu vier Schlüsselfotos der Alben darin
    private func folderTile(_ f: AlbumFolders.Folder) -> some View {
        let covers = model.albums.filter { f.albums.contains($0.id) }.compactMap(\.albumThumbnailAssetId).prefix(4)
        return NavigationLink(value: CollectionRoute.albumFolder(f.id)) {
            VStack(alignment: .leading, spacing: 4) {
                RoundedRectangle(cornerRadius: 18, style: .continuous).fill(Color.appFill)
                    .aspectRatio(1, contentMode: .fit)
                    .overlay {
                        if covers.isEmpty {
                            Image(systemName: "folder").font(.system(size: 44)).foregroundStyle(.secondary)
                        } else {
                            LazyVGrid(columns: [GridItem(.flexible(), spacing: 4), GridItem(.flexible(), spacing: 4)], spacing: 4) {
                                ForEach(Array(covers), id: \.self) { AssetThumb(id: $0).aspectRatio(1, contentMode: .fill)
                                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous)) }
                            }
                            .padding(8)
                        }
                    }
                Label(f.name, systemImage: "folder").font(.system(size: 16, weight: .semibold)).foregroundStyle(.primary).lineLimit(1)
                Text(f.albums.count == 1 ? "1 Album" : "\(f.albums.count) Alben").font(.system(size: 14)).foregroundStyle(.secondary)
            }
        }
        .buttonStyle(.plain)
        .contextMenu {
            Button("Umbenennen", systemImage: "pencil") { naming = (f.id, f.name) }
            Button("Ordner löschen", systemImage: "trash", role: .destructive) {
                folders.delete(f.id)
                app.toast(String(localized: "Ordner gelöscht – die Alben bleiben erhalten"))
            }
        }
    }
}

// MARK: - Neues Album / Fotos auswählen

/// „Neues Album“ wie in Fotos: Schlüsselfoto-Vorschau, „Fotos hinzufügen“, Albumname, „Erstellen“.
struct NewAlbumSheet: View {
    var initial: [String] = []
    var onCreated: (AlbumDTO) -> Void = { _ in }
    @Environment(\.dismiss) private var dismiss
    @Environment(AppModel.self) private var app
    @State private var name = ""
    @State private var ids: [String] = []
    @State private var picker = false
    @FocusState private var focused: Bool

    var body: some View {
        NavigationStack {
            VStack(spacing: 14) {
                Group {
                    if let first = ids.first { AssetThumb(id: first, size: .preview).scaledToFill() }
                    else { Color.appFill2.overlay { Image(systemName: "photo").font(.system(size: 40)).foregroundStyle(.secondary) } }
                }
                .frame(width: 230, height: 230)
                .clipShape(RoundedRectangle(cornerRadius: 26, style: .continuous))
                .overlay(alignment: .bottomTrailing) {
                    if ids.count > 1 {
                        Text("\(ids.count)").font(.system(size: 14, weight: .bold)).foregroundStyle(.white)
                            .padding(.horizontal, 9).frame(height: 26).background(Capsule().fill(.blue)).padding(10)
                    }
                }
                Button(String(localized: "Fotos hinzufügen")) { picker = true }
                    .font(.system(size: 16, weight: .semibold)).foregroundStyle(.blue)
                    .padding(.horizontal, 18).frame(height: 38)
                    .background(Capsule().fill(Color.appFill2))
                    .buttonStyle(.plain)
                TextField(String(localized: "Albumname"), text: $name)
                    .font(.system(size: 20))
                    .padding(.horizontal, 22).frame(height: 62)
                    .background(Capsule().fill(Color.appFill))
                    .focused($focused)
                    .submitLabel(.done)
                    .onSubmit(create)
                    .padding(.top, 30)
                Spacer()
            }
            .padding(.horizontal, 20)
            .padding(.top, 8)
            .navigationTitle(String(localized: "Neues Album"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { dismiss() } label: { Image(systemName: "xmark") }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button(String(localized: "Erstellen"), action: create).buttonStyle(.borderedProminent)
                }
            }
        }
        .onAppear { if ids.isEmpty { ids = initial }; focused = true }
        .sheet(isPresented: $picker) {
            PhotoPicker(exclude: [], preselected: Set(ids)) { ids = $0 }
        }
    }

    private func create() {
        let n = name.trimmingCharacters(in: .whitespaces).isEmpty ? String(localized: "Neues Album") : name.trimmingCharacters(in: .whitespaces)
        let chosen = ids
        Task {
            if let a = try? await ImmichClient.shared.createAlbum(n, chosen) { onCreated(a) }
            AlbumActions.changed()
        }
        app.toast(String(localized: "Album „\(n)“ erstellt"))
        dismiss()
    }
}

/// Fotos aus der Mediathek auswählen (Neuestes unten wie in Fotos), blauer Haken übernimmt.
struct PhotoPicker: View {
    let exclude: Set<String>
    var preselected: Set<String> = []
    let onDone: ([String]) -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(TimelineStore.self) private var timeline
    @State private var chosen: Set<String> = []
    @State private var order: [String] = []

    var body: some View {
        let list = timeline.allLoaded
        NavigationStack {
            ScrollView {
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 2), count: 3), spacing: 2) {
                    ForEach(list) { a in
                        let already = exclude.contains(a.id)
                        Button { toggle(a.id) } label: {
                            GridCell(asset: a, selected: already || chosen.contains(a.id))
                                .opacity(already ? 0.4 : 1)
                        }
                        .buttonStyle(.plain)
                        .disabled(already)
                    }
                }
                .padding(.bottom, 20)
            }
            .defaultScrollAnchor(.bottom)
            .background(Color.appBackground)
            .navigationTitle(chosen.isEmpty ? String(localized: "Objekte auswählen") : chosen.count == 1 ? String(localized: "1 Objekt ausgewählt") : String(localized: "\(chosen.count) Objekte ausgewählt"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { Button { dismiss() } label: { Image(systemName: "xmark") } }
                ToolbarItem(placement: .topBarTrailing) {
                    Button { onDone(order.filter(chosen.contains)); dismiss() } label: { Image(systemName: "checkmark") }
                        .buttonStyle(.borderedProminent)
                        .disabled(chosen.isEmpty)
                }
            }
        }
        .onAppear { chosen = preselected; order = Array(preselected) }
        .task { await timeline.loadAll() }
    }

    private func toggle(_ id: String) {
        if chosen.contains(id) { chosen.remove(id); order.removeAll { $0 == id } }
        else { chosen.insert(id); order.append(id) }
    }
}
