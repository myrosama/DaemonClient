import SwiftUI
import LocalAuthentication

/// Medienarten und „Sonstige“ wie in Apple Fotos. Woher die Zuordnung kommt:
/// - `tag`: Server-Dienst `immich-kategorien` (server/kategorien.py) bzw. später der Backup-Motor der App setzt Tags „Kategorie/<tag>“
/// - sonst: direkt aus Immich (Typ, Favorit, Papierkorb …) oder lokal auf dem Gerät (zuletzt angesehen/geteilt)
enum Category: String, CaseIterable, Hashable, Identifiable {
    case videos, selfies, livePhotos, portrait, panoramas, timelapse, slomo, cinematic, bursts,
         screenshots, screenRecordings, animated, raw, prores
    case favorites, hidden, trash, duplicates, receipts, handwriting, illustrations, qrCodes,
         recentlySaved, recentlyViewed, recentlyEdited, recentlyShared, documents, imports, map, pets, largeVideos

    var id: String { rawValue }

    static let mediaTypes: [Category] = [.videos, .selfies, .livePhotos, .portrait, .panoramas, .timelapse,
                                         .slomo, .cinematic, .bursts, .screenshots, .screenRecordings, .animated, .raw, .prores]
    static let others: [Category] = [.favorites, .pets, .hidden, .trash, .duplicates, .largeVideos, .receipts, .handwriting,
                                     .illustrations, .qrCodes, .recentlySaved, .recentlyViewed, .recentlyEdited,
                                     .recentlyShared, .documents, .imports, .map]

    var title: String {
        switch self {
        case .videos: String(localized: "Videos"); case .selfies: String(localized: "Selfies"); case .livePhotos: String(localized: "Live Photos"); case .portrait: String(localized: "Porträt")
        case .panoramas: String(localized: "Panoramen"); case .timelapse: String(localized: "Zeitraffer"); case .slomo: String(localized: "Slo-Mo"); case .cinematic: String(localized: "Kino")
        case .bursts: String(localized: "Serien"); case .screenshots: String(localized: "Bildschirmfotos"); case .screenRecordings: String(localized: "Bildschirmaufnahmen")
        case .animated: String(localized: "Animiert"); case .raw: "RAW"; case .prores: "ProRes"
        case .favorites: String(localized: "Favoriten"); case .hidden: String(localized: "Ausgeblendet"); case .trash: String(localized: "Zuletzt gelöscht")
        case .duplicates: String(localized: "Duplikate"); case .largeVideos: String(localized: "Große Videos"); case .receipts: String(localized: "Belege"); case .handwriting: String(localized: "Handschrift")
        case .illustrations: String(localized: "Illustrationen"); case .qrCodes: String(localized: "QR-Codes"); case .recentlySaved: String(localized: "Zuletzt gesichert")
        case .recentlyViewed: String(localized: "Zuletzt angesehen"); case .recentlyEdited: String(localized: "Zuletzt bearbeitet")
        case .recentlyShared: String(localized: "Zuletzt geteilt"); case .documents: String(localized: "Dokumente"); case .imports: String(localized: "Importe"); case .map: String(localized: "Karte")
        case .pets: String(localized: "Haustiere")
        }
    }

    var icon: String {
        switch self {
        case .videos: "video"; case .selfies: "person.crop.square"; case .livePhotos: "livephoto"
        case .portrait: "f.cursive.circle"; case .panoramas: "pano"; case .timelapse: "timelapse"
        case .slomo: "slowmo"; case .cinematic: "film"; case .bursts: "square.stack.3d.down.right"
        case .screenshots: "camera.viewfinder"; case .screenRecordings: "record.circle"
        case .animated: "square.stack.3d.forward.dottedline"; case .raw: "r.square.on.square"; case .prores: "p.circle"
        case .favorites: "heart"; case .hidden: "eye.slash"; case .trash: "trash"; case .duplicates: "square.on.square"
        case .receipts: "doc.text"; case .handwriting: "pencil.and.scribble"; case .illustrations: "scribble.variable"
        case .qrCodes: "qrcode"; case .recentlySaved: "square.and.arrow.down"; case .recentlyViewed: "eye"
        case .recentlyEdited: "slider.horizontal.3"; case .recentlyShared: "square.and.arrow.up"
        case .documents: "doc"; case .imports: "square.and.arrow.down.on.square"; case .map: "map"
        case .pets: "pawprint"; case .largeVideos: "externaldrive"
        }
    }

