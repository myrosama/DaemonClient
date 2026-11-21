import SwiftUI

/// Ablaufzeiten wie in Immichs „Link teilen“-Dialog.
enum ShareExpiry: String, CaseIterable, Identifiable {
    case never, min30, hour1, hour6, day1, day7, day30, month3, year1, custom
    var id: String { rawValue }

    var title: String {
        switch self {
        case .never: String(localized: "Läuft nie ab")
        case .min30: String(localized: "Nach 30 Minuten")
        case .hour1: String(localized: "Nach 1 Stunde")
        case .hour6: String(localized: "Nach 6 Stunden")
        case .day1: String(localized: "Nach 1 Tag")
        case .day7: String(localized: "Nach 7 Tagen")
        case .day30: String(localized: "Nach 30 Tagen")
        case .month3: String(localized: "Nach 3 Monaten")
        case .year1: String(localized: "Nach 1 Jahr")
        case .custom: String(localized: "Eigenes Datum …")
        }
    }

    var interval: TimeInterval? {
        switch self {
        case .never, .custom: nil
        case .min30: 30 * 60
        case .hour1: 3600
        case .hour6: 6 * 3600
        case .day1: 86400
        case .day7: 7 * 86400
        case .day30: 30 * 86400
        case .month3: 90 * 86400
        case .year1: 365 * 86400
        }
    }
}

/// Einstellungen eines Freigabelinks (Immich: POST/PATCH /shared-links).
struct ShareLinkOptions {
    var description = ""
    var password = ""
    var removePassword = false
    var expiry: ShareExpiry = .day30
    var customDate = Date().addingTimeInterval(7 * 86400)
    var showMetadata = false
    /// Immich erlaubt Herunterladen nur zusammen mit Metadaten (beim Anlegen erzwungen) → hier genauso
    var allowDownload = false
    var allowUpload = false
    var slug = ""

    var expiresAt: Date? {
        expiry == .custom ? customDate : expiry.interval.map { Date().addingTimeInterval($0) }
    }

    /// URL-tauglicher Linkname (Leerzeichen → „-“).
    var cleanSlug: String {
        slug.trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: " ", with: "-")
            .addingPercentEncoding(withAllowedCharacters: .urlPathAllowed)?
            .replacingOccurrences(of: "/", with: "") ?? ""
    }

    private static let key = "shareLinkOptions"

    /// Zuletzt benutzte Schalter und Ablaufzeit (Beschreibung, Passwort und Name nie).
    static func restored() -> ShareLinkOptions {
        var o = ShareLinkOptions()
        let d = UserDefaults.standard
        if let raw = d.string(forKey: key + ".expiry"), let e = ShareExpiry(rawValue: raw), e != .custom { o.expiry = e }
        if d.object(forKey: key + ".meta") != nil { o.showMetadata = d.bool(forKey: key + ".meta") }
        if d.object(forKey: key + ".download") != nil { o.allowDownload = d.bool(forKey: key + ".download") }
        if !o.showMetadata { o.allowDownload = false }
        return o
    }

    func remember() {
        let d = UserDefaults.standard
        if expiry != .custom { d.set(expiry.rawValue, forKey: Self.key + ".expiry") }
        d.set(showMetadata, forKey: Self.key + ".meta")
        d.set(allowDownload, forKey: Self.key + ".download")
    }
}

enum ShareDates {
    /// Immich schickt Zeiten wie „2026-11-08T20:00:00.000Z“.
    static func parse(_ s: String) -> Date? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.date(from: s) ?? ISO8601DateFormatter().date(from: s)
    }
}

/// Ein vorhandener Freigabelink des Servers (GET /shared-links).
struct SharedLinkDTO: Decodable, Identifiable, Hashable {
    struct Ref: Decodable, Hashable { let id: String }
    let id: String
    let key: String
    let type: String
    let slug: String?
    let description: String?
    let password: String?
    let expiresAt: String?
    let allowUpload: Bool?
    let allowDownload: Bool?
    let showMetadata: Bool?
    let assets: [Ref]?
    let album: Ref?

    var expires: Date? { expiresAt.flatMap(ShareDates.parse) }
    var isActive: Bool { expires.map { $0 > Date() } ?? true }
    var hasPassword: Bool { !(password ?? "").isEmpty }
}

/// Eingabefelder für Link-Optionen – beim Anlegen und beim Bearbeiten gleich.
struct ShareLinkFields: View {
    @Binding var o: ShareLinkOptions
    var editing = false
    var hasPassword = false
    var firstHeader: String? = nil
    /// Album-Link: Empfänger dürfen auch Fotos hinzufügen
    var album = false

