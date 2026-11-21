import SwiftUI
import UIKit
import UniformTypeIdentifiers
import AVFoundation

/// Zoom-Stufen der Mediathek wie Apple Fotos: 1 · 3 · 5 · Monate (15) · Jahre (23).
enum GridZoom {
    static let steps = [1, 3, 5, 15, 23]
    /// Ab hier Monat/Jahr als Kapsel, Tippen zoomt statt zu öffnen.
    static let dense = 15
    static func normalized(_ c: Int) -> Int { steps.min { abs($0 - c) < abs($1 - c) } ?? 3 }
    /// Beim Zoomen mit zwei Fingern feuert sonst der Tipp auf die Kachel unter den Fingern (Foto öffnet sich).
    @MainActor static var tapsBlockedUntil = Date.distantPast
    @MainActor static var tapsAllowed: Bool { Date() > tapsBlockedUntil }
}

/// Steuert das Raster von außen (Springen zu einem Objekt, Rahmen für den Zoom-Übergang).
@MainActor
final class GridController {
    fileprivate weak var view: GridCollectionView?
    /// Weich ans Ende (Neuestes) scrollen.
    func scrollToEnd() {
        guard let v = view else { return }
        let y = max(-v.contentInset.top, v.contentSize.height + v.contentInset.bottom - v.bounds.height)
        v.setContentOffset(CGPoint(x: 0, y: y), animated: true)
    }
    /// Springen, sobald das Raster seine Größe kennt (vorher ist scrollToItem wirkungslos).
    func scroll(to index: Int, anchor: UnitPoint) {
        guard let v = view else { return }
        v.pending = (index, anchor)
        v.setNeedsLayout()
    }
    /// Rahmen der Kachel im Raster-Ausschnitt; liegt sie außerhalb, wird sie (ohne Animation) ins Bild geholt –
    /// wie Apple: nach dem Weiterwischen in der Einzelansicht zoomt das Foto an seinen Platz zurück.
    func frame(of index: Int, reveal: Bool) -> CGRect? {
        guard let v = view, index < v.numberOfItems(inSection: 0),
              let f = v.collectionViewLayout.layoutAttributesForItem(at: IndexPath(item: index, section: 0))?.frame else { return nil }
        let visible = CGRect(x: 0, y: v.contentOffset.y + v.contentInset.top + 100, width: v.bounds.width,
                             height: v.bounds.height - v.contentInset.top - v.contentInset.bottom - 160)
        if reveal, !visible.contains(f) {
            let maxY = max(-v.contentInset.top, v.contentSize.height + v.contentInset.bottom - v.bounds.height)
            v.contentOffset.y = min(maxY, max(-v.contentInset.top, f.midY - v.bounds.height / 2))
            v.layoutIfNeeded()
        }
        return f.offsetBy(dx: 0, dy: -v.contentOffset.y)
    }
}

/// Führt einen gemerkten Sprung erst aus, wenn Breite und Inhalt da sind.
final class GridCollectionView: UICollectionView {
    var pending: (Int, UnitPoint)?
    /// Fußzeile unter dem letzten Objekt (Mediathek: Anzahl + Backup-Stand), liegt im unteren Abstand
    var footer: UIView?
    var footerHeight: CGFloat = 0
    /// Nach jedem Anordnen: oberste Reihe neu bestimmen (Datum in der Überschrift). Beim ersten Sprung ans Ende kam
    /// das Scroll-Ereignis, bevor die Zellen standen → Überschrift zeigte nach dem Neustart das älteste Datum (#15).
    var onLayout: (() -> Void)?
    override func layoutSubviews() {
        super.layoutSubviews()
        if let f = footer { f.frame = CGRect(x: 0, y: contentSize.height + 6, width: bounds.width, height: footerHeight) }
        defer { onLayout?() }
        guard let (index, anchor) = pending, bounds.width > 0 else { return }
        let n = numberOfItems(inSection: 0)
        guard n > 0 else { return }
        pending = nil
        let pos: UICollectionView.ScrollPosition = anchor == .top ? .top : anchor == .bottom ? .bottom : .centeredVertically
        scrollToItem(at: IndexPath(item: min(index, n - 1), section: 0), at: pos, animated: false)
    }
}

/// Raster-Layout wie Apples Kachel-Engine: rechnet nur, was sichtbar ist. (UICollectionViewFlowLayout fragt bei
/// jedem Neuladen die Größe aller 80 000 Kacheln ab – bei jedem nachkommenden Monat und jedem Zoomschritt.)
final class GridLayout: UICollectionViewLayout {
    /// Zoomstufe (gleiche Werte wie auf dem iPhone)
    var columns = 3
    /// Tatsächliche Spalten: auf breiten Bildschirmen (iPad, Querformat) mehr, damit Kacheln etwa iPhone-groß
    /// bleiben (GitHub #47) – 3 Spalten ≈ 130 pt pro Kachel. 1 Spalte bleibt 1 Foto in voller Breite.
    private(set) var cols = 3
    static func effective(_ columns: Int, width: CGFloat) -> Int {
        guard columns > 1, width > 500 else { return columns }
        return max(columns, Int((CGFloat(columns) * width / 430).rounded()))
    }
    /// Seitenverhältnis je Objekt – nur für die 1-Spalten-Stufe (Fotos in voller Breite, unterschiedlich hoch).
    var ratio: (Int) -> CGFloat = { _ in 1 }
    private var spacing: CGFloat { columns >= GridZoom.dense ? 1 : 2 }
    private var n = 0, width: CGFloat = 0, pitch: CGFloat = 1, scale: CGFloat = 3
    private var xs: [(CGFloat, CGFloat)] = []      // Spalte → (x, Breite)
    private var tops: [CGFloat] = []               // 1 Spalte: Oberkante je Objekt, zuletzt das Ende

    private func px(_ v: CGFloat) -> CGFloat { (v * scale).rounded() / scale }

    override func prepare() {
        guard let cv = collectionView else { return }
        n = cv.numberOfSections > 0 ? cv.numberOfItems(inSection: 0) : 0
        width = cv.bounds.width
        scale = cv.traitCollection.displayScale > 0 ? cv.traitCollection.displayScale : 3
        cols = Self.effective(columns, width: width)
        let c = CGFloat(cols)
        // Kacheln füllen die Breite exakt (kein Restspalt rechts), Kanten auf ganze Pixel
        xs = (0..<cols).map { k in
            let x0 = px(CGFloat(k) * (width + spacing) / c), x1 = px(CGFloat(k + 1) * (width + spacing) / c - spacing)
            return (x0, x1 - x0)
        }
        pitch = max(1, px((width + spacing) / c))
        if columns == 1 {
            var y: CGFloat = 0
            tops = []; tops.reserveCapacity(n + 1)
            for i in 0..<n { tops.append(y); y += px(width / max(0.3, ratio(i))) + spacing }
            tops.append(y)
        } else { tops = [] }
    }

