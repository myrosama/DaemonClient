import SwiftUI
import AVFoundation
import MapKit
import UniformTypeIdentifiers
import ImageIO

/// Bögen, die von überall aus (Einzelansicht, Auswahl, Kontextmenü) geöffnet werden.
enum ActionSheet: Identifiable {
    case addToAlbum([String])
    case dateTime([Asset])
    case location([Asset])
    case slideshow([Asset])
    case shareLink([String])
    /// Link auf ein ganzes Album (Immich: type ALBUM) – Empfänger sehen auch später hinzugefügte Fotos
    case albumLink(String)
    /// Teilen-Optionen (Ort, Bildunterschriften, Format, Original) und danach teilen
    case shareOptions([String])
    /// Rückfragen wie bei Apple; `done` läuft nach der Aktion (z. B. Einzelansicht weiterblättern).
    case confirmHide([Asset], done: () -> Void)
    case confirmDeleteForever([Asset], done: () -> Void)
    var id: String {
        switch self {
        case .addToAlbum(let i): "album\(i)"
        case .dateTime(let a): "date\(a.map(\.id))"
        case .location(let a): "loc\(a.map(\.id))"
        case .slideshow(let a): "show\(a.map(\.id))"
        case .shareLink(let i): "link\(i)"
        case .albumLink(let i): "albumlink\(i)"
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
    // MARK: Datum/Ort kopieren und einsetzen (wie Fotos „Datum & Uhrzeit kopieren“)
    static var copiedDate: Date?
    static var copiedLocation: (lat: Double, lon: Double)?

    static func copyDate(_ a: Asset, app: AppModel) {
        copiedDate = a.date
        app.toast(String(localized: "Datum & Uhrzeit kopiert"))
    }
    static func pasteDate(_ assets: [Asset], app: AppModel, timeline: TimelineStore) async {
        guard let d = copiedDate else { return }
        let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.timeZone = DateParsing.utc
        f.dateFormat = "yyyy-MM-dd'T'HH:mm:ss"
        let api = ImmichClient.shared
        for a in assets { try? await api.raw("assets/\(a.id)", method: "PUT", body: api.json(["dateTimeOriginal": f.string(from: d)])) }
        app.toast(assets.count == 1 ? String(localized: "Datum & Uhrzeit eingesetzt") : String(localized: "Datum & Uhrzeit für \(assets.count) Objekte eingesetzt"))
        try? await Task.sleep(for: .seconds(2))   // Server liest Metadaten neu ein
        await timeline.reload()
    }
    static func copyLocation(_ a: Asset, app: AppModel) async {
        guard let e = try? await ImmichClient.shared.asset(a.id).exifInfo, let lat = e.latitude, let lon = e.longitude else {
            app.toast(String(localized: "Dieses Foto hat keinen Ort")); return
        }
        copiedLocation = (lat, lon)
        app.toast(String(localized: "Ort kopiert"))
    }
    static func pasteLocation(_ assets: [Asset], app: AppModel, timeline: TimelineStore) async {
        guard let l = copiedLocation else { return }
        try? await ImmichClient.shared.update(assets.map(\.id), ["latitude": l.lat, "longitude": l.lon])
        app.toast(assets.count == 1 ? String(localized: "Ort eingesetzt") : String(localized: "Ort für \(assets.count) Objekte eingesetzt"))
        try? await Task.sleep(for: .seconds(2))
        await timeline.reload()
    }

    // MARK: Stapeln (z. B. RAW + JPEG): das erste Objekt bleibt sichtbar, die anderen liegen darunter
    static func stack(_ assets: [Asset], app: AppModel, timeline: TimelineStore) async {
        guard assets.count > 1 else { return }
        do {
            try await ImmichClient.shared.createStack(assets.sorted { $0.date < $1.date }.map(\.id))
            app.toast(String(localized: "\(assets.count) Objekte gestapelt"))
            await timeline.reload()
        } catch { app.toast(String(localized: "Stapeln fehlgeschlagen")) }
    }
    static func unstack(_ a: Asset, app: AppModel, timeline: TimelineStore) async {
        guard let s = try? await ImmichClient.shared.asset(a.id).stack else { app.toast(String(localized: "Dieses Foto ist nicht gestapelt")); return }
        do {
            try await ImmichClient.shared.deleteStack(s.id)
            app.toast(String(localized: "Stapel aufgelöst"))
            await timeline.reload()
        } catch { app.toast(String(localized: "Stapel konnte nicht aufgelöst werden")) }
    }

    // MARK: Videobild / Live-Video als eigenes Objekt sichern (Datum und Ort vom Original)
    static func saveVideoFrame(_ a: Asset, at seconds: Double, app: AppModel, timeline: TimelineStore) async {
        guard let url = ImmichClient.shared.originalURL(a.id, edited: true) else { return }
        app.busy = String(localized: "Wird gesichert …")
        defer { app.busy = nil }
        do {
            let api = ImmichClient.shared
            let data = try await api.data(url)
            let file = FileManager.default.temporaryDirectory.appendingPathComponent("frame-\(UUID().uuidString).mov")
            try data.write(to: file); defer { try? FileManager.default.removeItem(at: file) }
            let gen = AVAssetImageGenerator(asset: AVURLAsset(url: file))
            gen.appliesPreferredTrackTransform = true
            gen.requestedTimeToleranceBefore = .zero; gen.requestedTimeToleranceAfter = .zero
            let cg = try await gen.image(at: CMTime(seconds: seconds, preferredTimescale: 600)).image
            guard let jpeg = UIImage(cgImage: cg).jpegData(compressionQuality: 0.95) else { return }
            let dto = try await api.asset(a.id)
            let base = ((dto.originalFileName ?? "VIDEO") as NSString).deletingPathExtension
            let id = try await api.upload(jpeg, filename: base + "_bild.jpg", created: dto.fileCreatedAt)
            await copyPlace(from: dto, to: id)
            app.toast(String(localized: "Videobild als Foto gesichert"))
            await timeline.reload()
        } catch { app.toast(String(localized: "Videobild konnte nicht gesichert werden")) }
    }
    static func saveLiveAsVideo(_ a: Asset, app: AppModel, timeline: TimelineStore) async {
        guard let vid = a.livePhotoVideoId, let url = ImmichClient.shared.originalURL(vid, edited: false) else { return }
        app.busy = String(localized: "Wird gesichert …")
        defer { app.busy = nil }
        do {
            let api = ImmichClient.shared
            let data = try await api.data(url)
            let dto = try await api.asset(a.id)
            let base = ((dto.originalFileName ?? "LIVE") as NSString).deletingPathExtension
            let id = try await api.upload(data, filename: base + "_video.mov", created: dto.fileCreatedAt, mime: "video/quicktime")
            await copyPlace(from: dto, to: id)
            app.toast(String(localized: "Als Video gesichert"))
            await timeline.reload()
        } catch { app.toast(String(localized: "Video konnte nicht gesichert werden")) }
    }
    /// Ort vom Original übernehmen (das neue Objekt hat sonst keinen)
    private static func copyPlace(from dto: AssetDTO, to id: String) async {
        if let lat = dto.exifInfo?.latitude, let lon = dto.exifInfo?.longitude {
            try? await ImmichClient.shared.update([id], ["latitude": lat, "longitude": lon])
        }
    }

    /// „Kopieren“ – Bild in die Zwischenablage (zum Einsetzen in Nachrichten, Notizen …).
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
        info.jobName = images.count == 1 ? "Foto" : "\(images.count) Fotos"
        pc.printInfo = info
        pc.printingItems = images
        pc.present(animated: true)
    }

    /// „Duplizieren“ – echte zweite Datei. Der Server erkennt gleiche Dateien an der Prüfsumme,
    /// deshalb wird das Foto neu gespeichert (gleiche Metadaten, andere Bytes).
    static func duplicate(_ assets: [Asset], app: AppModel, timeline: TimelineStore) async {
        let api = ImmichClient.shared
        var n = 0
        for (i, a) in assets.enumerated() where a.isImage {
            app.busy = String(localized: "Wird dupliziert … \(i + 1) von \(assets.count)")
            guard let url = api.originalURL(a.id, edited: true), let data = try? await api.data(url),
                  let dto = try? await api.asset(a.id), let copy = reencode(data) else { continue }
            let name = ((dto.originalFileName ?? "IMG") as NSString).deletingPathExtension + "_kopie.jpg"
            if let id = try? await api.upload(copy, filename: name, created: dto.fileCreatedAt) {
                try? await api.raw("assets/copy", method: "PUT",
                                   body: api.json(["sourceId": a.id, "targetId": id, "albums": true, "favorite": true] as [String: Any]))
                n += 1
            }
        }
        app.busy = nil
        app.toast(n == 0 ? String(localized: "Videos können nicht dupliziert werden") : String(localized: "\(n) dupliziert"))
        await timeline.reload()
    }

    private static func reencode(_ data: Data) -> Data? {
        guard let src = CGImageSourceCreateWithData(data as CFData, nil),
              let img = CGImageSourceCreateImageAtIndex(src, 0, nil) else { return nil }
        var props = (CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any]) ?? [:]
        props[kCGImageDestinationLossyCompressionQuality] = 0.95
        let out = NSMutableData()
        guard let dst = CGImageDestinationCreateWithData(out, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(dst, img, props as CFDictionary)
        return CGImageDestinationFinalize(dst) ? out as Data : nil
    }

    /// „Link teilen“: öffnet den Bogen mit den Link-Optionen (Passwort, Ablauf, Herunterladen … wie in Immich).
    static func shareLink(_ ids: [String], app: AppModel) async {
        app.sheet = .shareLink(ids)
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

    static func restore(_ ids: [String], app: AppModel, timeline: TimelineStore) {
        app.toast(ids.count == 1 ? String(localized: "Wiederhergestellt") : String(localized: "\(ids.count) wiederhergestellt"))
        Task {
            try? await ImmichClient.shared.restore(ids)
            await timeline.reload()
        }
    }

    static func deleteForever(_ ids: [String], app: AppModel) {
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

    static func delete(_ ids: [String], timeline: TimelineStore) {
        ids.forEach(timeline.remove)
        Task { try? await ImmichClient.shared.trash(ids) }
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
struct DateTimeSheet: View {
    let assets: [Asset]
    @Environment(\.dismiss) private var dismiss
    @Environment(TimelineStore.self) private var timeline
    @State private var date = Date()

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(String(localized: "Original")).font(.footnote).foregroundStyle(.secondary)
                        Text(Fmt.fullDate.string(from: assets.first?.date ?? Date()) + " " + Fmt.time.string(from: assets.first?.date ?? Date()))
                        if assets.count > 1 {
                            Text(String(localized: "Alle \(assets.count) Objekte werden um denselben Abstand verschoben.")).font(.footnote).foregroundStyle(.secondary)
                        }
                    }
                }
                Section {
                    DatePicker(String(localized: "Datum"), selection: $date).datePickerStyle(.graphical)
                        .environment(\.timeZone, DateParsing.utc)
                }
            }
            .navigationTitle(String(localized: "Datum & Uhrzeit anpassen"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { Button(String(localized: "Abbrechen")) { dismiss() } }
                ToolbarItem(placement: .topBarTrailing) { Button(String(localized: "Anpassen")) { save() }.bold() }
            }
        }
        .onAppear { date = assets.first?.date ?? Date() }
    }

    private func save() {
        guard let first = assets.first else { return }
        let api = ImmichClient.shared
        let minutes = Int((date.timeIntervalSince(first.date) / 60).rounded())
        Task {
            if assets.count == 1 {
                // Wanduhrzeit ohne Zone → Server rechnet mit der bisherigen Zeitzone des Fotos
                let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.timeZone = DateParsing.utc
                f.dateFormat = "yyyy-MM-dd'T'HH:mm:ss"
                try? await api.raw("assets/\(first.id)", method: "PUT", body: api.json(["dateTimeOriginal": f.string(from: date)]))
            } else if minutes != 0 {
                try? await api.update(assets.map(\.id), ["dateTimeRelative": minutes])
            }
            try? await Task.sleep(for: .seconds(2))   // Server liest Metadaten neu ein
            await timeline.reload()
        }
        dismiss()
    }
}

/// „Ort anpassen“ – Ort suchen oder auf der Karte wählen, „Kein Ort“ entfernt ihn.
struct LocationSheet: View {
    let assets: [Asset]
    @Environment(\.dismiss) private var dismiss
    @Environment(TimelineStore.self) private var timeline
    @State private var query = ""
    @State private var results: [MKMapItem] = []
    @State private var position: MapCameraPosition = .automatic
    @State private var picked: CLLocationCoordinate2D?
    @State private var pickedName = ""

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                MapReader { proxy in
                    Map(position: $position) {
                        if let picked { Marker(pickedName.isEmpty ? String(localized: "Ort") : pickedName, coordinate: picked) }
                    }
                    .onTapGesture { p in
                        if let c = proxy.convert(p, from: .local) { picked = c; pickedName = "" }
                    }
                }
                .frame(height: 260)
                List {
                    if query.isEmpty {
                        Button(String(localized: "Kein Ort"), systemImage: "location.slash", role: .destructive) { save(nil) }
                    }
                    ForEach(results, id: \.self) { item in
                        Button { save(item.location.coordinate) } label: {
                            VStack(alignment: .leading) {
                                Text(item.name ?? "").foregroundStyle(.primary)
                                if let a = item.address?.shortAddress { Text(a).font(.footnote).foregroundStyle(.secondary) }
                            }
                        }
                    }
                }
                .listStyle(.plain)
            }
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: String(localized: "Ort suchen"))
            .task(id: query) {
                guard query.count > 1 else { results = []; return }
                try? await Task.sleep(for: .milliseconds(250))
                let r = MKLocalSearch.Request(); r.naturalLanguageQuery = query
                results = (try? await MKLocalSearch(request: r).start().mapItems) ?? []
            }
            .navigationTitle(String(localized: "Ort anpassen"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { Button(String(localized: "Abbrechen")) { dismiss() } }
                ToolbarItem(placement: .topBarTrailing) { Button(String(localized: "Fertig")) { save(picked) }.bold().disabled(picked == nil) }
            }
        }
    }

    private func save(_ c: CLLocationCoordinate2D?) {
        // Immich kennt kein „Ort löschen“ – 0/0 wird beim Einlesen als „kein Ort“ behandelt
        let lat = c?.latitude ?? 0, lon = c?.longitude ?? 0
        Task {
            try? await ImmichClient.shared.update(assets.map(\.id), ["latitude": lat, "longitude": lon])
            try? await Task.sleep(for: .seconds(2))
            await timeline.reload()
        }
        dismiss()
    }
}