    var body: some View {
        Section {
            TextField(String(localized: "Beschreibung des Links (optional)"), text: $o.description, axis: .vertical)
                .lineLimit(1...3)
        } header: {
            if let firstHeader { Text(firstHeader) }
        }
        Section {
            SecureField(editing && hasPassword ? String(localized: "Neues Passwort (leer lassen = unverändert)")
                                               : String(localized: "Passwort für den Link (optional)"), text: $o.password)
                .textContentType(.newPassword)
                .disabled(o.removePassword)
            if editing && hasPassword {
                Toggle(String(localized: "Passwort entfernen"), isOn: $o.removePassword)
            }
        } footer: {
            Text(String(localized: "Wer den Link öffnet, muss dieses Passwort eingeben."))
        }
        Section {
            Picker(String(localized: "Link läuft ab"), selection: $o.expiry) {
                ForEach(ShareExpiry.allCases) { Text($0.title).tag($0) }
            }
            if o.expiry == .custom {
                if editing {
                    DatePicker(String(localized: "Ablaufdatum des Links"), selection: $o.customDate,
                               displayedComponents: [.date, .hourAndMinute])
                } else {
                    DatePicker(String(localized: "Ablaufdatum des Links"), selection: $o.customDate, in: Date()...,
                               displayedComponents: [.date, .hourAndMinute])
                }
            }
        }
        Section {
            Toggle(String(localized: "Metadaten für Empfänger zeigen"), isOn: $o.showMetadata)
                .onChange(of: o.showMetadata) { _, on in if !on { o.allowDownload = false } }
            Toggle(String(localized: "Empfänger dürfen herunterladen"), isOn: $o.allowDownload)
                .disabled(!o.showMetadata)
            // „Hochladen“ gibt es nur bei Album-Links (wohin sonst?) – Immich zeigt es bei Einzel-Links auch nicht
            if album { Toggle(String(localized: "Empfänger dürfen Fotos hinzufügen"), isOn: $o.allowUpload) }
        } footer: {
            Text(String(localized: "Herunterladen geht nur zusammen mit Metadaten (Ort, Kamera, Datum) – so verlangt es Immich."))
        }
        Section {
            TextField(String(localized: "Eigener Linkname (optional)"), text: $o.slug)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
        } footer: {
            Text(String(localized: "Der Link lautet dann …/s/name statt eines zufälligen Schlüssels."))
        }
    }
}

/// Zeile in der Liste aktiver Links.
private struct SharedLinkRow: View {
    let link: SharedLinkDTO

    private var title: String {
        if let d = link.description, !d.isEmpty { return d }
        if let s = link.slug, !s.isEmpty { return s }
        return String(localized: "Link ohne Beschreibung")
    }
    private var expiry: String {
        guard let d = link.expires else { return String(localized: "Läuft nie ab") }
        return String(localized: "Läuft ab: \(d.formatted(date: .abbreviated, time: .shortened))")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.system(size: 16, weight: .semibold)).lineLimit(1)
            Text(expiry).font(.footnote).foregroundStyle(.secondary)
            HStack(spacing: 10) {
                if link.hasPassword { Image(systemName: "lock.fill") }
                if link.allowDownload ?? false { Image(systemName: "arrow.down.circle") }
                if link.showMetadata ?? false { Image(systemName: "info.circle") }
            }
            .font(.footnote).foregroundStyle(.secondary)
        }
        .padding(.vertical, 2)
    }
}

