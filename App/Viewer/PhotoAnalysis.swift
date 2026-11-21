import SwiftUI
import VisionKit

/// Live Text, Nachschlagen und Motiv freistellen wie in Apple Fotos – mit Apples VisionKit direkt auf dem iPhone
/// (das Foto verlässt das Gerät dafür nicht). Ergebnis je Foto im Speicher gemerkt.
@MainActor @Observable
final class PhotoAnalysis {
    static let supported = ImageAnalyzer.isSupported
    private(set) var results: [String: ImageAnalysis] = [:]
    /// „Nachschlagen“ aus dem Info-Bereich: Objekte im Foto markieren
    var lookUp = false
    @ObservationIgnored private let analyzer = ImageAnalyzer()
    @ObservationIgnored private var running: Set<String> = []

    func analysis(_ id: String) -> ImageAnalysis? { results[id] }
    func hasLookUp(_ id: String) -> Bool { results[id]?.hasResults(for: .visualLookUp) ?? false }
    func hasText(_ id: String) -> Bool { results[id]?.hasResults(for: .text) ?? false }

    /// Große Vorschau analysieren (reicht für Text und Objekte; das Original müsste erst geladen werden).
    func analyze(_ a: Asset) async {
        guard Self.supported, a.isImage, results[a.id] == nil, !running.contains(a.id) else { return }
        running.insert(a.id); defer { running.remove(a.id) }
        guard let img = await ImageCache.shared.load(a.id, .preview) else { return }
        let cfg = ImageAnalyzer.Configuration([.text, .visualLookUp, .machineReadableCode])
        if let r = try? await analyzer.analyze(img, orientation: .up, configuration: cfg) {
            results[a.id] = r
            if results.count > 40 { results.removeValue(forKey: results.keys.first { $0 != a.id }!) }
        }
    }
}

/// Unsichtbare Fläche genau über dem Foto, die Text markierbar macht und Objekte zum Nachschlagen anbietet.
struct AnalysisOverlay: UIViewRepresentable {
    let analysis: ImageAnalysis?
    let chrome: Bool
    let lookUp: Bool

    func makeUIView(context: Context) -> UIView {
        let v = UIView()
        v.backgroundColor = .clear
        let i = ImageAnalysisInteraction()
        i.delegate = context.coordinator
        v.addInteraction(i)
        context.coordinator.interaction = i
        return v
    }

    func updateUIView(_ v: UIView, context: Context) {
        guard let i = context.coordinator.interaction else { return }
        if i.analysis !== analysis { i.analysis = analysis }
        i.preferredInteractionTypes = lookUp ? [.visualLookUp] : .automatic
        // Live-Text-Knopf unten rechts nur mit den Leisten, und über der Leiste der App
        i.isSupplementaryInterfaceHidden = !chrome
        i.supplementaryInterfaceContentInsets = UIEdgeInsets(top: 0, left: 0, bottom: 150, right: 6)
    }

    func makeCoordinator() -> Coord { Coord() }
    final class Coord: NSObject, ImageAnalysisInteractionDelegate {
        var interaction: ImageAnalysisInteraction?
        /// Die Fläche ist so groß wie das Foto (Seitenverhältnis), also ganzer Bereich.
        func contentsRect(for interaction: ImageAnalysisInteraction) -> CGRect { CGRect(x: 0, y: 0, width: 1, height: 1) }
        /// „Teilen“ und „Sticker hinzufügen“ beim freigestellten Motiv öffnen eigene Fenster – ohne Controller,
        /// von dem aus sie erscheinen dürfen, passierte beim Tippen nichts (GitHub #53).
        func presentingViewController(for interaction: ImageAnalysisInteraction) -> UIViewController? {
            var vc = interaction.view?.window?.rootViewController
            while let p = vc?.presentedViewController, !p.isBeingDismissed { vc = p }
            return vc
        }
    }
}
