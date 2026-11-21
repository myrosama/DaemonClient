import Foundation
import MetricKit

/// Hänger- und Absturzberichte von iOS (MetricKit) – mit Codestellen, nur auf dem Gerät, ohne Cloud.
/// iOS liefert sie beim nächsten Start der App; sie landen als JSON in Application Support/diagnose/ und als
/// Kurzzeile in `leistung.log`. So lässt sich sehen, was z. B. einen 5-Sekunden-Hänger verursacht hat.
final class Diagnostics: NSObject, MXMetricManagerSubscriber, @unchecked Sendable {   // ohne veränderlichen Zustand
    static let shared = Diagnostics()

    static var folder: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("diagnose")
    }

    func start() {
        MXMetricManager.shared.add(self)
        store(MXMetricManager.shared.pastDiagnosticPayloads)
    }

    func didReceive(_ payloads: [MXDiagnosticPayload]) { store(payloads) }

    private func store(_ payloads: [MXDiagnosticPayload]) {
        guard !payloads.isEmpty else { return }
        let fm = FileManager.default
        try? fm.createDirectory(at: Self.folder, withIntermediateDirectories: true)
        let f = DateFormatter(); f.dateFormat = "yyyyMMdd-HHmmss"
        for p in payloads {
            let name = "\(f.string(from: p.timeStampEnd))-\(UUID().uuidString.prefix(4)).json"
            try? p.jsonRepresentation().write(to: Self.folder.appendingPathComponent(name))
            var parts: [String] = []
            if let h = p.hangDiagnostics, !h.isEmpty {
                let longest = h.map { $0.hangDuration.converted(to: .seconds).value }.max() ?? 0
                parts.append("\(h.count) Hänger (längster \(String(format: "%.1f", longest)) s)")
            }
            if let c = p.crashDiagnostics, !c.isEmpty { parts.append("\(c.count) Absturz") }
            if let c = p.cpuExceptionDiagnostics, !c.isEmpty { parts.append("\(c.count) CPU-Überlast") }
            if let d = p.diskWriteExceptionDiagnostics, !d.isEmpty { parts.append("\(d.count) Schreib-Überlast") }
            if !parts.isEmpty { PerfLog.mark("Diagnose von iOS: \(parts.joined(separator: ", ")) → diagnose/\(name)") }
        }
        // nur die letzten 30 Berichte behalten
        let files = ((try? fm.contentsOfDirectory(at: Self.folder, includingPropertiesForKeys: nil)) ?? []).sorted { $0.lastPathComponent < $1.lastPathComponent }
        for old in files.dropLast(30) { try? fm.removeItem(at: old) }
    }
}
