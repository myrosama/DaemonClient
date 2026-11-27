import Foundation

// MARK: - Server-Antworten (Immich v3.3.5, siehe API-NOTIZEN.md)

struct TimeBucket: Decodable, Hashable, Identifiable, Sendable {
    let timeBucket: String          // "2024-12-01" (Monatsanfang)
    let count: Int
    var id: String { timeBucket }

    /// Monatsanfang als Datum (Kalender in UTC = „Wanduhrzeit“, siehe Asset.date).
    var monthDate: Date { DateParsing.day(timeBucket) ?? .distantPast }
}

/// Spaltenformat von GET /timeline/bucket: jedes Feld ist ein Array, Index i = Asset i.
/// A video's length in ms. The worker sends a number, but older rows still carry Immich's "H:MM:SS.mmm" text: a
/// strict `[Int?]` let one such row blank its whole month (2026-11-26: 14 rows hid 880 photos on the test account).
/// Parses "0:00:05.500" and "5000"; other text is nil.
struct Millis: Decodable {
    let value: Int?
    init(_ value: Int?) { self.value = value }
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { value = nil }
        else if let i = try? c.decode(Int.self) { value = i }
        else if let x = try? c.decode(Double.self) { value = Self.whole(x) }
        else if let s = try? c.decode(String.self) { value = Self.parse(s) }
        else { value = nil }
    }
    static func parse(_ s: String) -> Int? {
        guard !s.contains("-") else { return nil }
        let parts = s.split(separator: ":", omittingEmptySubsequences: false)
        if parts.count == 1 { return Int(s) }
        let nums = parts.compactMap { Double($0) }
        guard nums.count == parts.count else { return nil }
        return whole(nums.reduce(0) { $0 * 60 + $1 } * 1000)
    }
    private static func whole(_ x: Double) -> Int? { x.isFinite && abs(x) < 1e15 ? Int(x) : nil }
}

struct BucketColumns: Decodable {
    let id: [String]
    let isImage: [Bool]
    let isFavorite: [Bool]
    let fileCreatedAt: [String]          // UTC, ohne "Z"
    let localOffsetHours: [Double?]?     // + Offset = Ortszeit der Aufnahme
    let ratio: [Double?]
    let duration: [Millis]?              // Millisekunden, nur Videos
    let livePhotoVideoId: [String?]
    let city: [String?]?
    let country: [String?]?
    let thumbhash: [String?]?
    let createdAt: [String]?             // Upload-Zeitpunkt (für „Nach zuletzt hinzugefügt“)
    let ownerId: [String]?
    let visibility: [String?]?           // "timeline" | "archive" (Ausgeblendet) | …

    /// nil when a column's length differs from `id`'s (a worker bug must not crash the app on every launch).
    func assets() -> [Asset]? {
        let n = id.count
        let lengths = [isImage.count, isFavorite.count, fileCreatedAt.count, ratio.count, livePhotoVideoId.count,
                       localOffsetHours?.count, duration?.count, city?.count, country?.count, thumbhash?.count,
                       createdAt?.count, ownerId?.count, visibility?.count].compactMap { $0 }
        guard lengths.allSatisfy({ $0 == n }) else { return nil }
        return id.indices.map { i in
            ImageCache.shared.setHash(id[i], thumbhash?[i] ?? nil, video: !isImage[i])
            let utc = DateParsing.wallClock(fileCreatedAt[i]) ?? .distantPast
            let offset = (localOffsetHours?[i] ?? nil) ?? 0
            return Asset(id: id[i],
                  isImage: isImage[i],
                  isFavorite: isFavorite[i],
                  date: utc.addingTimeInterval(offset * 3600),
                  ratio: ratio[i] ?? 1,
                  durationMs: duration?[i].value,
                  livePhotoVideoId: livePhotoVideoId[i],
                  city: city?[i] ?? nil,
                  country: country?[i] ?? nil,
                  addedAt: createdAt.flatMap { DateParsing.wallClock($0[i]) },
                  ownerId: ownerId?[i],
                  isHidden: (visibility?[i] ?? nil).map { $0 != "timeline" } ?? false)
        }
    }
}

