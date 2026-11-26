import Combine
import SwiftUI
import AVFoundation
import MapKit
import UniformTypeIdentifiers
import ImageIO

/// Bögen, die von überall aus (Einzelansicht, Auswahl, Kontextmenü) geöffnet werden.
enum ActionSheet: Identifiable {
    case addToAlbum([String])
    case slideshow([Asset])
    /// Teilen-Optionen (Ort, Bildunterschriften, Format, Original) und danach teilen
    case shareOptions([String])
    /// Rückfragen wie bei Apple; `done` läuft nach der Aktion (z. B. Einzelansicht weiterblättern).
    case confirmHide([Asset], done: () -> Void)
    case confirmDeleteForever([Asset], done: () -> Void)
    var id: String {
        switch self {
        case .addToAlbum(let i): "album\(i)"
        case .slideshow(let a): "show\(a.map(\.id))"
        case .shareOptions(let i): "shareopts\(i)"
        case .confirmHide(let a, _): "hide\(a.map(\.id))"
        case .confirmDeleteForever(let a, _): "forever\(a.map(\.id))"
        }
    }
    var isDialog: Bool {
        switch self { case .confirmHide, .confirmDeleteForever: true; default: false }
    }
}

/// Aktionen wie im Fotos-Menü „…“ / Kontextmenü.
@MainActor
enum AssetActions {
    static func copy(_ assets: [Asset], app: AppModel) async {
        let api = ImmichClient.shared
        var items: [[String: Any]] = []
        app.busy = String(localized: "Wird kopiert …")
        for a in assets {
            guard let url = a.isImage ? api.thumbnailURL(a.id, .fullsize) : api.originalURL(a.id),
                  let d = try? await api.data(url) else { continue }
            if a.isImage, let img = UIImage(data: d) { items.append([UTType.jpeg.identifier: img.jpegData(compressionQuality: 0.95) ?? d]) }
            else { items.append([UTType.mpeg4Movie.identifier: d]) }
        }
        UIPasteboard.general.setItems(items)
        app.busy = nil
        app.toast(assets.count == 1 ? String(localized: "Kopiert") : String(localized: "\(assets.count) Objekte kopiert"))
    }

    /// „Drucken“ (REA: PXPhotoKitPrintAssetActionPerformer) – Fotos in voller Größe an AirPrint, Videos nicht.
    static func print(_ assets: [Asset], app: AppModel) async {
        let api = ImmichClient.shared
        let photos = assets.filter(\.isImage)
        guard !photos.isEmpty else { app.toast(String(localized: "Videos lassen sich nicht drucken")); return }
        var images: [UIImage] = []
        for (i, a) in photos.enumerated() {
            app.busy = photos.count == 1 ? String(localized: "Wird vorbereitet …") : String(localized: "Wird vorbereitet … \(i + 1) von \(photos.count)")
            guard let url = api.thumbnailURL(a.id, .fullsize), let d = try? await api.data(url),
                  let img = UIImage(data: d) else { continue }
            images.append(img)
        }
        app.busy = nil
        guard !images.isEmpty else { app.toast(String(localized: "Foto konnte nicht geladen werden")); return }
        let pc = UIPrintInteractionController.shared
        let info = UIPrintInfo.printInfo()
        info.outputType = .photo
        info.jobName = images.count == 1 ? String(localized: "Foto") : String(localized: "\(images.count) Fotos")
        pc.printInfo = info
        pc.printingItems = images
        pc.present(animated: true)
    }

    static func hide(_ ids: [String], app: AppModel, timeline: TimelineStore) {
        ids.forEach(timeline.remove)
        Task { try? await ImmichClient.shared.update(ids, ["visibility": "archive"]) }
        app.toast(ids.count == 1 ? String(localized: "Ausgeblendet") : String(localized: "\(ids.count) ausgeblendet"))
    }

    static func unhide(_ ids: [String], app: AppModel, timeline: TimelineStore) {
        app.toast(ids.count == 1 ? String(localized: "Eingeblendet") : String(localized: "\(ids.count) eingeblendet"))
        Task {
            try? await ImmichClient.shared.update(ids, ["visibility": "timeline"])
            await timeline.reload()
        }
    }

