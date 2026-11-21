import UIKit
import SwiftUI
import UniformTypeIdentifiers
import CryptoKit

/// „Fotos“ im Teilen-Menü anderer Apps (WhatsApp, Safari, Dateien …): Bilder und Videos direkt auf den eigenen
/// Server sichern – wie „In Fotos sichern“, nur ohne iCloud. Server und Token kommen aus der App (App-Gruppe).
final class ShareViewController: UIViewController {
    private let model = ShareModel()

    override func viewDidLoad() {
        super.viewDidLoad()
        // gleiches Erscheinungsbild wie die App (Einstellungen → Erscheinungsbild); „Automatisch“ = wie das iPhone
        overrideUserInterfaceStyle = switch AppGroup.loadTheme() { case "light": .light; case "dark": .dark; default: .unspecified }
        let host = UIHostingController(rootView: ShareView(model: model) { [weak self] in
            self?.extensionContext?.completeRequest(returningItems: nil)
        })
        addChild(host); host.view.frame = view.bounds; host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(host.view); host.didMove(toParent: self)
        model.providers = (extensionContext?.inputItems as? [NSExtensionItem] ?? []).flatMap { $0.attachments ?? [] }
            .filter { $0.hasItemConformingToTypeIdentifier(UTType.image.identifier) || $0.hasItemConformingToTypeIdentifier(UTType.movie.identifier) }
    }
}

@MainActor @Observable
final class ShareModel {
    var providers: [NSItemProvider] = []
    var done = 0
    var duplicates = 0
    var failed = 0
    var running = false
    var finished = false
    var error: String?
    let access = AppGroup.loadAccess()

    func upload() async {
        guard let access, let base = URL(string: access.server) else { error = String(localized: "Bitte zuerst die Fotos-App öffnen und anmelden."); return }
        running = true
        let up = Uploader(base: base, token: access.token)
        for p in providers {
            guard let (file, name) = await Self.file(from: p) else { failed += 1; continue }
            defer { try? FileManager.default.removeItem(at: file.deletingLastPathComponent()) }
            switch await up.upload(file, name: name) {
            case .created: done += 1
            case .duplicate: duplicates += 1
            case .failed: failed += 1
            }
        }
        running = false; finished = true
    }

    /// Datei aus der fremden App holen (Video vor Bild, damit Live-/Bewegtbilder als Video ankommen).
    private static func file(from p: NSItemProvider) async -> (URL, String)? {
        let type = p.hasItemConformingToTypeIdentifier(UTType.movie.identifier) ? UTType.movie : UTType.image
        let preferred = p.registeredTypeIdentifiers.first { UTType($0)?.conforms(to: type) == true } ?? type.identifier
        return await withCheckedContinuation { cont in
            _ = p.loadFileRepresentation(forTypeIdentifier: preferred) { url, _ in
                guard let url else {
                    // manche Apps liefern nur Daten (z. B. ein Bild aus Safari)
                    p.loadDataRepresentation(forTypeIdentifier: preferred) { d, _ in
                        guard let d else { cont.resume(returning: nil); return }
                        let ext = UTType(preferred)?.preferredFilenameExtension ?? "jpg"
                        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
                        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
                        let f = dir.appendingPathComponent("geteilt.\(ext)")
                        cont.resume(returning: (try? d.write(to: f)) != nil ? (f, f.lastPathComponent) : nil)
                    }
                    return
                }
                // die Datei gehört dem System nur während dieses Rückrufs → kopieren
                let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
                try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
                let f = dir.appendingPathComponent(url.lastPathComponent)
                cont.resume(returning: (try? FileManager.default.copyItem(at: url, to: f)) != nil ? (f, url.lastPathComponent) : nil)
            }
        }
    }
}

/// Hochladen wie das Backup der App (POST /assets mit Prüfsumme – doppelte erkennt der Server).
struct Uploader {
    enum Result { case created, duplicate, failed }
    let base: URL, token: String

