import SwiftUI

/// Einstellungen und Fortschritt des iPhone-Backups (aus dem Konto-Menü in „Sammlungen“).
struct BackupView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var engine = BackupEngine.shared

    var body: some View {
        @Bindable var engine = engine
        NavigationStack {
            List {
                Section {
                    HStack(spacing: 14) {
                        Image(systemName: icon).font(.system(size: 28, weight: .semibold)).foregroundStyle(tint)
                            .frame(width: 40)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(title).font(.headline)
                            Text(subtitle).font(.subheadline).foregroundStyle(.secondary)
                        }
                    }
                    .padding(.vertical, 4)
                    if engine.running, engine.total > 0 {
                        ProgressView(value: Double(engine.finished), total: Double(engine.total))
                        if !engine.current.isEmpty { Text(engine.current).font(.footnote).foregroundStyle(.secondary).lineLimit(1) }
                    }
                    if engine.paused, let until = engine.pausedUntil {
                        // wie iCloud-Fotos: Pausieren gilt einen Tag, auch für das Backup in der Nacht
                        Text(String(localized: "Pausiert bis \(until.formatted(date: .omitted, time: .shortened)) morgen"))
                            .font(.footnote).foregroundStyle(.secondary)
                        Button(String(localized: "Fortsetzen")) { engine.resume() }.disabled(!engine.enabled)
                    } else if engine.running {
                        Button(String(localized: "Für einen Tag pausieren")) { engine.pause() }
                    } else {
                        Button(String(localized: "Jetzt sichern")) { engine.start() }.disabled(!engine.enabled)
                    }
                }
                Section {
                    Toggle(String(localized: "Fotos sichern"), isOn: $engine.enabled)
                    Toggle(String(localized: "Nur im WLAN"), isOn: $engine.wifiOnly)
                } footer: {
                    Text(String(localized: "Neue Fotos und Videos landen auf deinem eigenen Server – im Hintergrund, wenn das iPhone nachts am Strom hängt, und sobald du die App öffnest. Auf dem iPhone wird nur gelöscht, wenn du unten „Speicher freigeben“ wählst."))
                }
                Section {
                    Toggle(String(localized: "Ältere Fotos sind schon auf dem Server"), isOn: Binding(
                        get: { engine.importCutoff != nil },
                        set: { engine.importCutoff = $0 ? Calendar.current.startOfDay(for: .now) : nil }))
                    if let cutoff = engine.importCutoff {
                        DatePicker(String(localized: "Übernommen bis"), selection: Binding(get: { cutoff }, set: { engine.importCutoff = $0 }),
                                   in: ...Date.now, displayedComponents: .date)
                        Toggle(String(localized: "Ganze Mediathek prüfen"), isOn: $engine.fullLibrary)
                    }
                } footer: {
                    if let cutoff = engine.importCutoff {
                        Text(String(localized: "Alles vor dem \(cutoff.formatted(.dateTime.day().month(.wide).year().locale(.autoupdatingCurrent))) ist schon aus iCloud übernommen. Eingeschaltet prüft die App auch ältere Fotos – aber nur die, die auf dem iPhone liegen, ohne sie aus iCloud zu laden."))
                    } else {
                        Text(String(localized: "Die App sichert die ganze Mediathek, auch Fotos, die nur in iCloud liegen (sie werden dafür geladen). Hast du ältere Fotos schon anders auf den Server gebracht, z. B. mit icloudpd, schalte das ein: Dann sichert die App nur, was danach dazukommt."))
                    }
                }
                OfflineSection()
                Section {
                    ShareLink(item: PerfLog.url, preview: SharePreview("Leistungsprotokoll")) {
                        Label(String(localized: "Leistungsprotokoll teilen"), systemImage: "waveform.path.ecg")
                    }
                    Button(String(localized: "Protokoll leeren"), role: .destructive) { PerfLog.clear() }
                } header: { Text(String(localized: "Leistung")) } footer: {
                    Text(String(localized: "Die App merkt sich, wann sie hängt oder beim Scrollen ruckelt – ohne Fotos oder Namen. Schick das Protokoll, wenn etwas langsam ist."))
                }
                if !engine.problems.isEmpty {
                    Section(String(localized: "Nicht gesichert (\(engine.problems.count))")) {
                        ForEach(engine.problems.prefix(50), id: \.self) { Text($0).font(.footnote) }
                    }
                }
                // installierte Version, zum Vergleich mit dem neuesten Release (GitHub-Issue #12)
                Section {} footer: { Text(verbatim: "Phosphor Photos \(AppInfo.version)").frame(maxWidth: .infinity) }
            }
            .navigationTitle(String(localized: "Backup & Offline"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button(String(localized: "Fertig")) { dismiss() } } }
            .onChange(of: engine.enabled) { engine.schedule() }
        }
    }

    private var icon: String {
        if engine.paused { return "pause.circle" }
        return switch engine.phase {
        case .failed: "exclamationmark.icloud"
        case .scanning, .uploading: "arrow.triangle.2.circlepath.icloud"
        default: engine.enabled ? "checkmark.icloud" : "icloud.slash"
        }
    }
    private var tint: Color {
        if engine.paused { return .secondary }
        if case .failed = engine.phase { return .orange }
        return engine.enabled ? .blue : .secondary
    }
    private var title: String {
        if engine.paused { return String(localized: "Backup pausiert") }
        return switch engine.phase {
        case .scanning: String(localized: "Mediathek wird geprüft …")
        case .uploading: String(localized: "\(engine.finished.formatted()) von \(engine.total.formatted()) gesichert")
        case .failed(let m): m
        default: engine.enabled ? String(localized: "Backup ist aktiv") : String(localized: "Backup ist aus")
        }
    }
    private var subtitle: String {
        var parts: [String] = []
        if engine.uploaded > 0 { parts.append(String(localized: "\(engine.uploaded) hochgeladen")) }
        if engine.duplicates > 0 { parts.append(String(localized: "\(engine.duplicates) schon da")) }
        if engine.failed > 0 { parts.append(String(localized: "\(engine.failed) fehlgeschlagen")) }
        if parts.isEmpty, let l = engine.lastRun { parts.append(String(localized: "Zuletzt \(l.formatted(.relative(presentation: .named).locale(.autoupdatingCurrent)))")) }
        if parts.isEmpty { parts.append(String(localized: "Noch nicht gelaufen")) }
        return parts.joined(separator: " · ")
    }
}