    override var collectionViewContentSize: CGSize {
        let h = columns == 1 ? (tops.last ?? 0) : CGFloat((n + cols - 1) / cols) * pitch
        return CGSize(width: width, height: max(0, h - spacing))
    }

    private func frame(_ i: Int) -> CGRect {
        if columns == 1, i + 1 < tops.count { return CGRect(x: 0, y: tops[i], width: width, height: tops[i + 1] - tops[i] - spacing) }
        let (x, w) = xs.isEmpty ? (0, width) : xs[i % cols]
        return CGRect(x: x, y: CGFloat(i / cols) * pitch, width: w, height: pitch - spacing)
    }

    private func attributes(_ i: Int) -> UICollectionViewLayoutAttributes {
        let a = UICollectionViewLayoutAttributes(forCellWith: IndexPath(item: i, section: 0))
        a.frame = frame(i)
        return a
    }

    override func layoutAttributesForElements(in rect: CGRect) -> [UICollectionViewLayoutAttributes]? {
        guard n > 0 else { return [] }
        let range: ClosedRange<Int>
        if columns == 1 {
            guard tops.count == n + 1 else { return [] }
            // erstes Objekt, das ins Rechteck reicht (binäre Suche über die Oberkanten)
            var lo = 0, hi = n - 1
            while lo < hi { let m = (lo + hi + 1) / 2; if tops[m] <= rect.minY { lo = m } else { hi = m - 1 } }
            var last = lo
            while last + 1 < n, tops[last + 1] < rect.maxY { last += 1 }
            range = lo...last
        } else {
            let first = max(0, Int(rect.minY / pitch)), lastRow = max(0, Int(rect.maxY / pitch))
            let lo = first * cols, hi = min(n - 1, (lastRow + 1) * cols - 1)
            guard lo <= hi else { return [] }
            range = lo...hi
        }
        return range.map(attributes)
    }

    override func layoutAttributesForItem(at ip: IndexPath) -> UICollectionViewLayoutAttributes? {
        ip.item < n ? attributes(ip.item) : nil
    }

    override func shouldInvalidateLayout(forBoundsChange b: CGRect) -> Bool { b.width != width }
}

/// Kachel der Stufen 1/3/5: reines UIKit wie bei Apple (keine SwiftUI-Ansicht, kein Knopf, kein Kontextmenü je Kachel).
final class AssetCell: UICollectionViewCell {
    let image = UIImageView()
    private let duration = UILabel()
    private let heart = UIImageView(image: UIImage(systemName: "heart.fill"))
    private let shared = UIImageView(image: UIImage(systemName: "person.2.fill"))
    private let dim = UIView()
    private let check = UIImageView()
    private let flash = UIView()
    /// Noch nicht gesichertes iPhone-Foto: durchgestrichene Wolke bzw. Fortschrittsring (wie die Immich-App, plus Ring)
    private let cloud = UIImageView()
    private let ring = CAShapeLayer()
    private let ringTrack = CAShapeLayer()
    private(set) var id = ""
    private var size: ImmichClient.Size = .thumbnail
    private var task: Task<Void, Never>?
    /// Automatisches Abspielen im Raster (Videos/Live Photos, stumm) – wie Apple in großen Zoomstufen
    private var playerLayer: AVPlayerLayer?
    private var looper: AVPlayerLooper?
    private(set) var playing = false