/// Diashow im Vollbild: Überblendung, langsamer Zoom, Tippen pausiert.
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
    private var inTrash: Bool { !assets.isEmpty && assets.allSatisfy { $0.trashedAt != nil } }
    private var allHidden: Bool { !assets.isEmpty && assets.allSatisfy(\.isHidden) }

    var body: some View {
        if inTrash { trashMenu } else { normalMenu }
    }

    /// In „Zuletzt gelöscht“ gibt es wie bei Apple nur Wiederherstellen und endgültiges Löschen.
    @ViewBuilder private var trashMenu: some View {
        Button(String(localized: "Wiederherstellen"), systemImage: "arrow.uturn.backward.circle") {
            AssetActions.restore(ids, app: app, timeline: timeline); onDelete()
        }
        Button(String(localized: "Löschen"), systemImage: "trash", role: .destructive) {
            present(.confirmDeleteForever(assets, done: onDelete))
        }
    }

    @ViewBuilder private var normalMenu: some View {
        switch style {
        case .context:
            ControlGroup {
                Button(String(localized: "Teilen"), systemImage: "square.and.arrow.up") { Task { await ShareService.share(ids, app: app) } }
                favButton
                Button(String(localized: "Löschen"), systemImage: "trash", role: .destructive) { AssetActions.delete(ids, timeline: timeline); onDelete() }
            }
            .controlGroupStyle(.menu)
            common
            albumButton
        case .selection:
            ControlGroup {
                Button(String(localized: "Diashow"), systemImage: "play.rectangle") { present(.slideshow(assets)) }
                favButton
                Button(String(localized: "Löschen"), systemImage: "trash", role: .destructive) { AssetActions.delete(ids, timeline: timeline); onDelete() }
            }
            .controlGroupStyle(.menu)
            common
            Section { albumButton; memoryButton }
            Section { dateButtons }
        case .viewer:
            common
            Button(String(localized: "Diashow"), systemImage: "play.rectangle") { present(.slideshow(assets)) }
            Section { albumButton }
            Section { dateButtons }
            Section {
                Button(String(localized: "Löschen"), systemImage: "trash", role: .destructive) { AssetActions.delete(ids, timeline: timeline); onDelete() }
            }
        }
    }

    /// Eigener Rückblick aus den ausgewählten Fotos (GitHub #55): Titel = häufigster Ort, sonst „Mein Rückblick“;
    /// spielt gleich ab und lässt sich im Rückblick umbenennen.
    @ViewBuilder private var memoryButton: some View {
        let photos = assets.filter(\.isImage)
        if photos.count >= 3 {
            Button(String(localized: "Rückblick erstellen"), systemImage: "sparkles") {
                let cities = Dictionary(grouping: photos.compactMap(\.city), by: { $0 })
                let title = cities.max { $0.value.count < $1.value.count }?.key ?? String(localized: "Mein Rückblick")
                guard let m = MemoryCenter.shared.addCustom(title: title, assets: photos) else { return }
                onDelete()
                Task { try? await Task.sleep(for: .milliseconds(300)); app.memory = m }
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
        if style != .context {
            Button(String(localized: "Link teilen (Heimnetz/VPN)"), systemImage: "link") { present(.shareLink(ids)) }
        }
        Button(String(localized: "Duplizieren"), systemImage: "plus.square.on.square") { Task { await AssetActions.duplicate(assets, app: app, timeline: timeline) } }
        if style != .context, assets.contains(where: \.isImage) {
            Button("Drucken", systemImage: "printer") { Task { await AssetActions.print(assets, app: app) } }
        }
        // wie Fotos: Bearbeitungen eines Fotos auf andere übertragen
        if assets.count == 1, let a = assets.first, a.isImage, style != .selection {
            Button("Bearbeitungen kopieren", systemImage: "slider.horizontal.below.square.and.square.filled") {
                Task { await EditClipboard.copy(from: a, app: app) }
            }
        }
        if EditClipboard.hasEdits, assets.contains(where: \.isImage) {
            Button("Bearbeitungen einsetzen", systemImage: "doc.on.clipboard") {
                Task { await EditClipboard.paste(on: assets, app: app, timeline: timeline) }
            }
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

    @ViewBuilder private var dateButtons: some View {
        Button(String(localized: "Datum/Uhrzeit"), systemImage: "calendar.badge.clock") { present(.dateTime(assets)) }
        Button(String(localized: "Ort anpassen"), systemImage: "mappin.circle") { present(.location(assets)) }
        Menu(String(localized: "Kopieren & Einsetzen"), systemImage: "doc.on.clipboard") {
            if assets.count == 1, let a = assets.first {
                Button(String(localized: "Datum & Uhrzeit kopieren"), systemImage: "calendar") { AssetActions.copyDate(a, app: app) }
                Button(String(localized: "Ort kopieren"), systemImage: "mappin") { Task { await AssetActions.copyLocation(a, app: app) } }
            }
            if AssetActions.copiedDate != nil {
                Button(String(localized: "Datum & Uhrzeit einsetzen"), systemImage: "calendar.badge.plus") {
                    Task { await AssetActions.pasteDate(assets, app: app, timeline: timeline) }
                }
            }
            if AssetActions.copiedLocation != nil {
                Button(String(localized: "Ort einsetzen"), systemImage: "mappin.and.ellipse") {
                    Task { await AssetActions.pasteLocation(assets, app: app, timeline: timeline) }
                }
            }
        }
        if assets.count > 1 {
            Button(String(localized: "Stapeln"), systemImage: "square.stack.3d.down.right") {
                let chosen = assets
                onDelete()   // Auswahl beenden – die Nebenbilder verschwinden ohnehin aus dem Raster
                Task { await AssetActions.stack(chosen, app: app, timeline: timeline) }
            }
        } else if style == .viewer, let a = assets.first {
            Button(String(localized: "Stapel auflösen"), systemImage: "square.stack.3d.up.slash") { Task { await AssetActions.unstack(a, app: app, timeline: timeline) } }
        }
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
                AssetActions.delete(ids, timeline: timeline); onRemove?()
            },
        ])
        var common: [UIMenuElement] = []
        if app.outsideLibrary, !a.isHidden {
            common.append(UIAction(title: String(localized: "In Mediathek zeigen"), image: img("photo.on.rectangle")) { _ in app.showInLibrary(a.id) })
        }
        common += [
            UIAction(title: String(localized: "Kopieren"), image: img("doc.on.doc")) { _ in Task { await AssetActions.copy([a], app: app) } },
            UIAction(title: String(localized: "Duplizieren"), image: img("plus.square.on.square")) { _ in
                Task { await AssetActions.duplicate([a], app: app, timeline: timeline) }
            },
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
                case .dateTime(let a): DateTimeSheet(assets: a).presentationDetents([.large])
                case .location(let a): LocationSheet(assets: a)
                case .shareLink(let ids): ShareLinkSheet(ids: ids).presentationDetents([.large])
                case .albumLink(let id): ShareLinkSheet(ids: [], album: id).presentationDetents([.large])
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
                    AssetActions.deleteForever(a.map(\.id), app: app); done()
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