    /// Endgültig: der Worker hat noch keinen Papierkorb (SPEC D30, CONTRACT_V2 §5b) – nur nach der Rückfrage.
    static func deleteForever(_ ids: [String], app: AppModel, timeline: TimelineStore) {
        ids.forEach(timeline.remove)
        Task { try? await ImmichClient.shared.deleteForever(ids) }
        app.toast(ids.count == 1 ? String(localized: "Endgültig gelöscht") : String(localized: "\(ids.count) endgültig gelöscht"))
    }

    /// „Foto“, „2 Fotos“, „Video“, „3 Objekte“ – für Rückfragen.
    static func noun(_ assets: [Asset]) -> String {
        let n = assets.count
        if assets.allSatisfy(\.isImage) { return n == 1 ? String(localized: "Foto") : String(localized: "\(n) Fotos") }
        if assets.allSatisfy(\.isVideo) { return n == 1 ? String(localized: "Video") : String(localized: "\(n) Videos") }
        return n == 1 ? String(localized: "Objekt") : String(localized: "\(n) Objekte")
    }
    /// Ganze Sätze je Sprache (Bausteine wie „Diese“ + „Fotos“ + „werden“ lassen sich nicht übersetzen)
    static func hideQuestion(_ assets: [Asset]) -> String {
        let n = assets.count
        if assets.allSatisfy(\.isImage) {
            return n == 1 ? String(localized: "Dieses Foto wird ausgeblendet, ist aber weiterhin im Album „Ausgeblendet“ zu sehen.")
                          : String(localized: "Diese \(n) Fotos werden ausgeblendet, sind aber weiterhin im Album „Ausgeblendet“ zu sehen.")
        }
        if assets.allSatisfy(\.isVideo) {
            return n == 1 ? String(localized: "Dieses Video wird ausgeblendet, ist aber weiterhin im Album „Ausgeblendet“ zu sehen.")
                          : String(localized: "Diese \(n) Videos werden ausgeblendet, sind aber weiterhin im Album „Ausgeblendet“ zu sehen.")
        }
        return n == 1 ? String(localized: "Dieses Objekt wird ausgeblendet, ist aber weiterhin im Album „Ausgeblendet“ zu sehen.")
                      : String(localized: "Diese \(n) Objekte werden ausgeblendet, sind aber weiterhin im Album „Ausgeblendet“ zu sehen.")
    }

    static func setFavorite(_ assets: [Asset], _ on: Bool, timeline: TimelineStore) {
        for var a in assets { a.isFavorite = on; timeline.update(a) }
        Task { try? await ImmichClient.shared.update(assets.map(\.id), ["isFavorite": on]) }
    }

}

// MARK: - Bögen

