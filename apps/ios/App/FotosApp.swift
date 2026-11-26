import CoreSpotlight
import Photos
import SwiftUI

@main
struct FotosApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @State private var app = AppModel()
    @State private var timeline = TimelineStore()

    init() {
        BackupEngine.registerBackgroundTask()
        BackgroundUploader.shared.reconnect()   // Ergebnisse von Übertragungen aus früheren Sitzungen abholen
        PerfLog.start()
        Diagnostics.shared.start()   // Hänger-/Absturzberichte von iOS (MetricKit)
        #if DEBUG
        // Simulator-Test „lokale Kopie bevorzugen“: simctl kann vollen Fotozugriff nicht setzen → Systemdialog
        if ProcessInfo.processInfo.environment["FOTOS_TEST_ASK_PHOTOS"] != nil { PHPhotoLibrary.requestAuthorization(for: .readWrite) { _ in } }
        // Simulator-Test „verwaiste Zwischenkopien“: Aufräumen ohne Backup-Lauf auslösen
        if ProcessInfo.processInfo.environment["FOTOS_TEST_SWEEP"] != nil { Task { await BackupEngine.sweepLeftovers() } }
        #endif
    }

    var body: some Scene {
        WindowGroup {
            Group {
                if app.loggedIn { RootView() } else { LoginView() }
            }
            .environment(app)
            .environment(timeline)
            .appTheme(app.theme)
            // The worker refused the session: forget it everywhere, or the next launch restores it again.
            .onReceive(NotificationCenter.default.publisher(for: .sessionExpired)) { _ in
                if app.loggedIn { app.signOut(timeline) }
            }
            // Tippen auf einen Treffer in der iPhone-Suche → wie ein homeroll://-Link
            .onContinueUserActivity(CSSearchableItemActionType) { act in
                if let s = act.userInfo?[CSSearchableItemActivityIdentifier] as? String, let url = URL(string: s) {
                    NotificationCenter.default.post(name: .openFotosURL, object: url)
                }
            }
            .onReceive(NotificationCenter.default.publisher(for: .openSearch)) { n in
                app.pendingQuery = n.object as? String
                app.viewer = nil; app.showSearch = true
            }
        }
    }
}

/// App-Version für Profil-Menü und Backup-Seite (GitHub-Issue #12), z. B. „1.0.10 (11)“
enum AppInfo {
    static var version: String {
        let i = Bundle.main.infoDictionary
        return "\(i?["CFBundleShortVersionString"] as? String ?? "?") (\(i?["CFBundleVersion"] as? String ?? "?"))"
    }
}

enum Tab: Hashable { case library, collections }
enum LibraryScale: String, CaseIterable, Identifiable {
    case years = "Jahre", months = "Monate", all = "Alle"
    var id: String { rawValue }
}

/// Filter/Sortierung der Mediathek – wie das Menü neben „Auswählen“ in Fotos.
enum LibraryFilter: String, CaseIterable, Identifiable {
    case all, favorites, edited, photos, videos, livePhotos, portrait, screenshots, shared, notInAlbum
    var id: String { rawValue }
    var title: String {
        switch self {
        case .all: String(localized: "Alle Objekte"); case .favorites: String(localized: "Favoriten"); case .edited: String(localized: "Bearbeitet"); case .photos: String(localized: "Fotos")
        case .videos: String(localized: "Videos"); case .livePhotos: String(localized: "Live Photos"); case .portrait: String(localized: "Porträt")
        case .screenshots: String(localized: "Bildschirmfotos"); case .shared: String(localized: "Geteilt mit dir"); case .notInAlbum: String(localized: "In keinem Album")
        }
    }
    var icon: String {
        switch self {
        case .all: "square.grid.3x3"; case .favorites: "heart"; case .edited: "slider.horizontal.3"; case .photos: "photo"
        case .videos: "video"; case .livePhotos: "livephoto"; case .portrait: "cube"; case .screenshots: "camera.viewfinder"; case .shared: "person.2"; case .notInAlbum: "rectangle.stack.badge.minus"
        }
    }
}

struct ViewerRequest: Identifiable {
    let id = UUID()
    let assets: [Asset]
    let index: Int
}