    override init(frame: CGRect) {
        super.init(frame: frame)
        contentView.backgroundColor = .systemGray6
        contentView.clipsToBounds = true
        image.clipsToBounds = true
        for b in [heart, shared] as [UIView] + [duration] {
            b.layer.shadowColor = UIColor.black.cgColor; b.layer.shadowOpacity = 0.55; b.layer.shadowRadius = 2; b.layer.shadowOffset = .zero
        }
        heart.tintColor = .white; heart.contentMode = .scaleAspectFit
        shared.tintColor = .white; shared.contentMode = .scaleAspectFit
        duration.font = .systemFont(ofSize: 12, weight: .semibold); duration.textColor = .white
        dim.backgroundColor = UIColor(white: 1, alpha: 0.25)
        flash.backgroundColor = UIColor(white: 1, alpha: 0.35)
        check.image = UIImage(systemName: "checkmark.circle.fill")?
            .applyingSymbolConfiguration(.init(pointSize: 22, weight: .semibold))?
            .applyingSymbolConfiguration(.init(paletteColors: [.white, .systemBlue]))
        check.layer.shadowColor = UIColor.black.cgColor; check.layer.shadowOpacity = 0.4; check.layer.shadowRadius = 2; check.layer.shadowOffset = .zero
        cloud.tintColor = .white; cloud.contentMode = .scaleAspectFit
        cloud.layer.shadowColor = UIColor.black.cgColor; cloud.layer.shadowOpacity = 0.55; cloud.layer.shadowRadius = 2; cloud.layer.shadowOffset = .zero
        for l in [ringTrack, ring] {
            l.fillColor = UIColor.clear.cgColor; l.lineWidth = 2.5; l.lineCap = .round; l.isHidden = true
            contentView.layer.addSublayer(l)
        }
        ringTrack.strokeColor = UIColor(white: 1, alpha: 0.3).cgColor
        ring.strokeColor = UIColor.white.cgColor
        for v in [image, dim, duration, heart, shared, check, flash, cloud] { contentView.addSubview(v) }
        NotificationCenter.default.addObserver(forName: .localBadgesChanged, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.updateCloud() }
        }
        isAccessibilityElement = true
        accessibilityTraits = .image
    }
    required init?(coder: NSCoder) { fatalError() }

    override func layoutSubviews() {
        super.layoutSubviews()
        let b = contentView.bounds
        image.frame = b; dim.frame = b; flash.frame = b
        playerLayer?.frame = b
        duration.sizeToFit()
        duration.frame.origin = CGPoint(x: b.maxX - duration.bounds.width - 5, y: b.maxY - duration.bounds.height - 4)
        let s: CGFloat = b.width < 80 ? 10 : 12
        heart.frame = CGRect(x: 5, y: b.maxY - s - 5, width: s, height: s)
        shared.frame = CGRect(x: b.maxX - s * 1.4 - 5, y: 5, width: s * 1.4, height: s)
        check.frame = CGRect(x: b.maxX - 27, y: b.maxY - 27, width: 22, height: 22)
        let c: CGFloat = b.width < 80 ? 13 : 16
        cloud.frame = CGRect(x: b.maxX - c - 5, y: 5, width: c, height: c)
        let r = CGRect(x: b.maxX - c - 7, y: 3, width: c + 4, height: c + 4)
        let path = UIBezierPath(arcCenter: CGPoint(x: r.midX, y: r.midY), radius: r.width / 2, startAngle: -.pi / 2, endAngle: 1.5 * .pi, clockwise: true).cgPath
        ring.path = path; ringTrack.path = path
    }

    /// Wolke/Ring für noch nicht gesicherte Fotos (LocalPending)
    func updateCloud() {
        guard id.hasPrefix(LocalPending.prefix), let b = LocalPending.shared.badges[id] else {
            cloud.isHidden = true; ring.isHidden = true; ringTrack.isHidden = true; return
        }
        cloud.isHidden = false
        switch b {
        case .waiting:
            cloud.image = UIImage(systemName: "icloud.slash"); ring.isHidden = true; ringTrack.isHidden = true
        case .uploading(let p):
            cloud.image = UIImage(systemName: "arrow.up"); cloud.transform = CGAffineTransform(scaleX: 0.6, y: 0.6)
            ring.isHidden = false; ringTrack.isHidden = false
            CATransaction.begin(); CATransaction.setDisableActions(true); ring.strokeEnd = max(0.03, p); CATransaction.commit()
            return
        case .processing:
            cloud.image = UIImage(systemName: "checkmark.icloud"); ring.isHidden = true; ringTrack.isHidden = true
        }
        cloud.transform = .identity
    }

    override func prepareForReuse() {
        super.prepareForReuse()
        // Laden abbrechen: weggescrollte Kacheln belegen sonst die Verbindungen zum Server
        task?.cancel(); task = nil
        stopPlayback()
        image.image = nil; id = ""
    }

    /// Stumm in Schleife abspielen (Video bzw. Live-Teil eines Live Photos), Vorschau bleibt darunter.
    func startPlayback(videoID: String) {
        guard !playing, let url = ImmichClient.shared.videoURL(videoID) else { return }
        playing = true
        let av = ImmichClient.shared.avAsset(url)
        let p = AVQueuePlayer(); p.isMuted = true; p.preventsDisplaySleepDuringVideoPlayback = false
        looper = AVPlayerLooper(player: p, templateItem: AVPlayerItem(asset: av))
        let l = AVPlayerLayer(player: p); l.videoGravity = .resizeAspectFill; l.frame = contentView.bounds
        contentView.layer.insertSublayer(l, above: image.layer)
        playerLayer = l
        p.play()
        // Zeitlupen wie in der Einzelansicht verlangsamt (Erkennung lädt nur die Spur-Infos)
        Task { [weak self] in
            guard let s = await SlowMo.detect(av), let comp = try? await s.composition(av, audio: false) else { return }
            guard let self, self.playing, self.playerLayer?.player === p else { return }
            // eigener Player: ein zweiter Looper auf demselben Player wirft eine Ausnahme
            self.looper?.disableLooping(); p.pause(); p.removeAllItems()
            let q = AVQueuePlayer(); q.isMuted = true; q.preventsDisplaySleepDuringVideoPlayback = false
            self.looper = AVPlayerLooper(player: q, templateItem: AVPlayerItem(asset: comp))
            self.playerLayer?.player = q
            q.play()
        }
    }
    func stopPlayback() {
        guard playing else { return }
        playerLayer?.player?.pause(); playerLayer?.removeFromSuperlayer()
        playerLayer = nil; looper = nil; playing = false
    }

    func show(_ a: Asset, size: ImmichClient.Size, fit: Bool, selected: Bool?, highlighted: Bool, sharedFromOther: Bool) {
        let changed = id != a.id || self.size != size
        id = a.id; self.size = size
        image.contentMode = fit ? .scaleAspectFit : .scaleAspectFill
        duration.text = a.isVideo ? Fmt.duration(a.durationMs) : nil
        duration.isHidden = !a.isVideo
        heart.isHidden = !a.isFavorite
        shared.isHidden = !sharedFromOther
        update(selected: selected, highlighted: highlighted)
        accessibilityLabel = (a.isVideo ? String(localized: "Video, ") : String(localized: "Foto, ")) + Fmt.dayLongMonthYear.string(from: a.date)
            + (a.isLocalOnly ? String(localized: ", noch nicht gesichert") : "")
        updateCloud()
        if changed { loadImage() }
        setNeedsLayout()
    }

    func update(selected: Bool?, highlighted: Bool) {
        dim.isHidden = selected != true
        check.isHidden = selected != true
        flash.isHidden = !highlighted
        accessibilityTraits = selected == true ? [.image, .selected] : .image
    }

    /// Speicher → unscharfes Sofortbild (thumbhash) → iPhone/Server; neu auch nach `.thumbChanged`.
    func loadImage() {
        task?.cancel()
        let c = ImageCache.shared, want = id, size = size
        if let i = c.get("\(want)-\(size.rawValue)") { image.image = i; return }
        image.image = (size != .thumbnail ? c.get("\(want)-thumbnail") : nil) ?? c.placeholder(want)
        guard c.canLoad(want) else { return }
        task = Task { @MainActor [weak self] in
            if size != .thumbnail, c.get("\(want)-thumbnail") == nil, let t = await c.loadStored(want, .thumbnail),
               let self, self.id == want { self.image.image = t }
            for attempt in 0..<2 {
                if let img = await c.load(want, size) {
                    guard let self, self.id == want, !Task.isCancelled else { return }
                    UIView.transition(with: self.image, duration: 0.15, options: [.transitionCrossDissolve, .allowUserInteraction]) {
                        self.image.image = img
                    }
                    return
                }
                if Task.isCancelled { return }
                if attempt == 0 { try? await Task.sleep(for: .seconds(3)) }
            }
        }
    }
}

/// Kachel der dichten Stufen: nur ein Bild. Zeigt die kleine Vorschau, wenn sie schon da ist
/// (Speicher/iPhone), sonst den thumbhash – bei 23 Spalten (~18 pt) sieht man den Unterschied kaum.
final class DenseCell: UICollectionViewCell {
    let image = UIImageView()
    private(set) var id = ""
    private var task: Task<Void, Never>?
    override init(frame: CGRect) {
        super.init(frame: frame)
        image.contentMode = .scaleAspectFill; image.clipsToBounds = true
        image.backgroundColor = .systemGray6
        contentView.addSubview(image)
    }
    required init?(coder: NSCoder) { fatalError() }
    override func layoutSubviews() { super.layoutSubviews(); image.frame = contentView.bounds }
    override func prepareForReuse() { super.prepareForReuse(); task?.cancel(); task = nil; image.image = nil; id = "" }

