import Foundation
import os

/// The Rust core (dc-core through dc-ffi), one per app process. Sign-in, restore and sign-out go through it (I4);
/// HomeRoll's client gets the worker's address and token from it until the core serves the rest (I5–I8).
enum CoreBridge {
    /// nil when the core could not start (its folders); `startError` says why.
    static let core: Core? = start()
    nonisolated(unsafe) private(set) static var startError: String?

    private static func start() -> Core? {
        _ = setLogSink(sink: CoreLog())
        let fm = FileManager.default
        let data = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("core")
        let cache = fm.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("core")
        do { return try Core(dataDir: data.path, cacheDir: cache.path) }
        catch { startError = message(error); return nil }
    }

    /// Signs in through the core and hands the worker's address and token to HomeRoll's client.
    /// The account's display name; the token stays in here.
    static func signIn(server: String, email: String, password: String) async throws -> String {
        guard let core else { throw CoreFailure(message: startError ?? "") }
        do {
            let s = try await core.signIn(address: server, email: email, password: password)
            save(s)
            adopt(s)
            return s.name
        } catch { throw CoreFailure(message: message(error)) }
    }

    /// At launch: the session kept in the Keychain back into the core and HomeRoll's client; false = sign in.
    static func restore() -> Bool {
        // Unreadable before the first unlock after a reboot (like UserDefaults): then nothing is wiped.
        guard let core, let s = stored() else { return false }
        // The Keychain outlives a deleted app, UserDefaults does not: a session from an earlier install is dropped.
        guard UserDefaults.standard.bool(forKey: installKey) else { save(nil); return false }
        do { try core.restore(session: s) } catch { save(nil); return false }
        adopt(s)
        return true
    }

    static func signOut() {
        try? core?.signOut()
        save(nil)
    }

    /// In the user's language by kind; otherwise the core's own words (the generated `errorDescription` shows the
    /// type name).
    static func message(_ error: Error) -> String {
        switch error as? CoreError {
        case .WrongCredentials: String(localized: "Wrong email or password.")
        case .NotProvisioned: String(localized: "Your storage isn't set up yet. Finish setting it up at accounts.daemonclient.uz.")
        case .BadAddress: String(localized: "No Phosphor server answers at this address.")
        case .Network: String(localized: "Can't reach the server. Check your connection and try again.")
        case .SignedOut: String(localized: "You were signed out. Please sign in again.")
        case .Failed(let m): m
        // e.g. a panic UniFFI caught: its text is not scrubbed by the core
        case nil: String(localized: "Something went wrong. Please try again.")
        }
    }

    private static func adopt(_ s: SignedIn) {
        if let u = URL(string: s.workerUrl) { ImmichClient.shared.activate(server: u, token: s.token) }
    }

    // The whole session in one Keychain item (the token is in it); never UserDefaults.
    private static let installKey = "session.thisInstall"

    private static func save(_ s: SignedIn?) {
        UserDefaults.standard.set(s != nil, forKey: installKey)
        guard let s else { Keychain.set(nil, for: "session"); return }
        let d = ["workerUrl": s.workerUrl, "token": s.token, "userId": s.userId, "email": s.email, "name": s.name]
        Keychain.set((try? JSONEncoder().encode(d)).flatMap { String(data: $0, encoding: .utf8) }, for: "session")
    }

    private static func stored() -> SignedIn? {
        guard let j = Keychain.get("session")?.data(using: .utf8),
              let d = try? JSONDecoder().decode([String: String].self, from: j),
              let w = d["workerUrl"], let t = d["token"], let u = d["userId"], let e = d["email"], let n = d["name"]
        else { return nil }
        return SignedIn(workerUrl: w, token: t, userId: u, email: e, name: n)
    }
}

struct CoreFailure: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

/// The core's log lines (tokens scrubbed by the core; it logs no URL or secret of its own) into the system log.
private final class CoreLog: LogSink {
    private let log = Logger(subsystem: "uz.daemonclient.photos", category: "core")
    #if DEBUG
    func line(line: String) { log.info("\(line, privacy: .public)") }
    #else
    func line(line: String) { log.info("\(line, privacy: .private)") }
    #endif
}
