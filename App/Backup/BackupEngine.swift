import Foundation
import UIKit
import Photos
import ImageIO
import CryptoKit
import BackgroundTasks

/// Sichert neue Fotos/Videos vom iPhone auf den eigenen Immich-Server (wie „iCloud-Fotos“, nur ohne Löschen).
/// - Lädt nur Originale (`.photo`, `.video`, `.pairedVideo`); eine Bearbeitung aus Fotos kommt als eigene Fassung
///   oben auf das Original (Stapel + Tag „Kategorie/Bearbeitet“) – wie beim iCloud-Import.
/// - Duplikate erkennt der Server über die SHA1 (`bulk-upload-check`, Header `x-immich-checksum`).
/// - Ältere Objekte als `importCutoff` liegen schon auf dem Server (z. B. per icloudpd importiert): werden nur geprüft,
///   wenn sie lokal liegen (kein Nachladen aus iCloud), und nur mit „Ganze Mediathek prüfen“. Ohne Datum wird alles gesichert.
@MainActor @Observable
final class BackupEngine {
    static let shared = BackupEngine()
    nonisolated static let taskID = "org.homeroll.app.backup"
    /// Kurzer Hintergrund-Auftrag (wie die Immich-App): neue Fotos einreihen, auch ohne Ladekabel
    nonisolated static let refreshID = "org.homeroll.app.refresh"

    enum Phase: Equatable { case idle, scanning, uploading, done, failed(String) }

    var enabled = UserDefaults.standard.object(forKey: "backup.enabled") as? Bool ?? true { didSet { save() } }
    /// Entwicklung mit echtem Konto: Backup fest aus (FOTOS_BACKUP_OFF), damit nichts hochgeladen wird.
    private var hardOff: Bool {
        #if DEBUG
        ProcessInfo.processInfo.environment["FOTOS_BACKUP_OFF"] != nil
        #else
        false
        #endif
    }
    var wifiOnly = UserDefaults.standard.object(forKey: "backup.wifiOnly") as? Bool ?? true { didSet { save() } }
    var fullLibrary = UserDefaults.standard.bool(forKey: "backup.full") { didSet { save() } }
    /// Großer Hintergrund-Lauf nur am Ladekabel (vorher immer so); aus = auch im Akkubetrieb, wenn iOS es zulässt
    var chargingOnly = UserDefaults.standard.bool(forKey: "backup.chargingOnly") { didSet { save(); schedule() } }
    /// Gerade übertragene iPhone-Fotos und ihr Fortschritt (0…1) – für die Ringe auf den Kacheln.
    /// Mehrere gleichzeitig (siehe `parallelUploads`).
    private(set) var uploading: [String: Double] = [:]
    func setProgress(_ lid: String, _ p: Double) {
        guard uploading[lid] != nil else { return }
        uploading[lid] = p
        LocalPending.shared.progressChanged(lid)
    }
    /// Bei offener App zwei Objekte gleichzeitig: Während eins hochlädt, wird das nächste schon kopiert, geprüft und
    /// beim Server angefragt – auf langen Strecken (~265 ms je Rückfrage) fiel sonst zwischen den Uploads viel Zeit weg.
    /// Mehr bringt nichts (eine Verbindung nutzt die Leitung schon aus, Speedtest 20.11.2026). Im Hintergrund nur
    /// eins: dort angelegte Übertragungen schiebt iOS nach eigenem Ermessen und sie blockieren sonst später.
    nonisolated static let parallelUploads = 2
    /// Videos werden vor dem Hochladen kopiert (Zwischendatei + Rumpf) → höchstens eins gleichzeitig
    nonisolated static let parallelVideos = 1
    /// Während eines Laufs kam ein neues Foto dazu → danach gleich noch einmal
    @ObservationIgnored private var rerun = false
    /// Bis hierher ist die Mediathek schon auf dem Server (eigener Import); nil = ganze Mediathek sichern.
    var importCutoff = UserDefaults.standard.object(forKey: "backup.importCutoff") as? Date { didSet { save() } }
    var lastRun = UserDefaults.standard.object(forKey: "backup.lastRun") as? Date
    /// Für welchen Server der Nutzer dem Backup zugestimmt hat (GitHub-Issue #11): nichts wird hochgeladen, bevor er
    /// einmal „Backup einschalten“ gewählt hat, und nach einem Serverwechsel wird erneut gefragt.
    private(set) var consentedServer = UserDefaults.standard.string(forKey: "backup.consentedServer")
    var needsConsent: Bool {
        guard enabled, !hardOff, let s = ImmichClient.shared.baseURL?.absoluteString else { return false }
        // wer schon gesichert hat (ältere Fassung), muss nicht nochmal zustimmen
        if consentedServer == nil, lastRun != nil { consentedServer = s; UserDefaults.standard.set(s, forKey: "backup.consentedServer") }
        return consentedServer != s
    }
    func consent(_ yes: Bool) {
        consentedServer = ImmichClient.shared.baseURL?.absoluteString
        UserDefaults.standard.set(consentedServer, forKey: "backup.consentedServer")
        enabled = yes
        if yes { start() }
    }
    /// Pausiert bis (wie iCloud-Fotos „Pausieren“: einen Tag lang, auch nachts im Hintergrund); nil = läuft.
    private(set) var pausedUntil = UserDefaults.standard.object(forKey: "backup.pausedUntil") as? Date
    var paused: Bool { pausedUntil.map { $0 > Date() } ?? false }
    /// Noch NICHT auf dem Server laut letztem Lauf (fehlgeschlagene zählen mit – sonst stand „gesichert“ da, obwohl ein
    /// Video fehlte, 07.11.2026); nil = unbekannt.
    var pending: Int? { total > 0 ? max(0, total - uploaded - duplicates) : storedPending }
    private var storedPending = UserDefaults.standard.object(forKey: "backup.pending") as? Int

