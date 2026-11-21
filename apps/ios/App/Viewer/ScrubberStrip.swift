import SwiftUI
import UIKit

/// Vorschau-Leiste der Einzelansicht wie Fotos (REA: PUScrubberView / PUScrubberTilingLayout / PXVideoScrubberController):
/// - schmale Streifen; was unter der Mitte liegt, ist das gezeigte Foto – Wischen wechselt das Foto sofort mit
///   (`_indexOfItemClosestToAbscissa`), beim Loslassen rastet die Leiste auf ein Foto ein (`targetContentOffset`)
/// - in Ruhe ist das aktuelle Foto breiter (`expandedItemWidth`), ein Video bekommt eine Breite nach seiner Länge
///   (`_lengthForDuration`) mit Standbildern; dort ist die Mitte der Abspielkopf (`useEmbeddedVideoScrubber`)
/// - Wischen im Video spult (`_isContentScrubbing`), über den Rand hinaus geht es in die Fotoliste (`_allowExitFromContentScrubbing`)
/// UIKit statt SwiftUI: nur die sichtbaren Streifen existieren (auch bei 80 000 Fotos flüssig).
struct ScrubberStrip: UIViewRepresentable {
    let assets: [Asset]
    @Binding var selection: String
    let video: VideoState
    /// Wischt der Nutzer gerade durch die Fotoliste (dann keine teure Arbeit je Foto)?
    var onScrubbing: (Bool) -> Void = { _ in }

    func makeUIView(context: Context) -> ScrubberView {
        let v = ScrubberView()
        v.onSelect = { id in if selection != id { selection = id } }
        v.onScrubbing = onScrubbing
        v.video = video
        return v
    }

    func updateUIView(_ v: ScrubberView, context: Context) {
        v.onSelect = { id in if selection != id { selection = id } }
        v.onScrubbing = onScrubbing
        v.video = video
        v.update(assets: assets, selection: selection, frames: video.id == selection ? video.frames : [],
                 progress: video.id == selection && video.duration > 0 ? video.time / video.duration : 0)
    }
}

final class ScrubberView: UIView, UIScrollViewDelegate {
    var onSelect: (String) -> Void = { _ in }
    var onScrubbing: (Bool) -> Void = { _ in }
    weak var video: VideoState?

    private enum Mode { case settled, library, content }
    private var mode = Mode.settled

    private let scroll = UIScrollView()
    private let playhead = UIView()
    private var pool: [Int: SlitView] = [:]
    private var spare: [SlitView] = []

    private var assets: [Asset] = []
    private var index = 0                // aktuelles Foto
    private var expanded: Int?          // breit gezeigtes Foto (in Ruhe = index)
    private var frames: [UIImage] = []
    private var progress: Double = 0
    private var wasPlaying = false

    // Maße wie Fotos: Streifen 30 pt hoch, schmal, 2 pt Abstand
    private let height: CGFloat = 30
    private let slit: CGFloat = 18
    private let gap: CGFloat = 2
    private let pad: CGFloat = 5
    private var pitch: CGFloat { slit + gap }

