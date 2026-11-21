import Photos
import SwiftUI

/// Vor dem ersten Backup (und nach einem Serverwechsel) fragen, statt nach dem Anmelden sofort die ganze
/// Mediathek hochzuladen (GitHub-Issue #11): wohin, wie viel, unverschlüsselt ja/nein.
struct BackupConsentView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var count: Int?
    private var server: URL? { ImmichClient.shared.baseURL }
    private var plainHTTP: Bool { server?.scheme?.lowercased() == "http" }

    var body: some View {
        VStack(spacing: 18) {
            Image(systemName: "arrow.triangle.2.circlepath.icloud").font(.system(size: 52)).foregroundStyle(.tint)
                .padding(.top, 24)
            Text(String(localized: "Fotos auf deinem Server sichern?")).font(.title2.bold()).multilineTextAlignment(.center)
            VStack(spacing: 8) {
                Text(String(localized: "Neue Fotos und Videos von diesem iPhone werden als Originale hochgeladen nach")).foregroundStyle(.secondary)
                Text(server?.host() ?? "–").font(.headline)
                if let count { Text(String(localized: "\(count.formatted()) Fotos und Videos auf diesem iPhone")).font(.subheadline).foregroundStyle(.secondary) }
            }
            .multilineTextAlignment(.center)
            if plainHTTP {
                Label(String(localized: "Unverschlüsselte Verbindung (http) – nur im eigenen Heimnetz oder über VPN verwenden."),
                      systemImage: "lock.open.trianglebadge.exclamationmark")
                    .font(.footnote).foregroundStyle(.orange).multilineTextAlignment(.leading)
            }
            Text(String(localized: "Auf dem iPhone wird nichts gelöscht. Ändern kannst du das jederzeit unter Backup."))
                .font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
            Spacer(minLength: 0)
            Button { BackupEngine.shared.consent(true); dismiss() } label: {
                Text(String(localized: "Backup einschalten")).font(.headline).frame(maxWidth: .infinity, minHeight: 50)
            }
            .buttonStyle(.glassProminent)
            Button(String(localized: "Nicht jetzt")) { BackupEngine.shared.consent(false); dismiss() }
                .padding(.bottom, 8)
        }
        .padding(.horizontal, 28)
        .interactiveDismissDisabled()
        .presentationDetents([.medium, .large])
        .task {
            // Anzahl nur zeigen, wenn der Fotozugriff schon erlaubt ist (hier nicht ungefragt danach fragen)
            let s = PHPhotoLibrary.authorizationStatus(for: .readWrite)
            if s == .authorized || s == .limited { count = PHAsset.fetchAssets(with: nil).count }
        }
    }
}
