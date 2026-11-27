import SwiftUI

/// Untere Leiste im Auswahlmodus: Teilen · „N Fotos ausgewählt“ · Löschen (wie Fotos in iOS 26).
/// Weitere Aktionen stecken im „…“-Menü oben (`SelectionMenuButton`).
struct SelectionBar: View {
    @Environment(AppModel.self) private var app
    @Environment(TimelineStore.self) private var timeline
    @State private var confirmDelete = false

    private var ids: [String] { Array(app.selected) }

    var body: some View {
        HStack(spacing: 12) {
            Menu {
                Button(String(localized: "Datei senden"), systemImage: "doc") { Task { await ShareService.share(ids, app: app) } }
                Button(String(localized: "Link teilen (Heimnetz/VPN)"), systemImage: "link") { app.sheet = .shareLink(ids) }
                Button(String(localized: "Teilen-Optionen …"), systemImage: "slider.horizontal.3") { app.sheet = .shareOptions(ids) }
            } label: {
                Image(systemName: "square.and.arrow.up").frame(width: 58, height: 58).contentShape(.rect)
            } primaryAction: { Task { await ShareService.share(ids, app: app) } }
            .glassEffect(.regular.interactive(), in: .circle)
            .disabled(ids.isEmpty)
            Text(SelectionText.make(app.selected, timeline))
                .font(.system(size: 17, weight: .semibold))
                .frame(maxWidth: .infinity)
                .shadow(color: Color.appBackground.opacity(0.5), radius: 6)
            Button { confirmDelete = true } label: {
                Image(systemName: "trash").frame(width: 58, height: 58).contentShape(.rect)
            }
            .glassEffect(.regular.interactive(), in: .circle)
            .disabled(ids.isEmpty)
        }
        .font(.system(size: 21, weight: .medium))
        .foregroundStyle(.primary)
        .buttonStyle(.plain)
        .confirmationDialog("", isPresented: $confirmDelete) {
            Button(SelectionText.deleteTitle(app.selected, timeline), role: .destructive) {
                AssetActions.delete(ids, timeline: timeline)
                withAnimation(.snappy) { app.endSelection() }
            }
        } message: {
            Text(String(localized: "Diese Objekte kommen in „Zuletzt gelöscht“ und bleiben dort 30 Tage wiederherstellbar."))
        }
    }
}

enum SelectionText {
    /// „Objekte auswählen“, „1 Foto ausgewählt“, „2 Videos ausgewählt“, „3 Objekte ausgewählt“
    @MainActor static func make(_ sel: Set<String>, _ t: TimelineStore) -> String {
        make(t.assets(sel), count: sel.count)
    }
    static func make(_ list: [Asset], count n: Int) -> String {
        if n == 0 { return String(localized: "Objekte auswählen") }
        if !list.isEmpty && list.allSatisfy(\.isImage) { return n == 1 ? String(localized: "1 Foto ausgewählt") : String(localized: "\(n) Fotos ausgewählt") }
        if !list.isEmpty && list.allSatisfy(\.isVideo) { return n == 1 ? String(localized: "1 Video ausgewählt") : String(localized: "\(n) Videos ausgewählt") }
        return n == 1 ? String(localized: "1 Objekt ausgewählt") : String(localized: "\(n) Objekte ausgewählt")
    }
    /// „1 Foto löschen“, „3 Videos löschen“ …
    @MainActor static func deleteTitle(_ sel: Set<String>, _ t: TimelineStore) -> String {
        let list = t.assets(sel), n = sel.count
        if !list.isEmpty && list.allSatisfy(\.isImage) { return n == 1 ? String(localized: "1 Foto löschen") : String(localized: "\(n) Fotos löschen") }
        if !list.isEmpty && list.allSatisfy(\.isVideo) { return n == 1 ? String(localized: "1 Video löschen") : String(localized: "\(n) Videos löschen") }
        return n == 1 ? String(localized: "1 Objekt löschen") : String(localized: "\(n) Objekte löschen")
    }
}

/// „…“ oben rechts im Auswahlmodus.
struct SelectionMenuButton: View {
    @Environment(AppModel.self) private var app
    @Environment(TimelineStore.self) private var timeline
    var body: some View {
        let assets = timeline.assets(app.selected)
        Menu {
            AssetMenu(assets: assets, style: .selection, present: { app.sheet = $0 }) {
                withAnimation(.snappy) { app.endSelection() }
            }
        } label: {
            Image(systemName: "ellipsis").font(.system(size: 18, weight: .semibold))
                .foregroundStyle(.primary).frame(width: 46, height: 46).contentShape(.rect)
        }
        .disabled(assets.isEmpty)
    }
}
