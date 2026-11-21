import Foundation
import UIKit
import QuartzCore

/// Leistungsprotokoll – läuft auch in der installierten App, damit Ruckeln auf dem echten iPhone messbar ist:
/// Hänger des Hauptthreads ab 250 ms und Ruckler beim Scrollen/Zoomen (zu spät gezeichnete Bilder, „Hitches“).
/// Datei in Application Support/leistung.log, teilbar unter „Backup & Offline“.
enum PerfLog {
    static let url = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("leistung.log")
    private static let t0 = Date()
    private static let queue = DispatchQueue(label: "perflog", qos: .utility)
    /// Was gerade zu sehen ist / passiert (vom Hauptthread gesetzt, vom Wächter gelesen)
    nonisolated(unsafe) private static var screen = "Start"
    nonisolated(unsafe) private static var activity = ""

    @MainActor static func start() {
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        _ = t0
        trim()
        let info = Bundle.main.infoDictionary
        let version = "\(info?["CFBundleShortVersionString"] ?? "?") (\(info?["CFBundleVersion"] ?? "?"))"
        var sys = utsname(); uname(&sys)
        let model = withUnsafeBytes(of: &sys.machine) { String(decoding: $0.prefix { $0 != 0 }, as: UTF8.self) }
        write("=== Start \(Date().formatted(.dateTime.day().month().hour().minute().locale(Locale(identifier: "de_DE")))) · \(model) · iOS \(UIDevice.current.systemVersion) · App \(version) ===")
        Thread.detachNewThread {
            Thread.current.name = "Hänger-Wächter"
            while true {
                let sem = DispatchSemaphore(value: 0)
                let start = Date()
                DispatchQueue.main.async { sem.signal() }
                if sem.wait(timeout: .now() + 0.25) == .timedOut {
                    sem.wait()
                    let ms = Date().timeIntervalSince(start) * 1000
                    // nicht im Hintergrund zählen (iOS friert die App dort ein)
                    if ms < 30_000 { line(String(format: "HÄNGER %.0f ms", ms)) }
                }
                Thread.sleep(forTimeInterval: 0.05)
            }
        }
    }

    static func setScreen(_ s: String) { screen = s }
    static func mark(_ s: String) { line(s) }

    private static func line(_ s: String) {
        let ctx = activity.isEmpty ? screen : "\(screen), \(activity)"
        write(String(format: "%7.2fs %@ · %@", Date().timeIntervalSince(t0), s, ctx))
    }

    private static func write(_ s: String) {
        queue.async {
            let d = Data((s + "\n").utf8)
            if let h = try? FileHandle(forWritingTo: url) { h.seekToEndOfFile(); h.write(d); try? h.close() }
            else { try? d.write(to: url) }
        }
    }

    /// Datei klein halten: über 400 KB nur die letzten 200 KB behalten.
    private static func trim() {
        guard let d = try? Data(contentsOf: url), d.count > 400_000 else { return }
        var tail = d.suffix(200_000)
        if let nl = tail.firstIndex(of: 10) { tail = tail[(nl + 1)...] }
        try? Data(tail).write(to: url)
    }

    static func clear() { queue.async { try? Data().write(to: url) } }

    // MARK: Ruckler-Messung

    @MainActor private static let meter = HitchMeter()
    /// Scrollen/Zoomen beginnt (`what` erscheint im Protokoll).
    @MainActor static func motionBegan(_ what: String) {
        activity = what
        meter.begin(what)
    }
    @MainActor static func motionEnded() {
        if let r = meter.end() { line(r) }
        activity = ""
    }
}

/// Misst, wie viele Bilder beim Scrollen zu spät kamen (wie Apples „Hitch-Rate“ in ms pro Sekunde).
@MainActor
private final class HitchMeter: NSObject {
    private var link: CADisplayLink?
    private var last: CFTimeInterval = 0
    private var started: CFTimeInterval = 0
    private var hitch: CFTimeInterval = 0
    private var longest: CFTimeInterval = 0
    private var frames = 0
    private var what = ""

    func begin(_ w: String) {
        what = w
        guard link == nil else { return }
        hitch = 0; longest = 0; frames = 0; last = 0
        started = CACurrentMediaTime()
        let l = CADisplayLink(target: self, selector: #selector(tick(_:)))
        l.preferredFrameRateRange = CAFrameRateRange(minimum: 60, maximum: 120, preferred: 120)
        l.add(to: .main, forMode: .common)
        link = l
    }

    @objc private func tick(_ l: CADisplayLink) {
        defer { last = l.timestamp }
        guard last > 0 else { return }
        let dt = l.timestamp - last, frame = l.targetTimestamp - l.timestamp
        frames += 1
        longest = max(longest, dt)
        if frame > 0, dt > frame * 1.5 { hitch += dt - frame }
    }

    func end() -> String? {
        guard let l = link else { return nil }
        l.invalidate(); link = nil
        let dur = CACurrentMediaTime() - started
        guard dur > 0.3, frames > 10 else { return nil }
        let rate = hitch * 1000 / dur
        // unter 5 ms/s merkt man nichts (Apple: „gut“) – dann nur kurz
        return String(format: "%@ %.1f s · Ruckler %.0f ms/s · längstes Bild %.0f ms%@", what, dur, rate, longest * 1000,
                      rate >= 10 ? " · RUCKELT" : "")
    }
}