    /// Name des Tags unter „Kategorie/…“ (gleiche Namen setzt später auch die App beim Sichern).
    var tag: String? {
        switch self {
        // feste (deutsche) Namen wie auf dem Server – nicht `title`, das ist übersetzt
        case .selfies: "Selfies"; case .livePhotos: "Live Photos"; case .panoramas: "Panoramen"; case .bursts: "Serien"
        case .screenshots: "Bildschirmfotos"; case .screenRecordings: "Bildschirmaufnahmen"; case .animated: "Animiert"
        case .receipts: "Belege"; case .handwriting: "Handschrift"; case .illustrations: "Illustrationen"; case .documents: "Dokumente"
        case .portrait: "Porträt"; case .timelapse: "Zeitraffer"; case .slomo: "Slo-Mo"; case .cinematic: "Kino"
        case .raw: "RAW"; case .prores: "ProRes"; case .qrCodes: "QR-Codes"; case .imports: "Importe"
        case .recentlyEdited: "Bearbeitet"   // setzt der Editor der App
        default: nil
        }
    }

    var locked: Bool { self == .hidden || self == .trash }

    /// Anhang an den Dateinamen bearbeiteter Fassungen (in der Sprache des iPhones; liest niemand zurück).
    static var editedSuffix: String { String(localized: "_bearbeitet", comment: "Anhang an Dateinamen bearbeiteter Fotos") }

    /// Server-Tag „Kategorie/<Name>“ in der Sprache des iPhones anzeigen (gespeichert bleibt der deutsche Name).
    static func displayName(forTag value: String) -> String {
        let prefix = "Kategorie/"
        guard value.hasPrefix(prefix) else { return value }
        let name = String(value.dropFirst(prefix.count))
        let shown: String
        switch name {
        case "Bearbeitet": shown = String(localized: "Bearbeitet")
        case "Bereinigt": shown = String(localized: "Bereinigt")
        default: shown = allCases.first { $0.tag == name }?.title ?? name
        }
        return String(localized: "Kategorie") + "/" + shown
    }

    /// Suchwörter, mit denen die Suche direkt auf die Kategorie springt.
    var synonyms: [String] {
        switch self {
        case .screenshots: ["screenshot", "screenshots", "bildschirmfoto"]
        case .screenRecordings: ["bildschirmaufnahme", "bildschirmvideo", "screen recording"]
        case .selfies: ["selfie"]; case .videos: ["video", "film", "filme"]; case .panoramas: ["panorama"]
        case .receipts: ["beleg", "quittung", "kassenbon", "kassenzettel", "rechnung"]
        case .documents: ["dokument", "brief", "scan"]; case .qrCodes: ["qr", "qr-code", "qrcode"]
        case .pets: ["haustier", "haustiere", "hund", "hunde", "katze", "katzen"]
        case .favorites: ["favorit", "lieblingsfotos"]; case .livePhotos: ["live photo", "live photos", "livephoto", "livephotos"]
        case .animated: ["gif", "gifs"]; case .portrait: ["portrait", "porträts", "porträtmodus"]
        default: []
        }
    }
}