struct AddToAlbumSheet: View {
    let ids: [String]
    @Environment(\.dismiss) private var dismiss
    @Environment(AppModel.self) private var app
    @State private var albums: [AlbumDTO] = []
    @State private var askName = false
    @State private var created = false

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVGrid(columns: [GridItem(.flexible(), spacing: 14), GridItem(.flexible(), spacing: 14)], spacing: 18) {
                    Button { askName = true } label: {
                        VStack(alignment: .leading, spacing: 6) {
                            RoundedRectangle(cornerRadius: 16, style: .continuous).fill(Color.appFill2)
                                .aspectRatio(1, contentMode: .fit)
                                .overlay { Image(systemName: "plus").font(.system(size: 34, weight: .medium)).foregroundStyle(.blue) }
                            Text(String(localized: "Neues Album …")).font(.system(size: 15, weight: .semibold))
                            Text(" ").font(.system(size: 13))
                        }
                    }
                    ForEach(albums) { a in
                        Button { add(a.id) } label: {
                            VStack(alignment: .leading, spacing: 6) {
                                Group { if let t = a.albumThumbnailAssetId { AssetThumb(id: t, size: .preview) } else { Color.appFill2 } }
                                    .aspectRatio(1, contentMode: .fit)
                                    .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                                Text(a.albumName).font(.system(size: 15, weight: .semibold)).lineLimit(1)
                                Text("\(a.assetCount)").font(.system(size: 13)).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
                .buttonStyle(.plain)
                .padding(20)
            }
            .navigationTitle(String(localized: "Zum Album hinzufügen"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button(String(localized: "Abbrechen"), role: .cancel) { dismiss() } } }
        }
        .task { albums = AlbumSort.modified.apply((try? await ImmichClient.shared.albums()) ?? []) }
        .sheet(isPresented: $askName, onDismiss: { if created { dismiss() } }) {
            NewAlbumSheet(initial: ids) { _ in created = true }
        }
    }

    private func add(_ album: String) {
        Task { await AlbumActions.add(album, ids) }
        app.toast(String(localized: "Zum Album hinzugefügt"))
        dismiss()
    }
}

/// „Datum/Uhrzeit anpassen“ – ein Objekt: neues Datum; mehrere: um die Differenz verschieben (wie Apple).
struct SlideshowView: View {
    let assets: [Asset]
    @Environment(\.dismiss) private var dismiss
    @State private var index = 0
    @State private var zoom = false
    @State private var paused = false
    private let timer = Timer.publish(every: 3, on: .main, in: .common).autoconnect()

    var body: some View {
        let photos = assets.filter(\.isImage)
        ZStack {
            Color.black.ignoresSafeArea()
            if !photos.isEmpty {
                AssetThumb(id: photos[index % photos.count].id, size: .preview)
                    .aspectRatio(photos[index % photos.count].ratio, contentMode: .fit)
                    .scaleEffect(zoom ? 1.08 : 1)
                    .animation(.linear(duration: 3), value: zoom)
                    .id(index)
                    .transition(.opacity)
            }
            if paused {
                VStack {
                    HStack {
                        Spacer()
                        Button { dismiss() } label: {
                            Image(systemName: "xmark").font(.system(size: 17, weight: .semibold)).foregroundStyle(.white).frame(width: 44, height: 44).contentShape(.rect)
                        }
                        .glassEffect(.regular.interactive(), in: .circle)
                    }
                    Spacer()
                    Image(systemName: "play.fill").font(.system(size: 22)).foregroundStyle(.white)
                        .frame(width: 60, height: 60).glassEffect(.regular, in: .circle)
                    Spacer()
                }
                .padding(20)
            }
        }
        .contentShape(Rectangle())
        .onTapGesture { withAnimation { paused.toggle() } }
        .statusBarHidden()
        .onAppear { zoom = true }
        .onReceive(timer) { _ in
            guard !paused, photos.count > 1 else { return }
            withAnimation(.easeInOut(duration: 0.9)) { index += 1 }
            zoom = false; DispatchQueue.main.async { zoom = true }
        }
    }
}

/// Kurze Bestätigung oben („Kopiert“, „Zum Album hinzugefügt“ …).
struct ToastBadge: View {
    @Environment(AppModel.self) private var app
    var body: some View {
        if let t = app.toastText {
            Text(t).font(.system(size: 15, weight: .semibold)).foregroundStyle(.white)
                .padding(.horizontal, 18).frame(height: 40)
                .glassEffect(.regular.tint(.black.opacity(0.45)), in: .capsule)
                .padding(.top, 8)
                .transition(.move(edge: .top).combined(with: .opacity))
        }
    }
}

/// Menüeinträge wie in Fotos – `style` bestimmt, welche Gruppe oben als Symbolreihe steht.
struct AssetMenu: View {
    enum Style { case context, selection, viewer }
    let assets: [Asset]
    let style: Style
    let present: (ActionSheet) -> Void
    var onDelete: () -> Void = {}
    @Environment(AppModel.self) private var app
    @Environment(TimelineStore.self) private var timeline

    private var ids: [String] { assets.map(\.id) }
    private var allFav: Bool { !assets.isEmpty && assets.allSatisfy(\.isFavorite) }
    private var allHidden: Bool { !assets.isEmpty && assets.allSatisfy(\.isHidden) }

