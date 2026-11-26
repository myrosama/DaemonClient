import AVFoundation
import CryptoKit
import Foundation
#if canImport(UIKit)
import UIKit
#endif
import UniformTypeIdentifiers

enum APIError: LocalizedError {
    case notLoggedIn, http(Int, String), badURL
    var errorDescription: String? {
        switch self {
        case .notLoggedIn: String(localized: "Nicht angemeldet")
        case .http(let c, let m): String(localized: "Server-Fehler \(c): \(m)")
        case .badURL: String(localized: "Ungültige Server-Adresse")
        }
    }
}

/// Spricht mit dem eigenen Immich-Server (getestet mit v3.3.5). Wer eine eigene Heimnetz-CA nutzt, legt deren
/// Zertifikat als `Resources/HeimnetzCA.der` ins Projekt – dann vertraut die App ihr zusätzlich.
final class ImmichClient: NSObject, URLSessionDelegate, @unchecked Sendable {
    static let shared = ImmichClient()

    private(set) var baseURL: URL?
    private(set) var token: String?
    private var session: URLSession!
    private let anchor: SecCertificate? = {
        guard let url = Bundle.main.url(forResource: "HeimnetzCA", withExtension: "der"),
              let data = try? Data(contentsOf: url) else { return nil }
        return SecCertificateCreateWithData(nil, data as CFData)
    }()

    let decoder = JSONDecoder()
    /// Mac: API-Antworten nie aus dem Zwischenspeicher (Immich schickt nur ETag → sonst veraltete Alben/Infos).
    nonisolated(unsafe) static var freshAPI = false

    override init() {
        super.init()
        let cfg = URLSessionConfiguration.default
        cfg.urlCache = URLCache(memoryCapacity: 64 << 20, diskCapacity: 1 << 30)   // 1 GB Bild-Cache
        cfg.requestCachePolicy = .useProtocolCachePolicy
        cfg.httpMaximumConnectionsPerHost = 8
        cfg.timeoutIntervalForRequest = 30
        session = URLSession(configuration: cfg, delegate: self, delegateQueue: nil)
        // The session now lives in the core and its Keychain item (CoreBridge, I4); a token an earlier build kept goes.
        Keychain.set(nil, for: "accessToken")
        #if DEBUG
        // Simulator-Tests: Token/Server per Startumgebung (SIMCTL_CHILD_FOTOS_*), kein Passwort-Tippen.
        let env = ProcessInfo.processInfo.environment
        if let s = env["FOTOS_SERVER"], let t = env["FOTOS_TOKEN"] { baseURL = URL(string: s); token = t }
        #endif
    }

    var isLoggedIn: Bool { baseURL != nil && token != nil }

    /// Mac-App mit mehreren Konten: gespeichertes Konto aktiv schalten (Token kommt aus dem Speicher je Konto).
    func activate(server: URL, token: String) {
        baseURL = server
        self.token = token
        videoLock.withLock { videoFallback = [:] }
    }

    /// Heimnetz/VPN statt Internet: private IPv4/IPv6-Bereiche, Tailscale (100.64/10), Namen ohne Punkt oder mit
    /// .local/.lan/.home/.internal/.home.arpa/.ts.net.
    static func isPrivateHost(_ host: String) -> Bool {
        let h = host.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        if h == "localhost" || !h.contains(".") && !h.contains(":") { return true }
        if [".local", ".lan", ".home", ".internal", ".home.arpa", ".ts.net"].contains(where: { h.hasSuffix($0) }) { return true }
        let p = h.split(separator: ".").compactMap { Int($0) }
        if p.count == 4 {
            switch (p[0], p[1]) {
            case (10, _), (127, _), (192, 168), (169, 254): return true
            case (172, 16...31), (100, 64...127): return true
            default: return false
            }
        }
        if h.contains(":") { return h == "::1" || h.hasPrefix("fc") || h.hasPrefix("fd") || h.hasPrefix("fe80") }
        return false
    }

