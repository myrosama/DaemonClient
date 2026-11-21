import UserNotifications
import UIKit

/// „Heute vor X Jahren“ wie bei Apple: morgens eine Mitteilung, wenn es an diesem Tag Fotos aus früheren Jahren gibt.
/// Alles lokal auf dem iPhone geplant (aus der Zeitleiste), kein Server-Dienst nötig. Standardmäßig aus.
@MainActor
enum MemoryNotifications {
    private static let key = "memories.notify"
    static var enabled: Bool { UserDefaults.standard.bool(forKey: key) }
    /// Uhrzeit der Mitteilung
    static let hour = 9

    /// Einschalten fragt einmal nach der Erlaubnis; ohne Erlaubnis bleibt es aus.
    static func set(_ on: Bool, timeline: TimelineStore) async -> Bool {
        if on {
            let granted = (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound])) ?? false
            UserDefaults.standard.set(granted, forKey: key)
            if granted { await schedule(timeline: timeline) }
            return granted
        }
        UserDefaults.standard.set(false, forKey: key)
        UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: (0..<14).map { "memory-\($0)" })
        return false
    }

    /// Die nächsten 14 Tage planen (beim Wechsel in den Hintergrund neu, damit es immer aktuell ist).
    static func schedule(timeline: TimelineStore) async {
        guard enabled else { return }
        let center = UNUserNotificationCenter.current()
        center.removePendingNotificationRequests(withIdentifiers: (0..<14).map { "memory-\($0)" })
        let cal = Calendar.wall, local = Calendar.current
        let photos = timeline.allLoaded.filter(\.isImage)
        // Fotos je Monat-Tag und Jahr (Wanduhr-Datum der Aufnahme)
        var byDay: [String: [Int: [Asset]]] = [:]
        for a in photos {
            let c = cal.dateComponents([.year, .month, .day], from: a.date)
            byDay["\(c.month!)-\(c.day!)", default: [:]][c.year!, default: []].append(a)
        }
        for offset in 0..<14 {
            guard let day = local.date(byAdding: .day, value: offset, to: Date()) else { continue }
            let d = local.dateComponents([.year, .month, .day], from: day)
            // heute nach 9 Uhr nicht mehr
            if offset == 0, local.component(.hour, from: Date()) >= hour { continue }
            guard let years = byDay["\(d.month!)-\(d.day!)"]?.filter({ $0.key < d.year! && $0.value.count >= 3 }),
                  let (year, list) = years.max(by: { $0.value.count < $1.value.count }) else { continue }
            let n = d.year! - year
            let content = UNMutableNotificationContent()
            content.title = (n == 1 ? String(localized: "Heute vor 1 Jahr") : String(localized: "Heute vor \(n) Jahren"))
            content.body = String(localized: "\(list.count) Fotos vom \(Fmt.dayLongMonthYear.string(from: list[0].date))") +
                (list.compactMap(\.city).first.map { " · \($0)" } ?? "")
            content.userInfo = ["memoryDay": "\(d.month!)-\(d.day!)", "year": year]
            if let att = await attachment(list.first(where: \.isFavorite) ?? list[list.count / 2], index: offset) {
                content.attachments = [att]
            }
            var trigger = DateComponents(); trigger.year = d.year; trigger.month = d.month; trigger.day = d.day; trigger.hour = hour
            try? await center.add(UNNotificationRequest(identifier: "memory-\(offset)",
                                                        content: content,
                                                        trigger: UNCalendarNotificationTrigger(dateMatching: trigger, repeats: false)))
        }
    }

    /// Vorschaubild für die Mitteilung (muss als Datei vorliegen).
    private static func attachment(_ a: Asset, index: Int) async -> UNNotificationAttachment? {
        guard let img = await ImageCache.shared.load(a.id, .thumbnail), let jpg = img.jpegData(compressionQuality: 0.8) else { return nil }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("rueckblick-\(index).jpg")
        guard (try? jpg.write(to: url)) != nil else { return nil }
        return try? UNNotificationAttachment(identifier: "bild", url: url)
    }

    /// Geplante Mitteilungen (für die Anzeige in den Einstellungen).
    static func pendingCount() async -> Int {
        await UNUserNotificationCenter.current().pendingNotificationRequests().filter { $0.identifier.hasPrefix("memory-") }.count
    }
}
