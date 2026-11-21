import SwiftUI

/// Geteilte Mediathek wie in Fotos (PXSharedLibrary) – bei Immich „Partner“: Wer seine Fotos mit dir teilt,
/// erscheint auf Wunsch mitten in deiner Mediathek (Kennzeichen oben rechts an der Kachel).
struct SharedLibraryView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(TimelineStore.self) private var timeline
    @State private var sharedBy: [Partner] = []      // ich teile mit …
    @State private var sharedWith: [Partner] = []    // … teilt mit mir
    @State private var users: [UserDTO] = []
    @State private var me = ""
    @State private var loaded = false
    @State private var confirmStop: Partner?

    struct Partner: Decodable, Identifiable, Hashable { let id: String; let name: String; let email: String; let inTimeline: Bool? }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(sharedWith) { p in
                        Toggle(isOn: Binding(get: { p.inTimeline ?? false }, set: { on in Task { await setTimeline(p, on) } })) {
                            VStack(alignment: .leading) { Text(p.name); Text(p.email).font(.footnote).foregroundStyle(.secondary) }
                        }
                    }
                    if sharedWith.isEmpty && loaded { Text(String(localized: "Noch niemand teilt seine Fotos mit dir.")).foregroundStyle(.secondary) }
                } header: { Text(String(localized: "Teilt mit dir")) } footer: {
                    Text(String(localized: "Eingeschaltet erscheinen die Fotos dieser Person in deiner Mediathek – ausblenden geht im Mediathek-Menü unter „Mit dir geteilt“."))
                }
                Section {
                    ForEach(sharedBy) { p in
                        HStack {
                            VStack(alignment: .leading) { Text(p.name); Text(p.email).font(.footnote).foregroundStyle(.secondary) }
                            Spacer()
                            Button(String(localized: "Beenden"), role: .destructive) { confirmStop = p }.buttonStyle(.borderless)
                        }
                    }
                    let candidates = users.filter { u in u.id != me && !sharedBy.contains { $0.id == u.id } }
                    if !candidates.isEmpty {
                        Menu {
                            ForEach(candidates, id: \.id) { u in Button("\(u.name) (\(u.email))") { Task { await share(with: u.id) } } }
                        } label: { Label(String(localized: "Person hinzufügen …"), systemImage: "person.badge.plus") }
                    }
                } header: { Text(String(localized: "Du teilst mit")) } footer: {
                    Text(String(localized: "Diese Personen sehen alle deine Fotos (nicht „Ausgeblendet“ und „Zuletzt gelöscht“). Nur Nutzer deines eigenen Servers."))
                }
            }
            .navigationTitle(String(localized: "Geteilte Mediathek"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button(String(localized: "Fertig")) { dismiss() } } }
            .confirmationDialog(String(localized: "Teilen mit \(confirmStop?.name ?? "") beenden?"), isPresented: Binding(get: { confirmStop != nil }, set: { if !$0 { confirmStop = nil } }),
                                titleVisibility: .visible) {
                Button(String(localized: "Teilen beenden"), role: .destructive) { if let p = confirmStop { Task { await stop(p) } } }
            }
        }
        .task { await load() }
    }

    private func load() async {
        let api = ImmichClient.shared
        async let a: [Partner]? = try? api.request("partners", query: ["direction": "shared-by"])
        async let b: [Partner]? = try? api.request("partners", query: ["direction": "shared-with"])
        async let u: [UserDTO]? = try? api.request("users")
        async let m = try? api.me()
        sharedBy = await a ?? []; sharedWith = await b ?? []; users = await u ?? []; me = (await m)?.id ?? ""
        loaded = true
    }
    private func share(with id: String) async {
        try? await ImmichClient.shared.raw("partners", method: "POST", body: ImmichClient.shared.json(["sharedWithId": id]))
        await load()
    }
    private func stop(_ p: Partner) async {
        try? await ImmichClient.shared.raw("partners/\(p.id)", method: "DELETE")
        await load()
    }
    private func setTimeline(_ p: Partner, _ on: Bool) async {
        try? await ImmichClient.shared.raw("partners/\(p.id)", method: "PUT", body: ImmichClient.shared.json(["inTimeline": on]))
        await load(); await timeline.reload()
    }
}