/// „Link teilen“ mit Optionen wie in der Immich-App. Oben die aktiven Links dieses Fotos (bearbeiten, löschen,
/// kopieren, teilen), darunter ein neuer Link mit Beschreibung, Passwort, Ablauf, Metadaten, Herunterladen, Hochladen, Linkname.
struct ShareLinkSheet: View {
    let ids: [String]
    /// gesetzt = Link auf das ganze Album statt auf einzelne Fotos
    var album: String? = nil
    @Environment(\.dismiss) private var dismiss
    @Environment(AppModel.self) private var app
    @State private var o = ShareLinkOptions.restored()
    @State private var links: [SharedLinkDTO] = []
    @State private var pendingDelete: SharedLinkDTO?
    @State private var working = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                if !links.isEmpty {
                    Section(String(localized: "Aktive Links")) {
                        ForEach(links) { link in
                            NavigationLink {
                                ShareLinkEditView(link: link) { Task { await reload() } }
                            } label: {
                                SharedLinkRow(link: link)
                            }
                            .swipeActions {
                                Button(role: .destructive) { pendingDelete = link } label: {
                                    Label(String(localized: "Diesen Link löschen"), systemImage: "trash")
                                }
                            }
                            .contextMenu {
                                Button(String(localized: "Linkadresse kopieren"), systemImage: "doc.on.doc") { Task { await copy(link) } }
                                Button(String(localized: "Linkadresse teilen"), systemImage: "square.and.arrow.up") { Task { await share(link) } }
                                Button(String(localized: "Diesen Link löschen"), systemImage: "trash", role: .destructive) { pendingDelete = link }
                            }
                        }
                    }
                }
                ShareLinkFields(o: $o, firstHeader: album == nil ? String(localized: "Neuer Link") : String(localized: "Neuer Link für das ganze Album"),
                                album: album != nil)
                Section {
                    Button { Task { await create() } } label: {
                        HStack { Spacer(); Text(String(localized: "Link anlegen")).bold(); Spacer() }
                    }
                }
            }
            .disabled(working)
            .overlay { if working { ProgressView().controlSize(.large) } }
            .navigationTitle(String(localized: "Link-Optionen"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) { Button(String(localized: "Fertig")) { dismiss() }.bold() }
            }
            .task { await reload() }
            .alert(error ?? "", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
                Button("OK", role: .cancel) {}
            }
            .confirmationDialog(String(localized: "Der Link funktioniert danach nicht mehr."),
                                isPresented: Binding(get: { pendingDelete != nil }, set: { if !$0 { pendingDelete = nil } }),
                                titleVisibility: .visible) {
                Button(String(localized: "Diesen Link löschen"), role: .destructive) {
                    if let l = pendingDelete { Task { await delete(l) } }
                }
            }
        }
    }

    private func reload() async {
        if let l = try? await ImmichClient.shared.sharedLinks(containing: ids, album: album) { links = l }
    }

    private func linkURL(_ link: SharedLinkDTO) async -> URL? {
        await ImmichClient.shared.linkURL(key: link.key, slug: link.slug)
    }

    private func copy(_ link: SharedLinkDTO) async {
        guard let url = await linkURL(link) else { return }
        UIPasteboard.general.url = url
        app.toast(String(localized: "Link kopiert"))
    }

    private func share(_ link: SharedLinkDTO) async {
        guard let url = await linkURL(link) else { return }
        ShareService.present([url])
    }

    private func delete(_ link: SharedLinkDTO) async {
        do {
            try await ImmichClient.shared.deleteSharedLink(link.id)
            links.removeAll { $0.id == link.id }
            app.toast(String(localized: "Link gelöscht"))
        } catch { self.error = error.localizedDescription }
    }

    private func create() async {
        working = true
        defer { working = false }
        do {
            let url = try await ImmichClient.shared.createShareLink(ids, album: album, options: o)
            o.remember()
            o.description = ""; o.password = ""; o.slug = ""
            UIPasteboard.general.url = url
            app.toast(String(localized: "Link erstellt und kopiert"))
            await reload()
            ShareService.present([url])   // über dem Bogen; die Liste oben zeigt den neuen Link
        } catch {
            if case APIError.http(let code, _) = error, [400, 409].contains(code), !o.cleanSlug.isEmpty {
                self.error = String(localized: "Dieser Linkname ist schon vergeben.")
            } else {
                self.error = error.localizedDescription
            }
        }
    }
}

/// Vorhandenen Link ändern (Immich: PATCH /shared-links/{id}) oder löschen.
struct ShareLinkEditView: View {
    let link: SharedLinkDTO
    let onChange: () -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(AppModel.self) private var app
    @State private var o: ShareLinkOptions
    @State private var working = false
    @State private var error: String?
    @State private var confirmDelete = false

    init(link: SharedLinkDTO, onChange: @escaping () -> Void) {
        self.link = link
        self.onChange = onChange
        var o = ShareLinkOptions()
        o.description = link.description ?? ""
        o.showMetadata = link.showMetadata ?? false
        o.allowDownload = link.allowDownload ?? false
        o.allowUpload = link.allowUpload ?? false
        o.slug = link.slug ?? ""
        if let d = link.expires { o.expiry = .custom; o.customDate = d } else { o.expiry = .never }
        _o = State(initialValue: o)
    }

    var body: some View {
        Form {
            ShareLinkFields(o: $o, editing: true, hasPassword: link.hasPassword, album: link.type == "ALBUM")
            Section {
                Button(String(localized: "Diesen Link löschen"), role: .destructive) { confirmDelete = true }
            }
        }
        .disabled(working)
        .overlay { if working { ProgressView().controlSize(.large) } }
        .navigationTitle(String(localized: "Link bearbeiten"))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button(String(localized: "Änderungen sichern")) { Task { await save() } }.bold().disabled(working)
            }
        }
        .alert(error ?? "", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
            Button("OK", role: .cancel) {}
        }
        .confirmationDialog(String(localized: "Der Link funktioniert danach nicht mehr."), isPresented: $confirmDelete,
                            titleVisibility: .visible) {
            Button(String(localized: "Diesen Link löschen"), role: .destructive) { Task { await remove() } }
        }
    }

    private func save() async {
        working = true
        defer { working = false }
        do {
            try await ImmichClient.shared.updateSharedLink(link.id, options: o, hadSlug: !(link.slug ?? "").isEmpty)
            app.toast(String(localized: "Link aktualisiert"))
            onChange()
            dismiss()
        } catch {
            if case APIError.http(let code, _) = error, [400, 409].contains(code), !o.cleanSlug.isEmpty {
                self.error = String(localized: "Dieser Linkname ist schon vergeben.")
            } else {
                self.error = error.localizedDescription
            }
        }
    }

    private func remove() async {
        working = true
        defer { working = false }
        do {
            try await ImmichClient.shared.deleteSharedLink(link.id)
            app.toast(String(localized: "Link gelöscht"))
            onChange()
            dismiss()
        } catch { self.error = error.localizedDescription }
    }
}