/// Vorschauen dauerhaft auf dem iPhone (Mediathek ohne Internet durchblättern).
private struct OfflineSection: View {
    @State private var sync = OfflineSync.shared
    @State private var confirmClear = false

    var body: some View {
        @Bindable var sync = sync
        Section {
            Toggle(String(localized: "Vorschauen auf dem iPhone speichern"), isOn: $sync.enabled)
            row(String(localized: "Kleine Vorschauen"), sync.thumbs, sync.thumbBytes)
            row(String(localized: "Große Vorschauen"), sync.previews, sync.previewBytes)
            Picker(String(localized: "Große Vorschauen höchstens"), selection: $sync.previewLimitGB) {
                Text(String(localized: "Keine")).tag(-1)
                Text("2 GB").tag(2); Text("10 GB").tag(10); Text("30 GB").tag(30); Text(String(localized: "Alle")).tag(0)
            }
            if sync.running {
                HStack { ProgressView(); Text(String(localized: "\(sync.note) werden geladen …")).foregroundStyle(.secondary) }
            } else if !sync.note.isEmpty {
                Text(sync.note).foregroundStyle(.orange)
            }
            Button(String(localized: "Offline-Speicher leeren"), role: .destructive) { confirmClear = true }
        } header: { Text(String(localized: "Ohne Internet")) } footer: {
            Text(String(localized: "Ohne Verbindung zum Server siehst du alle Fotos als Vorschau; Videos und Originale brauchen den Server. Kleine Vorschauen sind für das Raster, große für die Einzelansicht. Geladen wird nur im WLAN, und das iPhone behält mindestens 10 GB frei."))
        }
        .confirmationDialog(String(localized: "Gespeicherte Vorschauen löschen?"), isPresented: $confirmClear, titleVisibility: .visible) {
            Button(String(localized: "Löschen"), role: .destructive) { sync.stop(); OfflineStore.shared.clear(); sync.refreshStats() }
        } message: { Text(String(localized: "Auf dem Server bleibt alles. Die Vorschauen werden danach im WLAN neu geladen.")) }
        .task {
            while !Task.isCancelled { sync.refreshStats(); try? await Task.sleep(for: .seconds(2)) }
        }
    }

    private func row(_ title: String, _ n: Int, _ bytes: Int) -> some View {
        LabeledContent(title) {
            Text(String(localized: "\(n.formatted()) von \(sync.total.formatted()) · \(ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file))"))
                .monospacedDigit()
        }
    }
}
