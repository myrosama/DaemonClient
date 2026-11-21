import SwiftUI
import Photos

/// „Speicher freigeben“: löscht auf dem iPhone nur, was nachweislich auf dem eigenen Server liegt
/// (vom Backup per Prüfsumme gesichert und dort noch vorhanden, nicht im Papierkorb). iOS fragt vor dem Löschen
/// selbst nach; die Objekte liegen danach noch 30 Tage in „Zuletzt gelöscht“ der Fotos-App.
@MainActor @Observable
final class FreeUp {
    static let shared = FreeUp()
    struct Plan { let assets: [PHAsset]; let bytes: Int64 }
    enum Phase: Equatable { case idle, checking, done(Int, Int64), failed(String) }
    var phase: Phase = .idle

    /// Kandidaten: älter als `days` Tage (0 = alle), Favoriten auf Wunsch ausgenommen.
    func plan(olderThan days: Int, keepFavorites: Bool) async -> Plan? {
        phase = .checking
        let map = await BackupEngine.shared.backedUp()
        guard !map.isEmpty else { phase = .done(0, 0); return Plan(assets: [], bytes: 0) }
        let limit = Calendar.current.date(byAdding: .day, value: -days, to: Date()) ?? Date()
        let fetched = PHAsset.fetchAssets(withLocalIdentifiers: Array(map.keys), options: nil)
        var local: [PHAsset] = []
        fetched.enumerateObjects { a, _, _ in
            if days > 0, (a.creationDate ?? Date()) > limit { return }
            if keepFavorites, a.isFavorite { return }
            if !BackupEngine.shared.currentVersionBackedUp(a) { return }   // Bearbeitung noch nicht gesichert (#56)
            local.append(a)
        }
        // Gegenprobe beim Server: Objekt muss noch da sein (nicht gelöscht, nicht im Papierkorb)
        var ok: [PHAsset] = []
        let api = ImmichClient.shared
        for part in stride(from: 0, to: local.count, by: 8).map({ Array(local[$0..<min($0 + 8, local.count)]) }) {
            let good = await withTaskGroup(of: PHAsset?.self) { g in
                for a in part {
                    guard let rid = map[a.localIdentifier] else { continue }
                    g.addTask { (try? await api.asset(rid)).flatMap { $0.isTrashed == true ? nil : a } }
                }
                var out: [PHAsset] = []
                for await r in g { if let r { out.append(r) } }
                return out
            }
            ok += good
        }
        let bytes = await Task.detached(priority: .utility) { ok.reduce(Int64(0)) { $0 + Self.size(of: $1) } }.value
        phase = .idle
        return Plan(assets: ok, bytes: bytes)
    }

    func delete(_ plan: Plan) async {
        let ids = plan.assets.map(\.localIdentifier)
        do {
            try await Self.deleteFromLibrary(plan.assets)
            BackupEngine.shared.forget(ids)
            phase = .done(ids.count, plan.bytes)
        } catch {
            // „Nicht löschen“ in der Rückfrage von iOS landet auch hier
            phase = .idle
        }
    }

    /// Photos führt den Änderungsblock auf einer eigenen Warteschlange aus – daher ohne MainActor-Bindung.
    nonisolated private static func deleteFromLibrary(_ assets: [PHAsset]) async throws {
        let list = assets as NSArray
        try await PHPhotoLibrary.shared().performChanges { PHAssetChangeRequest.deleteAssets(list) }
    }

    /// Größe der Dateien auf dem iPhone (Foto, Live-Video, Bearbeitung)
    nonisolated static func size(of a: PHAsset) -> Int64 {
        PHAssetResource.assetResources(for: a).reduce(Int64(0)) { $0 + (($1.value(forKey: "fileSize") as? Int64) ?? 0) }
    }
}

struct FreeUpSection: View {
    @State private var free = FreeUp.shared
    @AppStorage("freeup.days") private var days = 30
    @AppStorage("freeup.keepFavorites") private var keepFavorites = true
    @State private var plan: FreeUp.Plan?

    var body: some View {
        Section {
            Picker(String(localized: "Fotos älter als"), selection: $days) {
                Text(String(localized: "7 Tage")).tag(7); Text(String(localized: "30 Tage")).tag(30)
                Text(String(localized: "1 Jahr")).tag(365); Text(String(localized: "Alle")).tag(0)
            }
            Toggle(String(localized: "Favoriten auf dem iPhone behalten"), isOn: $keepFavorites)
            Button {
                Task { plan = await free.plan(olderThan: days, keepFavorites: keepFavorites) }
            } label: {
                HStack {
                    Label(String(localized: "Speicher freigeben …"), systemImage: "externaldrive.badge.checkmark")
                    if free.phase == .checking { Spacer(); ProgressView() }
                }
            }
            .disabled(free.phase == .checking)
            if case .done(let n, let b) = free.phase {
                Text(n == 0 ? String(localized: "Nichts zu löschen – keine passenden Fotos, die schon auf dem Server liegen.")
                            : String(localized: "\(n) Objekte vom iPhone gelöscht · \(ByteCountFormatter.string(fromByteCount: b, countStyle: .file)) frei"))
                    .font(.footnote).foregroundStyle(.secondary)
            }
        } header: { Text(String(localized: "iPhone-Speicher")) } footer: {
            Text(String(localized: "Löscht auf dem iPhone nur Fotos und Videos, die nachweislich auf deinem Server liegen. iOS fragt vorher nach, und in Apples Fotos-App liegen sie danach noch 30 Tage unter „Zuletzt gelöscht“. Achtung: Ist iCloud-Fotos eingeschaltet, löscht iOS sie auch dort."))
        }
        .confirmationDialog(confirmTitle, isPresented: Binding(get: { (plan?.assets.count ?? 0) > 0 }, set: { if !$0 { plan = nil } }),
                            titleVisibility: .visible) {
            Button(String(localized: "Vom iPhone löschen"), role: .destructive) {
                if let p = plan { Task { await free.delete(p) } }
                plan = nil
            }
        } message: { Text(String(localized: "Auf deinem Server bleibt alles erhalten.")) }
        .onChange(of: plan?.assets.count) { _, n in if n == 0 { free.phase = .done(0, 0) } }
    }

    private var confirmTitle: String {
        guard let p = plan else { return "" }
        let size = ByteCountFormatter.string(fromByteCount: p.bytes, countStyle: .file)
        return String(localized: "\(p.assets.count) Objekte vom iPhone löschen (\(size))?")
    }
}