    func show(_ item: GridItemRef, load: Bool) {
        guard case .asset(let a, _) = item else { image.image = nil; id = ""; return }
        id = a.id
        let c = ImageCache.shared
        if let i = c.get("\(a.id)-thumbnail") { image.image = i; return }
        image.image = nil
        guard c.hash(a.id) != nil || a.isLocalOnly else { return }
        let want = a.id
        // Beim Wechsel in diese Stufe entstehen ~600 Kacheln auf einmal → Unschärfe-Bild und Datei vom iPhone
        // im Hintergrund holen, sonst blockiert der Hauptthread über eine Sekunde.
        task = Task { @MainActor [weak self] in
            let blur = await Task.detached(priority: .userInitiated) { c.placeholder(want) }.value
            if let self, self.id == want, self.image.image == nil { self.image.image = blur }
            let img = load ? await c.load(want, .thumbnail) : await c.loadStored(want, .thumbnail)
            if let self, let img, self.id == want { self.image.image = img }
        }
    }
}

/// „Alle“-Raster auf UICollectionView – wie Apple Fotos: eigenes Layout, wiederverwendete UIKit-Kacheln,
/// Vorschaubilder für die nächsten Bildschirme vorab geladen; 80 000 Objekte kosten SwiftUI nichts.
struct PhotoGrid: UIViewRepresentable {
    let items: [GridItemRef]
    let columns: Int
    let topInset: CGFloat
    let controller: GridController
    /// Seitenverhältnisraster (ganzes Bild in der Kachel)
    let fit: Bool
    /// nil = keine Auswahl aktiv, sonst die ausgewählten IDs
    let selection: Set<String>?
    let highlight: String?
    /// Eigenes Konto (Kennzeichen „geteilt“ für Fotos anderer)
    let me: String
    /// Oberstes sichtbares Objekt (für Datum/Monat/Jahr in der Überschrift)
    let onTop: (Int) -> Void
    /// Zelle wird gezeigt (Platzhalter → Monat laden, Wächter füttern)
    let onShow: (GridItemRef) -> Void
    /// Neue Spaltenzahl nach dem Zusammen-/Auseinanderziehen oder Tippen in einer dichten Stufe
    let onColumns: (Int) -> Void
    /// Tippen auf ein Objekt (Index in `items`, Rahmen der Kachel für den Zoom-Übergang)
    let onOpen: (Int, CGRect) -> Void
    /// In der Auswahl: Objekt an/aus
    let onToggle: (String) -> Void
    /// Wisch-Auswahl: neue Auswahl als Ganzes
    let onSelect: (Set<String>) -> Void
    /// Langes Drücken: Menü wie in Fotos
    let menu: (Asset) -> UIMenu
    /// Videos und Live Photos in der 1-Spalten-Stufe automatisch (stumm) abspielen
    var autoplay = true
    /// Neueste oben (Sammlungen): beim Öffnen oben statt beim Neuesten unten beginnen
    var startAtTop = false
    /// Normale iOS-Scrollleiste: lässt sich greifen und ziehen → schnell durch große Mediatheken (Idee: Fork vands2013)
    var showsScrollIndicator = false
    /// Schneller Rollbalken mit Datumsblase (ersetzt die iOS-Leiste): Text für das oberste sichtbare Objekt
    var scrubLabel: ((Int) -> String?)? = nil
    /// SwiftUI-Fußzeile unter dem letzten Objekt (wie Apples Mediathek-Fußzeile)
    var footer: AnyView? = nil
    var footerHeight: CGFloat = 92

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> GridCollectionView {
        let layout = GridLayout()
        let v = GridCollectionView(frame: .zero, collectionViewLayout: layout)
        v.backgroundColor = .clear
        v.showsVerticalScrollIndicator = showsScrollIndicator && scrubLabel == nil
        if let footer {
            let h = UIHostingController(rootView: footer)
            h.view.backgroundColor = .clear
            h.safeAreaRegions = []
            v.addSubview(h.view)
            v.footer = h.view; v.footerHeight = footerHeight
            context.coordinator.footerHost = h
        }
        v.contentInsetAdjustmentBehavior = .never
        v.alwaysBounceVertical = true
        let c = context.coordinator
        c.view = v; c.layout = layout; controller.view = v
        v.onLayout = { [weak c] in c?.checkTop(); c?.scrubber?.update(scrolling: false) }
        if scrubLabel != nil {
            let s = GridScrubber()
            s.scrollView = v
            s.label = { [weak c] in
                guard let c, let i = c.topIndex() else { return nil }
                return c.parent.scrubLabel?(i)
            }
            s.onDrag = { [weak c] on in c?.scrubbing(on) }
            v.addSubview(s)
            c.scrubber = s
        }
        c.columns = columns; layout.columns = columns
        layout.ratio = { [weak c] i in
            guard let c, i < c.parent.items.count, case .asset(let a, _) = c.parent.items[i] else { return 1 }
            return a.ratio
        }
        c.registration = UICollectionView.CellRegistration<AssetCell, Int> { [weak c] cell, _, i in
            guard let c, i < c.parent.items.count else { return }
            c.configure(cell, c.parent.items[i])
        }
        c.placeholderRegistration = UICollectionView.CellRegistration<UICollectionViewCell, Int> { cell, _, _ in
            cell.contentView.backgroundColor = .systemGray6
        }
        c.denseRegistration = UICollectionView.CellRegistration<DenseCell, Int> { [weak c] cell, _, i in
            guard let c, i < c.parent.items.count else { return }
            cell.show(c.parent.items[i], load: c.columns < GridZoom.steps.last!)
        }
        v.dataSource = c; v.delegate = c; v.prefetchDataSource = c
        v.dragDelegate = c; v.dragInteractionEnabled = true
        let pinch = UIPinchGestureRecognizer(target: c, action: #selector(Coordinator.pinch(_:)))
        pinch.delegate = c          // neben dem Scrollen erkennen (sonst nimmt das Wischen beide Finger)
        v.addGestureRecognizer(pinch)
        // Wisch-Auswahl wie bei Apple: in der Auswahl waagerecht über Kacheln ziehen
        let swipe = UIPanGestureRecognizer(target: c, action: #selector(Coordinator.swipeSelect(_:)))
        swipe.delegate = c; swipe.maximumNumberOfTouches = 1
        v.addGestureRecognizer(swipe)
        c.swipe = swipe
        c.parent = self
        c.observeThumbs()
        return v
    }

    func updateUIView(_ v: GridCollectionView, context: Context) {
        let c = context.coordinator
        let old: PhotoGrid = c.parent
        c.parent = self
        controller.view = v
        if old.autoplay != autoplay { c.updateAutoplay() }
        if let footer, let h = c.footerHost { h.rootView = footer }
        let bottom = 96 + (v.window?.safeAreaInsets.bottom ?? 34) + (c.footerHost != nil ? footerHeight + 6 : 0)
        if v.contentInset.top != topInset || v.contentInset.bottom != bottom {
            v.contentInset = UIEdgeInsets(top: topInset, left: 0, bottom: bottom, right: 0)
            v.verticalScrollIndicatorInsets = v.contentInset
        }
        let sameIDs = old.items.count == items.count && old.items.first?.id == items.first?.id && old.items.last?.id == items.last?.id
        if columns != c.columns {
            // von außen geändert (Menü „Vergrößern/Verkleinern“) – ohne Fingerposition: Mitte halten
            c.apply(columns: columns, anchorIndex: c.centerIndex(), anchorY: v.bounds.height / 2)
        } else if !sameIDs || old.fit != fit {
            // Abstand zum Ende halten (man schaut meist auf das Neueste unten); Neueste oben: Position oben halten
            let fromBottom = v.contentSize.height - v.contentOffset.y
            v.reloadData()
            if c.didInitialScroll, v.contentSize.height > 0, !startAtTop {
                v.layoutIfNeeded()
                v.contentOffset.y = max(-topInset, v.contentSize.height - fromBottom)
            }
        } else if old.selection != selection || old.highlight != highlight {
            // Auswahl/Markierung: nur die sichtbaren Kacheln umschalten
            c.refreshVisible()
        } else {
            // gleiche Objekte, evtl. geändert (Favorit): sichtbare Kacheln neu belegen, Bild bleibt
            c.refreshVisible(content: true)
        }
        if items.isEmpty { c.didInitialScroll = false }      // geleert (z. B. Kontowechsel) → danach wieder ans Ende
        if !c.didInitialScroll, !items.isEmpty {
            c.didInitialScroll = true
            if v.pending == nil { controller.scroll(to: startAtTop ? 0 : items.count - 1, anchor: startAtTop ? .top : .bottom) }
        }
    }

    final class Coordinator: NSObject, UICollectionViewDataSource, UICollectionViewDelegate,
                             UICollectionViewDataSourcePrefetching, UIGestureRecognizerDelegate, UICollectionViewDragDelegate {
        var footerHost: UIHostingController<AnyView>?
        var scrubber: GridScrubber?
        /// Ziehen am schnellen Rollbalken wirkt wie Scrollen: Videos anhalten, Offline-Laden pausieren
        func scrubbing(_ on: Bool) {
            if on {
                view?.visibleCells.forEach { ($0 as? AssetCell)?.stopPlayback() }
                OfflineSync.shared.userBusy(true)
            } else { motionEnded() }
        }
        func gestureRecognizer(_ g: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith o: UIGestureRecognizer) -> Bool {
            g !== swipe && o !== swipe
        }
        func gestureRecognizerShouldBegin(_ g: UIGestureRecognizer) -> Bool {
            guard g === swipe, let pan = swipe, let v = view else { return true }
            // nur in der Auswahl und nur, wenn der Finger eher waagerecht startet (senkrecht = scrollen)
            guard parent.selection != nil, columns < GridZoom.dense else { return false }
            let vel = pan.velocity(in: v)
            return abs(vel.x) > abs(vel.y) * 1.2
        }
        weak var swipe: UIPanGestureRecognizer?
        var parent: PhotoGrid!
        weak var view: GridCollectionView?
        weak var layout: GridLayout?
        var registration: UICollectionView.CellRegistration<AssetCell, Int>!
        var placeholderRegistration: UICollectionView.CellRegistration<UICollectionViewCell, Int>!
        var denseRegistration: UICollectionView.CellRegistration<DenseCell, Int>!
        var didInitialScroll = false
        /// Tatsächlich angezeigte Spaltenzahl (kann während des Zoomens von `parent.columns` abweichen)
        var columns = 3
        private var lastTop = -1

        /// Neue Server-Vorschau für ein Objekt → nur dessen sichtbare Kachel lädt neu.
        func observeThumbs() {
            NotificationCenter.default.addObserver(self, selector: #selector(thumbChanged(_:)), name: .thumbChanged, object: nil)
        }
        @objc private func thumbChanged(_ n: Notification) {
            guard let id = n.object as? String else { return }
            for case let cell as AssetCell in view?.visibleCells ?? [] where cell.id == id { cell.loadImage() }
        }

        func configure(_ cell: AssetCell, _ item: GridItemRef) {
            guard case .asset(let a, _) = item else { return }
            let p = parent!
            cell.show(a, size: columns == 1 ? .preview : .thumbnail, fit: p.fit && columns > 1,
                      selected: p.selection.map { $0.contains(a.id) }, highlighted: p.highlight == a.id,
                      sharedFromOther: !p.me.isEmpty && a.ownerId != nil && a.ownerId != p.me)
        }

        /// Sichtbare Kacheln an den Zustand angleichen (ohne reloadData – das würde die Bilder neu setzen).
        func refreshVisible(content: Bool = false) {
            guard let v = view, columns < GridZoom.dense else { return }
            for ip in v.indexPathsForVisibleItems where ip.item < parent.items.count {
                guard let cell = v.cellForItem(at: ip) as? AssetCell, case .asset(let a, _) = parent.items[ip.item] else { continue }
                if content { configure(cell, parent.items[ip.item]) }
                else { cell.update(selected: parent.selection.map { $0.contains(a.id) }, highlighted: parent.highlight == a.id) }
            }
        }

        func collectionView(_ cv: UICollectionView, numberOfItemsInSection s: Int) -> Int { parent.items.count }

        func collectionView(_ cv: UICollectionView, cellForItemAt ip: IndexPath) -> UICollectionViewCell {
            if columns >= GridZoom.dense { return cv.dequeueConfiguredReusableCell(using: denseRegistration, for: ip, item: ip.item) }
            if ip.item < parent.items.count, case .placeholder = parent.items[ip.item] {
                return cv.dequeueConfiguredReusableCell(using: placeholderRegistration, for: ip, item: ip.item)
            }
            return cv.dequeueConfiguredReusableCell(using: registration, for: ip, item: ip.item)
        }

        func collectionView(_ cv: UICollectionView, willDisplay cell: UICollectionViewCell, forItemAt ip: IndexPath) {
            if ip.item < parent.items.count { parent.onShow(parent.items[ip.item]) }
        }

        /// Tippen: in den dichten Stufen dorthin zoomen (wie Apple), sonst öffnen bzw. auswählen.
        func collectionView(_ cv: UICollectionView, didSelectItemAt ip: IndexPath) {
            cv.deselectItem(at: ip, animated: false)
            guard GridZoom.tapsAllowed, let v = view, let attr = cv.layoutAttributesForItem(at: ip),
                  ip.item < parent.items.count else { return }
            if columns >= GridZoom.dense {
                let target = columns == GridZoom.steps.last! ? GridZoom.dense : 5
                let y = attr.frame.midY - cv.contentOffset.y
                animate(to: target, anchorIndex: ip.item, anchorY: y, from: v.snapshotView(afterScreenUpdates: false), scale: 1)
                return
            }
            guard case .asset(let a, _) = parent.items[ip.item] else { return }
            if parent.selection != nil { parent.onToggle(a.id) }
            else { parent.onOpen(ip.item, attr.frame.offsetBy(dx: 0, dy: -cv.contentOffset.y)) }
        }

        // MARK: Kontextmenü (langes Drücken) – UIKit statt SwiftUI-.contextMenu an jeder Kachel

        func collectionView(_ cv: UICollectionView, contextMenuConfigurationForItemsAt ips: [IndexPath], point: CGPoint) -> UIContextMenuConfiguration? {
            guard parent.selection == nil, columns < GridZoom.dense, let ip = ips.first, ip.item < parent.items.count,
                  case .asset(let a, _) = parent.items[ip.item], !a.isLocalOnly else { return nil }
            let menu = parent.menu
            return UIContextMenuConfiguration(identifier: ip.item as NSNumber, previewProvider: { PreviewController(asset: a) },
                                              actionProvider: { _ in menu(a) })
        }

        /// Tippen auf die große Vorschau öffnet das Foto (wie Apple).
        func collectionView(_ cv: UICollectionView, willPerformPreviewActionForMenuWith config: UIContextMenuConfiguration,
                            animator: UIContextMenuInteractionCommitAnimating) {
            guard let i = (config.identifier as? NSNumber)?.intValue,
                  let attr = cv.layoutAttributesForItem(at: IndexPath(item: i, section: 0)) else { return }
            animator.preferredCommitStyle = .dismiss
            animator.addCompletion { [weak self] in self?.parent.onOpen(i, attr.frame.offsetBy(dx: 0, dy: -cv.contentOffset.y)) }
        }

        func collectionView(_ cv: UICollectionView, prefetchItemsAt ips: [IndexPath]) {
            guard columns < GridZoom.steps.last! else { return }
            let items = parent.items
            var ids: [String] = []
            for ip in ips where ip.item < items.count {
                switch items[ip.item] {
                case .asset(let a, _): ids.append(a.id)
                case .placeholder: parent.onShow(items[ip.item])
                }
            }
            Task { @MainActor in ThumbPrefetcher.shared.prefetch(ids) }
        }

        func scrollViewWillBeginDragging(_ sv: UIScrollView) {
            view?.visibleCells.forEach { ($0 as? AssetCell)?.stopPlayback() }
            PerfLog.motionBegan("Scrollen \(columns) Spalten")
            OfflineSync.shared.userBusy(true)
        }
        func scrollViewDidEndDragging(_ sv: UIScrollView, willDecelerate d: Bool) { if !d { motionEnded() } }
        func scrollViewDidEndDecelerating(_ sv: UIScrollView) { motionEnded() }
        func scrollViewDidEndScrollingAnimation(_ sv: UIScrollView) { motionEnded() }
        private func motionEnded() { PerfLog.motionEnded(); OfflineSync.shared.userBusy(false); updateAutoplay() }

        /// Apple spielt in großen Stufen das Video/Live Photo ab, das gerade am meisten im Bild ist.
        func updateAutoplay() {
            guard let v = view else { return }
            let cells = v.visibleCells.compactMap { $0 as? AssetCell }
            guard parent.autoplay, columns == 1, !v.isDragging, !v.isDecelerating else { cells.forEach { $0.stopPlayback() }; return }
            let mid = v.contentOffset.y + v.bounds.height / 2
            var best: (AssetCell, String, CGFloat)?
            for c in cells {
                guard let ip = v.indexPath(for: c), ip.item < parent.items.count, case .asset(let a, _) = parent.items[ip.item] else { continue }
                let vid = a.isVideo ? a.id : a.livePhotoVideoId
                guard let vid, !a.isLocalOnly else { continue }   // Abspielen im Raster nur vom Server
                let d = abs(c.frame.midY - mid)
                if best == nil || d < best!.2 { best = (c, vid, d) }
            }
            for c in cells where c !== best?.0 { c.stopPlayback() }
            if let (c, vid, d) = best, d < v.bounds.height * 0.4 { c.startPlayback(videoID: vid) }
        }

        /// Wie Apple: beim Loslassen steht fest, wo der Schwung endet → genau dort zuerst vorladen
        /// (UIKits eigenes Vorausladen kennt nur die nächsten Reihen in Scrollrichtung).
        func scrollViewWillEndDragging(_ sv: UIScrollView, withVelocity vel: CGPoint, targetContentOffset t: UnsafeMutablePointer<CGPoint>) {
            guard columns < GridZoom.steps.last!, let v = view, abs(vel.y) > 0.5 else { return }
            let h = v.bounds.height
            let target = CGRect(x: 0, y: t.pointee.y - h * 0.25, width: v.bounds.width, height: h * 1.5)
            let items = parent.items
            let ids = (v.collectionViewLayout.layoutAttributesForElements(in: target) ?? []).compactMap { a -> String? in
                guard a.indexPath.item < items.count, case .asset(let x, _) = items[a.indexPath.item] else { return nil }
                return x.id
            }
            // was nicht am Ziel liegt, wartet: laufende Vorab-Downloads für den überflogenen Bereich abbrechen
            ThumbPrefetcher.shared.focus(on: ids, size: columns == 1 ? .preview : .thumbnail)
        }

        func collectionView(_ cv: UICollectionView, cancelPrefetchingForItemsAt ips: [IndexPath]) {
            let items = parent.items
            let ids = ips.compactMap { ip -> String? in
                guard ip.item < items.count, case .asset(let a, _) = items[ip.item] else { return nil }
                return a.id
            }
            Task { @MainActor in ThumbPrefetcher.shared.cancel(ids) }
        }

        // MARK: Ziehen & Ablegen (in andere Apps, z. B. Nachrichten, Notizen, Mail)

        func collectionView(_ cv: UICollectionView, itemsForBeginning session: UIDragSession, at ip: IndexPath) -> [UIDragItem] {
            guard columns < GridZoom.dense, ip.item < parent.items.count, case .asset(let a, _) = parent.items[ip.item] else { return [] }
            // in der Auswahl: alle ausgewählten mitnehmen (wie Apple)
            if let sel = parent.selection, sel.contains(a.id) {
                let all = parent.items.compactMap { i -> Asset? in if case .asset(let x, _) = i, sel.contains(x.id) { x } else { nil } }
                return all.prefix(50).map(dragItem)
            }
            return [dragItem(a)]
        }

        func collectionView(_ cv: UICollectionView, itemsForAddingTo session: UIDragSession, at ip: IndexPath, point: CGPoint) -> [UIDragItem] {
            guard ip.item < parent.items.count, case .asset(let a, _) = parent.items[ip.item] else { return [] }
            return [dragItem(a)]
        }

        /// Original (mit Bearbeitung) erst laden, wenn die Ziel-App es wirklich haben will.
        private func dragItem(_ a: Asset) -> UIDragItem {
            let p = NSItemProvider()
            let type = a.isVideo ? UTType.mpeg4Movie : UTType.jpeg
            p.registerDataRepresentation(forTypeIdentifier: type.identifier, visibility: .all) { done in
                Task {
                    let api = ImmichClient.shared
                    let url = a.isVideo ? api.originalURL(a.id) : api.thumbnailURL(a.id, .fullsize)
                    if let url, let d = try? await api.data(url) { done(d, nil) } else { done(nil, URLError(.cannotLoadFromNetwork)) }
                }
                return nil
            }
            // nur innerhalb der App: Asset-ID für das Ablegen auf einem Album (Sammlungen → Alben)
            p.registerObject("homeroll-asset:\(a.id)" as NSString, visibility: .ownProcess)
            let item = UIDragItem(itemProvider: p)
            item.localObject = a.id
            if let img = ImageCache.shared.get("\(a.id)-thumbnail") {
                item.previewProvider = {
                    let v = UIImageView(image: img); v.frame = CGRect(x: 0, y: 0, width: 120, height: 120 / max(0.5, a.ratio))
                    v.contentMode = .scaleAspectFill; v.clipsToBounds = true; v.layer.cornerRadius = 8
                    return UIDragPreview(view: v)
                }
            }
            return item
        }

        // MARK: Wisch-Auswahl

        private var swipeStart: Int?, swipeLast: Int?
        private var swipeSelecting = true
        private var swipeBase: Set<String> = []
        private var autoScroll: CADisplayLink?
        private var swipePoint = CGPoint.zero
        private let haptic = UISelectionFeedbackGenerator()

        @objc func swipeSelect(_ g: UIPanGestureRecognizer) {
            guard let v = view else { return }
            swipePoint = g.location(in: v)
            switch g.state {
            case .began:
                // Scrollen anhalten, solange gewischt wird
                v.panGestureRecognizer.isEnabled = false
                guard let i = v.indexPathForItem(at: swipePoint)?.item, i < parent.items.count,
                      case .asset(let a, _) = parent.items[i] else { return }
                swipeBase = parent.selection ?? []
                swipeSelecting = !swipeBase.contains(a.id)      // erste Kachel bestimmt: auswählen oder abwählen
                swipeStart = i; swipeLast = nil
                haptic.prepare()
                extendSwipe()
                let l = CADisplayLink(target: self, selector: #selector(autoScrollTick))
                l.add(to: .main, forMode: .common); autoScroll = l
            case .changed:
                extendSwipe()
            default:
                autoScroll?.invalidate(); autoScroll = nil
                swipeStart = nil; swipeLast = nil
                v.panGestureRecognizer.isEnabled = true
            }
        }

        /// Alles zwischen erster und aktueller Kachel (in Reihenfolge, auch über Zeilen) bekommt den Zustand der ersten.
        private func extendSwipe() {
            guard let v = view, let s = swipeStart else { return }
            let p = CGPoint(x: min(max(swipePoint.x, 1), v.bounds.width - 1), y: swipePoint.y)
            guard let i = v.indexPathForItem(at: p)?.item, i != swipeLast else { return }
            swipeLast = i
            var sel = swipeBase
            let items = parent.items
            for k in min(s, i)...max(s, i) where k < items.count {
                if case .asset(let a, _) = items[k] { if swipeSelecting { sel.insert(a.id) } else { sel.remove(a.id) } }
            }
            haptic.selectionChanged()
            parent.onSelect(sel)
        }

        /// Finger am oberen/unteren Rand → Raster scrollt mit (schneller, je näher am Rand).
        @objc private func autoScrollTick() {
            guard let v = view else { return }
            let y = swipePoint.y - v.contentOffset.y, edge: CGFloat = 90
            let top = v.contentInset.top + 120, bottom = v.bounds.height - v.contentInset.bottom
            var dy: CGFloat = 0
            if y < top + edge { dy = -(top + edge - y) / edge * 14 }
            else if y > bottom - edge { dy = (y - (bottom - edge)) / edge * 14 }
            guard dy != 0 else { return }
            let maxY = max(-v.contentInset.top, v.contentSize.height + v.contentInset.bottom - v.bounds.height)
            let newY = min(maxY, max(-v.contentInset.top, v.contentOffset.y + dy))
            swipePoint.y += newY - v.contentOffset.y
            v.contentOffset.y = newY
            extendSwipe()
        }

        func scrollViewDidScroll(_ sv: UIScrollView) {
            checkTop()
            if let s = scrubber { s.update(scrolling: sv.isDragging || sv.isDecelerating || s.dragging) }
        }

        func checkTop() {
            guard let i = topIndex(), i != lastTop else { return }
            lastTop = i; parent.onTop(i)
        }

        func topIndex() -> Int? {
            guard let v = view else { return nil }
            // Reihe direkt unter der Überschrift (≈ 120 pt ab Oberkante, unabhängig vom oberen Abstand)
            let y = v.contentOffset.y + 120
            return v.indexPathForItem(at: CGPoint(x: 4, y: y))?.item
                ?? v.indexPathsForVisibleItems.map(\.item).min()
        }

        func centerIndex() -> Int? {
            guard let v = view else { return nil }
            if let i = v.indexPathForItem(at: CGPoint(x: v.bounds.midX, y: v.contentOffset.y + v.bounds.height / 2))?.item { return i }
            let vis = v.indexPathsForVisibleItems.map(\.item).sorted()
            return vis.isEmpty ? nil : vis[vis.count / 2]
        }

        // MARK: Zoomen

        private var pinchAnchor: (index: Int, point: CGPoint)?
        /// Standbild des Rasters, das den Fingern folgt (das Raster selbst nie transformieren: SwiftUI setzt
        /// dessen Rahmen neu, dann stimmen Breite und Spalten nicht mehr).
        private var pinchSnap: UIView?

        @objc func pinch(_ g: UIPinchGestureRecognizer) {
            guard let v = view, let host = v.superview else { return }
            let c = CGPoint(x: v.bounds.midX, y: v.bounds.height / 2)
            func around(_ p: CGPoint, _ s: CGFloat) -> CGAffineTransform {
                CGAffineTransform(translationX: p.x - c.x, y: p.y - c.y).scaledBy(x: s, y: s).translatedBy(x: c.x - p.x, y: c.y - p.y)
            }
            GridZoom.tapsBlockedUntil = Date().addingTimeInterval(0.6)
            switch g.state {
            case .began:
                PerfLog.motionBegan("Zoomen ab \(columns) Spalten")
                // Wischen abbrechen: sonst läuft sein Schwung nach dem Zoomen weiter und schiebt das Raster weg
                v.panGestureRecognizer.isEnabled = false; v.panGestureRecognizer.isEnabled = true
                let p = g.location(in: v)
                let idx = v.indexPathForItem(at: p)?.item ?? centerIndex() ?? 0
                pinchAnchor = (idx, CGPoint(x: p.x, y: p.y - v.contentOffset.y))
                if let snap = v.snapshotView(afterScreenUpdates: false) {
                    snap.frame = v.frame
                    host.insertSubview(snap, aboveSubview: v)
                    pinchSnap = snap
                    v.alpha = 0
                }
            case .changed:
                guard let a = pinchAnchor else { return }
                pinchSnap?.transform = around(a.point, max(0.25, min(4, g.scale)))
            case .ended, .cancelled, .failed:
                guard let a = pinchAnchor else { return }
                pinchAnchor = nil
                let snap = pinchSnap; pinchSnap = nil
                let steps = GridZoom.steps
                let i = steps.firstIndex(of: columns) ?? 1
                let s = g.scale
                let next = s > 1.12 ? max(0, i - (s > 2.2 ? 2 : 1)) : s < 0.88 ? min(steps.count - 1, i + (s < 0.45 ? 2 : 1)) : i
                if next == i {
                    UIView.animate(withDuration: 0.2) { snap?.transform = .identity } completion: { _ in
                        v.alpha = 1; snap?.removeFromSuperview(); PerfLog.motionEnded()
                    }
                    return
                }
                let new = steps[next]
                let ratio = CGFloat(columns) / CGFloat(new)          // > 1 = hineinzoomen
                parent.onColumns(new)          // zuerst: Überschrift/Kapsel richten sich nach der neuen Stufe
                apply(columns: new, anchorIndex: a.index, anchorY: a.point.y)
                UIView.animate(withDuration: 0.28, delay: 0, options: [.curveEaseOut]) {
                    snap?.transform = around(a.point, ratio); snap?.alpha = 0; v.alpha = 1
                } completion: { _ in snap?.removeFromSuperview(); PerfLog.motionEnded() }
            default: break
            }
        }

        /// Neue Spaltenzahl einsetzen; das Objekt `anchorIndex` bleibt auf Höhe `anchorY` (Bildschirm).
        func apply(columns new: Int, anchorIndex: Int?, anchorY: CGFloat) {
            guard let v = view else { return }
            v.setContentOffset(v.contentOffset, animated: false)     // laufende Scroll-Animation/Schwung stoppen
            columns = new
            layout?.columns = new
            // NICHT reconfigureItems: das startet bei geänderter Gesamthöhe eine *animierte* Positionskorrektur,
            // die nach unserem Sprung weiterläuft und das Raster wegschiebt (nach 2019 bzw. ganz nach oben).
            UIView.performWithoutAnimation {
                v.collectionViewLayout.invalidateLayout()
                v.reloadData()
                v.layoutIfNeeded()
            }
            if let anchorIndex, anchorIndex < v.numberOfItems(inSection: 0),
               let f = v.layoutAttributesForItem(at: IndexPath(item: anchorIndex, section: 0))?.frame {
                let maxY = max(-v.contentInset.top, v.contentSize.height + v.contentInset.bottom - v.bounds.height)
                v.contentOffset.y = min(maxY, max(-v.contentInset.top, f.midY - anchorY))
            }
            lastTop = -1
            if let t = topIndex() { lastTop = t; parent.onTop(t) }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in self?.updateAutoplay() }
        }

        /// Übergang beim Tippen in einer dichten Stufe: Standbild zoomt und blendet aus, das neue Raster blendet ein.
        func animate(to new: Int, anchorIndex: Int, anchorY: CGFloat, from snap: UIView?, scale: CGFloat) {
            guard let v = view else { return }
            let ratio = CGFloat(columns) / CGFloat(new)
            let c = CGPoint(x: v.bounds.midX, y: v.bounds.height / 2), p = CGPoint(x: v.bounds.midX, y: anchorY)
            if let snap, let host = v.superview { snap.frame = v.frame; host.insertSubview(snap, aboveSubview: v) }
            parent.onColumns(new)
            apply(columns: new, anchorIndex: anchorIndex, anchorY: anchorY)
            guard let snap else { return }
            v.alpha = 0
            UIView.animate(withDuration: 0.28, delay: 0, options: [.curveEaseOut]) {
                snap.transform = CGAffineTransform(translationX: p.x - c.x, y: p.y - c.y)
                    .scaledBy(x: ratio, y: ratio).translatedBy(x: c.x - p.x, y: c.y - p.y)
                snap.alpha = 0; v.alpha = 1
            } completion: { _ in snap.removeFromSuperview() }
        }
    }
}

/// Große Vorschau beim langen Drücken (Seitenverhältnis des Fotos, scharf nachgeladen).
final class PreviewController: UIViewController {
    private let asset: Asset
    private let image = UIImageView()
    init(asset: Asset) {
        self.asset = asset
        super.init(nibName: nil, bundle: nil)
        let w: CGFloat = 360, r = CGFloat(max(0.5, min(2, asset.ratio)))
        preferredContentSize = CGSize(width: w, height: (w / r).rounded())
    }
    required init?(coder: NSCoder) { fatalError() }
    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemGray6
        image.contentMode = .scaleAspectFill; image.clipsToBounds = true
        image.frame = view.bounds; image.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(image)
        let c = ImageCache.shared, id = asset.id
        image.image = c.get("\(id)-preview") ?? c.get("\(id)-thumbnail") ?? c.placeholder(id)
        Task { @MainActor [weak self] in
            if let img = await c.load(id, .preview) { self?.image.image = img }
        }
    }
}
