import SwiftUI
import UIKit

/// Zoom für die Einzelansicht wie in Apple Fotos (GitHub #52). Bewusst UIKit: nur eine `UIScrollView` zoomt am
/// Fingerpunkt, schiebt mit Schwung und federt am Rand zurück; SwiftUIs `MagnifyGesture` fühlte sich nicht so an
/// und wurde vom Zoom-Übergang als „Schließen“ gedeutet.
///
/// - Inhalt hat die Größe des eingepassten Fotos und liegt mittig, solange er kleiner als die Fläche ist.
/// - Ungezoomt ist das Schieben aus: seitlich blättert die TabView, nach unten schließt der Zoom-Übergang.
/// - Gezoomt schiebt man in jede Richtung; am Rand übernimmt das Blättern.
/// - Doppeltippen zoomt 3× an die getippte Stelle, nochmal → ganz heraus. Einmal tippen: Leisten ein/aus.
struct ZoomScroll<Content: View>: UIViewRepresentable {
    /// Seitenverhältnis des Fotos (Breite / Höhe)
    let ratio: CGFloat
    /// Pixelbreite des geladenen Originals (0 = unbekannt): erlaubt Zoom bis zur echten Pixelgröße
    var pixelWidth: CGFloat = 0
    @Binding var scale: CGFloat
    /// gerade gezeigte Seite – beim Weiterblättern springt der Zoom zurück (wie in Fotos)
    var active = true
    let onTap: () -> Void
    @ViewBuilder let content: () -> Content

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> ZoomScrollView {
        let v = ZoomScrollView()
        let host = UIHostingController(rootView: content())
        host.view.backgroundColor = .clear
        host.safeAreaRegions = []
        v.addSubview(host.view)
        v.zoomView = host.view
        context.coordinator.host = host
        v.ratio = max(0.05, ratio)
        v.pixelWidth = pixelWidth
        v.delegate = context.coordinator

        let double = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.doubleTap(_:)))
        double.numberOfTapsRequired = 2
        v.addGestureRecognizer(double)
        let single = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.singleTap(_:)))
        single.require(toFail: double)
        v.addGestureRecognizer(single)
        return v
    }

    func updateUIView(_ v: ZoomScrollView, context: Context) {
        context.coordinator.parent = self
        context.coordinator.host?.rootView = content()
        let r = max(0.05, ratio)
        if v.ratio != r { v.ratio = r; v.relayout() }
        if v.pixelWidth != pixelWidth { v.pixelWidth = pixelWidth; v.updateMaxZoom() }
        if !active, v.zoomScale > 1.01 {
            v.setZoomScale(1, animated: false)
        }
    }

    final class Coordinator: NSObject, UIScrollViewDelegate {
        var parent: ZoomScroll
        var host: UIHostingController<Content>?
        init(_ p: ZoomScroll) { parent = p }

        func viewForZooming(in scrollView: UIScrollView) -> UIView? { (scrollView as? ZoomScrollView)?.zoomView }

        func scrollViewDidZoom(_ scrollView: UIScrollView) {
            guard let v = scrollView as? ZoomScrollView else { return }
            v.center()
            v.isScrollEnabled = v.zoomScale > 1.01
            ViewerZoom.zoomed = v.zoomScale > 1.01
            // SwiftUI nur beim Überschreiten der Schwelle informieren (sonst bei jedem Zoomschritt neu zeichnen)
            let s = v.zoomScale
            if (s > 1.01) != (parent.scale > 1.01) { parent.scale = s }
        }

        func scrollViewDidEndZooming(_ scrollView: UIScrollView, with view: UIView?, atScale scale: CGFloat) {
            parent.scale = scale
            ViewerZoom.zoomed = scale > 1.01
        }


        @objc func singleTap(_ g: UITapGestureRecognizer) { parent.onTap() }

        @objc func doubleTap(_ g: UITapGestureRecognizer) {
            guard let v = g.view as? ZoomScrollView, let z = v.zoomView else { return }
            if v.zoomScale > 1.01 {
                v.setZoomScale(1, animated: true)
            } else {
                // Rechteck um den Tippunkt mit einem Drittel der Fläche → 3× genau dort
                let p = g.location(in: z)
                let target = min(3, v.maximumZoomScale)
                let w = v.bounds.width / target, h = v.bounds.height / target
                v.zoom(to: CGRect(x: p.x - w / 2, y: p.y - h / 2, width: w, height: h), animated: true)
            }
        }
    }
}

final class ZoomScrollView: UIScrollView {
    var zoomView: UIView?
    var ratio: CGFloat = 1
    var pixelWidth: CGFloat = 0
    private var laidOutSize: CGSize = .zero

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .clear
        minimumZoomScale = 1
        maximumZoomScale = 6
        bouncesZoom = true
        decelerationRate = .fast
        contentInsetAdjustmentBehavior = .never
        showsVerticalScrollIndicator = false
        showsHorizontalScrollIndicator = false
        isScrollEnabled = false          // ungezoomt: Blättern und Wischen zum Schließen gehören dem Viewer
        clipsToBounds = true
    }
    required init?(coder: NSCoder) { fatalError() }

    override func layoutSubviews() {
        super.layoutSubviews()
        // nur bei neuer Größe (Drehen, erstes Anordnen) neu einpassen – nicht bei jedem Schiebe-/Zoomschritt
        if bounds.size != laidOutSize, bounds.width > 0, bounds.height > 0 { relayout() }
    }

    /// Foto in die Fläche einpassen (= Zoom 1), mittig.
    func relayout() {
        guard let z = zoomView, bounds.width > 0, bounds.height > 0 else { return }
        laidOutSize = bounds.size
        zoomScale = 1
        let fit: CGSize = bounds.width / bounds.height > ratio
            ? CGSize(width: bounds.height * ratio, height: bounds.height)
            : CGSize(width: bounds.width, height: bounds.width / ratio)
        z.frame = CGRect(origin: .zero, size: fit)
        contentSize = fit
        isScrollEnabled = false
        updateMaxZoom()
        center()
    }

    /// Mindestens 5×, bei großen Originalen bis zur echten Pixelgröße (höchstens 20×).
    func updateMaxZoom() {
        guard let z = zoomView, z.bounds.width > 0 else { return }
        let real = pixelWidth / (z.bounds.width * max(1, traitCollection.displayScale))
        maximumZoomScale = min(20, max(5, real))
    }

    /// Solange das Foto kleiner als die Fläche ist, liegt es in der Mitte.
    func center() {
        let dx = max(0, (bounds.width - contentSize.width) / 2)
        let dy = max(0, (bounds.height - contentSize.height) / 2)
        contentInset = UIEdgeInsets(top: dy, left: dx, bottom: dy, right: dx)
    }
}