    override init(frame: CGRect) {
        super.init(frame: frame)
        scroll.showsHorizontalScrollIndicator = false
        scroll.alwaysBounceHorizontal = true
        scroll.decelerationRate = .normal
        scroll.delegate = self
        scroll.clipsToBounds = false
        addSubview(scroll)
        playhead.backgroundColor = .white
        playhead.layer.cornerRadius = 1.5
        playhead.layer.shadowColor = UIColor.black.cgColor
        playhead.layer.shadowOpacity = 0.5
        playhead.layer.shadowRadius = 2
        playhead.layer.shadowOffset = .zero
        playhead.isUserInteractionEnabled = false
        playhead.isHidden = true
        addSubview(playhead)
        addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(tap(_:))))
    }
    required init?(coder: NSCoder) { fatalError() }

    // MARK: Geometrie

    private var expandedWidth: CGFloat {
        guard let e = expanded, assets.indices.contains(e) else { return slit }
        let a = assets[e]
        if a.isVideo {
            // wie `_lengthForDuration`: länger = breiter, aber nie über gut die halbe Breite
            let d = CGFloat(a.durationMs ?? 0) / 1000
            return max(90, min(bounds.width * 0.55, 90 + d * 6))
        }
        return max(height * 0.75, min(height * 1.6, height * CGFloat(a.ratio)))
    }
    /// Mehrbreite durch das breite Foto (inkl. Rand links/rechts)
    private var extra: CGFloat { expanded == nil ? 0 : expandedWidth + 2 * pad - slit }

    private func minX(_ i: Int) -> CGFloat {
        guard let e = expanded else { return CGFloat(i) * pitch }
        if i < e { return CGFloat(i) * pitch }
        if i == e { return CGFloat(i) * pitch + pad }
        return CGFloat(i) * pitch + extra
    }
    private func width(_ i: Int) -> CGFloat { i == expanded ? expandedWidth : slit }
    private func center(_ i: Int) -> CGFloat { minX(i) + width(i) / 2 }

    /// Foto unter der Stelle x (Inhaltskoordinate)
    private func item(at x: CGFloat) -> Int {
        guard !assets.isEmpty else { return 0 }
        var i: Int
        if let e = expanded {
            let start = CGFloat(e) * pitch, end = start + expandedWidth + 2 * pad
            if x < start { i = Int(((x + gap / 2) / pitch).rounded(.down)) }
            else if x <= end { i = e }
            else { i = e + 1 + Int(((x - end - gap / 2) / pitch).rounded(.down)) }
        } else {
            i = Int(((x + gap / 2) / pitch).rounded(.down))
        }
        return max(0, min(assets.count - 1, i))
    }
    /// Inhaltskoordinate unter der Bildschirmmitte
    private var focus: CGFloat { scroll.contentOffset.x + scroll.bounds.width / 2 }
    private func offset(centering x: CGFloat) -> CGFloat { x - scroll.bounds.width / 2 }

    // MARK: Aufbau

    override func layoutSubviews() {
        super.layoutSubviews()
        let old = scroll.frame
        scroll.frame = bounds
        playhead.frame = CGRect(x: bounds.midX - 1.5, y: -4, width: 3, height: height + 8)
        if old.width != bounds.width {
            scroll.contentInset = UIEdgeInsets(top: 0, left: bounds.width / 2, bottom: 0, right: bounds.width / 2)
            relayout(keep: false)
        }
    }

    func update(assets new: [Asset], selection: String, frames f: [UIImage], progress p: Double) {
        let changed = new.count != assets.count || new.first?.id != assets.first?.id || new.last?.id != assets.last?.id
        assets = new
        frames = f
        progress = p
        guard let i = assets.firstIndex(where: { $0.id == selection }) else { return }
        if changed { pool.values.forEach { $0.removeFromSuperview(); spare.append($0) }; pool.removeAll() }
        let selectionChanged = i != index
        index = i
        switch mode {
        case .library, .content:
            if mode == .content { tileVisible() }   // Standbilder können nachkommen
        case .settled:
            if selectionChanged || changed || expanded != i {
                // von außen gewechselt (Wischen im großen Bild, Tippen): breit machen und zur Mitte gleiten
                expanded = i
                relayout(keep: false, animated: !changed && window != nil)
            } else if assets[i].isVideo, !scroll.isTracking {
                // läuft das Video, wandert die Leiste unter dem Abspielkopf mit
                scroll.contentOffset.x = offset(centering: minX(i) + expandedWidth * CGFloat(progress))
                tileVisible()
            } else {
                tileVisible()
            }
        }
        playhead.isHidden = !(assets.indices.contains(index) && assets[index].isVideo && expanded == index)
    }

    /// Inhalt neu vermessen; `keep`: das Foto unter der Mitte bleibt dort (Wechsel breit ↔ schmal beim Ziehen).
    private func relayout(keep: Bool, animated: Bool = false) {
        guard !assets.isEmpty, scroll.bounds.width > 0 else { return }
        scroll.contentSize = CGSize(width: CGFloat(assets.count) * pitch - gap + extra, height: height)
        var target = center(index)
        if let e = expanded, assets.indices.contains(e), assets[e].isVideo { target = minX(e) + expandedWidth * CGFloat(progress) }
        let apply = {
            self.scroll.contentOffset = CGPoint(x: self.offset(centering: target), y: 0)
            self.tileVisible(force: true)
        }
        if animated { UIView.animate(withDuration: 0.25, delay: 0, options: [.curveEaseOut, .allowUserInteraction, .beginFromCurrentState], animations: apply) }
        else { apply() }
        _ = keep
    }

    /// Nur die sichtbaren Streifen anlegen bzw. wiederverwenden.
    private func tileVisible(force: Bool = false) {
        guard !assets.isEmpty else { return }
        let visible = CGRect(x: scroll.contentOffset.x - 40, y: 0, width: scroll.bounds.width + 80, height: height)
        let first = item(at: visible.minX), last = item(at: visible.maxX)
        for (i, v) in pool where i < first || i > last {
            v.removeFromSuperview(); v.reset(); spare.append(v); pool[i] = nil
        }
        for i in first...last {
            let v = pool[i] ?? {
                let n = spare.popLast() ?? SlitView()
                scroll.addSubview(n); pool[i] = n
                n.show(assets[i])
                return n
            }()
            if v.assetID != assets[i].id { v.show(assets[i]) }
            v.frame = CGRect(x: minX(i), y: 0, width: width(i), height: height)
            v.setFrames(i == expanded && assets[i].isVideo ? frames : [])
            _ = force
        }
    }

    // MARK: Ziehen

    func scrollViewWillBeginDragging(_ s: UIScrollView) {
        let touch = s.panGestureRecognizer.location(in: s)
        if let e = expanded, assets.indices.contains(e), assets[e].isVideo,
           touch.x >= minX(e) - pad, touch.x <= minX(e) + expandedWidth + pad {
            // im Video: spulen
            mode = .content
            wasPlaying = video?.playing ?? false
            video?.beginScrub()
        } else {
            enterLibrary()
        }
    }

    /// In die Fotoliste wechseln: alle Streifen schmal, das Foto unter der Mitte bleibt unter der Mitte.
    private func enterLibrary() {
        mode = .library
        onScrubbing(true)
        let i = item(at: focus)
        let within = (focus - minX(i)) / max(1, width(i))   // relative Lage im breiten Foto
        expanded = nil
        scroll.contentSize = CGSize(width: CGFloat(assets.count) * pitch - gap, height: height)
        scroll.contentOffset.x = offset(centering: minX(i) + slit * max(0, min(1, within)))
        playhead.isHidden = true
        tileVisible(force: true)
    }

    func scrollViewDidScroll(_ s: UIScrollView) {
        switch mode {
        case .settled: tileVisible()
        case .library:
            tileVisible()
            let i = item(at: focus)
            if i != index, assets.indices.contains(i) {
                index = i
                UISelectionFeedbackGenerator().selectionChanged()
                onSelect(assets[i].id)
            }
        case .content:
            guard let e = expanded else { return }
            let x0 = minX(e), w = expandedWidth
            if focus < x0 - pad - 6 || focus > x0 + w + pad + 6 {
                // über den Rand des Videos hinaus: weiter durch die Fotoliste
                video?.endScrub(resume: false)
                enterLibrary()
                return
            }
            video?.scrub(to: Double(max(0, min(1, (focus - x0) / w))))
            tileVisible()
        }
    }

    func scrollViewWillEndDragging(_ s: UIScrollView, withVelocity v: CGPoint, targetContentOffset t: UnsafeMutablePointer<CGPoint>) {
        switch mode {
        case .library:
            // auf ein Foto einrasten (Mitte des Streifens unter der Mitte)
            let i = item(at: t.pointee.x + s.bounds.width / 2)
            t.pointee.x = offset(centering: center(i))
        case .content:
            t.pointee.x = s.contentOffset.x   // beim Spulen nicht weitergleiten
        case .settled: break
        }
    }

    func scrollViewDidEndDragging(_ s: UIScrollView, willDecelerate d: Bool) { if !d { settle() } }
    func scrollViewDidEndDecelerating(_ s: UIScrollView) { settle() }

    private func settle() {
        switch mode {
        case .content:
            mode = .settled
            video?.endScrub(resume: wasPlaying)
        case .library:
            mode = .settled
            let i = item(at: focus)
            index = i
            onSelect(assets[i].id)
            expanded = i
            progress = 0
            relayout(keep: false, animated: true)
            onScrubbing(false)
        case .settled: break
        }
        playhead.isHidden = !(assets.indices.contains(index) && assets[index].isVideo)
    }

    @objc private func tap(_ g: UITapGestureRecognizer) {
        let x = g.location(in: scroll).x
        let i = item(at: x)
        guard assets.indices.contains(i), i != index else { return }
        index = i
        onSelect(assets[i].id)
        expanded = i
        progress = 0
        relayout(keep: false, animated: true)
    }
}