/// Lokal geführte Listen (Apple führt sie auch nur auf dem Gerät).
enum RecentStore {
    static func ids(_ c: Category) -> [String] { UserDefaults.standard.stringArray(forKey: "recent.\(c.rawValue)") ?? [] }
    static func add(_ id: String, to c: Category) {
        var l = ids(c).filter { $0 != id }
        l.insert(id, at: 0)
        UserDefaults.standard.set(Array(l.prefix(300)), forKey: "recent.\(c.rawValue)")
    }
    /// „Verlauf löschen“ wie bei Apple (nur die Liste, die Fotos bleiben)
    static func clear(_ c: Category) { UserDefaults.standard.removeObject(forKey: "recent.\(c.rawValue)") }
}

/// Lädt die Objekte einer Kategorie.
@MainActor
enum CategoryLoader {
    private static var tagIDs: [String: String] = [:]

    static func load(_ c: Category, timeline: TimelineStore) async -> [Asset] {
        let api = ImmichClient.shared
        func s(_ f: [String: Any], _ size: Int = 5000) async -> [Asset] {
            ((try? await api.search(filter: f, size: size)) ?? []).map(\.asset)
        }
        switch c {
        case .videos: return await s(["type": ["eq": "VIDEO"]])
        case .favorites: return await s(["isFavorite": ["eq": true]])
        case .livePhotos:
            // Server kennt Live Photos über isMotion (auch ohne Tag), dazu was die Zeitleiste schon weiß
            var out = await s(["isMotion": ["eq": true]])
            let have = Set(out.map(\.id))
            out += timeline.allLoaded.filter { $0.isLivePhoto && !have.contains($0.id) }
            return out
        case .hidden: return await s(["visibility": ["eq": "archive"]])
        case .trash: return await s(["trashedAt": ["ne": NSNull()]])
        case .recentlySaved:
            let since = ISO8601DateFormatter().string(from: Date().addingTimeInterval(-30 * 86400))
            return await s(["createdAt": ["gte": since]], 1000)
        case .recentlyViewed, .recentlyShared:
            return RecentStore.ids(c).compactMap { timeline.asset($0) }
        case .duplicates, .map, .largeVideos: return []
        case .pets:
            // Immich erkennt keine Tiere als Personen → KI-Bildsuche + Relevanz-Prüfung (wie Apples „Haustiere“)
            var seen = Set<String>(), out: [Asset] = []
            for q in ["Hund", "Katze", "Haustier"] {
                let found = ((try? await api.smartSearch(q, size: 300)) ?? []).map(\.asset)
                let keep = await api.relevant(q, ids: found.map(\.id))
                for a in found where (keep?.contains(a.id) ?? false) && seen.insert(a.id).inserted { out.append(a) }
            }
            return out.sorted { $0.date < $1.date }
        default:
            guard let tag = c.tag, let id = await tagID(tag) else { return [] }
            var out = await s(["tagIds": ["any": [id]]])
            if c == .livePhotos {   // Live Photos kennt die Zeitleiste auch ohne Tag
                let have = Set(out.map(\.id))
                out += timeline.allLoaded.filter { $0.isLivePhoto && !have.contains($0.id) }
            }
            return out
        }
    }

    static func tagID(_ name: String) async -> String? {
        if tagIDs.isEmpty || tagIDs["Kategorie/\(name)"] == nil {
            for t in (try? await ImmichClient.shared.tags()) ?? [] { tagIDs[t.value] = t.id }
        }
        return tagIDs["Kategorie/\(name)"]
    }
}

/// Kachel wie in Fotos: Symbol + Name, Schloss bei geschützten Alben.
struct CategoryTile: View {
    let category: Category
    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: category.icon).font(.system(size: 18)).frame(width: 24).foregroundStyle(.primary.opacity(0.85))
            Text(category.title).font(.system(size: 19)).lineLimit(1).minimumScaleFactor(0.85)
            Spacer(minLength: 0)
            if category.locked {
                Image(systemName: "lock.fill").font(.system(size: 13)).foregroundStyle(.secondary)
            }
        }
        .foregroundStyle(.primary)
        .padding(.horizontal, 12)
        .frame(width: 256, height: 42)
        .background(RoundedRectangle(cornerRadius: 11, style: .continuous).fill(Color.appFill))
    }
}

