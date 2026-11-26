import SwiftUI
import LocalAuthentication

/// Medienarten und „Sonstige“ wie in Apple Fotos – nur, was der Worker liefern kann (Typ, Favorit, Sichtbarkeit,
/// Datum) oder was das Gerät selbst führt (zuletzt angesehen/geteilt). Die übrigen (aus Server-Tags, KI-Suche,
/// Duplikaten) und „Zuletzt gelöscht“ (der Worker löscht endgültig, SPEC D30) kommen mit dem Kern zurück.
enum Category: String, CaseIterable, Hashable, Identifiable {
    case videos, livePhotos
    case favorites, hidden, recentlySaved, recentlyViewed, recentlyShared, map

    var id: String { rawValue }

    static let mediaTypes: [Category] = [.videos, .livePhotos]
    static let others: [Category] = [.favorites, .hidden, .recentlySaved, .recentlyViewed, .recentlyShared, .map]

    var title: String {
        switch self {
        case .videos: String(localized: "Videos"); case .livePhotos: String(localized: "Live Photos")
        case .favorites: String(localized: "Favoriten"); case .hidden: String(localized: "Ausgeblendet")
        case .recentlySaved: String(localized: "Zuletzt gesichert"); case .recentlyViewed: String(localized: "Zuletzt angesehen")
        case .recentlyShared: String(localized: "Zuletzt geteilt"); case .map: String(localized: "Karte")
        }
    }

    var icon: String {
        switch self {
        case .videos: "video"; case .livePhotos: "livephoto"
        case .favorites: "heart"; case .hidden: "eye.slash"
        case .recentlySaved: "square.and.arrow.down"; case .recentlyViewed: "eye"; case .recentlyShared: "square.and.arrow.up"
        case .map: "map"
        }
    }

    var locked: Bool { self == .hidden }
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

    static func load(_ c: Category, timeline: TimelineStore) async -> [Asset] {
        await timeline.loadAll()
        let all = timeline.allLoaded
        switch c {
        case .videos: return all.filter(\.isVideo)
        case .livePhotos: return all.filter(\.isLivePhoto)
        case .favorites: return all.filter(\.isFavorite)
        // the library holds only what is on the timeline; archived photos come from the worker's own filter
        case .hidden: return (try? await ImmichClient.shared.timelineAssets(["visibility": "archive"])) ?? []
        case .recentlySaved:
            let since = Date().addingTimeInterval(-30 * 86400)
            return all.filter { ($0.addedAt ?? $0.date) >= since }
        case .recentlyViewed, .recentlyShared:
            return RecentStore.ids(c).compactMap { timeline.asset($0) }
        case .map: return []
        }
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