    func upload(_ file: URL, name: String) async -> Result {
        guard let sum = try? sha1(file) else { return .failed }
        let created = ((try? file.resourceValues(forKeys: [.creationDateKey]).creationDate) ?? Date())
        let iso = ISO8601DateFormatter()
        let fields = ["deviceAssetId": "teilen-\(sum)", "deviceId": "fotos-teilen", "fileCreatedAt": iso.string(from: created),
                      "fileModifiedAt": iso.string(from: Date()), "filename": name]
        let boundary = "fotos-\(UUID().uuidString)"
        let body = FileManager.default.temporaryDirectory.appendingPathComponent("upload-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: body) }
        FileManager.default.createFile(atPath: body.path, contents: nil)
        guard let out = try? FileHandle(forWritingTo: body), let src = try? FileHandle(forReadingFrom: file) else { return .failed }
        var head = ""
        for (k, v) in fields.sorted(by: { $0.key < $1.key }) { head += "--\(boundary)\r\nContent-Disposition: form-data; name=\"\(k)\"\r\n\r\n\(v)\r\n" }
        let mime = UTType(filenameExtension: file.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
        head += "--\(boundary)\r\nContent-Disposition: form-data; name=\"assetData\"; filename=\"\(safeFilename(name))\"\r\nContent-Type: \(mime)\r\n\r\n"
        try? out.write(contentsOf: Data(head.utf8))
        try? src.forEachChunk { try? out.write(contentsOf: $0) }
        try? out.write(contentsOf: Data("\r\n--\(boundary)--\r\n".utf8)); try? out.close(); try? src.close()
        var req = URLRequest(url: base.appendingPathComponent("api/assets"))
        req.httpMethod = "POST"; req.timeoutInterval = 600
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        req.setValue(sum, forHTTPHeaderField: "x-immich-checksum")
        let session = URLSession(configuration: .default, delegate: TrustHomeCA(), delegateQueue: nil)
        guard let (d, resp) = try? await session.upload(for: req, fromFile: body), let h = resp as? HTTPURLResponse else { return .failed }
        if h.statusCode == 200, String(data: d, encoding: .utf8)?.contains("duplicate") == true { return .duplicate }
        return (200..<300).contains(h.statusCode) ? .created : .failed
    }

    private func sha1(_ url: URL) throws -> String {
        var h = Insecure.SHA1()
        let f = try FileHandle(forReadingFrom: url)
        try f.forEachChunk { h.update(data: $0) }
        try f.close()
        return h.finalize().map { String(format: "%02x", $0) }.joined()
    }
}

/// Heimnetz-Zertifikat (wie in der App) als zusätzlicher Anker.
final class TrustHomeCA: NSObject, URLSessionDelegate {
    private let anchor: SecCertificate? = {
        guard let url = Bundle.main.url(forResource: "HeimnetzCA", withExtension: "der"), let d = try? Data(contentsOf: url) else { return nil }
        return SecCertificateCreateWithData(nil, d as CFData)
    }()
    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge) async -> (URLSession.AuthChallengeDisposition, URLCredential?) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust else { return (.performDefaultHandling, nil) }
        if SecTrustEvaluateWithError(trust, nil) { return (.useCredential, URLCredential(trust: trust)) }
        if let anchor {
            SecTrustSetAnchorCertificates(trust, [anchor] as CFArray); SecTrustSetAnchorCertificatesOnly(trust, false)
            if SecTrustEvaluateWithError(trust, nil) { return (.useCredential, URLCredential(trust: trust)) }
        }
        return (.cancelAuthenticationChallenge, nil)
    }
}

struct ShareView: View {
    let model: ShareModel
    let close: () -> Void
    var body: some View {
        NavigationStack {
            VStack(spacing: 18) {
                Image(systemName: model.finished ? "checkmark.circle.fill" : "photo.badge.arrow.down")
                    .font(.system(size: 54)).foregroundStyle(model.finished ? .green : .blue).padding(.top, 30)
                Text(title).font(.title3.bold()).multilineTextAlignment(.center)
                if model.running {
                    ProgressView(value: Double(model.done + model.duplicates + model.failed), total: Double(max(1, model.providers.count)))
                        .padding(.horizontal, 40)
                }
                if let e = model.error { Text(e).foregroundStyle(.orange).multilineTextAlignment(.center) }
                Spacer()
                if model.finished {
                    Button(String(localized: "Fertig"), action: close).buttonStyle(.borderedProminent).controlSize(.large)
                } else {
                    Button { Task { await model.upload() } } label: {
                        Label(String(localized: "Auf deinem Server sichern"), systemImage: "arrow.up.circle.fill").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent).controlSize(.large)
                    .disabled(model.running || model.providers.isEmpty || model.access == nil)
                }
            }
            .padding(24)
            .navigationTitle(String(localized: "Fotos")).navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button(String(localized: "Abbrechen"), action: close).disabled(model.running) } }
        }
        .onAppear { if model.access == nil { model.error = String(localized: "Bitte zuerst die Fotos-App öffnen und anmelden.") } }
    }
    private var title: String {
        let n = model.providers.count
        if model.finished {
            var parts = [String(localized: "\(model.done) gesichert")]
            if model.duplicates > 0 { parts.append(String(localized: "\(model.duplicates) waren schon da")) }
            if model.failed > 0 { parts.append(String(localized: "\(model.failed) fehlgeschlagen")) }
            return parts.joined(separator: " · ")
        }
        return n == 1 ? String(localized: "1 Objekt auf deinen Server sichern") : String(localized: "\(n) Objekte auf deinen Server sichern")
    }
}
