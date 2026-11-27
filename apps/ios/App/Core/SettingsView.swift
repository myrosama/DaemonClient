import SwiftUI
import UIKit

/// Einstellungen der App (Mediathek-Menü → „Einstellungen“, auch im Konto-Menü der Sammlungen).
/// Bisher: Erscheinungsbild – Automatisch (wie das iPhone), Hell oder Dunkel; gilt sofort für die ganze App.
struct SettingsView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme

    /// Was das iPhone selbst vorgibt (Bildschirm-Merkmale, nicht die der App): der Bogen kann ein hängengebliebenes „Dunkel“
    /// tragen, dann stimmte „Gerade: …“ mit der Systemeinstellung nicht überein.
    private var systemIsDark: Bool {
        _ = colorScheme   // neu zeichnen, wenn sich das Erscheinungsbild ändert
        let screen = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first?.screen
        return (screen?.traitCollection.userInterfaceStyle ?? UITraitCollection.current.userInterfaceStyle) == .dark
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(AppTheme.allCases) { t in
                        Button {
                            withAnimation(.snappy) { app.theme = t }
                        } label: {
                            HStack(spacing: 14) {
                                Image(systemName: t.icon).frame(width: 26).foregroundStyle(.tint)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(t.title)
                                    // bei „Automatisch“ zeigen, was das iPhone gerade vorgibt
                                    if t == .auto, app.theme == .auto {
                                        Text(systemIsDark ? String(localized: "Gerade: Dunkel", table: "Theme")
                                                                  : String(localized: "Gerade: Hell", table: "Theme"))
                                            .font(.footnote).foregroundStyle(.secondary)
                                    }
                                }
                                Spacer()
                                if app.theme == t {
                                    Image(systemName: "checkmark").fontWeight(.semibold).foregroundStyle(.tint)
                                }
                            }
                            .contentShape(.rect)
                        }
                        .foregroundStyle(.primary)
                        .accessibilityAddTraits(app.theme == t ? .isSelected : [])
                    }
                } header: {
                    Text(String(localized: "Erscheinungsbild", table: "Theme"))
                } footer: {
                    Text(String(localized: "„Automatisch“ folgt der Einstellung deines iPhones und wechselt mit ihr zwischen Hell und Dunkel. Hell und Dunkel gelten dauerhaft, egal was das iPhone vorgibt.", table: "Theme"))
                }
            }
            .navigationTitle(String(localized: "Einstellungen", table: "Theme"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button(String(localized: "Fertig", table: "Theme")) { dismiss() }.bold()
                }
            }
        }
        .presentationDetents([.medium, .large])
    }
}