    var body: some View {
        normalMenu
    }

    @ViewBuilder private var normalMenu: some View {
        switch style {
        case .context:
            ControlGroup {
                Button(String(localized: "Teilen"), systemImage: "square.and.arrow.up") { Task { await ShareService.share(ids, app: app) } }
                favButton
                Button(String(localized: "Löschen"), systemImage: "trash", role: .destructive) { present(.confirmDeleteForever(assets, done: onDelete)) }
            }
            .controlGroupStyle(.menu)
            common
            albumButton
        case .selection:
            ControlGroup {
                Button(String(localized: "Diashow"), systemImage: "play.rectangle") { present(.slideshow(assets)) }
                favButton
                Button(String(localized: "Löschen"), systemImage: "trash", role: .destructive) { present(.confirmDeleteForever(assets, done: onDelete)) }
            }
            .controlGroupStyle(.menu)
            common
            Section { albumButton }
        case .viewer:
            common
            Button(String(localized: "Diashow"), systemImage: "play.rectangle") { present(.slideshow(assets)) }
            Section { albumButton }
            Section {
                Button(String(localized: "Löschen"), systemImage: "trash", role: .destructive) { present(.confirmDeleteForever(assets, done: onDelete)) }
            }
        }
    }

    private var favButton: some View {
        Button(allFav ? String(localized: "Kein Favorit") : String(localized: "Favorit"), systemImage: allFav ? "heart.slash" : "heart") {
            AssetActions.setFavorite(assets, !allFav, timeline: timeline)
        }
    }

    @ViewBuilder private var common: some View {
        if assets.count == 1, let a = assets.first, app.outsideLibrary, !a.isHidden {
            Button("In Mediathek zeigen", systemImage: "photo.on.rectangle") { app.showInLibrary(a.id) }
        }
        Button(String(localized: "Kopieren"), systemImage: "doc.on.doc") { Task { await AssetActions.copy(assets, app: app) } }
        if style != .context, assets.contains(where: \.isImage) {
            Button("Drucken", systemImage: "printer") { Task { await AssetActions.print(assets, app: app) } }
        }
        if allHidden {
            Button(String(localized: "Einblenden"), systemImage: "eye") { AssetActions.unhide(ids, app: app, timeline: timeline); onDelete() }
        } else {
            Button(String(localized: "Ausblenden"), systemImage: "eye.slash") { present(.confirmHide(assets, done: onDelete)) }
        }
    }

