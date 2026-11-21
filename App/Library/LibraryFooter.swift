import SwiftUI

/// Fußzeile unter den neuesten Fotos wie in Apples Fotos-App (REA: PXCuratedLibraryFooterController, PXFooterViewModel;
/// Stand von iCloud kommt dort aus PXCPLStatusProvider): Anzahl Fotos/Videos, darunter das Backup auf den eigenen
/// Server mit Balken und Pausieren/Fortsetzen – im Glas-Look von iOS 26 statt Apples alter weißer Box.
struct LibraryFooter: View {
    /// ändert sich mit der Mediathek → Anzahl neu vom Server holen
    let refresh: Int
    let onOpenBackup: () -> Void
    @State private var stats: (images: Int, videos: Int)?
    private var backup: BackupEngine { .shared }
    /// Zeitangaben in der Sprache der App, nicht des Systems (sonst „15 hours ago“ in deutscher Oberfläche)
    private let appLocale = Locale(identifier: Bundle.main.preferredLocalizations.first ?? "en")

    var body: some View {
        VStack(spacing: 7) {
            if let stats { Text(countText(stats)).font(.system(size: 15, weight: .semibold)) }
            if backup.enabled { status }
        }
        .foregroundStyle(.primary)
        .frame(maxWidth: .infinity)
        .padding(.vertical, 12).padding(.horizontal, 18)
        .contentShape(.rect)
        .onTapGesture(perform: onOpenBackup)
        .glassEffect(.regular, in: .rect(cornerRadius: 24))
        .padding(.horizontal, 16)
        .task(id: refresh) {
            // beim Start ist das Netz manchmal noch nicht da → wiederholen, bis der Server antwortet
            while !Task.isCancelled {
                if let s = await ImmichClient.shared.statistics() { stats = s; return }
                try? await Task.sleep(for: .seconds(stats == nil ? 3 : 30))
            }
        }
        .accessibilityElement(children: .contain)
    }

    private func countText(_ s: (images: Int, videos: Int)) -> String {
        // Einzahl getrennt („1 Videos“ stand so in Rückmeldungen)
        let photos = s.images == 1 ? String(localized: "1 Foto") : String(localized: "\(s.images.formatted()) Fotos")
        let videos = s.videos == 1 ? String(localized: "1 Video") : String(localized: "\(s.videos.formatted()) Videos")
        return switch (s.images, s.videos) {
        case (_, 0): photos
        case (0, _): videos
        default: "\(photos), \(videos)"
        }
    }

    @ViewBuilder private var status: some View {
        if backup.paused {
            if backup.total > 0 { bar(Double(backup.finished) / Double(backup.total), dimmed: true) }
            line(backup.pending.map { $0 > 0 ? String(localized: "Backup für \($0.formatted()) Objekte pausiert") : nil }
                    .flatMap { $0 } ?? String(localized: "Backup pausiert"),
                 action: String(localized: "Fortsetzen")) { backup.resume() }
        } else {
            switch backup.phase {
            case .scanning:
                line(String(localized: "Suche neue Fotos …"), action: String(localized: "Pausieren")) { backup.pause() }
            case .uploading:
                bar(backup.total > 0 ? Double(backup.finished) / Double(backup.total) : 0, dimmed: false)
                line(String(localized: "\(max(0, backup.total - backup.finished).formatted()) Objekte werden gesichert"),
                     action: String(localized: "Pausieren")) { backup.pause() }
            case .failed(let msg):
                line(String(localized: "Backup unterbrochen: \(msg)"), action: String(localized: "Erneut versuchen")) { backup.start() }
            case .idle, .done:
                if backup.background > 0 {
                    line(String(localized: "\(backup.background.formatted()) Objekte werden im Hintergrund gesichert"),
                         action: String(localized: "Pausieren")) { backup.pause() }
                } else if let n = backup.pending, n > 0 {
                    line(String(localized: "\(n.formatted()) Objekte noch nicht gesichert"),
                         action: String(localized: "Jetzt sichern")) { backup.start() }
                } else if let last = backup.lastRun {
                    line(String(localized: "Auf deinem Server gesichert · \(last.formatted(.relative(presentation: .named).locale(appLocale)))"), action: nil) {}
                }
            }
        }
    }

    /// Dünner Balken wie bei Apple.
    private func bar(_ value: Double, dimmed: Bool) -> some View {
        ProgressView(value: value)
        .progressViewStyle(.linear)
        .tint(dimmed ? Color.primary.opacity(0.45) : Color.primary)
        .frame(maxWidth: 260)
    }

    private func line(_ text: String, action: String?, _ run: @escaping () -> Void) -> some View {
        HStack(spacing: 5) {
            Text(text).foregroundStyle(Color.primary.opacity(0.75)).lineLimit(1).truncationMode(.middle)
            if let action {
                Text("·").foregroundStyle(Color.primary.opacity(0.5))
                Button(action, action: run).buttonStyle(.plain).foregroundStyle(.tint).fontWeight(.semibold)
            }
        }
        .font(.system(size: 13))
    }
}
