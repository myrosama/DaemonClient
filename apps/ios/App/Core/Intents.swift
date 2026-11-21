import AppIntents
import Foundation

/// Siri und Kurzbefehle: „Suche in Fotos“ – öffnet die App mit der Suche (wie Apples Fotos-Kurzbefehle).
struct SearchPhotosIntent: AppIntent {
    static let title: LocalizedStringResource = "Fotos suchen"
    static let description = IntentDescription("Durchsucht deine Mediathek auf dem eigenen Server, z. B. nach „Strand 2019“ oder „Belege“.")
    static let openAppWhenRun = true

    @Parameter(title: "Suchbegriff", requestValueDialog: "Wonach soll ich suchen?")
    var query: String

    @MainActor
    func perform() async throws -> some IntentResult {
        NotificationCenter.default.post(name: .openSearch, object: query)
        return .result()
    }
}

struct FotosShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: SearchPhotosIntent(),
                    phrases: ["Suche in \(.applicationName)", "\(.applicationName) durchsuchen", "Fotos suchen in \(.applicationName)"],
                    shortTitle: "Fotos suchen", systemImageName: "magnifyingglass")
    }
}

extension Notification.Name {
    static let openSearch = Notification.Name("openSearch")
}