    private var albumButton: some View {
        Button(String(localized: "Zum Album hinzufügen"), systemImage: "rectangle.stack.badge.plus") { present(.addToAlbum(ids)) }
    }
}

/// Kontextmenü der Mediathek in UIKit – gleiche Einträge wie `AssetMenu` im Stil `.context`
/// (das Raster hat UIKit-Kacheln, ein SwiftUI-`.contextMenu` je Kachel kostete beim Scrollen spürbar).
@MainActor
enum AssetMenuUIKit {
    static func context(_ a: Asset, app: AppModel, timeline: TimelineStore, onRemove: (() -> Void)? = nil) -> UIMenu {
        let ids = [a.id]
        func img(_ n: String) -> UIImage? { UIImage(systemName: n) }
        let top = UIMenu(options: .displayInline, preferredElementSize: .medium, children: [
            UIAction(title: String(localized: "Teilen"), image: img("square.and.arrow.up")) { _ in Task { await ShareService.share(ids, app: app) } },
            UIAction(title: a.isFavorite ? String(localized: "Kein Favorit") : String(localized: "Favorit"), image: img(a.isFavorite ? "heart.slash" : "heart")) { _ in
                AssetActions.setFavorite([a], !a.isFavorite, timeline: timeline)
            },
            UIAction(title: String(localized: "Löschen"), image: img("trash"), attributes: .destructive) { _ in
                app.sheet = .confirmDeleteForever([a], done: { onRemove?() })
            },
        ])
        var common: [UIMenuElement] = []
        if app.outsideLibrary, !a.isHidden {
            common.append(UIAction(title: String(localized: "In Mediathek zeigen"), image: img("photo.on.rectangle")) { _ in app.showInLibrary(a.id) })
        }
        common += [
            UIAction(title: String(localized: "Kopieren"), image: img("doc.on.doc")) { _ in Task { await AssetActions.copy([a], app: app) } },
            UIAction(title: String(localized: "Ausblenden"), image: img("eye.slash")) { _ in app.sheet = .confirmHide([a], done: { onRemove?() }) },
            UIAction(title: String(localized: "Zum Album hinzufügen"), image: img("rectangle.stack.badge.plus")) { _ in app.sheet = .addToAlbum(ids) },
        ]
        return UIMenu(children: [top] + common)
    }
}

extension View {
    /// Zeigt die Bögen aus `AssetMenu` an (Mediathek über AppModel, Einzelansicht mit eigenem Zustand).
    func actionSheets(_ item: Binding<ActionSheet?>) -> some View {
        modifier(ConfirmDialogs(item: item))
            .sheet(item: Binding(get: { if case .slideshow = item.wrappedValue { nil } else if item.wrappedValue?.isDialog == true { nil } else { item.wrappedValue } },
                                 set: { item.wrappedValue = $0 })) { s in
                switch s {
                case .addToAlbum(let ids): AddToAlbumSheet(ids: ids)
                case .shareOptions(let ids): ShareOptionsSheet(ids: ids).presentationDetents([.medium, .large])
                case .slideshow, .confirmHide, .confirmDeleteForever: EmptyView()
                }
            }
            .fullScreenCover(item: Binding(get: { if case .slideshow = item.wrappedValue { item.wrappedValue } else { nil } },
                                           set: { item.wrappedValue = $0 })) { s in
                if case .slideshow(let a) = s { SlideshowView(assets: a).preferredColorScheme(.dark) }
            }
    }
}

/// Wie lange ein gelöschtes Objekt noch in „Zuletzt gelöscht“ bleibt (Server-Einstellung: 30 Tage).
enum TrashDays {
    static let keep = 30
    static func left(_ a: Asset) -> Int {
        guard let t = a.trashedAt else { return keep }
        let gone = Calendar.current.dateComponents([.day], from: t, to: Date()).day ?? 0
        return max(0, keep - gone)
    }
    static func text(_ a: Asset) -> String {
        let d = left(a)
        return d == 1 ? String(localized: "1 Tag") : d == 0 ? String(localized: "Heute") : String(localized: "\(d) Tage")
    }
}

/// Rückfragen vor Ausblenden / endgültigem Löschen (Texte wie in Fotos).
private struct ConfirmDialogs: ViewModifier {
    @Binding var item: ActionSheet?
    @Environment(AppModel.self) private var app
    @Environment(TimelineStore.self) private var timeline

    private var shown: Binding<Bool> {
        Binding(get: { item?.isDialog == true }, set: { if !$0 { item = nil } })
    }

    func body(content: Content) -> some View {
        content.confirmationDialog(title, isPresented: shown, titleVisibility: .visible) {
            switch item {
            case .confirmHide(let a, let done):
                Button(String(localized: "\(AssetActions.noun(a)) ausblenden"), role: .destructive) {
                    AssetActions.hide(a.map(\.id), app: app, timeline: timeline); done()
                }
            case .confirmDeleteForever(let a, let done):
                Button(String(localized: "\(AssetActions.noun(a)) löschen"), role: .destructive) {
                    AssetActions.deleteForever(a.map(\.id), app: app, timeline: timeline); done()
                }
            default: EmptyView()
            }
        }
    }

    private var title: String {
        switch item {
        case .confirmHide(let a, _):
            return AssetActions.hideQuestion(a)
        case .confirmDeleteForever(let a, _):
            return a.count == 1 ? String(localized: "Dieses Objekt wird endgültig gelöscht. Dieser Vorgang kann nicht widerrufen werden.")
                                : String(localized: "Diese \(a.count) Objekte werden endgültig gelöscht. Dieser Vorgang kann nicht widerrufen werden.")
        default: return ""
        }
    }
}