/// Ein Foto/Video. `date` ist die lokale Aufnahme-Uhrzeit („Wanduhr“), als UTC gespeichert
/// und immer mit `Calendar.wall` / UTC-Formattern angezeigt → Tage kippen nie um Mitternacht.
struct Asset: Identifiable, Hashable, Sendable {
    let id: String
    let isImage: Bool
    var isFavorite: Bool
    let date: Date
    let ratio: Double
    let durationMs: Int?
    let livePhotoVideoId: String?
    let city: String?
    let country: String?
    var addedAt: Date? = nil
    var ownerId: String? = nil
    var isHidden = false             // liegt in „Ausgeblendet“ (Immich „archive“; „hidden“ sind Live-Videoteile)
    var trashedAt: Date? = nil       // liegt in „Zuletzt gelöscht“ (seit ungefähr)

    var isVideo: Bool { !isImage }
    var isLivePhoto: Bool { livePhotoVideoId != nil }
}

extension AssetDTO {
    /// Aufnahmezeit mit der Zeitzone des Originals, z. B. 2026-07-15T15:30:00+02:00 – für PUT dateTimeOriginal.
    /// Versatz = `localDateTime` (Ortszeit mit falschem „Z“) − `fileCreatedAt` (echte UTC-Zeit); beide liefert Immich immer.
    var captureTimeWithZone: String? {
        func parse(_ s: String) -> Date? {
            let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let d = f.date(from: s) { return d }
            f.formatOptions = [.withInternetDateTime]; return f.date(from: s)
        }
        guard let ls = localDateTime, let local = parse(ls), let utc = parse(fileCreatedAt) else { return nil }
        let offset = Int((local.timeIntervalSince(utc) / 60).rounded()) * 60
        guard abs(offset) <= 14 * 3600, let tz = TimeZone(secondsFromGMT: offset) else { return nil }
        let f = ISO8601DateFormatter(); f.timeZone = tz; f.formatOptions = [.withInternetDateTime]
        return f.string(from: utc)
    }
}

/// Vollständiges Asset (GET /assets/{id}, Suche, Rückblicke, Alben).
struct AssetDTO: Decodable {
    let id: String
    let type: String                 // IMAGE | VIDEO
    let isFavorite: Bool
    let localDateTime: String?       // Ortszeit der Aufnahme (mit falschem "Z")
    let fileCreatedAt: String
    let duration: Millis?               // Millisekunden (v3), null bei Fotos
    let livePhotoVideoId: String?
    let originalFileName: String?
    let originalMimeType: String?
    let exifInfo: ExifDTO?
    let createdAt: String?
    let ownerId: String?
    let isEdited: Bool?
    let description: String?
    let thumbhash: String?           // ändert sich, sobald der Server neue Vorschauen gerechnet hat
    let width: Double?               // nach Bearbeitung (Zuschnitt/Drehung) aktuell, EXIF nicht
    let height: Double?
    let stack: StackDTO?
    let visibility: String?          // timeline | hidden | archive | locked
    let isTrashed: Bool?
    let updatedAt: String?           // bei Gelöschtem ≈ Zeitpunkt des Löschens (eigenes Feld gibt die API nicht her)
    struct StackDTO: Decodable { let id: String; let primaryAssetId: String?; let assetCount: Int? }

    struct ExifDTO: Decodable {
        let city: String?
        let country: String?
        let state: String?
        let make: String?
        let model: String?
        let exifImageWidth: Double?
        let exifImageHeight: Double?
        let fileSizeInByte: Int?
        let latitude: Double?
        let longitude: Double?
        let fNumber: Double?
        let focalLength: Double?
        let iso: Double?
        let exposureTime: String?
        let lensModel: String?
        let description: String?
        var dateTimeOriginal: String? = nil   // mit Zeitzone, z. B. 2026-07-15T15:30:00+02:00
        var timeZone: String? = nil           // z. B. „UTC-8“ oder „Europe/Berlin“; nil = keine bekannt
    }

    var asset: Asset {
        ImageCache.shared.setHash(id, thumbhash, video: type != "IMAGE")
        let w = width ?? exifInfo?.exifImageWidth ?? 0, h = height ?? exifInfo?.exifImageHeight ?? 0
        return Asset(id: id, isImage: type == "IMAGE", isFavorite: isFavorite,
                     date: DateParsing.wallClock(localDateTime ?? fileCreatedAt) ?? .distantPast,
                     ratio: (w > 0 && h > 0) ? w / h : 1,
                     durationMs: (duration?.value ?? 0) > 0 ? duration?.value : nil,
                     livePhotoVideoId: livePhotoVideoId,
                     city: exifInfo?.city, country: exifInfo?.country,
                     addedAt: createdAt.flatMap(DateParsing.wallClock), ownerId: ownerId,
                     isHidden: visibility == "archive",
                     trashedAt: isTrashed == true ? (updatedAt.flatMap(DateParsing.wallClock) ?? Date()) : nil)
    }
}

