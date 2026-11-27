import SwiftUI
import UIKit

/// Ist das gerade gezeigte Foto gezoomt? (setzt `ZoomScroll`) – dann gehört Wischen dem Foto, nicht dem Schließen.
@MainActor enum ViewerZoom { static var zoomed = false }

/// Wischen nach unten zum Schließen wie in Fotos – selbst gebaut (GitHub #59). Apples Zoom-Übergang bringt eigene
/// Schließen-Gesten mit (Pinch-zu „Transform“, Wischen „SwipeDismiss“); die schnappten sich das Herauszoomen und
/// zogen beim Wischen die ganze Ansicht samt Leisten mit. Sie werden hier abgeschaltet, solange der Viewer offen ist.
struct ViewerDismissGesture: UIViewRepresentable {
    let changed: (CGSize) -> Void
    let ended: (CGSize, CGPoint) -> Void

    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeUIView(context: Context) -> Probe {
        let v = Probe()
        v.isUserInteractionEnabled = false
        v.coordinator = context.coordinator
        context.coordinator.parent = self
        return v
    }
    func updateUIView(_ v: Probe, context: Context) { context.coordinator.parent = self }

    final class Probe: UIView {
        weak var coordinator: Coordinator?
        override func didMoveToWindow() {
            super.didMoveToWindow()
            guard window != nil else { return }
            // erst nach dem Aufbau des Übergangs sind dessen Gesten angebracht
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in self?.install() }
        }
        private func install() {
            guard let c = coordinator, c.pan == nil, window != nil else { return }
            var found: [String] = [], off: [String] = []
            var host: UIView?
            var v = superview
            while let view = v, !(view is UIWindow) {
                for g in view.gestureRecognizers ?? [] where !(g.view is UIScrollView) {
                    let n = String(describing: type(of: g))
                    found.append(n)
                    if n.contains("Transform") || n.contains("Dismiss") || n.contains("Zoom") {
                        g.isEnabled = false; off.append(n); host = host ?? view
                    }
                }
                if host == nil, view.next is UIViewController { host = view }
                v = view.superview
            }
            let pan = UIPanGestureRecognizer(target: c, action: #selector(Coordinator.pan(_:)))
            pan.delegate = c
            pan.maximumNumberOfTouches = 1
            (host ?? superview)?.addGestureRecognizer(pan)
            c.pan = pan
            if !Coordinator.logged {
                Coordinator.logged = true
                PerfLog.mark("Viewer-Gesten: aus \(off.joined(separator: ", ")) · vorhanden \(Set(found).sorted().joined(separator: ", "))")
            }
        }
    }

    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        var parent: ViewerDismissGesture?
        weak var pan: UIPanGestureRecognizer?
        @MainActor static var logged = false

        @objc func pan(_ g: UIPanGestureRecognizer) {
            let t = g.translation(in: g.view)
            switch g.state {
            case .changed: parent?.changed(CGSize(width: t.x, height: max(0, t.y)))
            case .ended, .cancelled, .failed: parent?.ended(CGSize(width: t.x, height: max(0, t.y)), g.velocity(in: g.view))
            default: break
            }
        }
        /// Nur senkrecht nach unten und nur ungezoomt – seitlich bleibt Blättern, gezoomt bleibt Schieben.
        func gestureRecognizerShouldBegin(_ g: UIGestureRecognizer) -> Bool {
            guard let p = g as? UIPanGestureRecognizer, !ViewerZoom.zoomed else { return false }
            let v = p.velocity(in: p.view)
            return v.y > 0 && v.y > abs(v.x) * 1.2
        }
        func gestureRecognizer(_ g: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith o: UIGestureRecognizer) -> Bool { true }
    }
}