    var phase: Phase = .idle { didSet { keepAwake() } }

    /// Wie beim Erst-Import in Fotos: Solange gesichert wird, die App offen ist und das iPhone am Strom hängt, sperrt
    /// sich der Bildschirm nicht – sonst stoppt iOS das Hochladen bei offener App nach der Auto-Sperre.
    private func keepAwake() {
        UIDevice.current.isBatteryMonitoringEnabled = true
        let plugged = UIDevice.current.batteryState == .charging || UIDevice.current.batteryState == .full
        let on = running && plugged && UIApplication.shared.applicationState == .active
        if UIApplication.shared.isIdleTimerDisabled != on { UIApplication.shared.isIdleTimerDisabled = on }
    }
    var total = 0
    var finished = 0
    var uploaded = 0
    var duplicates = 0
    var failed = 0
    var current = ""
    /// Objekte, die (noch) nicht gesichert werden konnten – mit Grund.
    var problems: [String] = []
    var running: Bool { phase == .scanning || phase == .uploading }
    /// Übertragungen aus einer früheren Sitzung, die iOS noch im Hintergrund erledigt
    var background = 0

    private var task: Task<Void, Never>?
    private var state: [String: Entry] = [:] { didSet { byRemote = nil } }
    private var stateUser = ""
    /// Server-ID → iPhone-Foto (für „lokale Kopie bevorzugen“, LocalCopy); nach jeder Änderung neu gebaut
    @ObservationIgnored private var byRemote: [String: String]?
    func localID(forRemote id: String) -> String? {
        if byRemote == nil { byRemote = Dictionary(state.map { ($0.value.remote, $0.key) }, uniquingKeysWith: { a, _ in a }) }
        return byRemote?[id]
    }

    /// `tagged`: Kategorie-Tags (Bildschirmfotos, Panoramen …) sind sicher auf dem Server; nil = noch nachholen.
    /// `editedAt`: Stand der Bearbeitung (Änderungsdatum in Fotos), die als `edited` auf dem Server liegt.
    struct Entry: Codable { var remote: String; var edited: String?; var tagged: Bool?; var editedAt: Date? }

    private func save() {
        let d = UserDefaults.standard
        d.set(enabled, forKey: "backup.enabled"); d.set(wifiOnly, forKey: "backup.wifiOnly"); d.set(fullLibrary, forKey: "backup.full")
        d.set(importCutoff, forKey: "backup.importCutoff"); d.set(chargingOnly, forKey: "backup.chargingOnly")
    }

    // MARK: Start / Hintergrund

    /// Beim App-Start einmal registrieren (vor dem Ende von didFinishLaunching).
    nonisolated static func registerBackgroundTask() {
        // Hauptwarteschlange: der Handler läuft dann auf dem MainActor.
        BGTaskScheduler.shared.register(forTaskWithIdentifier: taskID, using: .main) { t in
            nonisolated(unsafe) let task = t   // läuft auf .main, wird nur dort benutzt
            MainActor.assumeIsolated { BackupEngine.shared.handle(task) }
        }
        BGTaskScheduler.shared.register(forTaskWithIdentifier: refreshID, using: .main) { t in
            nonisolated(unsafe) let task = t
            MainActor.assumeIsolated { BackupEngine.shared.handleRefresh(task) }
        }
    }