/// Seitlich blätterndes Raster mit drei Reihen (Medienarten / Sonstige).
struct CategoryRows: View {
    let items: [Category]
    var body: some View {
        ScrollView(.horizontal) {
            LazyHGrid(rows: Array(repeating: GridItem(.fixed(42), spacing: 7), count: 3), spacing: 12) {
                ForEach(items) { c in
                    NavigationLink(value: CollectionRoute.category(c)) { CategoryTile(category: c) }
                        .buttonStyle(.plain)
                }
            }
            .scrollTargetLayout()
            .padding(.horizontal, 22)
        }
        .scrollTargetBehavior(.viewAligned)
        .scrollIndicators(.hidden)
    }
}

/// Komplette Liste (Tippen auf „Medienarten >“ / „Sonstige >“).
struct CategoryListScreen: View {
    let title: String
    let items: [Category]
    var body: some View {
        List(items) { c in
            NavigationLink(value: CollectionRoute.category(c)) {
                Label { Text(c.title) } icon: { Image(systemName: c.icon) }
                    .badge(c.locked ? Text(Image(systemName: "lock.fill")) : nil)
            }
        }
        .navigationTitle(title)
        .scrollContentBackground(.hidden)
        .background(Color.appBackground)
    }
}

/// Face ID / Code vor „Ausgeblendet“ und „Zuletzt gelöscht“ – wie in Fotos:
/// Sperrseite mit „Album anzeigen“, Face ID startet von selbst, der Code nur auf Knopfdruck.
/// Einmal entsperrt bleiben beide Alben offen, bis die App in den Hintergrund geht.
struct LockGate<Content: View>: View {
    let title: String
    @ViewBuilder let content: () -> Content
    @Environment(AppModel.self) private var app
    @Environment(\.scenePhase) private var phase

    var body: some View {
        if app.privateUnlocked && phase == .active {
            content()
        } else {
            VStack(spacing: 16) {
                Image(systemName: "lock.fill").font(.system(size: 44)).foregroundStyle(.secondary)
                Text(Self.prompt).font(.system(size: 22, weight: .bold)).multilineTextAlignment(.center)
                Button(String(localized: "Album anzeigen")) { Task { await unlock(allowCode: true) } }
                    .font(.system(size: 17)).foregroundStyle(.blue)
            }
            .padding(.horizontal, 44)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Color.appBackground)
            .overlay(alignment: .top) { ScreenHeader(title: title) }
            .toolbar(.hidden, for: .navigationBar)
            .task { await unlock(allowCode: false) }
        }
    }

    static var prompt: String {
        let ctx = LAContext()
        _ = ctx.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil)
        switch ctx.biometryType {
        case .faceID: return String(localized: "Face ID verwenden oder Code eingeben, um dieses Album anzuzeigen")
        case .touchID: return String(localized: "Touch ID verwenden oder Code eingeben, um dieses Album anzuzeigen")
        case .opticID: return String(localized: "Optic ID verwenden oder Code eingeben, um dieses Album anzuzeigen")
        default: return String(localized: "Code eingeben, um dieses Album anzuzeigen")
        }
    }

    /// allowCode = false: nur Face ID (startet beim Öffnen von selbst); „Code eingeben“ darin führt zur Code-Abfrage.
    private func unlock(allowCode: Bool) async {
        guard !app.privateUnlocked, phase == .active else { return }
        let ctx = LAContext()
        ctx.localizedCancelTitle = String(localized: "Abbrechen")
        ctx.localizedFallbackTitle = String(localized: "Code eingeben")
        // Ohne Gerätecode gibt es nichts zu schützen (wie bei Apple).
        guard ctx.canEvaluatePolicy(.deviceOwnerAuthentication, error: nil) else { app.privateUnlocked = true; return }
        let policy: LAPolicy = allowCode ? .deviceOwnerAuthentication : .deviceOwnerAuthenticationWithBiometrics
        guard ctx.canEvaluatePolicy(policy, error: nil) else { return }
        do {
            if try await ctx.evaluatePolicy(policy, localizedReason: String(localized: "Geschützte Alben anzeigen")) {
                withAnimation(.snappy) { app.privateUnlocked = true }
            }
        } catch let e as LAError where e.code == .userFallback {
            await unlock(allowCode: true)
        } catch {}
    }
}