@MainActor @Observable
final class AppModel {
    var loggedIn = CoreBridge.restore() || ImmichClient.shared.isLoggedIn
    /// Abmelden (Konto-Menü, oder „Server nicht erreichbar“ in der Mediathek → anderen Server wählen)
    func signOut(_ timeline: TimelineStore) {
        CoreBridge.signOut(); ImmichClient.shared.logout(); timeline.clearCache(); MemoryCenter.shared.reset(); SpotlightIndex.clear(); LocalCopy.reset()
        // alles vom Konto vom Gerät löschen: Offline-Vorschauen, Bild-Speicher (GitHub-Issue #8)
        OfflineSync.shared.stop(); OfflineStore.shared.clear(); ImageCache.shared.purge()
        // Liste heikler Fotos (IDs) des Kontos
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        for f in (try? FileManager.default.contentsOfDirectory(atPath: support.path)) ?? [] where f.hasPrefix("heikel-") {
            try? FileManager.default.removeItem(at: support.appendingPathComponent(f))
        }
        loggedIn = false
    }
    var tab: Tab = .library
    /// Erscheinungsbild: Automatisch (wie das iPhone), Hell oder Dunkel – bleibt gespeichert (Einstellungen)
    var theme = AppTheme.saved { didSet {
        UserDefaults.standard.set(theme.rawValue, forKey: AppTheme.key)
    } }
    /// Einstellungen-Bogen (aus dem Mediathek-Menü und dem Konto-Menü der Sammlungen)
    var showSettings = false
    /// Backup-Fenster (aus der Mediathek-Fußzeile)
    var showBackup = false
    var scale: LibraryScale = .all
    var showSearch = false
    /// Suchbegriff aus Siri/Kurzbefehlen (wird von der Suche übernommen)
    var pendingQuery: String?
    /// Aus Spotlight/Link: diese Sammlung öffnen (CollectionsView übernimmt sie in den Navigationspfad)
    var pendingRoute: CollectionRoute?
    var viewer: ViewerRequest?
    /// Rückblick, der gerade abgespielt wird (Vollbild)
    var memory: Memory?
    /// Ziel für „springe zu“ zwischen Jahre → Monate → Alle (timeBucket-ID).
    var scrollTarget: String?
    /// „In ‚Alle Fotos‘ anzeigen“: Mediathek springt zu diesem Objekt.
    var revealID: String?
    func reveal(_ id: String) {
        endSelection(); scale = .all; tab = .library; revealID = id
    }
    /// „In Mediathek zeigen“ (REA: PXPhotoKitShowInLibraryActionPerformer) aus Einzelansicht, Sammlung oder Suche:
    /// erst Einzelansicht/Suche schließen, dann in der Mediathek hinspringen.
    func showInLibrary(_ id: String) {
        let covered = viewer != nil || showSearch
        viewer = nil; showSearch = false; memory = nil
        if covered { Task { try? await Task.sleep(for: .milliseconds(450)); reveal(id) } } else { reveal(id) }
    }
    /// Gilt das Objekt außerhalb der Mediathek (Sammlung, Suche)? Dann bietet das Menü „In Mediathek zeigen“ an.
    var outsideLibrary: Bool { tab != .library || showSearch }
    var userName = ""
    var userID = ""

    // Mediathek-Menü (bleibt gespeichert)
    var sortByAdded = UserDefaults.standard.bool(forKey: "lib.sortByAdded") { didSet { save() } }
    var filter = LibraryFilter(rawValue: UserDefaults.standard.string(forKey: "lib.filter") ?? "") ?? .all { didSet { save() } }
    var aspectGrid = UserDefaults.standard.bool(forKey: "lib.aspect") { didSet { save() } }
    var autoplay = UserDefaults.standard.object(forKey: "lib.autoplay") as? Bool ?? true { didSet { UserDefaults.standard.set(autoplay, forKey: "lib.autoplay") } }
    /// Einzelansicht: Original (HDR/Gain-Map, volle Auflösung) gleich laden statt nur Immichs SDR-Vorschau (GitHub #36);
    /// aus = Original erst beim Hineinzoomen (spart Daten)
    var alwaysOriginal = UserDefaults.standard.object(forKey: "viewer.alwaysOriginal") as? Bool ?? true { didSet { UserDefaults.standard.set(alwaysOriginal, forKey: "viewer.alwaysOriginal") } }
    var showScreenshots = UserDefaults.standard.object(forKey: "lib.showShots") as? Bool ?? true { didSet { save() } }
    var showShared = UserDefaults.standard.object(forKey: "lib.showShared") as? Bool ?? true { didSet { save() } }
    var columns = GridZoom.normalized(UserDefaults.standard.object(forKey: "lib.columns") as? Int ?? 3) { didSet { save() } }
    var libraryCustomized: Bool { sortByAdded || filter != .all || !showScreenshots || !showShared }
    private func save() {
        let d = UserDefaults.standard
        d.set(sortByAdded, forKey: "lib.sortByAdded"); d.set(filter.rawValue, forKey: "lib.filter"); d.set(aspectGrid, forKey: "lib.aspect")
        d.set(showScreenshots, forKey: "lib.showShots"); d.set(showShared, forKey: "lib.showShared"); d.set(columns, forKey: "lib.columns")
    }

    // Auswahl
    var selecting = false
    var selected: Set<String> = []
    /// Noch nicht gesicherte iPhone-Fotos lassen sich nicht auswählen (Aktionen laufen über den Server)
    func toggle(_ id: String) { guard !id.hasPrefix(LocalPending.prefix) else { return }; if selected.contains(id) { selected.remove(id) } else { selected.insert(id) } }
    func endSelection() { selecting = false; selected = [] }

    /// Kurze Statusanzeige (z. B. „Wird vorbereitet …“ beim Teilen).
    var busy: String?
    /// Bogen aus Menüs (Album, Datum, Ort, Diashow)
    var sheet: ActionSheet?
    /// „Ausgeblendet“ / „Zuletzt gelöscht“ entsperrt (bis die App in den Hintergrund geht)
    var privateUnlocked = false
    var toastText: String?
    func toast(_ t: String) {
        withAnimation(.snappy) { toastText = t }
        Task { try? await Task.sleep(for: .seconds(1.8)); withAnimation(.snappy) { if toastText == t { toastText = nil } } }
    }
    /// Untere Leiste in der Mediathek aufgeklappt (Mediathek/Sammlungen wie bei Apple)
    var tabsExpanded = false

    /// Kachel, in die die Einzelansicht beim Schließen zurückzoomt.
    var zoomID = ""

    func open(_ assets: [Asset], at index: Int) {
        guard !assets.isEmpty else { return }
        var i = min(max(index, 0), assets.count - 1)
        zoomID = assets[i].id
        // Einzelansicht baut je Objekt Seite + Vorschauleiste → bei 80 000 Objekten Sekunden zum Auf-/Abbauen.
        // Ein Fenster von 1 000 um das angetippte Foto reicht zum Wischen.
        var list = assets
        if assets.count > 1001 {
            let lo = max(0, i - 500), hi = min(assets.count, lo + 1001)
            list = Array(assets[max(0, hi - 1001)..<hi]); i -= max(0, hi - 1001)
        }
        viewer = ViewerRequest(assets: list, index: i)
    }
}
