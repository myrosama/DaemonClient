import SwiftUI

/// „Optionen“ fürs Teilen wie in Fotos: was mitgeschickt wird und in welchem Format. Gilt auch fürs nächste Teilen.
struct ShareOptionsSheet: View {
    let ids: [String]
    @Environment(\.dismiss) private var dismiss
    @Environment(AppModel.self) private var app
    @State private var o = ShareOptions.saved

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Label(o.location ? String(localized: "Ort ist enthalten") : String(localized: "Ort nicht enthalten"),
                          systemImage: o.location ? "location.fill" : "location.slash")
                        .foregroundStyle(.secondary)
                }
                Section {
                    Toggle(String(localized: "Ort"), isOn: $o.location)
                    Toggle(String(localized: "Bildunterschriften"), isOn: $o.captions)
                } header: { Text(String(localized: "Einschließen")) }
                Section {
                    Picker(String(localized: "Format"), selection: $o.compatible) {
                        Text(String(localized: "Aktuell")).tag(false)
                        Text(String(localized: "Kompatibelstes")).tag(true)
                    }
                    Toggle(String(localized: "Unbearbeitetes Original"), isOn: $o.unedited)
                } footer: {
                    Text(String(localized: "„Kompatibelstes“ schickt Fotos als JPEG und Videos als H.264, damit sie überall aufgehen."))
                }
            }
            .navigationTitle(String(localized: "Optionen"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(String(localized: "Abbrechen")) { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(String(localized: "Teilen")) {
                        ShareOptions.saved = o
                        dismiss()
                        Task { try? await Task.sleep(for: .milliseconds(400)); await ShareService.share(ids, app: app) }
                    }.bold()
                }
            }
        }
    }
}
