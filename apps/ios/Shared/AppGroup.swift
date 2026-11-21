import Foundation

/// Gemeinsamer Speicher von App, Widget und Teilen-Erweiterung.
/// SideStore/AltStore hängen beim Installieren die Team-ID an die Gruppe an und schreiben die echte ID
/// in die Info.plist (Schlüssel „ALTAppGroups“) – im Simulator gilt der Name aus den Berechtigungen.
enum AppGroup {
    static let base = "group.org.homeroll.app"
    static let id: String = {
        let info = Bundle.main.infoDictionary ?? [:]
        // AltStore-Quelltext: Bundle.Info.appGroups = "ALTAppGroups" (geprüft 05.11.2026); zur Sicherheit jeden
        // Eintrag durchsuchen, falls SideStore den Schlüssel anders nennt
        let lists = [info["ALTAppGroups"]] + info.values.map { Optional($0) }
        var candidates: [String] = []
        for case let list as [String] in lists.compactMap({ $0 }) { candidates += list.filter { $0.hasPrefix(base) } }
        candidates += [base]
        // die Gruppe nehmen, auf die diese Installation wirklich Zugriff hat (ohne Berechtigung liefert iOS nil)
        return candidates.first { FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: $0) != nil } ?? base
    }()
    static var container: URL? { FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: id) }

    /// Server + Token für die Teilen-Erweiterung (nur eine Datei im Gruppen-Ordner, bei Abmelden gelöscht).
    struct Access: Codable { let server: String; let token: String }
    private static var accessFile: URL? { container?.appendingPathComponent("zugang.json") }

    static func saveAccess(_ a: Access?) {
        guard let f = accessFile else { return }
        guard let a, let d = try? JSONEncoder().encode(a) else { try? FileManager.default.removeItem(at: f); return }
        // auch vor dem ersten Entsperren nach Neustart lesbar (Widgets/Erweiterungen laufen dann schon)
        try? d.write(to: f, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
    static func loadAccess() -> Access? {
        guard let f = accessFile, let d = try? Data(contentsOf: f) else { return nil }
        return try? JSONDecoder().decode(Access.self, from: d)
    }

    /// Erscheinungsbild der App (auto/light/dark) für die Teilen-Erweiterung, damit sie dasselbe zeigt wie die App.
    /// Die Widgets folgen immer dem System (iOS lässt Widgets keine eigene Einstellung der App annehmen).
    private static var themeFile: URL? { container?.appendingPathComponent("erscheinungsbild.txt") }
    static func saveTheme(_ raw: String) {
        guard let f = themeFile else { return }
        try? Data(raw.utf8).write(to: f, options: .atomic)
    }
    static func loadTheme() -> String? {
        guard let f = themeFile, let d = try? Data(contentsOf: f) else { return nil }
        return String(decoding: d, as: UTF8.self)
    }
}

/// Was das Widget zeigt (die App schreibt es, das Widget liest es – ohne eigenen Serverzugriff).
struct WidgetSnapshot: Codable {
    struct Item: Codable, Hashable {
        let id: String          // Rückblick- bzw. Objekt-ID (für den Sprung in die App)
        let title: String
        let subtitle: String
        let file: String        // Bilddatei im Ordner „widget“
        let memory: Bool
    }
    var memories: [Item] = []
    var photos: [Item] = []
    var updated = Date()

    static var folder: URL? { AppGroup.container?.appendingPathComponent("widget", isDirectory: true) }
    static func load() -> WidgetSnapshot? {
        guard let f = folder?.appendingPathComponent("snapshot.json"), let d = try? Data(contentsOf: f) else { return nil }
        return try? JSONDecoder().decode(WidgetSnapshot.self, from: d)
    }
    func save() {
        guard let dir = Self.folder, let d = try? JSONEncoder().encode(self) else { return }
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try? d.write(to: dir.appendingPathComponent("snapshot.json"), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
}

/// Übersetzt einen Text, der erst zur Laufzeit feststeht (z. B. Rohwerte von Aufzählungen). Fehlt die Übersetzung,
/// bleibt der Text, wie er ist. Feste Texte laufen über `String(localized:)` bzw. SwiftUI und brauchen das nicht.
func L(_ key: String) -> String { Bundle.main.localizedString(forKey: key, value: key, table: nil) }

/// Dateiname vom Server oder aus einer geteilten Mediathek sicher machen, bevor er in einen Pfad oder eine
/// Multipart-Kopfzeile kommt: nur der letzte Teil (kein „../“), ohne Steuerzeichen, Zeilenumbrüche, Anführungszeichen
/// und Schrägstriche, höchstens 200 Zeichen (GitHub-Issue #9).
func safeFilename(_ raw: String, fallback: String = "file") -> String {
    let bad = CharacterSet.controlCharacters.union(.newlines).union(CharacterSet(charactersIn: "\"/\\:"))
    var s = String(String.UnicodeScalarView(raw.unicodeScalars.filter { !bad.contains($0) }))
    s = s.trimmingCharacters(in: .whitespaces)
    while s.hasPrefix(".") { s.removeFirst() }          // keine versteckten Dateien, kein „..“
    if s.count > 200 {
        let ext = (s as NSString).pathExtension
        s = String(s.prefix(190)) + (ext.isEmpty ? "" : "." + String(ext.prefix(9)))
    }
    return s.isEmpty ? fallback : s
}