/// Speicher aufräumen wie Apples Speicherverwaltung: die größten Videos zuerst, mit Größe; Löschen geht in
/// „Zuletzt gelöscht“ (30 Tage wiederherstellbar).
struct LargeVideosScreen: View {
    @Environment(AppModel.self) private var app
    @State private var videos: [(Asset, Int)]?
    @State private var loaded = 0

    var body: some View {
        let list = videos ?? []
        ScrollView {
            if !list.isEmpty {
                Text(String(localized: "Zusammen \(ByteCountFormatter.string(fromByteCount: Int64(list.reduce(0) { $0 + $1.1 }), countStyle: .file))"))
                    .font(.subheadline).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 20).padding(.top, 8)
            }
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 2), count: 3), spacing: 2) {
                ForEach(Array(list.enumerated()), id: \.element.0.id) { i, e in
                    Button { app.open(list.map(\.0), at: i) } label: {
                        GridCell(asset: e.0).overlay(alignment: .topLeading) {
                            Text(ByteCountFormatter.string(fromByteCount: Int64(e.1), countStyle: .file))
                                .font(.system(size: 12, weight: .semibold)).foregroundStyle(.white)
                                .padding(.horizontal, 6).padding(.vertical, 3)
                                .background(Capsule().fill(.black.opacity(0.55))).padding(5)
                        }
                    }
                    .buttonStyle(.plain)
                    .assetContextMenu(e.0) { videos?.removeAll { $0.0.id == e.0.id } }
                }
            }
            .padding(.top, 8)
        }
        .overlay {
            if videos == nil { ProgressView(loaded > 0 ? String(localized: "\(loaded) Videos geprüft …") : String(localized: "Videos werden geprüft …")) }
            else if list.isEmpty { ContentUnavailableView(String(localized: "Keine Videos"), systemImage: "video") }
        }
        .navigationTitle(String(localized: "Große Videos"))
        .background(Color.appBackground)
        .task {
            // Immich sortiert nicht nach Größe → alle Videos mit Dateigröße holen (in Seiten), hier sortieren
            let all = (try? await ImmichClient.shared.search(filter: ["type": ["eq": "VIDEO"]], size: 50_000)) ?? []
            loaded = all.count
            videos = all.compactMap { d in d.exifInfo?.fileSizeInByte.map { (d.asset, $0) } }
                .sorted { $0.1 > $1.1 }.prefix(200).map { $0 }
        }
    }
}