    func logout() {
        token = nil
        Keychain.set(nil, for: "accessToken")
        videoLock.withLock { videoFallback = [:] }
        // Bilder/Antworten des Kontos nicht auf dem Gerät lassen (bis 1 GB, GitHub-Issue #8)
        session.configuration.urlCache?.removeAllCachedResponses()
        URLCache.shared.removeAllCachedResponses()
    }

    // MARK: Basis

    func url(_ path: String, query: [String: String] = [:]) throws -> URL {
        guard let baseURL else { throw APIError.notLoggedIn }
        var c = URLComponents(url: baseURL.appendingPathComponent("api/" + path), resolvingAgainstBaseURL: false)!
        if !query.isEmpty { c.queryItems = query.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) } }
        return c.url!
    }

    func authorized(_ url: URL) throws -> URLRequest {
        guard let token else { throw APIError.notLoggedIn }
        var r = URLRequest(url: url)
        r.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        return r
    }

    var authHeaders: [String: String] { token.map { ["Authorization": "Bearer \($0)"] } ?? [:] }

    /// Video vom Server für AVFoundation. Der Header-Schlüssel ist keine öffentliche API (unter iOS 27 vermutlich ignoriert
    /// → 401, schwarzes Video ohne Filmstreifen, Issue #1); darum zusätzlich Immichs Sitzungs-Cookie.
    func avAsset(_ url: URL) -> AVURLAsset {
        var opts: [String: Any] = ["AVURLAssetHTTPHeaderFieldsKey": authHeaders]
        if let token, let host = url.host(), let c = HTTPCookie(properties: [
            .domain: host, .path: "/", .name: "immich_access_token", .value: token]) {
            opts[AVURLAssetHTTPCookiesKey] = [c]
        }
        return AVURLAsset(url: url, options: opts)
    }

    func request<T: Decodable>(_ path: String, query: [String: String] = [:], method: String = "GET",
                               body: Data? = nil, auth: Bool = true) async throws -> T {
        let data = try await raw(path, query: query, method: method, body: body, auth: auth)
        return try decoder.decode(T.self, from: data)
    }

    @discardableResult
    func raw(_ path: String, query: [String: String] = [:], method: String = "GET",
             body: Data? = nil, auth: Bool = true) async throws -> Data {
        var req = auth ? try authorized(try url(path, query: query)) : URLRequest(url: try url(path, query: query))
        req.httpMethod = method
        if Self.freshAPI { req.cachePolicy = .reloadIgnoringLocalCacheData }
        if let body {
            req.httpBody = body
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, resp): (Data, URLResponse)
        do { (data, resp) = try await session.data(for: req); Connectivity.report(nil) }
        catch { Connectivity.report(error); throw error }
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(code) else {
            if code == 401 { await MainActor.run { NotificationCenter.default.post(name: .sessionExpired, object: nil) } }
            throw APIError.http(code, String(data: data, encoding: .utf8)?.prefix(200).description ?? "")
        }
        return data
    }

    func json(_ obj: Any) -> Data { (try? JSONSerialization.data(withJSONObject: obj)) ?? Data() }

    // MARK: Endpunkte

    /// Monatsliste als Rohdaten (die Zeitleiste merkt sie sich auf dem iPhone, siehe TimelineStore).
    func bucketsData() async throws -> Data {
        // withPartners: Fotos aus der Geteilten Mediathek (nur Partner mit „in Mediathek zeigen“)
        try await raw("timeline/buckets", query: ["visibility": "timeline", "withStacked": "true", "withPartners": "true"])
    }
    func bucketData(_ b: String) async throws -> Data {
        try await raw("timeline/bucket", query: ["timeBucket": b, "visibility": "timeline", "withStacked": "true", "withPartners": "true"])
    }
    /// Dekodieren außerhalb des Hauptthreads (2 000 Objekte ≈ 20 ms).
    nonisolated static func decodeBucket(_ d: Data) -> [Asset]? {
        (try? JSONDecoder().decode(BucketColumns.self, from: d))?.assets().sorted { $0.date < $1.date }
    }

    /// The worker's timeline narrowed by its own filters (`albumId`, `visibility`, `isFavorite`): every month, oldest
    /// first. (`search/metadata` reads an older request shape and ignores HomeRoll's filters.)
    func timelineAssets(_ q: [String: String]) async throws -> [Asset] {
        let months = try JSONDecoder().decode([TimeBucket].self, from: try await raw("timeline/buckets", query: q))
        var out: [Asset] = []
        for m in months {
            out += Self.decodeBucket(try await raw("timeline/bucket", query: q.merging(["timeBucket": m.timeBucket]) { $1 })) ?? []
        }
        return out.sorted { $0.date < $1.date }
    }

    func asset(_ id: String) async throws -> AssetDTO { try await request("assets/\(id)") }

    func albums() async throws -> [AlbumDTO] { try await request("albums") }
    func mapMarkers() async throws -> [MapMarkerDTO] { try await request("map/markers") }

    /// Alben, in denen ein Objekt liegt (Info-Bereich „In Alben“)
    func albums(containing id: String) async throws -> [AlbumDTO] { try await request("albums", query: ["assetId": id]) }
    func me() async throws -> UserDTO { try await request("users/me") }

    // MARK: Mehrfach-Aktionen (Auswahl)

    func update(_ ids: [String], _ fields: [String: Any]) async throws {
        var body = fields; body["ids"] = ids
        try await raw("assets", method: "PUT", body: json(body))
    }

    /// Aufnahmezeit mit Zeitzone (z. B. 2026-11-12T20:05:22-08:00) für ein frisch hochgeladenes Objekt setzen.
    /// Der Server liest die Metadaten der Datei erst einige Sekunden nach dem Hochladen aus und überschreibt dabei
    /// einen zu früh gesetzten Wert (Datei ohne Datum → UTC). Deshalb: setzen, prüfen, bei Bedarf wiederholen.
    /// Läuft für sich, damit Sichern/Bearbeiten nicht warten müssen.
    nonisolated func setCaptureTime(_ id: String, _ when: String) {
        let wall = String(when.prefix(19))   // Ortszeit ohne Versatz, z. B. 2026-11-12T20:05:22
        Task.detached {
            for wait in [0, 3, 6, 12, 30] {
                if wait > 0 { try? await Task.sleep(for: .seconds(wait)) }
                try? await self.update([id], ["dateTimeOriginal": when])
                try? await Task.sleep(for: .seconds(2))
                if let dto = try? await self.asset(id), dto.localDateTime?.hasPrefix(wall) == true,
                   dto.exifInfo?.timeZone != nil { return }
            }
        }
    }

    func addToAlbum(_ albumID: String, _ ids: [String]) async throws {
        try await raw("albums/\(albumID)/assets", method: "PUT", body: json(["ids": ids]))
    }

    @discardableResult
    func createAlbum(_ name: String, _ ids: [String]) async throws -> AlbumDTO {
        try await request("albums", method: "POST", body: json(["albumName": name, "assetIds": ids] as [String: Any]))
    }

    /// Titel, Schlüsselfoto (`albumThumbnailAssetId`) oder Sortierung (`order`: asc/desc) ändern.
    func updateAlbum(_ id: String, _ fields: [String: Any]) async throws {
        try await raw("albums/\(id)", method: "PATCH", body: json(fields))
    }
    /// Löscht nur das Album – die Fotos bleiben in der Mediathek.
    func deleteAlbum(_ id: String) async throws { try await raw("albums/\(id)", method: "DELETE") }
    func removeFromAlbum(_ id: String, _ ids: [String]) async throws {
        try await raw("albums/\(id)/assets", method: "DELETE", body: json(["ids": ids]))
    }
    func albumAssets(_ id: String) async throws -> [Asset] { try await timelineAssets(["albumId": id]) }
    func albumMarkers(_ id: String) async throws -> [MapMarkerDTO] { try await request("albums/\(id)/map-markers") }

    // MARK: Backup

    /// Kennt der Server die Datei schon (SHA1)? → vorhandene ID, sonst nil.
    func bulkUploadCheck(id: String, checksum: String) async throws -> String? {
        struct R: Decodable { struct Item: Decodable { let action: String; let assetId: String?; let isTrashed: Bool? }; let results: [Item] }
        let r: R = try await request("assets/bulk-upload-check", method: "POST",
                                     body: json(["assets": [["id": id, "checksum": checksum]]]))
        guard let i = r.results.first, i.action == "reject", let a = i.assetId, i.isTrashed != true else { return nil }
        return a
    }

    struct UploadResult: Decodable { let id: String; let status: String }

    /// Lädt eine Datei vom Datenträger hoch (Multipart wird als Datei gebaut – auch große Videos ohne viel Speicher).
    func uploadAsset(file: URL, filename: String, uti: String, fields: [String: String],
                     checksum: String, expensive: Bool) async throws -> UploadResult {
        let body = FileManager.default.temporaryDirectory.appendingPathComponent("upload-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: body) }
        let req = try prepareUpload(file: file, filename: filename, uti: uti, fields: fields, checksum: checksum,
                                    expensive: expensive, body: body)
        let (d, resp) = try await session.upload(for: req, fromFile: body)
        return try uploadResult(d, resp)
    }

    /// Multipart-Rumpf nach `body` schreiben und die passende Anfrage bauen (auch für die Hintergrund-Übertragung).
    func prepareUpload(file: URL, filename: String, uti: String, fields: [String: String],
                       checksum: String, expensive: Bool, body: URL) throws -> URLRequest {
        let boundary = "fotos-\(UUID().uuidString)"
        FileManager.default.createFile(atPath: body.path, contents: nil)
        let out = try FileHandle(forWritingTo: body)
        var head = ""
        for (k, v) in fields.sorted(by: { $0.key < $1.key }) {
            head += "--\(boundary)\r\nContent-Disposition: form-data; name=\"\(k)\"\r\n\r\n\(v)\r\n"
        }
        let mime = UTType(uti)?.preferredMIMEType ?? "application/octet-stream"
        head += "--\(boundary)\r\nContent-Disposition: form-data; name=\"assetData\"; filename=\"\(safeFilename(filename))\"\r\nContent-Type: \(mime)\r\n\r\n"
        try out.write(contentsOf: Data(head.utf8))
        let src = try FileHandle(forReadingFrom: file)
        // stückweise mit autoreleasepool (sonst bleibt die ganze Datei im Speicher, siehe App/Core/FileChunks.swift)
        while try autoreleasepool(invoking: {
            guard let chunk = try src.read(upToCount: 4 << 20), !chunk.isEmpty else { return false }
            try out.write(contentsOf: chunk); return true
        }) {}
        try src.close()
        try out.write(contentsOf: Data("\r\n--\(boundary)--\r\n".utf8))
        try out.close()

        var req = try authorized(try url("assets"))
        req.httpMethod = "POST"
        req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        req.setValue(checksum, forHTTPHeaderField: "x-immich-checksum")
        req.timeoutInterval = 600
        req.allowsExpensiveNetworkAccess = expensive
        req.allowsConstrainedNetworkAccess = expensive
        return req
    }

    func uploadResult(_ d: Data, _ resp: URLResponse?) throws -> UploadResult {
        guard let h = resp as? HTTPURLResponse, (200..<300).contains(h.statusCode) else {
            throw APIError.http((resp as? HTTPURLResponse)?.statusCode ?? 0, String(data: d, encoding: .utf8)?.prefix(200).description ?? "")
        }
        return try decoder.decode(UploadResult.self, from: d)
    }

    func setFavorite(_ id: String, _ fav: Bool) async throws {
        try await raw("assets/\(id)", method: "PUT", body: json(["isFavorite": fav]))
    }

    /// Endgültig löschen (nur aus „Zuletzt gelöscht“ heraus anbieten).
    func deleteForever(_ ids: [String]) async throws {
        try await raw("assets", method: "DELETE", body: json(["ids": ids, "force": true] as [String: Any]))
    }

    // MARK: Medien-URLs

    enum Size: String { case thumbnail, preview, fullsize, original }

    /// Immer die bearbeitete Fassung (ohne Bearbeitung = Original); `v` umgeht den 1-Tages-Cache nach Änderungen.
    func thumbnailURL(_ id: String, _ size: Size = .thumbnail) -> URL? {
        var q = ["size": size.rawValue, "edited": "true"]
        if let v = ImageCache.shared.version(id) { q["v"] = v }
        return try? url("assets/\(id)/thumbnail", query: q)
    }
    func videoURL(_ id: String) -> URL? {
        videoLock.withLock { videoFallback[id] } ?? (try? url("assets/\(id)/video/playback"))
    }

    // MARK: Videos, die iOS nicht abspielen kann

    private let videoLock = NSLock()
    private var videoFallback: [String: URL] = [:]

    /// Ausweg, wenn die Wiedergabedatei auf dem iPhone nicht abspielbar ist (HEVC mit Kennung „hev1“ statt „hvc1“,
    /// VP9, AV1, MKV: Laufzeit lesbar, Bild schwarz – Issue #1): dann das Original (falls nur die umgewandelte
    /// Datei nicht passt). nil = auch das nicht.
    func playableFallback(for id: String) async -> AVURLAsset? {
        for u in [originalURL(id)].compactMap({ $0 }) {
            let a = avAsset(u)
            if (try? await a.load(.isPlayable)) == true {
                videoLock.withLock { videoFallback[id] = u }
                return a
            }
        }
        return nil
    }

    /// Für die Video-Diagnose: Status, Typ, Größe und Antwortzeit einer Adresse (lädt nur die ersten zwei Bytes).
    func probe(_ url: URL) async -> String {
        var req = URLRequest(url: url, timeoutInterval: 30)
        req.setValue("bytes=0-1", forHTTPHeaderField: "Range")
        for (k, v) in authHeaders { req.setValue(v, forHTTPHeaderField: k) }
        let t = Date()
        let ms = { "\(Int(Date().timeIntervalSince(t) * 1000)) ms" }
        do {
            let (_, resp) = try await session.data(for: req)
            guard let h = resp as? HTTPURLResponse else { return "no http response, \(ms())" }
            let total = h.value(forHTTPHeaderField: "Content-Range")?.split(separator: "/").last.map(String.init)
                ?? h.value(forHTTPHeaderField: "Content-Length") ?? "?"
            let size = Double(total).map { $0 < 1_000_000 ? String(format: "%.0f KB", $0 / 1000) : String(format: "%.1f MB", $0 / 1_000_000) } ?? total
            return "\(h.statusCode) \(h.value(forHTTPHeaderField: "Content-Type") ?? "?") \(size), \(ms())"
        } catch {
            let e = error as NSError
            return "error \(e.domain) \(e.code), \(ms())"
        }
    }

    func originalURL(_ id: String, edited: Bool = true) -> URL? {
        try? url("assets/\(id)/original", query: ["edited": edited ? "true" : "false"])
    }

    func data(_ url: URL) async throws -> Data {
        let (d, resp): (Data, URLResponse)
        do { (d, resp) = try await session.data(for: try authorized(url)); Connectivity.report(nil) }
        catch { Connectivity.report(error); throw error }
        guard let h = resp as? HTTPURLResponse, (200..<300).contains(h.statusCode) else {
            throw APIError.http((resp as? HTTPURLResponse)?.statusCode ?? 0, "Medien")
        }
        return d
    }

    // MARK: TLS – Heimnetz-CA als zusätzlicher Anker

    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge) async
        -> (URLSession.AuthChallengeDisposition, URLCredential?) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust else { return (.performDefaultHandling, nil) }
        if SecTrustEvaluateWithError(trust, nil) { return (.useCredential, URLCredential(trust: trust)) }
        if let anchor {
            SecTrustSetAnchorCertificates(trust, [anchor] as CFArray)
            SecTrustSetAnchorCertificatesOnly(trust, false)
            if SecTrustEvaluateWithError(trust, nil) { return (.useCredential, URLCredential(trust: trust)) }
        }
        return (.cancelAuthenticationChallenge, nil)
    }
}

extension Notification.Name {
    static let sessionExpired = Notification.Name("sessionExpired")
}
