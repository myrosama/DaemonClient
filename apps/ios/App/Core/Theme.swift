import SwiftUI
import UIKit

/// Erscheinungsbild der App (Mediathek-Menü → Einstellungen → Erscheinungsbild).
/// Automatisch = wie das iPhone (Hell oder Dunkel), sonst fest Hell oder Dunkel. Gilt für die ganze App:
/// Seiten, Leisten, Bögen, Menüs und Systemelemente.
enum AppTheme: String, CaseIterable, Identifiable {
    case auto, light, dark
    var id: String { rawValue }

    var title: String {
        switch self {
        case .auto: String(localized: "Automatisch", table: "Theme")
        case .light: String(localized: "Hell", table: "Theme")
        case .dark: String(localized: "Dunkel", table: "Theme")
        }
    }
    var icon: String {
        switch self { case .auto: "circle.lefthalf.filled"; case .light: "sun.max"; case .dark: "moon" }
    }
    /// nil = dem System folgen
    var scheme: ColorScheme? {
        switch self { case .auto: nil; case .light: .light; case .dark: .dark }
    }
    var uiStyle: UIUserInterfaceStyle {
        switch self { case .auto: .unspecified; case .light: .light; case .dark: .dark }
    }

    static let key = "app.theme"
    /// Standard ist „Automatisch“
    static var saved: AppTheme { AppTheme(rawValue: UserDefaults.standard.string(forKey: key) ?? "") ?? .auto }
}

/// Setzt das Erscheinungsbild zusätzlich auf jedes Fenster der App. `preferredColorScheme(nil)` allein stellt nach
/// „Hell/Dunkel“ nicht zuverlässig wieder auf „dem System folgen“ zurück; so folgen auch Bögen, Menüs, Alerts und
/// UIKit-Teile (Raster, Kontextmenüs) sofort.
@MainActor
enum ThemeApplier {
    static func apply(_ theme: AppTheme, attempt: Int = 0) {
        let windows = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows)
        // beim Start gibt es das Fenster einen Augenblick später
        if windows.isEmpty, attempt < 10 {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { apply(theme, attempt: attempt + 1) }
            return
        }
        for w in windows {
            w.overrideUserInterfaceStyle = theme.uiStyle
            // SwiftUI setzt auf Hosting-Controllern und Bögen eigene Werte; nach „Automatisch“ blieb dort sonst ein
            // altes „Dunkel“ hängen und die App folgte dem System nicht mehr
            var vc = w.rootViewController
            while let c = vc { c.overrideUserInterfaceStyle = theme.uiStyle; vc = c.presentedViewController }
        }
    }
}

extension View {
    /// Erscheinungsbild für die ganze App setzen (an der Wurzel in `FotosApp`).
    func appTheme(_ theme: AppTheme) -> some View {
        preferredColorScheme(theme.scheme)
            .onChange(of: theme, initial: true) { _, t in ThemeApplier.apply(t) }
    }
}

/// Farben, die sich dem Erscheinungsbild anpassen. Ersetzen die früheren festen Werte
/// (`Color.black`, `Color(white: 0.11 … 0.3)`): im Dunkeln praktisch unverändert, im Hellen passende helle Gegenstücke.
extension Color {
    /// Seitenhintergrund: schwarz im Dunkeln, weiß im Hellen
    static let appBackground = Color(uiColor: .systemBackground)
    /// Karten, Platzhalter, Felder (vorher ≈ 0,11 – 0,14)
    static let appFill = Color(uiColor: .systemGray6)
    /// Kapseln, Knöpfe, abgesetzte Flächen (vorher ≈ 0,15 – 0,2)
    static let appFill2 = Color(uiColor: .systemGray5)
    /// Trennlinien, kräftigere Flächen (vorher ≈ 0,3)
    static let appFill3 = Color(uiColor: .systemGray4)
    /// oberer Rand des Anmeldebildschirms: dunkles Marineblau bzw. helles Blau
    static let loginTop = Color(uiColor: UIColor { t in
        t.userInterfaceStyle == .dark ? UIColor(red: 0.05, green: 0.07, blue: 0.16, alpha: 1)
                                      : UIColor(red: 0.86, green: 0.91, blue: 1.0, alpha: 1)
    })
}
