import UIKit

/// Schneller Rollbalken wie in Apple Fotos: erscheint rechts, sobald man scrollt, lässt sich sofort greifen (die normale
/// iOS-Leiste braucht erst langes Drücken) und zeigt beim Ziehen Monat und Jahr in einer Blase daneben.
/// Idee: Fork von vands2013. Liegt als Unteransicht im Raster und wandert beim Scrollen mit.
@MainActor
final class GridScrubber: UIView {
    weak var scrollView: UIScrollView?
    /// Text für die Blase (Monat und Jahr der obersten sichtbaren Reihe)
    var label: (() -> String?)?
    /// Ziehen beginnt/endet (Videos anhalten, Offline-Laden pausieren)
    var onDrag: ((Bool) -> Void)?

    private let thumb = UIView()
    private let bubble = UIVisualEffectView(effect: UIBlurEffect(style: .systemMaterial))
    private let text = UILabel()
    private let haptic = UISelectionFeedbackGenerator()
    private(set) var dragging = false
    private var grabOffset: CGFloat = 0
    private var hideWork: DispatchWorkItem?
    private var lastText = ""

    private let thumbSize = CGSize(width: 6, height: 46)
    private let hitWidth: CGFloat = 44

    override init(frame: CGRect) {
        super.init(frame: frame)
        alpha = 0
        thumb.backgroundColor = UIColor.label.withAlphaComponent(0.5)
        thumb.layer.cornerRadius = 3
        thumb.layer.cornerCurve = .continuous
        addSubview(thumb)
        bubble.layer.cornerRadius = 17
        bubble.layer.cornerCurve = .continuous
        bubble.clipsToBounds = true
        bubble.alpha = 0
        text.font = .systemFont(ofSize: 15, weight: .semibold)
        text.textColor = .label
        bubble.contentView.addSubview(text)
        addSubview(bubble)
        // sofort greifen (ohne Verzögerung), Bewegung beliebig
        let press = UILongPressGestureRecognizer(target: self, action: #selector(press(_:)))
        press.minimumPressDuration = 0
        press.allowableMovement = .greatestFiniteMagnitude
        addGestureRecognizer(press)
        isAccessibilityElement = false
    }
    required init?(coder: NSCoder) { fatalError() }

    /// Senkrechter Bereich, in dem der Griff wandert (unter der Überschrift, über der unteren Leiste)
    private var track: (top: CGFloat, height: CGFloat) {
        guard let sv = scrollView else { return (0, 0) }
        let top = sv.verticalScrollIndicatorInsets.top + 8
        let bottom = sv.verticalScrollIndicatorInsets.bottom + 8
        return (top, max(0, sv.bounds.height - top - bottom))
    }
    private var range: CGFloat {
        guard let sv = scrollView else { return 0 }
        return max(0, sv.contentSize.height + sv.adjustedContentInset.top + sv.adjustedContentInset.bottom - sv.bounds.height)
    }
    /// Lohnt sich nur bei langen Rastern (mehrere Bildschirme)
    private var useful: Bool {
        guard let sv = scrollView else { return false }
        return range > sv.bounds.height * 3 && track.height > thumbSize.height * 2
    }

    /// Bei jedem Scrollen und Anordnen: mitwandern, Griff setzen, ggf. einblenden.
    func update(scrolling: Bool) {
        guard let sv = scrollView else { return }
        let t = track
        frame = CGRect(x: sv.bounds.width - hitWidth, y: sv.contentOffset.y + t.top, width: hitWidth, height: t.height)
        let p = range > 0 ? min(1, max(0, (sv.contentOffset.y + sv.adjustedContentInset.top) / range)) : 0
        let w = dragging ? thumbSize.width + 2 : thumbSize.width
        thumb.frame = CGRect(x: hitWidth - w - 3, y: p * (t.height - thumbSize.height), width: w, height: thumbSize.height)
        sv.bringSubviewToFront(self)
        if dragging { layoutBubble() }
        guard useful else { if alpha > 0 { alpha = 0 }; return }
        if scrolling || dragging { show() }
    }

    private func show() {
        hideWork?.cancel()
        if alpha < 1 { UIView.animate(withDuration: 0.15) { self.alpha = 1 } }
        guard !dragging else { return }
        let w = DispatchWorkItem { [weak self] in
            guard let self, !self.dragging, !(self.scrollView?.isDragging ?? false), !(self.scrollView?.isDecelerating ?? false) else {
                self?.show(); return
            }
            UIView.animate(withDuration: 0.3) { self.alpha = 0 }
        }
        hideWork = w
        DispatchQueue.main.asyncAfter(deadline: .now() + 2, execute: w)
    }

    private func layoutBubble() {
        let s = label?() ?? ""
        if s != lastText { lastText = s; text.text = s; if !s.isEmpty { haptic.selectionChanged() } }
        text.sizeToFit()
        let size = CGSize(width: text.bounds.width + 28, height: 34)
        text.frame = CGRect(x: 14, y: (size.height - text.bounds.height) / 2, width: text.bounds.width, height: text.bounds.height)
        bubble.frame = CGRect(x: thumb.frame.minX - 12 - size.width, y: thumb.frame.midY - size.height / 2, width: size.width, height: size.height)
        bubble.alpha = s.isEmpty ? 0 : 1
    }

    /// Nur der Griff selbst nimmt Berührungen an – sonst scrollt und tippt das Raster ganz normal.
    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        guard alpha > 0.5 else { return false }
        return thumb.frame.insetBy(dx: -(hitWidth - thumbSize.width) / 2 - 4, dy: -14).contains(point)
    }

    @objc private func press(_ g: UILongPressGestureRecognizer) {
        guard let sv = scrollView else { return }
        let t = track, travel = max(1, t.height - thumbSize.height)
        let y = g.location(in: self).y
        switch g.state {
        case .began:
            dragging = true
            grabOffset = y - thumb.frame.minY
            sv.setContentOffset(sv.contentOffset, animated: false)   // laufendes Ausrollen anhalten
            haptic.prepare()
            onDrag?(true)
            update(scrolling: true)
        case .changed:
            let p = min(1, max(0, (y - grabOffset) / travel))
            sv.contentOffset.y = -sv.adjustedContentInset.top + p * range
            update(scrolling: true)
        default:
            dragging = false
            UIView.animate(withDuration: 0.2) { self.bubble.alpha = 0 }
            lastText = ""
            onDrag?(false)
            update(scrolling: true)
        }
    }
}