struct AlbumDTO: Decodable, Identifiable, Hashable {
    let id: String
    let albumName: String
    let albumThumbnailAssetId: String?
    let assetCount: Int
    var order: String? = nil          // asc | desc (Sortierung im Album, vom Server gespeichert)
    var createdAt: String? = nil
    var updatedAt: String? = nil
    var endDate: String? = nil        // neuestes Foto im Album
    var shared: Bool? = nil           // mit anderen geteilt (dann gibt es Kommentare/Likes)
}

struct MapMarkerDTO: Decodable, Identifiable {
    let id: String
    let lat: Double
    let lon: Double
    let city: String?
    let country: String?
}

struct UserDTO: Decodable {
    let id: String
    let name: String
    let email: String
}

// MARK: - Datum

enum DateParsing {
    static let utc = TimeZone(identifier: "UTC")!

    /// "2024-12-17T10:10:00" oder "...000Z" → Datum, als Wanduhrzeit in UTC interpretiert.
    private static let isoWall: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = utc
        f.dateFormat = "yyyy-MM-dd'T'HH:mm:ss"
        return f
    }()

    static func wallClock(_ s: String) -> Date? {
        var str = s
        if let z = str.firstIndex(where: { $0 == "Z" || $0 == "+" }) { str = String(str[..<z]) }
        if let dot = str.firstIndex(of: ".") { str = String(str[..<dot]) }
        return isoWall.date(from: str)
    }

    static func day(_ s: String) -> Date? {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = utc
        f.dateFormat = "yyyy-MM-dd"
        return f.date(from: String(s.prefix(10)))
    }

}

extension Calendar {
    /// Kalender für Wanduhr-Daten (siehe Asset.date).
    static let wall: Calendar = {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = DateParsing.utc
        c.locale = .autoupdatingCurrent
        return c
    }()
}

enum Fmt {
    private static func make(_ template: String) -> DateFormatter {
        let f = DateFormatter()
        f.locale = .autoupdatingCurrent
        f.timeZone = DateParsing.utc
        f.setLocalizedDateFormatFromTemplate(template)
        return f
    }
    static let dayMonthYear = make("d MMM yyyy")      // 2. Nov. 2026
    static let monthYear = make("MMMM yyyy")          // November 2026
    static let monthShortYear = make("MMM yyyy")      // Okt. 2026 (Kapsel der Monats-Zoomstufe)
    static let dayMonthYearShort = make("d MMM yyyy") // 7. Okt. 2026 (5-Spalten-Stufe)
    static let weekdayDay = make("EEEE, d. MMMM")     // Montag, 2. November
    static let time = make("HH:mm")
    static let weekday = make("EEEE")
    static let dayMonthYearUpper = make("d MMM yyyy")
    static let dayLongMonthYear = make("d MMMM yyyy")              // 26. August 2019
    static let fullDate = make("EEEE d MMMM yyyy")                 // Montag, 26. August 2019
    /// Montag, 26. August 2019 um 17:40 / Monday, 26 August 2019 at 17:40 – das Bindewort liefert das System
    static let fullDateTime: DateFormatter = {
        let f = DateFormatter()
        f.locale = .autoupdatingCurrent
        f.timeZone = DateParsing.utc
        f.dateStyle = .full; f.timeStyle = .short
        return f
    }()

    /// Wie Fotos: „Heute“, „Gestern“, innerhalb einer Woche der Wochentag, sonst `fallback` (Wanduhr-Datum, siehe Asset.date).
    static func relativeDay(_ d: Date, fallback: DateFormatter = dayLongMonthYear) -> String {
        let today = Calendar.wall.startOfDay(for: Date().addingTimeInterval(TimeInterval(TimeZone.current.secondsFromGMT())))
        let diff = Calendar.wall.dateComponents([.day], from: Calendar.wall.startOfDay(for: d), to: today).day ?? 99
        switch diff {
        case 0: return String(localized: "Heute")
        case 1: return String(localized: "Gestern")
        case 2..<7: return weekday.string(from: d)
        default: return fallback.string(from: d)
        }
    }

    static func duration(_ ms: Int?) -> String {
        guard let ms else { return "" }
        let s = ms / 1000
        return s >= 3600 ? String(format: "%d:%02d:%02d", s / 3600, (s % 3600) / 60, s % 60)
                         : String(format: "%d:%02d", s / 60, s % 60)
    }
}
