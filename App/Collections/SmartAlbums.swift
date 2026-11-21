import SwiftUI

/// Intelligentes Album wie in Fotos (Mac): Regeln, die der Server filtern kann; alle Bedingungen müssen zutreffen.
/// Gespeichert je Konto auf diesem iPhone, der Inhalt kommt immer frisch vom Server (Metadaten-Suche).
struct SmartAlbum: Codable, Identifiable, Hashable {
    var id = UUID().uuidString
    var name = ""
    var conditions: [Condition] = [Condition()]

    struct Condition: Codable, Hashable, Identifiable {
        var id = UUID().uuidString
        var field: Field = .favorite
        var text = ""
        var number = 30
        var date = Date()
        var date2 = Date()
        var flag = true
    }

    enum Field: String, Codable, CaseIterable {
        case favorite, photo, video, live, lastDays, between, person, city, country, make, model, lens, filename, tag

        var title: String {
            switch self {
            case .favorite: String(localized: "Favorit"); case .photo: String(localized: "Medienart: Foto")
            case .video: String(localized: "Medienart: Video"); case .live: String(localized: "Live Photo")
            case .lastDays: String(localized: "In den letzten … Tagen aufgenommen"); case .between: String(localized: "Aufgenommen zwischen")
            case .person: String(localized: "Person"); case .city: String(localized: "Ort (Stadt)"); case .country: String(localized: "Land")
            case .make: String(localized: "Kamerahersteller"); case .model: String(localized: "Kameramodell"); case .lens: String(localized: "Objektiv")
            case .filename: String(localized: "Dateiname enthält"); case .tag: String(localized: "Schlagwort/Kategorie")
            }
        }
    }

    var filter: [String: Any] {
        var f: [String: Any] = [:]
        let iso = ISO8601DateFormatter()
        for c in conditions {
            switch c.field {
            case .favorite: f["isFavorite"] = ["eq": c.flag]
            case .photo: f["type"] = ["eq": "IMAGE"]
            case .video: f["type"] = ["eq": "VIDEO"]
            case .live: f["isMotion"] = ["eq": c.flag]
            case .lastDays: f["takenAt"] = ["gte": iso.string(from: Date().addingTimeInterval(-Double(c.number) * 86400))]
            case .between: f["takenAt"] = ["gte": iso.string(from: Calendar.current.startOfDay(for: c.date)),
                                           "lt": iso.string(from: Calendar.current.startOfDay(for: c.date2).addingTimeInterval(86400))]
            case .person: if !c.text.isEmpty { f["personIds"] = ["all": [c.text]] }
            case .city: if !c.text.isEmpty { f["city"] = ["eq": c.text] }
            case .country: if !c.text.isEmpty { f["country"] = ["eq": c.text] }
            case .make: if !c.text.isEmpty { f["make"] = ["eq": c.text] }
            case .model: if !c.text.isEmpty { f["model"] = ["eq": c.text] }
            case .lens: if !c.text.isEmpty { f["lensModel"] = ["eq": c.text] }
            case .filename: if !c.text.isEmpty { f["originalFileName"] = ["like": "%\(c.text)%"] }
            case .tag: if !c.text.isEmpty { f["tagIds"] = ["any": [c.text]] }
            }
        }
        return f
    }
}

@MainActor @Observable
final class SmartAlbums {
    static let shared = SmartAlbums()
    private(set) var albums: [SmartAlbum] = []
    private var account = ""
    private var key: String { "smartAlbums.\(account)" }

    func use(_ account: String) {
        guard account != self.account else { return }
        self.account = account
        albums = UserDefaults.standard.data(forKey: key).flatMap { try? JSONDecoder().decode([SmartAlbum].self, from: $0) } ?? []
    }
    func album(_ id: String) -> SmartAlbum? { albums.first { $0.id == id } }
    func save(_ a: SmartAlbum) {
        if let i = albums.firstIndex(where: { $0.id == a.id }) { albums[i] = a } else { albums.append(a) }
        UserDefaults.standard.set(try? JSONEncoder().encode(albums), forKey: key)
    }
    func delete(_ id: String) {
        albums.removeAll { $0.id == id }
        UserDefaults.standard.set(try? JSONEncoder().encode(albums), forKey: key)
    }
}

/// Regel-Editor als Bogen (Fotos: „Neues intelligentes Album“).
struct SmartAlbumEditor: View {
    @State var album: SmartAlbum
    let onDone: (SmartAlbum) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var people: [PersonDTO] = []
    @State private var tags: [TagDTO] = []
    @State private var preview: Int?

    var body: some View {
        NavigationStack {
            Form {
                Section { TextField(String(localized: "Name"), text: $album.name) }
                Section {
                    ForEach($album.conditions) { $c in
                        VStack(alignment: .leading, spacing: 8) {
                            Picker(String(localized: "Bedingung"), selection: $c.field) {
                                ForEach(SmartAlbum.Field.allCases, id: \.self) { Text($0.title).tag($0) }
                            }
                            value($c)
                        }
                    }
                    .onDelete { album.conditions.remove(atOffsets: $0); if album.conditions.isEmpty { album.conditions = [.init()] } }
                    Button(String(localized: "Bedingung hinzufügen"), systemImage: "plus.circle") { album.conditions.append(.init()) }
                } header: {
                    Text(String(localized: "Alle Bedingungen müssen zutreffen"))
                } footer: {
                    if let preview { Text(preview == 1 ? String(localized: "1 Objekt passt") : String(localized: "\(preview) Objekte passen")) }
                }
            }
            .navigationTitle(String(localized: "Intelligentes Album"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(String(localized: "Abbrechen")) { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(String(localized: "Fertig")) { onDone(album); dismiss() }.bold()
                        .disabled(album.name.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
            .task {
                people = ((try? await ImmichClient.shared.people()) ?? []).filter { !$0.name.isEmpty }
                tags = ((try? await ImmichClient.shared.tags()) ?? []).sorted { Category.displayName(forTag: $0.value) < Category.displayName(forTag: $1.value) }
            }
            .task(id: album.conditions) {
                try? await Task.sleep(for: .milliseconds(400))
                preview = (try? await ImmichClient.shared.search(filter: album.filter, size: 1000))?.count
            }
        }
    }

    @ViewBuilder private func value(_ c: Binding<SmartAlbum.Condition>) -> some View {
        switch c.wrappedValue.field {
        case .favorite, .live:
            Picker(String(localized: "Wert"), selection: c.flag) { Text(String(localized: "Ja")).tag(true); Text(String(localized: "Nein")).tag(false) }
                .pickerStyle(.segmented)
        case .photo, .video: EmptyView()
        case .lastDays:
            Stepper(String(localized: "\(c.wrappedValue.number) Tage"), value: c.number, in: 1...3650, step: c.wrappedValue.number < 30 ? 1 : 30)
        case .between:
            DatePicker(String(localized: "Von"), selection: c.date, displayedComponents: .date)
            DatePicker(String(localized: "Bis"), selection: c.date2, displayedComponents: .date)
        case .person:
            Picker(String(localized: "Person"), selection: c.text) {
                Text(String(localized: "Auswählen …")).tag("")
                ForEach(people) { Text($0.name).tag($0.id) }
            }
        case .tag:
            Picker(String(localized: "Schlagwort"), selection: c.text) {
                Text(String(localized: "Auswählen …")).tag("")
                ForEach(tags, id: \.id) { Text(Category.displayName(forTag: $0.value)).tag($0.id) }
            }
        default:
            TextField(String(localized: "Wert"), text: c.text).textInputAutocapitalization(.never).autocorrectionDisabled()
        }
    }
}
