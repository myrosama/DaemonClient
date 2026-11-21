import AVFoundation
import CryptoKit
import Foundation
#if canImport(UIKit)
import UIKit
#endif
import UniformTypeIdentifiers

enum APIError: LocalizedError {
    case notLoggedIn, http(Int, String), badURL, emailAsServer, notImmich, insecureServer
    var errorDescription: String? {
        switch self {
        case .notLoggedIn: String(localized: "Nicht angemeldet")
        case .http(let c, let m): String(localized: "Server-Fehler \(c): \(m)")
        case .badURL: String(localized: "Ungültige Server-Adresse")
        case .emailAsServer: String(localized: "Das ist eine E-Mail-Adresse. Ins erste Feld gehört die Adresse deines Immich-Servers, z. B. http://192.168.1.20:2283")
        case .notImmich: String(localized: "Unter dieser Adresse antwortet kein Immich-Server. Stimmen Adresse und Port (meist 2283)?")
        case .insecureServer: String(localized: "Diese Adresse liegt im Internet, aber ohne https – Passwort und Fotos gingen unverschlüsselt durchs Netz. Bitte https:// verwenden (z. B. über einen Reverse-Proxy) oder per VPN die Heimnetz-Adresse.")
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
        // Der Schlüsselbund überlebt das Löschen der App, die Einstellungen nicht: Token ohne gültigen gespeicherten
        // Server stammen aus einer früheren Installation (oder 1.0.1 hat Eingaben zu früh gespeichert) → nicht nutzen,
        // sonst startet die App angemeldet mit kaputter Adresse und kommt nie zum Login (Issue #1). Die nächste
        // Anmeldung überschreibt das Token.
        if let s = UserDefaults.standard.string(forKey: "serverURL"), let u = Self.validBase(s) { baseURL = u }
        else { UserDefaults.standard.removeObject(forKey: "serverURL") }
        token = baseURL != nil ? Keychain.get("accessToken") : nil
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
        videoLock.withLock { videoFallback = [:]; realtimeHLS = nil }
    }

    // MARK: Anmeldung

    func login(server: String, email: String, password: String) async throws -> LoginResponse {
        let url = try await findServer(server)
        let r: LoginResponse = try await publicJSON(url, "auth/login", body: ["email": email, "password": password])
        adopt(url, r)
        return r
    }

    /// Erst nach erfolgreicher Anmeldung Server und Token übernehmen und merken.
    private func adopt(_ url: URL, _ r: LoginResponse) {
        baseURL = url
        token = r.accessToken
        UserDefaults.standard.set(url.absoluteString, forKey: "serverURL")
        Keychain.set(r.accessToken, for: "accessToken")
    }

    // MARK: Anmeldung per SSO (OAuth) – wie die Immich-App. Nötig bei Servern ohne Passwort-Anmeldung, z. B. bei
    // Immich-Anbietern wie PixelUnion („Login with …“).

    struct LoginOptions: Sendable { let password: Bool; let sso: Bool; let ssoTitle: String? }
    struct SSOFlow: Sendable { let base: URL; let url: URL; let state: String; let verifier: String }
    /// Rücksprung-Adresse der Immich-App: beim Anbieter ohnehin freigeschaltet, Immich-Server kennen sie
    static let ssoScheme = "app.immich"
    private static let ssoRedirect = "app.immich:///oauth-callback"

    /// Was die Anmeldeseite des Servers anbietet (öffentlich abrufbar, ohne Anmeldung).
    func loginOptions(server: String) async throws -> LoginOptions {
        let url = try await findServer(server)
        struct Features: Decodable { let oauth: Bool?; let passwordLogin: Bool? }
        struct Config: Decodable { let oauthButtonText: String? }
        let f: Features = try await publicJSON(url, "server/features")
        let c: Config? = try? await publicJSON(url, "server/config")
        return LoginOptions(password: f.passwordLogin ?? true, sso: f.oauth ?? false,
                            ssoTitle: c?.oauthButtonText.flatMap { $0.isEmpty ? nil : $0 })
    }

    /// Schritt 1: Anmeldeseite des Anbieters holen – mit eigenem state und PKCE (S256), wie die Immich-App.
    func ssoStart(server: String) async throws -> SSOFlow {
        let base = try await findServer(server)
        let state = Self.randomKey(32), verifier = Self.randomKey(64)
        let challenge = Self.base64URL(Data(SHA256.hash(data: Data(verifier.utf8))))
        struct Start: Decodable { let url: String }
        let r: Start = try await publicJSON(base, "oauth/authorize",
                                            body: ["redirectUri": Self.ssoRedirect, "state": state, "codeChallenge": challenge])
        guard let u = URL(string: r.url) else { throw APIError.badURL }
        return SSOFlow(base: base, url: u, state: state, verifier: verifier)
    }

    /// Schritt 2: Rücksprung des Anbieters beim eigenen Server gegen ein Token einlösen.
    func ssoFinish(_ flow: SSOFlow, callback: URL) async throws -> LoginResponse {
        var s = callback.absoluteString
        // iOS liefert die Adresse teils mit nur einem Schrägstrich zurück
        if s.hasPrefix("app.immich:/oauth-callback") { s = Self.ssoRedirect + s.dropFirst("app.immich:/oauth-callback".count) }
        let r: LoginResponse = try await publicJSON(flow.base, "oauth/callback",
                                                    body: ["url": s, "state": flow.state, "codeVerifier": flow.verifier])
        adopt(flow.base, r)
        return r
    }

    private static func randomKey(_ bytes: Int) -> String {
        var b = [UInt8](repeating: 0, count: bytes)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes, &b)
        return base64URL(Data(b))
    }
    private static func base64URL(_ d: Data) -> String {
        d.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    /// Anfrage an einen (noch nicht übernommenen) Server ohne Anmeldung – für Anmeldung und Anmeldeseite.
    private func publicJSON<T: Decodable>(_ base: URL, _ path: String, body: [String: Any]? = nil) async throws -> T {
        var req = URLRequest(url: base.appendingPathComponent("api").appendingPathComponent(path), timeoutInterval: 20)
        if let body {
            req.httpMethod = "POST"
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, resp) = try await session.data(for: req)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(code) else {
            let msg = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["message"] as? String
            throw APIError.http(code, msg ?? "")
        }
        return try decoder.decode(T.self, from: data)
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

    /// http(s)-Adresse mit Rechnername und ohne Benutzerteil („test@email.com“ wäre sonst Benutzer test auf email.com).
    static func validBase(_ s: String) -> URL? {
        guard let u = URL(string: s), ["http", "https"].contains(u.scheme?.lowercased() ?? ""),
              let h = u.host(), !h.isEmpty, u.user == nil else { return nil }
        return u
    }

    /// Eingabe → Server-Adresse, unter der wirklich Immich antwortet. Ohne http(s):// erst https, dann http (Heimnetz).
    private func findServer(_ input: String) async throws -> URL {
        var s = input.trimmingCharacters(in: .whitespacesAndNewlines)
        while s.hasSuffix("/") { s.removeLast() }
        if s.lowercased().hasSuffix("/api") { s.removeLast(4) }
        let hasScheme = s.lowercased().hasPrefix("http://") || s.lowercased().hasPrefix("https://")
        // http nur im eigenen Netz (Heimnetz, VPN, Tailscale) – im Internet nie unverschlüsselt (GitHub-Issue #11)
        var tries = (hasScheme ? [s] : ["https://" + s, "http://" + s]).compactMap(Self.validBase)
        guard !tries.isEmpty else { throw s.contains("@") && !s.contains("/") ? APIError.emailAsServer : APIError.badURL }
        tries = tries.filter { $0.scheme?.lowercased() == "https" || Self.isPrivateHost($0.host() ?? "") }
        guard !tries.isEmpty else { throw APIError.insecureServer }
        var reached = false, lastError: Error?
        for u in tries {
            var req = URLRequest(url: u.appendingPathComponent("api/server/ping"))
            req.timeoutInterval = 10
            do {
                let (data, resp) = try await session.data(for: req)
                if (resp as? HTTPURLResponse)?.statusCode == 200,
                   (try? JSONDecoder().decode([String: String].self, from: data))?["res"] == "pong" { return u }
                reached = true
            } catch { lastError = error }
        }
        // Hat irgendein Server geantwortet (nur eben nicht Immich), ist das die nützlichere Meldung als ein Netzfehler
        throw reached ? APIError.notImmich : (lastError ?? APIError.notImmich)
    }

    func logout() {
        token = nil
        Keychain.set(nil, for: "accessToken")
        videoLock.withLock { videoFallback = [:]; realtimeHLS = nil }
        AppGroup.saveAccess(nil)
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

    func asset(_ id: String) async throws -> AssetDTO { try await request("assets/\(id)") }

    func memories() async throws -> [MemoryDTO] {
        let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"; f.locale = Locale(identifier: "en_US_POSIX")
        return try await request("memories", query: ["for": f.string(from: Date())])
    }

    func albums() async throws -> [AlbumDTO] { try await request("albums") }
    /// Ordner, in denen der Server Fotos ablegt (externe Bibliotheken: echte Ordnerstruktur)
    func folderPaths() async throws -> [String] { try await request("view/folder/unique-paths") }
    /// Fotos direkt in einem Ordner (ohne Unterordner)
    func folderAssets(_ path: String) async throws -> [AssetDTO] { try await request("view/folder", query: ["path": path]) }
    func people() async throws -> [PersonDTO] {
        let p: PeopleDTO = try await request("people", query: ["withHidden": "false"])
        return p.people.filter { !($0.isHidden ?? false) }
    }
    func mapMarkers() async throws -> [MapMarkerDTO] { try await request("map/markers") }
    /// Freigabelink mit allen Optionen aus Immichs Dialog (Beschreibung, Passwort, Ablauf, Metadaten, Herunterladen,
    /// Hochladen, eigener Name). Mit Namen lautet die Adresse …/s/<name>, sonst …/share/<Schlüssel>.
    /// Mit `album` entsteht ein Album-Link (type ALBUM), sonst ein Link auf genau diese Objekte.
    func createShareLink(_ ids: [String], album: String? = nil, options o: ShareLinkOptions) async throws -> URL {
        struct Link: Decodable { let key: String; let slug: String? }
        var body: [String: Any] = ["allowDownload": o.allowDownload, "allowUpload": album != nil && o.allowUpload,
                                   "showMetadata": o.showMetadata]
        if let album { body["type"] = "ALBUM"; body["albumId"] = album } else { body["type"] = "INDIVIDUAL"; body["assetIds"] = ids }
        let text = o.description.trimmingCharacters(in: .whitespacesAndNewlines)
        if !text.isEmpty { body["description"] = text }
        if !o.password.isEmpty { body["password"] = o.password }
        if let d = o.expiresAt { body["expiresAt"] = ISO8601DateFormatter().string(from: d) }
        let slug = o.cleanSlug
        if !slug.isEmpty { body["slug"] = slug }
        let l: Link = try await request("shared-links", method: "POST", body: json(body))
        guard let url = await linkURL(key: l.key, slug: l.slug) else { throw APIError.badURL }
        return url
    }

    /// Adresse eines Links (Server-Einstellung „externe Domain“, sonst die Anmelde-Adresse).
    func linkURL(key: String, slug: String?) async -> URL? {
        struct Config: Decodable { let externalDomain: String? }
        let cfg: Config? = try? await request("server/config")
        guard let base = cfg?.externalDomain.flatMap({ $0.isEmpty ? nil : URL(string: $0) }) ?? baseURL else { return nil }
        if let s = slug, !s.isEmpty { return base.appendingPathComponent("s").appendingPathComponent(s) }
        return base.appendingPathComponent("share").appendingPathComponent(key)
    }

    /// Aktive (nicht abgelaufene) Einzel-Links, die mindestens eines dieser Objekte enthalten – oder mit `album` die Links dieses Albums.
    func sharedLinks(containing ids: [String], album: String? = nil) async throws -> [SharedLinkDTO] {
        let all: [SharedLinkDTO] = try await request("shared-links")
        let want = Set(ids)
        return all.filter {
            guard $0.isActive else { return false }
            if let album { return $0.type == "ALBUM" && $0.album?.id == album }
            return $0.type == "INDIVIDUAL" && ($0.assets ?? []).contains { want.contains($0.id) }
        }
            .sorted { ($0.expires ?? .distantFuture) < ($1.expires ?? .distantFuture) }
    }

    /// Link ändern (PATCH). Leeres Passwortfeld = unverändert, „Passwort entfernen“ schickt „“.
    func updateSharedLink(_ id: String, options o: ShareLinkOptions, hadSlug: Bool) async throws {
        var body: [String: Any] = ["description": o.description.trimmingCharacters(in: .whitespacesAndNewlines),
                                   "allowDownload": o.allowDownload, "allowUpload": o.allowUpload,
                                   "showMetadata": o.showMetadata, "changeExpiryTime": true]
        if let d = o.expiresAt { body["expiresAt"] = ISO8601DateFormatter().string(from: d) }
        if o.removePassword { body["password"] = "" } else if !o.password.isEmpty { body["password"] = o.password }
        let slug = o.cleanSlug
        if !slug.isEmpty { body["slug"] = slug } else if hadSlug { body["slug"] = NSNull() }
        try await raw("shared-links/\(id)", method: "PATCH", body: json(body))
    }

    func deleteSharedLink(_ id: String) async throws { try await raw("shared-links/\(id)", method: "DELETE") }
    /// Werte für Suchvorschläge (type: country | state | city | camera-make | camera-model)
    func suggestions(_ type: String) async throws -> [String] { try await request("search/suggestions", query: ["type": type]) }
    /// IDs geteilter Alben (die Liste „Alben mit Foto X“ liefert `shared` nicht zuverlässig)
    func sharedAlbumIDs() async -> Set<String> {
        let list: [AlbumDTO] = (try? await request("albums", query: ["shared": "true"])) ?? []
        return Set(list.filter { $0.shared == true }.map(\.id))
    }
    /// Kommentare und Likes zu einem Foto in einem geteilten Album
    func activities(album: String, asset: String) async throws -> [ActivityDTO] {
        try await request("activities", query: ["albumId": album, "assetId": asset])
    }
    func addActivity(album: String, asset: String, comment: String?) async throws -> ActivityDTO {
        var b: [String: Any] = ["albumId": album, "assetId": asset, "type": comment == nil ? "like" : "comment"]
        if let comment { b["comment"] = comment }
        return try decoder.decode(ActivityDTO.self, from: try await raw("activities", method: "POST", body: json(b)))
    }
    func deleteActivity(_ id: String) async throws { _ = try await raw("activities/\(id)", method: "DELETE") }

    /// Alben, in denen ein Objekt liegt (Info-Bereich „In Alben“)
    func albums(containing id: String) async throws -> [AlbumDTO] { try await request("albums", query: ["assetId": id]) }
    func allPeople(withHidden: Bool) async throws -> [PersonDTO] {
        let p: PeopleDTO = try await request("people", query: ["withHidden": withHidden ? "true" : "false", "size": "1000"])
        return p.people
    }
    func updatePerson(_ id: String, _ fields: [String: Any]) async throws {
        try await raw("people/\(id)", method: "PUT", body: json(fields))
    }
    /// `others` gehen in `id` auf (Immich: POST /people/{id}/merge)
    func mergePeople(into id: String, _ others: [String]) async throws {
        try await raw("people/\(id)/merge", method: "POST", body: json(["ids": others]))
    }
    func cities() async throws -> [AssetDTO] { try await request("search/cities") }
    func me() async throws -> UserDTO { try await request("users/me") }

    /// Anzahl Fotos und Videos in der Mediathek (für die Fußzeile wie in Apples Fotos-App).
    func statistics() async -> (images: Int, videos: Int)? {
        struct S: Decodable { let images: Int; let videos: Int }
        guard let s: S = try? await request("assets/statistics", query: ["visibility": "timeline"]) else { return nil }
        return (s.images, s.videos)
    }

    /// Metadaten-Suche mit dem neuen Filter-Objekt (v3.2+), blättert über `nextCursor` bis `size`.
    @MainActor func search(filter: [String: Any], size: Int = 250, order: String = "desc") async throws -> [AssetDTO] {
        try await searchPage(filter: filter, size: size, order: order).items
    }

    /// Wie `search`, gibt aber den Cursor für die nächste Seite zurück (nil = alles geholt) – für „Mehr laden“.
    @MainActor func searchPage(filter: [String: Any], size: Int, cursor start: String? = nil,
                               order: String = "desc") async throws -> (items: [AssetDTO], next: String?) {
        let filter = Self.visible(filter)
        var out: [AssetDTO] = []
        var cursor = start
        repeat {
            var body: [String: Any] = ["filter": filter, "size": min(1000, size - out.count), "withExif": true,
                                       "orderBy": ["field": "fileCreatedAt", "direction": order]]
            if let cursor { body["cursor"] = cursor }
            let r: SearchResponseDTO = try await request("search/metadata", method: "POST", body: json(body))
            out += r.assets.items
            cursor = r.assets.nextCursor
        } while cursor != nil && out.count < size
        return (out, cursor)
    }

    /// Ohne eigene Sichtbarkeit nur die Mediathek: Immich liefert sonst auch die Videoteile der Live Photos
    /// („hidden“) und Ausgeblendetes („archive“) mit.
    static func visible(_ f: [String: Any]) -> [String: Any] {
        guard f["visibility"] == nil, f["trashedAt"] == nil else { return f }
        var f = f; f["visibility"] = ["eq": "timeline"]; return f
    }

    /// KI-Suche (mehrsprachiges Bild-Text-Modell auf dem Server); optional mit zusätzlichem Filter.
    @MainActor func smartSearch(_ query: String, filter: [String: Any] = [:], size: Int = 120) async throws -> [AssetDTO] {
        let body: [String: Any] = ["query": query, "size": size, "withExif": true, "filter": Self.visible(filter)]
        let r: SearchResponseDTO = try await request("search/smart", method: "POST", body: json(body))
        return r.assets.items
    }

    /// Zusatzdienste neben Immich (Ordner server/): direkt über ihren Port (http://<server>:<port>) oder über den
    /// Reverse-Proxy unter /fotos-dienst/<name> (siehe server/README.md).
    func serviceURL(_ name: String, port: Int) -> URL? {
        guard let base = baseURL, var c = URLComponents(url: base, resolvingAgainstBaseURL: false) else { return nil }
        if c.port == 2283 { c.port = port; c.path = "/\(name)" } else { c.path = "/fotos-dienst/\(name)" }
        return c.url
    }

    /// Welche KI-Treffer wirklich passen (Relevanz-Dienst auf Port 2284 neben Immich, siehe server/relevanz.py).
    /// nil = Dienst nicht erreichbar → App zeigt dann die ungeprüfte Liste.
    func relevant(_ query: String, ids: [String]) async -> Set<String>? {
        guard !ids.isEmpty, let url = serviceURL("relevanz", port: 2284), var req = try? authorized(url) else { return nil }
        req.httpMethod = "POST"; req.timeoutInterval = 8
        req.httpBody = json(["query": query, "ids": ids] as [String: Any])
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        struct R: Decodable { let keep: [String] }
        guard let (data, resp) = try? await session.data(for: req), (resp as? HTTPURLResponse)?.statusCode == 200,
              let r = try? decoder.decode(R.self, from: data) else { return nil }
        return Set(r.keep)
    }

    /// Heikle Fotos unter `ids` (Relevanz-Dienst rechnet fehlende KI-Merkmale selbst nach, ~3 s je Foto).
    /// nil = Dienst nicht erreichbar.
    func sensitive(_ ids: [String], queries: [String]) async -> Set<String>? {
        guard !ids.isEmpty, let url = serviceURL("relevanz", port: 2284), var req = try? authorized(url) else { return nil }
        req.httpMethod = "POST"; req.timeoutInterval = 240
        req.httpBody = json(["check": ids, "queries": queries] as [String: Any])
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        struct R: Decodable { let flagged: [String] }
        guard let (data, resp) = try? await session.data(for: req), (resp as? HTTPURLResponse)?.statusCode == 200,
              let r = try? decoder.decode(R.self, from: data) else { return nil }
        return Set(r.flagged)
    }

    /// „Ist das X?“: noch nicht zugeordnete Gesichter, die dieser Person ähneln (Relevanz-Dienst, server/relevanz.py).
    struct FaceSuggestion: Decodable, Identifiable, Hashable {
        let faceId: String
        let assetId: String
        let distance: Double
        let box: [Int]       // x1, y1, x2, y2 in Pixeln von `size`
        let size: [Int]      // Breite, Höhe des Bildes, auf dem das Gesicht erkannt wurde
        var id: String { faceId }
    }
    func similarFaces(_ personId: String) async -> [FaceSuggestion]? {
        guard let url = serviceURL("relevanz", port: 2284), var req = try? authorized(url) else { return nil }
        req.httpMethod = "POST"; req.timeoutInterval = 15
        req.httpBody = json(["personId": personId])
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        struct R: Decodable { let faces: [FaceSuggestion] }
        guard let (data, resp) = try? await session.data(for: req), (resp as? HTTPURLResponse)?.statusCode == 200,
              let r = try? decoder.decode(R.self, from: data) else { return nil }
        return r.faces
    }
    /// „Nicht diese Person“ (REA: PXPhotoKitNotThisPersonActionPerformer): Immich kennt kein Lösen eines Gesichts –
    /// wie die Immich-Weboberfläche kommt das Gesicht zu einer neuen, unbenannten Person (leere räumt Immich selbst weg).
    func notThisPerson(asset: String, person: String) async throws {
        struct Face: Decodable { let id: String; let person: P?; struct P: Decodable { let id: String } }
        let faces: [Face] = try await request("faces", query: ["id": asset])
        guard let face = faces.first(where: { $0.person?.id == person }) else { return }
        struct NewPerson: Decodable { let id: String }
        let fresh: NewPerson = try await request("people", method: "POST", body: json([String: String]()))
        try await assignFace(face.id, to: fresh.id)
    }

    /// Gesicht einer Person zuordnen (Immich: PUT /faces/{personId}, Gesicht im Body).
    func assignFace(_ faceId: String, to personId: String) async throws {
        try await raw("faces/\(personId)", method: "PUT", body: json(["id": faceId]))
    }

    /// Bereinigen (Objekte entfernen) über den Dienst auf Port 2285 neben Immich (server/bereinigen).
    func cleanup(image: Data, mask: Data) async -> Data? {
        guard let url = serviceURL("bereinigen", port: 2285), var req = try? authorized(url) else { return nil }
        let boundary = "fotos-\(UUID().uuidString)"
        var body = Data()
        for (name, file, type, d) in [("image", "bild.jpg", "image/jpeg", image), ("mask", "maske.png", "image/png", mask)] {
            body.append("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(name)\"; filename=\"\(safeFilename(file))\"\r\nContent-Type: \(type)\r\n\r\n".data(using: .utf8)!)
            body.append(d); body.append("\r\n".data(using: .utf8)!)
        }
        body.append("--\(boundary)--\r\n".data(using: .utf8)!)
        req.httpMethod = "POST"; req.timeoutInterval = 120
        req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        guard let (d, resp) = try? await session.upload(for: req, from: body), (resp as? HTTPURLResponse)?.statusCode == 200 else { return nil }
        return d
    }

    func tags() async throws -> [TagDTO] { try await request("tags") }

    /// Legt Tags (Pfad „Kategorie/Bearbeitet“) an und hängt sie an Objekte.
    func tag(_ ids: [String], with path: String) async throws {
        let tags: [TagDTO] = try await request("tags", method: "PUT", body: json(["tags": [path]]))
        guard let t = tags.first(where: { $0.value == path }) else { return }
        try await raw("tags/assets", method: "PUT", body: json(["tagIds": [t.id], "assetIds": ids]))
    }

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
    func albumAssets(_ id: String) async throws -> [AssetDTO] {
        try await search(filter: ["albumIds": ["any": [id]]], size: 20000, order: "asc")
    }
    func albumMarkers(_ id: String) async throws -> [MapMarkerDTO] { try await request("albums/\(id)/map-markers") }

    // MARK: Bearbeiten

    /// Zuschneiden/Drehen/Spiegeln macht der Server selbst (nicht-destruktiv, Original bleibt).
    func setEdits(_ id: String, _ edits: [[String: Any]]) async throws {
        try await raw("assets/\(id)/edits", method: "PUT", body: json(["edits": edits]))
    }
    func removeEdits(_ id: String) async throws { try await raw("assets/\(id)/edits", method: "DELETE") }

    func setMetadata(_ id: String, key: String, value: [String: Any]) async throws {
        try await raw("assets/\(id)/metadata", method: "PUT", body: json(["items": [["key": key, "value": value]]]))
    }
    func metadata(_ id: String, key: String) async -> [String: Any]? {
        guard let d = try? await raw("assets/\(id)/metadata/\(key)"),
              let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { return nil }
        return o["value"] as? [String: Any]
    }

    func createStack(_ ids: [String]) async throws {
        try await raw("stacks", method: "POST", body: json(["assetIds": ids]))
    }
    func deleteStack(_ id: String) async throws { try await raw("stacks/\(id)", method: "DELETE") }

    /// Lädt eine Datei hoch (bearbeitete Fassung) und gibt die neue ID zurück.
    func upload(_ data: Data, filename: String, created: String, mime: String = "image/jpeg") async throws -> String {
        let boundary = "fotos-\(UUID().uuidString)"
        var body = Data()
        func field(_ name: String, _ value: String) {
            body.append("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(name)\"\r\n\r\n\(value)\r\n".data(using: .utf8)!)
        }
        field("fileCreatedAt", created); field("fileModifiedAt", ISO8601DateFormatter().string(from: Date())); field("filename", filename)
        body.append("--\(boundary)\r\nContent-Disposition: form-data; name=\"assetData\"; filename=\"\(safeFilename(filename))\"\r\nContent-Type: \(mime)\r\n\r\n".data(using: .utf8)!)
        body.append(data); body.append("\r\n--\(boundary)--\r\n".data(using: .utf8)!)
        var req = try authorized(try url("assets"))
        req.httpMethod = "POST"
        req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        req.timeoutInterval = 300
        let (d, resp) = try await session.upload(for: req, from: body)
        guard let h = resp as? HTTPURLResponse, (200..<300).contains(h.statusCode),
              let o = try JSONSerialization.jsonObject(with: d) as? [String: Any], let id = o["id"] as? String else {
            throw APIError.http((resp as? HTTPURLResponse)?.statusCode ?? 0, String(data: d, encoding: .utf8) ?? "")
        }
        return id
    }
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
        // stückweise mit autoreleasepool (sonst bleibt die ganze Datei im Speicher, siehe Shared/FileChunks.swift)
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

    func duplicates() async throws -> [DuplicateGroupDTO] { try await request("duplicates") }

    /// Behält `keep`, verschiebt die übrigen der Gruppe in „Zuletzt gelöscht“.
    func resolveDuplicate(_ g: DuplicateGroupDTO, keep: [String]) async throws {
        let trash = g.assets.map(\.id).filter { !keep.contains($0) }
        try await raw("duplicates/resolve", method: "POST",
                      body: json(["groups": [["duplicateId": g.duplicateId, "keepAssetIds": keep, "trashAssetIds": trash]]]))
    }

    func random(size: Int = 12) async throws -> [AssetDTO] {
        try await request("search/random", method: "POST", body: json(["size": size, "withExif": true] as [String: Any]))
    }

    func setFavorite(_ id: String, _ fav: Bool) async throws {
        try await raw("assets/\(id)", method: "PUT", body: json(["isFavorite": fav]))
    }

    func trash(_ ids: [String]) async throws {
        try await raw("assets", method: "DELETE", body: json(["ids": ids, "force": false] as [String: Any]))
    }

    /// Aus „Zuletzt gelöscht“ zurückholen.
    func restore(_ ids: [String]) async throws {
        try await raw("trash/restore/assets", method: "POST", body: json(["ids": ids]))
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
    private var realtimeHLS: Bool?

    /// Ausweg, wenn die Wiedergabedatei auf dem iPhone nicht abspielbar ist (HEVC mit Kennung „hev1“ statt „hvc1“,
    /// VP9, AV1, MKV: Laufzeit lesbar, Bild schwarz – Issue #1): erst das Original (falls nur die umgewandelte Datei
    /// nicht passt), dann Immichs Echtzeit-Umwandlung (HLS, wenn auf dem Server eingeschaltet). nil = beides nicht.
    func playableFallback(for id: String) async -> AVURLAsset? {
        var tries = [originalURL(id)].compactMap { $0 }
        if await realtimeTranscoding(), let u = await hlsVariant(id) { tries.append(u) }
        for u in tries {
            let a = avAsset(u)
            if (try? await a.load(.isPlayable)) == true {
                videoLock.withLock { videoFallback[id] = u }
                return a
            }
        }
        return nil
    }

    /// HLS-Stream wie in Immich, aber FEST auf eine Stufe: Immichs Sitzung verträgt keinen Stufenwechsel („Variant
    /// changed“ → Umwandlung startet neu), Apples Player probiert aber von sich aus mehrere → 1–2 min Laden, Ruckeln,
    /// 20 s nach Pause (GitHub-Issue #1).
    func hlsVariant(_ id: String) async -> URL? {
        guard let main = try? url("assets/\(id)/video/stream/main.m3u8"), let d = try? await data(main),
              let text = String(data: d, encoding: .utf8) else { return nil }
        let lines = text.split(whereSeparator: \.isNewline).map(String.init)
        var variants: [(height: Int, hevc: Bool, uri: String)] = []
        for (n, line) in lines.enumerated() where line.hasPrefix("#EXT-X-STREAM-INF") && n + 1 < lines.count {
            let res = line.range(of: #"RESOLUTION=\d+x(\d+)"#, options: .regularExpression).map { String(line[$0]) }
            let h = res.flatMap { Int($0.split(separator: "x").last ?? "") } ?? 0
            variants.append((h, line.contains("hvc1") || line.contains("hev1"), lines[n + 1]))
        }
        // H.264: auf Servern ohne Grafikbeschleunigung um ein Vielfaches schneller umzuwandeln als HEVC (HEVC 1080p
        // mit 120 fps schaffte die CPU nicht in Echtzeit → Zeitüberschreitung); 720p im Heimnetz, 480p unterwegs.
        let cap = Self.isPrivateHost(main.host() ?? "") ? 720 : 480
        let fit = variants.filter { $0.height <= cap }
        let pick = fit.filter { !$0.hevc }.max { $0.height < $1.height } ?? fit.max { $0.height < $1.height }
            ?? variants.min { $0.height < $1.height }
        guard let pick else { return nil }
        return URL(string: pick.uri, relativeTo: main)?.absoluteURL
    }

    /// Beim Start einmal fragen, ob der Server Echtzeit-Umwandlung kann (spart die Wartezeit, wenn ein Video den Ausweichweg braucht).
    func prepareVideo() async { _ = await realtimeTranscoding() }

    /// Für die Video-Diagnose: Server kann Echtzeit-Umwandlung (HLS)?
    func serverRealtime() async -> Bool { await realtimeTranscoding() }

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

    private func realtimeTranscoding() async -> Bool {
        if let v = videoLock.withLock({ realtimeHLS }) { return v }
        struct Features: Decodable { let realtimeTranscoding: Bool? }
        // nur eine echte Antwort merken – scheitert die Abfrage (offline, Netz-Erlaubnis noch offen), später neu fragen
        guard let f: Features = try? await request("server/features") else { return false }
        let v = f.realtimeTranscoding ?? false
        videoLock.withLock { realtimeHLS = v }
        return v
    }
    func originalURL(_ id: String, edited: Bool = true) -> URL? {
        try? url("assets/\(id)/original", query: ["edited": edited ? "true" : "false"])
    }
    func personThumbURL(_ id: String) -> URL? { try? url("people/\(id)/thumbnail") }

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