/// Duplikate: Gruppen mit „Zusammenführen“ (behält das beste Foto, Rest in „Zuletzt gelöscht“).
struct DuplicatesScreen: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var groups: [DuplicateGroupDTO]?
    @State private var confirm: DuplicateGroupDTO?

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 26) {
                ForEach(groups ?? []) { g in
                    VStack(alignment: .leading, spacing: 10) {
                        HStack {
                            Text(g.assets.first.map { Fmt.dayMonthYear.string(from: $0.asset.date) } ?? "")
                                .font(.system(size: 17, weight: .semibold))
                            Spacer()
                            Button(String(localized: "Zusammenführen")) { confirm = g }
                                .font(.system(size: 15, weight: .semibold))
                                .padding(.horizontal, 14).frame(height: 32)
                                .glassEffect(.regular.interactive(), in: .capsule)
                        }
                        ScrollView(.horizontal) {
                            HStack(spacing: 8) {
                                let list = g.assets.map(\.asset)
                                ForEach(Array(list.enumerated()), id: \.element.id) { i, a in
                                    Button { app.open(list, at: i) } label: {
                                        AssetThumb(id: a.id).frame(width: 110, height: 110)
                                            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                                            .overlay(alignment: .bottomTrailing) {
                                                if g.suggestedKeepAssetIds?.contains(a.id) == true {
                                                    Image(systemName: "checkmark.circle.fill").symbolRenderingMode(.multicolor)
                                                        .font(.system(size: 20)).padding(6)
                                                }
                                            }
                                    }
                                    .buttonStyle(.plain)
                                }
                            }
                        }
                        .scrollIndicators(.hidden)
                    }
                    .padding(.horizontal, 20)
                }
            }
            .padding(.top, 130).padding(.bottom, 110)
        }
        .ignoresSafeArea(edges: .top)
        .background(Color.appBackground)
        .overlay(alignment: .top) { ScreenHeader(title: String(localized: "Duplikate"), subtitle: groups.map { String(localized: "\($0.count) Gruppen") } ?? "") }
        .overlay { if groups?.isEmpty == true { ContentUnavailableView(String(localized: "Keine Duplikate"), systemImage: "square.on.square") } }
        .toolbar(.hidden, for: .navigationBar)
        .task { if groups == nil { groups = (try? await ImmichClient.shared.duplicates()) ?? [] } }
        .confirmationDialog(String(localized: "Duplikate zusammenführen?"), isPresented: .init(get: { confirm != nil }, set: { if !$0 { confirm = nil } }),
                            titleVisibility: .visible) {
            Button(String(localized: "Zusammenführen")) {
                guard let g = confirm else { return }
                let keep = g.suggestedKeepAssetIds?.isEmpty == false ? g.suggestedKeepAssetIds! : [g.assets[0].id]
                Task {
                    try? await ImmichClient.shared.resolveDuplicate(g, keep: keep)
                    groups?.removeAll { $0.id == g.id }
                }
            }
        } message: {
            Text(String(localized: "Das beste Foto bleibt, die anderen kommen in „Zuletzt gelöscht“ (30 Tage wiederherstellbar)."))
        }
    }
}

/// Kopfzeile der Unterseiten: großer Titel + Glas-Schließen-Knopf.
struct ScreenHeader: View {
    let title: String
    var subtitle: String = ""
    /// zusätzlicher Knopf links vom Schließen (z. B. „…“ einer Person)
    var menu: AnyView? = nil
    /// tiefer in einem Stapel (z. B. Ordner in Ordnern): Zurück-Pfeil links statt Schließen-Kreuz (GitHub #46)
    var back = false
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        HStack(alignment: .top) {
            if back {
                Button { dismiss() } label: {
                    Image(systemName: "chevron.left").font(.system(size: 17, weight: .semibold)).frame(width: 44, height: 44).contentShape(.rect)
                }
                .glassEffect(.regular.interactive(), in: .circle)
                .accessibilityLabel(String(localized: "Zurück"))
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.system(size: 30, weight: .bold)).lineLimit(1)
                if !subtitle.isEmpty { Text(subtitle).font(.system(size: 16, weight: .semibold)).opacity(0.8) }
            }
            Spacer()
            if let menu { menu }
            if !back {
                Button { dismiss() } label: {
                    Image(systemName: "xmark").font(.system(size: 17, weight: .semibold)).frame(width: 44, height: 44).contentShape(.rect)
                }
                .glassEffect(.regular.interactive(), in: .circle)
            }
        }
        .foregroundStyle(.primary)
        .padding(.horizontal, 20).padding(.bottom, 28)
        .background(alignment: .top) { TopBlur() }
    }
}