    /// Kurzer Auftrag (iOS gibt ~30 s): neue Fotos prüfen und an die Hintergrund-Übertragung übergeben – die läuft
    /// nach dem Ende des Auftrags im System weiter, `adopt` trägt das Ergebnis später ein.
    private func handleRefresh(_ t: BGTask) {
        t.expirationHandler = { Task { @MainActor in if UIApplication.shared.applicationState != .active { BackupEngine.shared.cancel() } } }
        Task {
            // Nur einen Lauf beenden, den dieser Auftrag selbst gestartet hat – und nie, solange die App offen ist.
            // Vorher brach der Weckruf nach 22 s auch ein gerade laufendes Backup bei offener App ab (17.11.2026:
            // Lauf nach 52 s mit 0 Uploads beendet, Backup schien zu hängen).
            if !paused, !running {
                start()
                let deadline = Date().addingTimeInterval(22)
                while running, Date() < deadline { try? await Task.sleep(for: .milliseconds(500)) }
                if UIApplication.shared.applicationState != .active { cancel() }
            }
            t.setTaskCompleted(success: true)
            schedule()
        }
    }

    private func handle(_ t: BGTask) {
        t.expirationHandler = { Task { @MainActor in
            if UIApplication.shared.applicationState != .active { BackupEngine.shared.cancel(); OfflineSync.shared.stop() }
        } }
        Task {
            if !paused { await run() }
            await OfflineSync.shared.runAndWait()      // danach Vorschauen fürs Offline-Blättern nachladen
            t.setTaskCompleted(success: phase == .done)
            schedule()
        }
    }