/// Ein Streifen: Vorschaubild, beim breiten Video die Standbilder nebeneinander.
private final class SlitView: UIView {
    private let image = UIImageView()
    private var strip: [UIImageView] = []
    private(set) var assetID = ""
    private var task: Task<Void, Never>?

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = UIColor(white: 0.13, alpha: 1)
        clipsToBounds = true
        layer.cornerRadius = 2
        layer.cornerCurve = .continuous
        image.contentMode = .scaleAspectFill
        image.clipsToBounds = true
        addSubview(image)
    }
    required init?(coder: NSCoder) { fatalError() }

    func show(_ a: Asset) {
        task?.cancel()
        assetID = a.id
        let cache = ImageCache.shared, key = "\(a.id)-\(ImmichClient.Size.thumbnail.rawValue)"
        if let img = cache.get(key) { image.image = img; return }
        image.image = cache.placeholder(a.id)
        let id = a.id
        task = Task { [weak self] in
            let img = await cache.load(id, .thumbnail)
            guard let self, !Task.isCancelled, self.assetID == id, let img else { return }
            self.image.image = img
        }
    }

    func setFrames(_ f: [UIImage]) {
        if f.isEmpty {
            strip.forEach { $0.isHidden = true }
            image.isHidden = false
            return
        }
        while strip.count < f.count {
            let v = UIImageView(); v.contentMode = .scaleAspectFill; v.clipsToBounds = true
            addSubview(v); strip.append(v)
        }
        image.isHidden = true
        let w = bounds.width / CGFloat(f.count)
        for (i, v) in strip.enumerated() {
            v.isHidden = i >= f.count
            guard i < f.count else { continue }
            v.image = f[i]
            v.frame = CGRect(x: CGFloat(i) * w, y: 0, width: ceil(w), height: bounds.height)
        }
    }

    func reset() { task?.cancel(); task = nil; assetID = ""; image.image = nil; setFrames([]) }

    override func layoutSubviews() {
        super.layoutSubviews()
        image.frame = bounds
        let n = strip.filter { !$0.isHidden }.count
        guard n > 0 else { return }
        let w = bounds.width / CGFloat(n)
        for (i, v) in strip.enumerated() where !v.isHidden { v.frame = CGRect(x: CGFloat(i) * w, y: 0, width: ceil(w), height: bounds.height) }
    }
}