    /// Nachts sichern, wenn das iPhone am Strom und im Netz ist.
    func schedule() {
        guard enabled, !hardOff else { BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: Self.taskID); return }
        let r = BGProcessingTaskRequest(identifier: Self.taskID)
        r.requiresNetworkConnectivity = true
        r.requiresExternalPower = chargingOnly
        r.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        try? BGTaskScheduler.shared.submit(r)
        let q = BGAppRefreshTaskRequest(identifier: Self.refreshID)
        q.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        try? BGTaskScheduler.shared.submit(q)
    }

    /// Beim Öffnen der App: jedes Mal abgleichen (nur Neues kostet Zeit), höchstens alle 30 s.
    func runIfDue() {
        guard enabled, !paused, !running, !needsConsent, Date().timeIntervalSince(lastRun ?? .distantPast) > 30 else { return }
        start()
    }

    /// Neues Foto oder Bildschirmfoto, während die App offen ist (LibraryWatcher) → gleich sichern.
    func libraryChanged() {
        guard enabled, !paused, !needsConsent, !hardOff else { return }
        if running { rerun = true } else { start() }
    }

    func start() {
        guard !running, !paused else { return }
        task = Task {
            // Weiterlaufen, wenn die App in den Hintergrund geht (iOS gibt dafür begrenzt Zeit; was nicht fertig wird,
            // gilt als nicht gesichert und kommt beim nächsten Lauf dran)
            let bg = UIApplication.shared.beginBackgroundTask(withName: "backup") { BackupEngine.shared.cancel() }
            await run()
            while rerun, !Task.isCancelled { rerun = false; await run() }
            UIApplication.shared.endBackgroundTask(bg)
        }
    }

    /// Wie iCloud-Fotos: einen Tag pausieren (laufender Upload stoppt sofort, Nachtlauf wartet).
    func pause(for seconds: TimeInterval = 24 * 3600) {
        pausedUntil = Date(timeIntervalSinceNow: seconds)
        UserDefaults.standard.set(pausedUntil, forKey: "backup.pausedUntil")
        cancel()
        BackgroundUploader.shared.cancelAll()
    }

    #if DEBUG
    /// Simulator: Zustände der Mediathek-Fußzeile ansehen, ohne etwas hochzuladen (FOTOS_BACKUP_DEMO=uploading|paused|done|failed).
    func demo(_ s: String) {
        total = 988; finished = 312; lastRun = Date(timeIntervalSinceNow: -300)
        switch s {
        case "uploading": phase = .uploading
        case "paused": pausedUntil = Date(timeIntervalSinceNow: 3600)
        case "failed": phase = .failed(String(localized: "Server nicht erreichbar"))
        default: total = 0; finished = 0; phase = .done
        }
    }
    #endif

    func resume() {
        pausedUntil = nil
        UserDefaults.standard.removeObject(forKey: "backup.pausedUntil")
        if case .failed = phase { phase = .idle }
        start()
    }

    func cancel() { task?.cancel(); task = nil }

    // MARK: Ablauf

    func run() async {
        guard !running, !hardOff, !paused, !needsConsent else { return }
        problems = []; total = 0; finished = 0; uploaded = 0; duplicates = 0; failed = 0; current = ""
        phase = .scanning
        let auth = await PHPhotoLibrary.requestAuthorization(for: .readWrite)
        guard auth == .authorized || auth == .limited else { phase = .failed(String(localized: "Kein Zugriff auf Fotos – in den Einstellungen erlauben.")); return }
        let api = ImmichClient.shared
        guard let me = try? await api.me() else { phase = .failed(String(localized: "Server nicht erreichbar")); return }
        loadState(user: me.id)

        let opts = PHFetchOptions()
        opts.includeHiddenAssets = true
        opts.includeAllBurstAssets = true
        opts.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: true)]
        if !fullLibrary, let cutoff = importCutoff { opts.predicate = NSPredicate(format: "creationDate >= %@", cutoff as NSDate) }
        let result = PHAsset.fetchAssets(with: opts)
        var todo: [PHAsset] = []
        result.enumerateObjects { a, _, _ in
            if a.mediaType == .image || a.mediaType == .video, self.state[a.localIdentifier] == nil { todo.append(a) }
        }
        total = todo.count
        let inFlight = await BackgroundUploader.shared.activeLocalIDs()
        background = inFlight.count
        await Self.sweepLeftovers()
        await repairTags(api)
        phase = .uploading

        // Mehrere gleichzeitig: auf langen Strecken mit Paketverlust bringt eine einzelne Verbindung nur einen
        // Bruchteil der Leitung (siehe `parallelUploads`). Reihenfolge bleibt grob nach Aufnahmedatum.
        let list = todo.filter { !inFlight.contains($0.localIdentifier) }   // laufen schon im Hintergrund (frühere Sitzung)
        var next = 0
        var heldVideos: [PHAsset] = []
        func take(videosRunning: Int) -> PHAsset? {
            if videosRunning < Self.parallelVideos, !heldVideos.isEmpty { return heldVideos.removeFirst() }
            while next < list.count {
                let a = list[next]; next += 1
                if a.mediaType == .video, videosRunning >= Self.parallelVideos { heldVideos.append(a); continue }
                return a
            }
            return nil
        }
        await withTaskGroup(of: (video: Bool, stop: Bool).self) { g in
            var active = 0, videos = 0, stop = false
            while true {
                while !stop, !Task.isCancelled,
                      active < (UIApplication.shared.applicationState == .active ? Self.parallelUploads : 1),
                      let a = take(videosRunning: videos) {
                    let v = a.mediaType == .video
                    active += 1; if v { videos += 1 }
                    let lid = a.localIdentifier   // PHAsset ist nicht Sendable → per ID weiterreichen
                    g.addTask { (v, await BackupEngine.shared.backupOne(lid)) }
                }
                guard let r = await g.next() else { break }
                active -= 1; if r.video { videos -= 1 }
                if r.stop { stop = true }
            }
        }
        if !Task.isCancelled { await syncEdits() }
        current = ""
        lastRun = Date(); UserDefaults.standard.set(lastRun, forKey: "backup.lastRun")
        storedPending = max(0, total - uploaded - duplicates); UserDefaults.standard.set(storedPending, forKey: "backup.pending")
        phase = Task.isCancelled ? .idle : .done
    }

    // MARK: Bearbeitungen aus Fotos nachziehen (Änderungs-Token, ab iOS 16)

    /// Token je Konto: welche Fotos sich seit dem letzten Lauf in Fotos geändert haben (statt alles zu vergleichen)
    private var tokenKey: String { "backup.changeToken.\(stateUser)" }

    /// Fotos, die nach dem Sichern in Apples Fotos bearbeitet wurden: neue Fassung hochladen und auf den Stapel
    /// über das Original legen (wie beim ersten Sichern). Ohne gespeichertes Token nur das Token merken.
    private func syncEdits() async {
        let lib = PHPhotoLibrary.shared()
        let now = lib.currentChangeToken
        defer { if let d = try? NSKeyedArchiver.archivedData(withRootObject: now, requiringSecureCoding: true) { UserDefaults.standard.set(d, forKey: tokenKey) } }
        guard let raw = UserDefaults.standard.data(forKey: tokenKey),
              let since = try? NSKeyedUnarchiver.unarchivedObject(ofClass: PHPersistentChangeToken.self, from: raw),
              let changes = try? lib.fetchPersistentChanges(since: since) else { return }   // abgelaufen → ab jetzt neu
        var updated: Set<String> = []
        for c in changes {
            if let d = try? c.changeDetails(for: .asset) { updated.formUnion(d.updatedLocalIdentifiers) }
        }
        let ids = updated.filter { state[$0] != nil }
        guard !ids.isEmpty else { return }
        let api = ImmichClient.shared
        for lid in ids {
            if Task.isCancelled { return }
            guard var e = state[lid], let a = PHAsset.fetchAssets(withLocalIdentifiers: [lid], options: nil).firstObject else { continue }
            let res = PHAssetResource.assetResources(for: a)
            guard let full = res.first(where: { $0.type == (a.mediaType == .video ? .fullSizeVideo : .fullSizePhoto) }),
                  let main = res.first(where: { $0.type == (a.mediaType == .video ? .video : .photo) }) else { continue }
            // nur wenn sich die Bearbeitung seit dem letzten Hochladen geändert hat
            let stamp = a.modificationDate ?? Date()
            if let done = e.editedAt, done >= stamp { continue }
            if e.edited != nil, e.editedAt == nil { e.editedAt = stamp; state[lid] = e; continue }   // Altbestand: nichts doppelt
            current = main.originalFilename; uploading[lid] = 0
            defer { uploading[lid] = nil }
            var x: [String: String] = [:]
            if a.isFavorite { x["isFavorite"] = "true" }
            if a.isHidden { x["visibility"] = "archive" }
            let stem = (main.originalFilename as NSString).deletingPathExtension
            let ext = (full.originalFilename as NSString).pathExtension
            let local = Self.needsLocalDate(a, full) ? Self.localISO(a.creationDate ?? Date()) : nil
            guard let r = try? await send(full, of: a, network: true, extra: x, name: "\(stem)\(Category.editedSuffix).\(ext.isEmpty ? "jpg" : ext)", kind: "edited", localDate: local)
            else { continue }
            if r.isNew {
                try? await api.createStack([r.id, e.remote]); try? await api.tag([r.id], with: "Kategorie/Bearbeitet")
                // Erneut bearbeitet: Der neue Stapel nimmt dem alten das Original weg, die frühere Fassung stünde dann
                // allein in der Mediathek. Wie im Editor der App ersetzt die neue Fassung sie → frühere in den Papierkorb.
                if let previous = e.edited, previous != r.id { try? await api.trash([previous]) }
            }
            e.edited = r.id; e.editedAt = stamp; state[lid] = e
            saveState()
            uploaded += r.isNew ? 1 : 0
        }
        LocalPending.shared.reloadSoon()
    }

    /// Ein Objekt des Laufs sichern und zählen. true = Lauf anhalten (pausiert/abgebrochen).
    private func backupOne(_ lid: String) async -> Bool {
        guard let a = PHAsset.fetchAssets(withLocalIdentifiers: [lid], options: nil).firstObject else { return false }
        let api = ImmichClient.shared
        let name = PHAssetResource.assetResources(for: a).first?.originalFilename ?? ""
        current = name
        uploading[lid] = 0
        defer { uploading[lid] = nil; LocalPending.shared.refresh() }
        do {
            if let r = try await backup(a) {
                let (id, edited, isNew) = r
                state[lid] = Entry(remote: id, edited: edited, editedAt: edited != nil ? a.modificationDate : nil)
                if isNew { uploaded += 1 } else { duplicates += 1 }
                saveState()
                // Tags sofort setzen, nicht erst am Ende des Laufs: wird die App vorher beendet,
                // stünde das Bildschirmfoto sonst in der Mediathek, aber nie unter „Bildschirmfotos“.
                var ok = true
                for (t, ids) in Self.tagPlan(a, Entry(remote: id, edited: edited)) {
                    do { try await api.tag(ids, with: t) } catch { ok = false }
                }
                if ok { state[lid]?.tagged = true; saveState() }
            }
        } catch is CancellationError {
            return true
        } catch let e as URLError where e.code == .cancelled {
            return true   // Pausieren bricht den laufenden Upload ab – kein Fehler, das Objekt kommt beim nächsten Lauf dran
        } catch {
            failed += 1
            problems.append("\(name): \(error.localizedDescription)")
        }
        finished += 1
        return false
    }

    /// Ein Objekt sichern → (Server-ID, ID der bearbeiteten Fassung, neu hochgeladen?) oder nil = übersprungen.
    private func backup(_ a: PHAsset) async throws -> (String, String?, Bool)? {
        let res = PHAssetResource.assetResources(for: a)
        let mainType: PHAssetResourceType = a.mediaType == .video ? .video : .photo
        guard let main = res.first(where: { $0.type == mainType }) else { throw BackupError.noOriginal }
        // Vor dem Import liegt alles schon auf dem Server: nie aus iCloud nachladen, nur Lokales prüfen.
        let allowNetwork = importCutoff.map { (a.creationDate ?? .distantPast) >= $0 } ?? true
        let api = ImmichClient.shared

        // Live Photo: zuerst das Video, damit das Foto darauf zeigen kann.
        var liveID: String?
        if a.mediaSubtypes.contains(.photoLive), let pv = res.first(where: { $0.type == .pairedVideo }) {
            liveID = try await send(pv, of: a, network: allowNetwork, extra: [:], kind: "live").id
        }
        var extra: [String: String] = [:]
        if let liveID { extra["livePhotoVideoId"] = liveID }
        if a.isFavorite { extra["isFavorite"] = "true" }
        if a.isHidden { extra["visibility"] = "archive" }
        if a.mediaType == .video { extra["duration"] = String(Int(a.duration * 1000)) }
        // Bildschirmfotos (PNG) und Videos tragen keine Zeitzone → Immich zeigte sonst UTC (wie beim iCloud-Import).
        let local = Self.needsLocalDate(a, main) ? Self.localISO(a.creationDate ?? Date()) : nil
        let r = try await send(main, of: a, network: allowNetwork, extra: extra, localDate: local)

        // Bearbeitung aus Fotos: gerenderte Fassung oben auf den Stapel (nur für neue Objekte).
        var editedID: String?
        if allowNetwork, let full = res.first(where: { $0.type == (a.mediaType == .video ? .fullSizeVideo : .fullSizePhoto) }) {
            var e: [String: String] = [:]
            if a.isFavorite { e["isFavorite"] = "true" }
            if a.isHidden { e["visibility"] = "archive" }
            let stem = (main.originalFilename as NSString).deletingPathExtension
            let ext = (full.originalFilename as NSString).pathExtension
            let elocal = Self.needsLocalDate(a, full) ? Self.localISO(a.creationDate ?? Date()) : nil
            let er = try await send(full, of: a, network: true, extra: e, name: "\(stem)\(Category.editedSuffix).\(ext.isEmpty ? "jpg" : ext)", kind: "edited", localDate: elocal)
            if er.isNew { try? await api.createStack([er.id, r.id]) }
            editedID = er.id
        }
        return (r.id, editedID, r.isNew)
    }

    /// Datei in den Zwischenordner holen, Prüfsumme bilden, beim Server nachfragen, ggf. hochladen.
    private func send(_ res: PHAssetResource, of a: PHAsset, network: Bool, extra: [String: String],
                      name: String? = nil, kind: String = "main", localDate: String? = nil) async throws -> (id: String, isNew: Bool) {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("backup-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: file) }
        try await Self.write(res, to: file, network: network)
        let sha1 = try await Task.detached { try Self.sha1(of: file) }.value
        let api = ImmichClient.shared
        if let existing = try await api.bulkUploadCheck(id: a.localIdentifier, checksum: sha1) { return (existing, false) }
        // Von Fotos gerenderte Bearbeitungen (fullSizePhoto) tragen oft gar kein Aufnahmedatum → Immich nähme UTC.
        var localDate = localDate
        if localDate == nil, kind != "live", a.mediaType == .image, !Self.fileHasTimeZone(file) {
            localDate = Self.localISO(a.creationDate ?? Date())
        }
        let created = ISO8601DateFormatter().string(from: a.creationDate ?? Date())
        let modified = ISO8601DateFormatter().string(from: a.modificationDate ?? a.creationDate ?? Date())
        var fields = ["fileCreatedAt": created, "fileModifiedAt": modified, "filename": name ?? res.originalFilename]
        fields.merge(extra) { $1 }
        // Rumpf an einem festen Ort: die Hintergrund-Übertragung braucht ihn, auch wenn die App inzwischen weg ist
        let dir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("backup-uploads")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let body = dir.appendingPathComponent(UUID().uuidString)
        let req: URLRequest
        do {
            req = try api.prepareUpload(file: file, filename: name ?? res.originalFilename, uti: res.uniformTypeIdentifier,
                                        fields: fields, checksum: sha1, expensive: !wifiOnly, body: body)
        } catch { try? FileManager.default.removeItem(at: body); throw error }
        try? FileManager.default.removeItem(at: file)   // Platz sparen: ab hier zählt nur noch der Rumpf
        let meta = BackgroundUploader.Meta(user: stateUser, localID: a.localIdentifier, kind: kind, body: body.path,
                                           localDate: localDate, checksum: sha1)
        let r = try await BackgroundUploader.shared.upload(req, body: body, meta: meta)
        if r.status != "duplicate", let localDate { api.setCaptureTime(r.id, localDate) }
        return (r.id, r.status != "duplicate")
    }

    /// Zwischenkopien wegräumen, die ein früherer Lauf nicht mehr löschen konnte: Beendet iOS die App mitten im
    /// Kopieren oder Prüfsummenbilden, läuft kein `defer` – ein 5,4-GB-Video ließ so 26 Kopien liegen (141 GB, 07.11.2026).
    nonisolated static func sweepLeftovers() async {
        let active = await BackgroundUploader.shared.activeBodies()
        await Task.detached(priority: .utility) {
            let fm = FileManager.default
            let keys: [URLResourceKey] = [.isRegularFileKey, .contentModificationDateKey]
            func files(_ dir: URL) -> [URL] {
                ((try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: keys)) ?? [])
                    .filter { (try? $0.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true }
            }
            let dayAgo = Date().addingTimeInterval(-24 * 3600)
            for f in files(fm.temporaryDirectory) {
                let n = f.lastPathComponent
                // „backup-…“ legt nur `send` an; aufgeräumt wird vor dem Start eines Laufs → alles Vorhandene ist verwaist.
                // „upload-…“ kann gerade vom Kürzen im Editor stammen → nur Altes löschen.
                let old = ((try? f.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast) < dayAgo
                if n.hasPrefix("backup-") || (n.hasPrefix("upload-") && old) { try? fm.removeItem(at: f) }
            }
            // Rümpfe, die zu keiner laufenden Hintergrund-Übertragung mehr gehören (App starb vor dem Start der Übertragung)
            let bodies = fm.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("backup-uploads")
            for f in files(bodies) where !active.contains(f.lastPathComponent) { try? fm.removeItem(at: f) }
        }.value
    }

    private static func write(_ res: PHAssetResource, to url: URL, network: Bool) async throws {
        let o = PHAssetResourceRequestOptions()
        o.isNetworkAccessAllowed = network
        try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
            PHAssetResourceManager.default().writeData(for: res, toFile: url, options: o) { err in
                if let err { c.resume(throwing: network ? err : BackupError.onlyInICloud) } else { c.resume() }
            }
        }
    }

    /// Dateien ohne Zeitzone (Videos, Bildschirmfotos, PNG) – sonst zeigt Immich UTC. Gilt auch für bearbeitete Fassungen.
    static func needsLocalDate(_ a: PHAsset, _ res: PHAssetResource) -> Bool {
        a.mediaType == .video || a.mediaSubtypes.contains(.photoScreenshot) || res.uniformTypeIdentifier == "public.png"
    }

    /// Trägt das Bild Aufnahmedatum und Zeitzonen-Versatz in den EXIF-Daten?
    nonisolated static func fileHasTimeZone(_ url: URL) -> Bool {
        guard let src = CGImageSourceCreateWithURL(url as CFURL, nil),
              let p = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any],
              let exif = p[kCGImagePropertyExifDictionary] as? [CFString: Any] else { return false }
        return exif[kCGImagePropertyExifDateTimeOriginal] != nil && exif[kCGImagePropertyExifOffsetTimeOriginal] != nil
    }

    /// Zeitpunkt mit Zeitzonen-Versatz des iPhones, z. B. 2026-11-05T00:20:01+01:00.
    static func localISO(_ d: Date) -> String {
        let f = ISO8601DateFormatter(); f.timeZone = .current; f.formatOptions = [.withInternetDateTime]
        return f.string(from: d)
    }

    nonisolated private static func sha1(of url: URL) throws -> String {
        let h = try FileHandle(forReadingFrom: url)
        defer { try? h.close() }
        var sha = Insecure.SHA1()
        try h.forEachChunk { sha.update(data: $0) }
        return sha.finalize().map { String(format: "%02x", $0) }.joined()
    }

    /// Tag → Server-IDs für ein gesichertes Objekt (Original und ggf. bearbeitete Fassung).
    private static func tagPlan(_ a: PHAsset, _ e: Entry) -> [String: [String]] {
        var plan: [String: [String]] = [:]
        for t in tags(for: a) { plan[t, default: []].append(e.remote) }
        if let edited = e.edited { plan["Kategorie/Bearbeitet", default: []].append(edited) }
        return plan
    }

    /// Holt Tags nach, die frühere Läufe nicht mehr setzen konnten (App beendet, Netz weg).
    /// Gesammelt je Tag in Paketen, damit auch viele Objekte nur wenige Anfragen kosten.
    private func repairTags(_ api: ImmichClient) async {
        let open = state.filter { $0.value.tagged != true }
        guard !open.isEmpty else { return }
        var plan: [String: [String]] = [:]
        let found = PHAsset.fetchAssets(withLocalIdentifiers: Array(open.keys), options: nil)
        found.enumerateObjects { a, _, _ in
            guard let e = open[a.localIdentifier] else { return }
            for (t, ids) in Self.tagPlan(a, e) { plan[t, default: []] += ids }
        }
        for (t, ids) in plan {
            for i in stride(from: 0, to: ids.count, by: 500) {
                guard (try? await api.tag(Array(ids[i..<min(i + 500, ids.count)]), with: t)) != nil else { return }
            }
        }
        // auch vom iPhone Gelöschte abhaken: deren Art kennt nur noch der Server
        for id in open.keys { state[id]?.tagged = true }
        saveState()
    }

    /// Was nur das iPhone weiß – gleiche Tag-Namen wie Server-Kategorien und iCloud-Import.
    static func tags(for a: PHAsset) -> [String] {
        var t: [String] = []
        let s = a.mediaSubtypes
        if s.contains(.photoScreenshot) { t.append("Bildschirmfotos") }
        if s.contains(.photoPanorama) { t.append("Panoramen") }
        if s.contains(.photoDepthEffect) { t.append("Porträt") }
        if s.contains(.videoTimelapse) { t.append("Zeitraffer") }
        if s.contains(.videoHighFrameRate) { t.append("Slo-Mo") }
        if s.contains(.videoCinematic) { t.append("Kino") }
        if a.burstIdentifier != nil { t.append("Serien") }
        return t.map { "Kategorie/\($0)" }
    }

    /// Ergebnis einer Hintergrund-Übertragung, deren Ende die App nicht mehr selbst erlebt hat (beendet/eingefroren).
    /// Nur das Hauptobjekt ohne bearbeitete Fassung wird direkt übernommen; alles andere holt der nächste Lauf nach
    /// (der Server erkennt die Datei dann an der Prüfsumme, es wird nichts doppelt geladen).
    func adopt(_ r: ImmichClient.UploadResult, meta: BackgroundUploader.Meta) async {
        PerfLog.mark("Hintergrund-Übertragung fertig (\(meta.kind))")
        background = max(0, background - 1)
        if meta.kind == "edited", r.status != "duplicate", let d = meta.localDate { ImmichClient.shared.setCaptureTime(r.id, d) }
        guard meta.kind == "main", !meta.user.isEmpty else { return }
        loadState(user: meta.user)
        guard state[meta.localID] == nil else { return }
        let a = PHAsset.fetchAssets(withLocalIdentifiers: [meta.localID], options: nil).firstObject
        let edited = a.map { PHAssetResource.assetResources(for: $0).contains { $0.type == .fullSizePhoto || $0.type == .fullSizeVideo } } ?? false
        guard !edited else { return }
        state[meta.localID] = Entry(remote: r.id, edited: nil)   // Tags holt repairTags beim nächsten Lauf nach
        saveState()
        if r.status != "duplicate", let d = meta.localDate { ImmichClient.shared.setCaptureTime(r.id, d) }
        if let p = storedPending, p > 0 { storedPending = p - 1; UserDefaults.standard.set(p - 1, forKey: "backup.pending") }
    }

    // MARK: Gedächtnis (je Server-Nutzer, damit Test- und echtes Konto getrennt bleiben)

    private var stateURL: URL {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("backup-\(stateUser).json")
    }
    private func loadState(user: String) {
        guard user != stateUser else { return }
        stateUser = user
        state = (try? JSONDecoder().decode([String: Entry].self, from: Data(contentsOf: stateURL))) ?? [:]
    }
    private func saveState() {
        if let d = try? JSONEncoder().encode(state) { try? d.write(to: stateURL, options: .atomic) }
    }
    var backedUpCount: Int { state.count }
    /// Für die Mediathek: Sicherungsstand dieses Kontos kennen, ohne einen Lauf zu starten
    func useAccount(_ user: String) { if !user.isEmpty { loadState(user: user) } }
    func remoteID(forLocal lid: String) -> String? { state[lid]?.remote }
    /// Server-ID der zuletzt gesicherten bearbeiteten Fassung (liegt oben auf dem Stapel, das Original darunter).
    func editedID(forLocal lid: String) -> String? { state[lid]?.edited }
    /// Liegt der aktuelle Stand dieses Fotos auf dem Server? Nein, solange eine Bearbeitung aus Fotos noch nicht
    /// nachgezogen ist (gleiche Regel wie `syncEdits`) – dann darf „Speicher freigeben“ es nicht löschen, sonst wäre
    /// die neueste Fassung weg (gemeldet von @RedEforIT, GitHub #56). Unbearbeitete Fotos: das Original ist gesichert.
    func currentVersionBackedUp(_ a: PHAsset) -> Bool {
        guard let e = state[a.localIdentifier] else { return false }
        let full: PHAssetResourceType = a.mediaType == .video ? .fullSizeVideo : .fullSizePhoto
        guard PHAssetResource.assetResources(for: a).contains(where: { $0.type == full }) else { return true }
        guard e.edited != nil, let done = e.editedAt else { return false }
        return done >= (a.modificationDate ?? .distantFuture)
    }

    // MARK: Speicher freigeben (für FreeUpSection)

    /// Gesicherte iPhone-Objekte mit ihrer Server-ID (nur das angemeldete Konto).
    func backedUp() async -> [String: String] {
        guard let me = try? await ImmichClient.shared.me() else { return [:] }
        loadState(user: me.id)
        return state.mapValues(\.remote)
    }
    /// Nach dem Löschen auf dem iPhone die lokalen IDs vergessen.
    func forget(_ localIDs: [String]) {
        for id in localIDs { state[id] = nil }
        saveState()
    }

    enum BackupError: LocalizedError {
        case noOriginal, onlyInICloud
        var errorDescription: String? {
            switch self {
            case .noOriginal: String(localized: "Kein Original gefunden")
            case .onlyInICloud: String(localized: "Liegt nur in iCloud (nicht auf dem iPhone)")
            }
        }
    }
}
