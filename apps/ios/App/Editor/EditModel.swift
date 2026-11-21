import SwiftUI
import PencilKit
import CoreImage
import CoreImage.CIFilterBuiltins
import ImageIO
import UniformTypeIdentifiers
import Vision
import AVFoundation

/// Regler aus „Anpassen“ – Werte jeweils −1 … +1 (0 = unverändert).
/// Die 15 Regler von Fotos (iOS 26) in Apples Reihenfolge. Rohwerte nie umbenennen – stehen in gesicherten Bearbeitungen.
enum Adjust: String, CaseIterable, Identifiable, Codable {
    case exposure, brilliance, highlights, shadows, contrast, brightness, blackPoint,
         saturation, vibrance, warmth, tint, sharpness, definition, noiseReduction, vignette
    var id: String { rawValue }
    var title: String {
        switch self {
        case .exposure: String(localized: "Belichtung"); case .brilliance: String(localized: "Brillanz"); case .highlights: String(localized: "Glanzlichter"); case .shadows: String(localized: "Schatten")
        case .contrast: String(localized: "Kontrast"); case .brightness: String(localized: "Helligkeit"); case .blackPoint: String(localized: "Schwarzpunkt"); case .saturation: String(localized: "Sättigung")
        case .vibrance: String(localized: "Lebendigkeit"); case .warmth: String(localized: "Wärme"); case .tint: String(localized: "Farbton"); case .sharpness: String(localized: "Schärfe")
        case .definition: String(localized: "Auflösung"); case .noiseReduction: String(localized: "Rauschreduzierung"); case .vignette: String(localized: "Vignette")
        }
    }
    /// Schärfe und Rauschreduzierung gehen wie bei Apple nur von 0 bis 100.
    var range: ClosedRange<Double> { self == .sharpness || self == .noiseReduction ? 0...1 : -1...1 }
}

enum PhotoFilter: String, CaseIterable, Identifiable, Codable {
    case original, vivid, vividWarm, vividCool, dramatic, dramaticWarm, dramaticCool, mono, silvertone, noir
    var id: String { rawValue }
    var title: String {
        switch self {
        case .original: String(localized: "Original"); case .vivid: String(localized: "Lebendig"); case .vividWarm: String(localized: "Lebendig warm"); case .vividCool: String(localized: "Lebendig kühl")
        case .dramatic: String(localized: "Dramatisch"); case .dramaticWarm: String(localized: "Dramatisch warm"); case .dramaticCool: String(localized: "Dramatisch kühl")
        case .mono: "Mono"; case .silvertone: String(localized: "Silberton"); case .noir: "Noir"
        }
    }
}

/// Vollständiger Bearbeitungsstand. Geometrie in der Reihenfolge des Servers:
/// erst Zuschnitt (normiert, im Original, Ursprung oben links), dann Drehung im Uhrzeigersinn, dann Spiegeln.
/// Fotografische Stile wie in Apple Fotos (PISemanticStyle): Grundstimmung + Ton/Farbe (Steuerfeld) + Palette.
enum PhotoStyle: String, CaseIterable, Identifiable, Codable {
    case standard, amber, gold, roseGold, neutral, coolRose, vibrant, natural, luminous, dramatic, quiet, cozy, ethereal, mutedBW, starkBW
    var id: String { rawValue }
    var title: String {
        switch self {
        case .standard: String(localized: "Standard"); case .amber: String(localized: "Bernstein"); case .gold: String(localized: "Gold"); case .roseGold: String(localized: "Roségold")
        case .neutral: String(localized: "Neutral"); case .coolRose: String(localized: "Kühles Rosé"); case .vibrant: String(localized: "Lebendig"); case .natural: String(localized: "Natürlich")
        case .luminous: String(localized: "Leuchtend"); case .dramatic: String(localized: "Dramatisch"); case .quiet: String(localized: "Ruhig"); case .cozy: String(localized: "Gemütlich")
        case .ethereal: String(localized: "Ätherisch"); case .mutedBW: String(localized: "Gedämpftes S/W"); case .starkBW: String(localized: "Kontrastreiches S/W")
        }
    }
    /// Grundwerte: Wärme, Farbton (grün↔magenta), Sättigung, Kontrast, Schatten anheben, Schwarzweiß
    var base: (warm: Double, tint: Double, sat: Double, con: Double, lift: Double, mono: Bool) {
        switch self {
        case .standard: (0, 0, 0, 0, 0, false)
        case .amber: (0.35, 0.05, 0.05, 0.02, 0.05, false)
        case .gold: (0.28, -0.05, 0.12, 0.04, 0.03, false)
        case .roseGold: (0.18, 0.22, 0.05, 0, 0.05, false)
        case .neutral: (-0.12, 0, -0.08, -0.02, 0.04, false)
        case .coolRose: (-0.25, 0.18, 0, 0, 0.04, false)
        case .vibrant: (0.02, 0, 0.32, 0.08, 0, false)
        case .natural: (0, 0, -0.12, -0.06, 0.08, false)
        case .luminous: (0.04, 0.02, 0.1, -0.08, 0.2, false)
        case .dramatic: (-0.04, 0, -0.08, 0.28, -0.08, false)
        case .quiet: (0.06, 0.02, -0.3, -0.16, 0.14, false)
        case .cozy: (0.4, 0.06, -0.06, 0.06, -0.04, false)
        case .ethereal: (-0.06, 0.12, -0.22, -0.2, 0.25, false)
        case .mutedBW: (0, 0, 0, -0.12, 0.12, true)
        case .starkBW: (0, 0, 0, 0.35, -0.1, true)
        }
    }
}

/// Farbbereiche der selektiven Farbe (wie IPXSelectiveColorBrickController); Rohwerte stehen in gesicherten Bearbeitungen.
enum SelectiveHue: String, CaseIterable, Identifiable {
    case red, orange, yellow, green, cyan, blue, purple, magenta
    var id: String { rawValue }
    var title: String {
        switch self {
        case .red: String(localized: "Rot"); case .orange: String(localized: "Orange"); case .yellow: String(localized: "Gelb")
        case .green: String(localized: "Grün"); case .cyan: String(localized: "Cyan"); case .blue: String(localized: "Blau")
        case .purple: String(localized: "Lila"); case .magenta: String(localized: "Magenta")
        }
    }
    /// Mitte auf dem Farbkreis (0…1)
    var center: Double {
        switch self {
        case .red: 0; case .orange: 0.083; case .yellow: 0.166; case .green: 0.333
        case .cyan: 0.5; case .blue: 0.633; case .purple: 0.75; case .magenta: 0.875
        }
    }
}

struct CleanStroke: Equatable, Codable, Hashable {
    var points: [CGPoint]
    var width: Double
}

/// Maske fürs Bereinigen: weiße Striche auf Schwarz, in Pixelgröße des Bildes.
enum CleanMask {
    static func png(_ strokes: [CleanStroke], size: CGSize) -> Data? {
        let fmt = UIGraphicsImageRendererFormat(); fmt.scale = 1; fmt.opaque = true
        let img = UIGraphicsImageRenderer(size: size, format: fmt).image { c in
            UIColor.black.setFill(); c.fill(CGRect(origin: .zero, size: size))
            let g = c.cgContext
            g.setStrokeColor(UIColor.white.cgColor); g.setLineCap(.round); g.setLineJoin(.round)
            for st in strokes {
                g.setLineWidth(st.width * size.width)
                let pts = st.points.map { CGPoint(x: $0.x * size.width, y: $0.y * size.height) }
                guard let first = pts.first else { continue }
                g.beginPath(); g.move(to: first)
                if pts.count == 1 { g.addLine(to: CGPoint(x: first.x + 0.1, y: first.y)) }
                for p in pts.dropFirst() { g.addLine(to: p) }
                g.strokePath()
            }
        }
        return img.pngData()
    }
}

struct EditState: Equatable, Codable {
    var values: [Adjust: Double] = [:]      // vom Nutzer gesetzt (−1 … 1)
    var auto = false
    var autoValues: [Adjust: Double] = [:]  // was „Auto“ für dieses Bild vorschlägt
    var autoStrength: Double = 0            // Auto-Regler: −1 … 1 → 0- bis 2-fach
    var disabled: Set<Adjust> = []          // per Tippen ausgeschaltet, Wert bleibt erhalten
    var filter: PhotoFilter = .original
    var angle = 0              // 0, 90, 180, 270 (im Uhrzeigersinn)
    var mirrored = false
    var crop = CGRect(x: 0, y: 0, width: 1, height: 1)
    var straighten: Double = 0      // Grad, −45 … 45 (rechnet die App, Server kann nur 90°-Schritte)
    var perspV: Double = 0          // −1 … 1
    var perspH: Double = 0
    /// Filterstärke 0 … 1 (Apple: Lineal unter den Filtern)
    var filterAmount: Double = 1
    var style: PhotoStyle = .standard
    var styleTone: Double = 0       // −1 … 1 (Steuerfeld senkrecht)
    var styleColor: Double = 0      // −1 … 1 (Steuerfeld waagerecht)
    var stylePalette: Double = 1    // 0 … 1 (Palette)
    /// Fotografische Stile 3: Textur (−1 weich … 1 knackig) und Körnung (0 … 1, Filmkorn)
    var styleTexture: Double = 0
    var styleGrain: Double = 0
    /// Porträt: Blende (ƒ-Zahl) für die Tiefenunschärfe, nil = aus
    var aperture: Double?
    /// Schalter „PORTRÄT“ aus: Blende, Fokus und Licht bleiben gemerkt, wirken aber nicht
    var portraitOff = false
    /// Schärfepunkt per Tippen (0…1, oben links = 0/0, im unbearbeiteten Bild); nil = Person bzw. Gesicht
    var focus: CGPoint?
    /// Porträtlicht und Stärke je Effekt (0…1, Standard 0,5)
    var light: PortraitLight = .natural
    var lightStrength: [PortraitLight: Double] = [:]
    /// Markieren (PencilKit-Zeichnung) und die Größe der Zeichenfläche, auf die sie sich bezieht
    var markup: Data?
    var markupCanvas: CGSize?
    /// Live Photo: Schlüsselbild (Sekunde im Live-Video), nil = Originalfoto
    var keyFrame: Double?
    /// Bereinigen: gewischte Striche (Punkte 0…1 im unbearbeiteten Bild, Breite relativ zur Bildbreite)
    var cleanup: [CleanStroke] = []
    /// Profi-Werkzeuge der Mac-App (Apple macOS: Kurven, Tonwerte, Selektive Farbe); das iPhone rechnet sie mit.
    /// Kurven: Ausgabe (0…1) an den Eingaben 0, ¼, ½, ¾, 1 – nil = Diagonale.
    var curves: [Double]?
    /// Tonwerte: Schwarzpunkt, Mitteltöne (Gamma 0,25…4, 1 = neutral), Weißpunkt – nil = aus.
    var levels: [Double]?
    /// Selektive Farbe je Farbbereich (SelectiveHue.rawValue): Farbton −1…1, Sättigung −1…1, Helligkeit −1…1.
    var selective: [String: [Double]] = [:]

    enum CodingKeys: String, CodingKey {
        case values, auto, autoValues, autoStrength, disabled, filter, angle, mirrored, crop, straighten, perspV, perspH
        case filterAmount, style, styleTone, styleColor, stylePalette, styleTexture, styleGrain, aperture, portraitOff, focus, light, lightStrength, markup, markupCanvas, keyFrame, cleanup
        case curves, levels, selective
    }
    init() {}
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        values = try c.decodeIfPresent([Adjust: Double].self, forKey: .values) ?? [:]
        auto = try c.decodeIfPresent(Bool.self, forKey: .auto) ?? false
        autoValues = try c.decodeIfPresent([Adjust: Double].self, forKey: .autoValues) ?? [:]
        autoStrength = try c.decodeIfPresent(Double.self, forKey: .autoStrength) ?? 0
        disabled = try c.decodeIfPresent(Set<Adjust>.self, forKey: .disabled) ?? []
        filter = try c.decodeIfPresent(PhotoFilter.self, forKey: .filter) ?? .original
        angle = try c.decodeIfPresent(Int.self, forKey: .angle) ?? 0
        mirrored = try c.decodeIfPresent(Bool.self, forKey: .mirrored) ?? false
        crop = try c.decodeIfPresent(CGRect.self, forKey: .crop) ?? Self.unit
        straighten = try c.decodeIfPresent(Double.self, forKey: .straighten) ?? 0
        perspV = try c.decodeIfPresent(Double.self, forKey: .perspV) ?? 0
        perspH = try c.decodeIfPresent(Double.self, forKey: .perspH) ?? 0
        filterAmount = try c.decodeIfPresent(Double.self, forKey: .filterAmount) ?? 1
        style = try c.decodeIfPresent(PhotoStyle.self, forKey: .style) ?? .standard
        styleTone = try c.decodeIfPresent(Double.self, forKey: .styleTone) ?? 0
        styleColor = try c.decodeIfPresent(Double.self, forKey: .styleColor) ?? 0
        stylePalette = try c.decodeIfPresent(Double.self, forKey: .stylePalette) ?? 1
        styleTexture = try c.decodeIfPresent(Double.self, forKey: .styleTexture) ?? 0
        styleGrain = try c.decodeIfPresent(Double.self, forKey: .styleGrain) ?? 0
        aperture = try c.decodeIfPresent(Double.self, forKey: .aperture)
        portraitOff = try c.decodeIfPresent(Bool.self, forKey: .portraitOff) ?? false
        focus = try c.decodeIfPresent(CGPoint.self, forKey: .focus)
        light = (try? c.decodeIfPresent(PortraitLight.self, forKey: .light)) ?? .natural
        lightStrength = (try? c.decodeIfPresent([PortraitLight: Double].self, forKey: .lightStrength)) ?? [:]
        markup = try c.decodeIfPresent(Data.self, forKey: .markup)
        markupCanvas = try c.decodeIfPresent(CGSize.self, forKey: .markupCanvas)
        keyFrame = try c.decodeIfPresent(Double.self, forKey: .keyFrame)
        cleanup = try c.decodeIfPresent([CleanStroke].self, forKey: .cleanup) ?? []
        curves = try c.decodeIfPresent([Double].self, forKey: .curves)
        levels = try c.decodeIfPresent([Double].self, forKey: .levels)
        selective = try c.decodeIfPresent([String: [Double]].self, forKey: .selective) ?? [:]
    }

    /// „Änderungen einsetzen“ übernimmt nur Licht/Farbe/Filter, nicht den Zuschnitt (wie Apple).
    mutating func pasteColor(from o: EditState) {
        values = o.values; auto = o.auto; autoValues = o.autoValues; autoStrength = o.autoStrength
        disabled = o.disabled; filter = o.filter; filterAmount = o.filterAmount
        style = o.style; styleTone = o.styleTone; styleColor = o.styleColor; stylePalette = o.stylePalette
        styleTexture = o.styleTexture; styleGrain = o.styleGrain
        curves = o.curves; levels = o.levels; selective = o.selective
    }

    static let unit = CGRect(x: 0, y: 0, width: 1, height: 1)
    /// Alles, was die App selbst rechnen muss (Server kann nur Zuschnitt + 90°-Drehung + Spiegeln).
    var hasColor: Bool {
        filter != .original || Adjust.allCases.contains { abs(value($0)) > 0.005 } || straighten != 0 || perspV != 0 || perspH != 0
            || hasStyle || hasPortrait || markup != nil || keyFrame != nil || !cleanup.isEmpty || hasPro
    }
    var hasPro: Bool {
        (curves.map { c in zip(c, [0, 0.25, 0.5, 0.75, 1]).contains { abs($0 - $1) > 0.003 } } ?? false)
            || (levels.map { abs($0[0]) > 0.003 || abs($0[1] - 1) > 0.003 || abs($0[2] - 1) > 0.003 } ?? false)
            || selective.values.contains { $0.contains { abs($0) > 0.003 } }
    }
    /// Porträt wirkt gerade (Tiefenunschärfe oder Licht) – dafür braucht der Renderer die Tiefendaten
    var hasPortrait: Bool { !portraitOff && (aperture != nil || light != .natural) }
    func strength(_ l: PortraitLight) -> Double { lightStrength[l] ?? 0.5 }
    var hasStyle: Bool { style != .standard || styleTone != 0 || styleColor != 0 || abs(styleTexture) > 0.005 || styleGrain > 0.005 }
    var hasGeometry: Bool { angle % 360 != 0 || mirrored || !crop.isApprox(Self.unit) }
    var isIdentity: Bool { !hasColor && !hasGeometry }

    /// Wirksamer Wert: ausgeschaltet → 0, sonst Nutzerwert, sonst Auto-Vorschlag.
    func value(_ a: Adjust) -> Double {
        if disabled.contains(a) { return 0 }
        return values[a] ?? autoValue(a)
    }
    /// Angezeigter Wert, auch wenn der Regler gerade ausgeschaltet ist.
    func storedValue(_ a: Adjust) -> Double { values[a] ?? autoValue(a) }
    func autoValue(_ a: Adjust) -> Double {
        guard auto, let v = autoValues[a] else { return 0 }
        return min(a.range.upperBound, max(a.range.lowerBound, (v * (1 + autoStrength) * 100).rounded() / 100))
    }
    /// true, wenn der Wert nur von „Auto“ kommt (Ring weiß statt gelb).
    func isAuto(_ a: Adjust) -> Bool { values[a] == nil && autoValue(a) != 0 }

    // Zuschnitt in Anzeige-Koordinaten (nach Drehen/Spiegeln) ↔ Original-Koordinaten
    var displayCrop: CGRect {
        get {
            var r = crop
            for _ in 0..<(angle / 90 % 4) { r = CGRect(x: 1 - r.maxY, y: r.minX, width: r.height, height: r.width) }
            if mirrored { r.origin.x = 1 - r.maxX }
            return r
        }
        set {
            var r = newValue
            if mirrored { r.origin.x = 1 - r.maxX }
            for _ in 0..<(angle / 90 % 4) { r = CGRect(x: r.minY, y: 1 - r.maxX, width: r.height, height: r.width) }
            crop = r.intersection(Self.unit)
        }
    }
}

extension CGRect {
    func isApprox(_ o: CGRect) -> Bool {
        abs(minX - o.minX) < 0.002 && abs(minY - o.minY) < 0.002 && abs(width - o.width) < 0.002 && abs(height - o.height) < 0.002
    }
}

/// Porträtlicht wie in Fotos (Reihenfolge wie dort).
enum PortraitLight: String, CaseIterable, Identifiable, Codable {
    case natural, studio, contour, stage, stageMono, highKeyMono
    var id: String { rawValue }
    var title: String {
        switch self {
        case .natural: String(localized: "NATÜRLICHES LICHT"); case .studio: String(localized: "STUDIOLICHT")
        case .contour: String(localized: "KONTURENLICHT"); case .stage: String(localized: "BÜHNENLICHT")
        case .stageMono: String(localized: "BÜHNENLICHT MONO"); case .highKeyMono: String(localized: "HIGH-KEY-LICHT MONO")
        }
    }
    var symbol: String {
        switch self {
        case .natural: "sun.max"; case .studio: "light.max"; case .contour: "circle.lefthalf.filled"
        case .stage: "theatermasks"; case .stageMono: "theatermasks.fill"; case .highKeyMono: "circle.dotted"
        }
    }
}

/// Tiefendaten eines Porträtfotos aus dem Original (HEIC): Tiefenkarte und – falls vorhanden – Personen-Matte.
struct DepthMaps: @unchecked Sendable {
    let disparity: CIImage
    let matte: CIImage?
    init?(data: Data) {
        guard let d = CIImage(data: data, options: [.auxiliaryDisparity: true, .applyOrientationProperty: true]) else { return nil }
        disparity = d
        matte = CIImage(data: data, options: [.auxiliaryPortraitEffectsMatte: true, .applyOrientationProperty: true])
    }
}

/// Rechnet Bearbeitungen mit Core Image (Vorschau live, Endfassung in voller Auflösung).
final class EditRenderer: @unchecked Sendable {
    let context = CIContext(options: [.cacheIntermediates: false])

    /// geometry=false: nur Farbe (für die Zuschneiden-Ansicht, die das ganze Bild zeigt)
    /// disparity: Tiefenkarte des Originals (Porträtfotos) für die Blende.
    func apply(_ base: CIImage, _ s: EditState, crop: Bool = true, disparity: DepthMaps? = nil) -> CIImage {
        var img = base
        if !s.portraitOff, let f = s.aperture, let disparity { img = depthBlur(img, depth: disparity, aperture: f, focus: s.focus) }
        if s.hasPortrait, s.light != .natural, let disparity { img = portraitLight(img, depth: disparity, s) }
        if crop && !s.crop.isApprox(EditState.unit) {
            let e = img.extent, r = s.crop
            img = img.cropped(to: CGRect(x: e.minX + r.minX * e.width, y: e.minY + (1 - r.maxY) * e.height,
                                         width: r.width * e.width, height: r.height * e.height))
        }
        for _ in 0..<(s.angle / 90 % 4) { img = img.oriented(.right) }   // 90° im Uhrzeigersinn
        if s.mirrored { img = img.oriented(.upMirrored) }
        img = img.transformed(by: CGAffineTransform(translationX: -img.extent.minX, y: -img.extent.minY))
        img = geometry(img, s)
        img = color(img, s)
        if s.hasPro { img = pro(img, s) }
        if crop, let m = s.markup, let size = s.markupCanvas { img = markup(img, data: m, canvas: size) }
        return img
    }

    /// Tonwerte → Kurven → Selektive Farbe (Reihenfolge wie die Bricks in Fotos auf dem Mac).
    func pro(_ input: CIImage, _ s: EditState) -> CIImage {
        var img = input
        if let l = s.levels, l.count == 3 {
            let black = min(l[0], l[2] - 0.02), span = max(0.02, l[2] - black)
            img = img.applyingFilter("CIColorMatrix", parameters: [
                "inputRVector": CIVector(x: 1 / span, y: 0, z: 0, w: 0), "inputGVector": CIVector(x: 0, y: 1 / span, z: 0, w: 0),
                "inputBVector": CIVector(x: 0, y: 0, z: 1 / span, w: 0),
                "inputBiasVector": CIVector(x: -black / span, y: -black / span, z: -black / span, w: 0)])
                .applyingFilter("CIColorClamp")
            if abs(l[1] - 1) > 0.003 { img = img.applyingFilter("CIGammaAdjust", parameters: ["inputPower": 1 / max(0.25, min(4, l[1]))]) }
        }
        if let c = s.curves, c.count == 5 {
            img = img.applyingFilter("CIToneCurve", parameters: [
                "inputPoint0": CIVector(x: 0, y: c[0]), "inputPoint1": CIVector(x: 0.25, y: c[1]), "inputPoint2": CIVector(x: 0.5, y: c[2]),
                "inputPoint3": CIVector(x: 0.75, y: c[3]), "inputPoint4": CIVector(x: 1, y: c[4])])
        }
        if s.selective.values.contains(where: { $0.contains { abs($0) > 0.003 } }), let cube = selectiveCube(s.selective) {
            img = img.applyingFilter("CIColorCubeWithColorSpace", parameters: [
                "inputCubeDimension": 32, "inputCubeData": cube, "inputColorSpace": CGColorSpace(name: CGColorSpace.sRGB)!])
        }
        return img
    }

    /// Farbwürfel für die selektive Farbe (gemerkt je Einstellung, ≈ 5 ms beim ersten Mal).
    private var cubeCache: ([String: [Double]], Data)?
    private let cubeLock = NSLock()
    private func selectiveCube(_ sel: [String: [Double]]) -> Data? {
        if let c = cubeLock.withLock({ cubeCache }), c.0 == sel { return c.1 }
        let n = 32
        var out = [Float](repeating: 0, count: n * n * n * 4)
        for b in 0..<n { for g in 0..<n { for r in 0..<n {
            var (h, sat, v) = Self.hsv(Double(r) / Double(n - 1), Double(g) / Double(n - 1), Double(b) / Double(n - 1))
            var dh = 0.0, ds = 0.0, dv = 0.0
            for hue in SelectiveHue.allCases {
                guard let p = sel[hue.rawValue], p.count == 3 else { continue }
                // weiche Gewichtung um die Mitte des Farbbereichs (±1/8 Farbkreis), graue Töne bleiben unberührt
                var d = abs(h - hue.center); d = min(d, 1 - d)
                let w = max(0, 1 - d / 0.11) * min(1, sat * 4)
                dh += w * p[0] * 0.08; ds += w * p[1]; dv += w * p[2] * 0.5
            }
            h = (h + dh + 1).truncatingRemainder(dividingBy: 1)
            sat = min(1, max(0, sat * (1 + ds)))
            v = min(1, max(0, v * (1 + dv)))
            let (rr, gg, bb) = Self.rgb(h, sat, v)
            let i = ((b * n + g) * n + r) * 4
            out[i] = Float(rr); out[i + 1] = Float(gg); out[i + 2] = Float(bb); out[i + 3] = 1
        } } }
        let d = out.withUnsafeBufferPointer { Data(buffer: $0) }
        cubeLock.withLock { cubeCache = (sel, d) }
        return d
    }

    static func hsv(_ r: Double, _ g: Double, _ b: Double) -> (Double, Double, Double) {
        let mx = max(r, g, b), mn = min(r, g, b), d = mx - mn
        var h = 0.0
        if d > 0 {
            if mx == r { h = ((g - b) / d).truncatingRemainder(dividingBy: 6) }
            else if mx == g { h = (b - r) / d + 2 } else { h = (r - g) / d + 4 }
            h /= 6; if h < 0 { h += 1 }
        }
        return (h, mx == 0 ? 0 : d / mx, mx)
    }

    static func rgb(_ h: Double, _ s: Double, _ v: Double) -> (Double, Double, Double) {
        let i = Int(h * 6) % 6, f = h * 6 - Double(Int(h * 6))
        let p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s)
        switch i {
        case 0: return (v, t, p); case 1: return (q, v, p); case 2: return (p, v, t)
        case 3: return (p, q, v); case 4: return (t, p, v); default: return (v, p, q)
        }
    }

    /// Porträt-Unschärfe wie Apples Blende (PIDepthAdjustment): kleinere ƒ-Zahl = stärkere Unschärfe.
    /// Eigene Rechnung statt CIDepthBlurEffect (der braucht Apples interne Porträt-Bibliothek und stürzt ohne sie ab):
    /// Schärfeebene = Tiefe der Person (Porträt-Matte, sonst Gesicht per Vision), davor und dahinter wächst die
    /// Unschärfe mit dem Abstand; die Person selbst bleibt über die Matte immer scharf.
    func depthBlur(_ img: CIImage, depth: DepthMaps, aperture f: Double, focus point: CGPoint? = nil) -> CIImage {
        let disparity = depth.disparity
        let e = img.extent, de = disparity.extent
        guard de.width > 0, de.height > 0 else { return img }
        // Spanne der Tiefenwerte (Disparität: groß = nah)
        guard let mm = pixel(disparity.applyingFilter("CIAreaMinMaxRed", parameters: [kCIInputExtentKey: CIVector(cgRect: de)])) else { return img }
        let lo = Double(min(mm[0], mm[1])), hi = Double(max(mm[0], mm[1]))   // R = Minimum, G = Maximum
        let span = hi - lo
        guard span > 0.001 else { return img }
        let focus = point.flatMap { tapDisparity(depth, at: $0) } ?? focusDisparity(img, depth: depth) ?? (hi - span * 0.15)
        // Wie Fotos: Unschärfe wächst linear mit dem Nähe-Abstand HINTER der Schärfeebene und umgekehrt mit der ƒ-Zahl,
        // höchstens 3 % der Bildbreite; was vor der Schärfeebene liegt, bleibt scharf. 2,8 = bei ƒ4.5 etwa halbe Unschärfe
        // für eine Wand im Abstand 0,8 hinter der Person, bei ƒ1.4 schon ab 0,25 die volle.
        let k = 2.8 / f
        var mask = Self.fit(disparity.applyingFilter("CIColorMatrix", parameters: [
            "inputRVector": CIVector(x: -k, y: 0, z: 0, w: 0), "inputGVector": CIVector(x: -k, y: 0, z: 0, w: 0),
            "inputBVector": CIVector(x: -k, y: 0, z: 0, w: 0), "inputAVector": CIVector(x: 0, y: 0, z: 0, w: 0),
            "inputBiasVector": CIVector(x: k * focus, y: k * focus, z: k * focus, w: 1)])
            .applyingFilter("CIColorClamp")
            .applyingFilter("CIGammaAdjust", parameters: ["inputPower": 1.3])   // nahe der Ebene erst sanft (quadratischer Anlauf)
            .cropped(to: de), to: e)
        // Person über die Matte scharf halten (ab ~50 % Matte voll scharf) – außer der Fokus liegt bewusst neben der Person
        if let matte = depth.matte, point.map({ onPerson(depth, at: $0) }) ?? true {
            let keep = Self.fit(matte, to: e).applyingFilter("CIColorMatrix", parameters: [
                "inputRVector": CIVector(x: -2, y: 0, z: 0, w: 0), "inputGVector": CIVector(x: -2, y: 0, z: 0, w: 0),
                "inputBVector": CIVector(x: -2, y: 0, z: 0, w: 0), "inputAVector": CIVector(x: 0, y: 0, z: 0, w: 0),
                "inputBiasVector": CIVector(x: 1, y: 1, z: 1, w: 1)]).applyingFilter("CIColorClamp")
            mask = mask.applyingFilter("CIMultiplyCompositing", parameters: [kCIInputBackgroundImageKey: keep])
        }
        mask = mask.clampedToExtent()
            .applyingFilter("CIGaussianBlur", parameters: [kCIInputRadiusKey: max(1, e.width / 1500)])   // schmaler Kantenübergang
            .cropped(to: e)
        let radius = e.width * 0.03
        guard radius > 0.5 else { return img }
        return img.clampedToExtent()
            .applyingFilter("CIMaskedVariableBlur", parameters: ["inputMask": mask, kCIInputRadiusKey: radius])
            .cropped(to: e)
    }

    // MARK: Porträtlicht

    /// Stärke-Regler → wirksame Stärke je Effekt (wie Fotos): Studio/High-Key steigen anfangs schneller (Potenz 0,75),
    /// Kontur/Bühne noch steiler (1,8·s − 0,8·s²); 50 % ergeben so ~59 % bzw. 70 %.
    static func appliedStrength(_ l: PortraitLight, _ s: Double) -> Double {
        let s = max(0, min(1, s))
        switch l {
        case .natural: return 0
        case .studio, .highKeyMono: return pow(s, 0.75)
        case .contour, .stage, .stageMono: return 1.8 * s - 0.8 * s * s
        }
    }

    /// Gesichter für das Licht: nur breiter als ~15 % des Bildes und weniger als ~60° geneigt (Rechtecke in Bildkoordinaten, CI = unten links).
    private var faceCache: (ObjectIdentifier, [CGRect])?
    private func lightFaces(_ img: CIImage, key: ObjectIdentifier) -> [CGRect] {
        if let c = focusLock.withLock({ faceCache }), c.0 == key { return c.1 }
        let e = img.extent, scale = 800 / max(e.width, e.height)
        var out: [CGRect] = []
        if let cg = context.createCGImage(img.transformed(by: CGAffineTransform(scaleX: scale, y: scale)),
                                          from: e.applying(CGAffineTransform(scaleX: scale, y: scale))) {
            let req = VNDetectFaceRectanglesRequest()
            try? VNImageRequestHandler(cgImage: cg).perform([req])
            for f in req.results ?? [] where f.boundingBox.width > 0.15 && abs(f.roll?.doubleValue ?? 0) < .pi / 3 {
                let b = f.boundingBox
                out.append(CGRect(x: e.minX + b.minX * e.width, y: e.minY + b.minY * e.height, width: b.width * e.width, height: b.height * e.height))
            }
        }
        focusLock.withLock { faceCache = (key, out) }
        return out
    }

    /// Weicher elliptischer Lichtfleck (1 innen → 0 außen) als Maske.
    private static func spot(_ r: CGRect, in e: CGRect, softness: CGFloat = 1) -> CIImage {
        let c = CIVector(x: r.midX, y: r.midY), rad = max(r.width, r.height) / 2
        let g = CIFilter.radialGradient()
        g.center = CGPoint(x: c.x, y: c.y); g.radius0 = Float(rad * (1 - 0.6 * softness)); g.radius1 = Float(rad)
        g.color0 = CIColor(red: 1, green: 1, blue: 1); g.color1 = CIColor(red: 0, green: 0, blue: 0)
        // Kreis auf Ellipse stauchen
        let sx = r.width / max(1, max(r.width, r.height)), sy = r.height / max(1, max(r.width, r.height))
        return g.outputImage!.transformed(by: CGAffineTransform(translationX: -r.midX, y: -r.midY)
            .concatenating(CGAffineTransform(scaleX: sx, y: sy)).concatenating(CGAffineTransform(translationX: r.midX, y: r.midY))).cropped(to: e)
    }

    private static func blend(_ a: CIImage, _ b: CIImage, mask: CIImage) -> CIImage {
        b.applyingFilter("CIBlendWithMask", parameters: [kCIInputBackgroundImageKey: a, kCIInputMaskImageKey: mask])
    }
    private static func mono(_ img: CIImage) -> CIImage {
        img.applyingFilter("CIColorControls", parameters: [kCIInputSaturationKey: 0, kCIInputContrastKey: 1.12])
    }

    /// Porträtlicht wie Fotos: Studio hellt das Gesicht auf (Wangen-Lichter, leichter Schatten unters Kinn), Kontur setzt
    /// Schatten an die Gesichtsseiten und dunkelt den Rand ab, Bühne stellt die Person vor Schwarz, High-Key Mono vor Weiß.
    /// Der Effekt wird nach der Stärke mit dem Bild gemischt; Schwarz/Weiß im Hintergrund hängt nur an der Personen-Maske.
    func portraitLight(_ input: CIImage, depth: DepthMaps, _ s: EditState) -> CIImage {
        let l = s.light
        guard l != .natural else { return input }
        let e = input.extent
        let st = Self.appliedStrength(l, s.strength(l))
        let faces = lightFaces(input, key: ObjectIdentifier(depth.disparity))
        var fx = input
        // Studio-Grundlage (für alle außer „Natürlich“): Gesicht aufhellen + Wangen-Kicker + Kinnschatten, Farben anreichern
        var faceMask = CIImage(color: .black).cropped(to: e)
        for f in faces {
            let ell = f.insetBy(dx: -f.width * 0.08, dy: -f.height * 0.12)
            faceMask = Self.spot(ell, in: e, softness: 0.8).applyingFilter("CILightenBlendMode", parameters: [kCIInputBackgroundImageKey: faceMask])
        }
        let bright = fx.applyingFilter("CIExposureAdjust", parameters: [kCIInputEVKey: 0.35])
            .applyingFilter("CIHighlightShadowAdjust", parameters: ["inputShadowAmount": 0.35, "inputHighlightAmount": 0.95])
            .applyingFilter("CIVibrance", parameters: ["inputAmount": 0.15])
        fx = Self.blend(fx, bright, mask: faceMask)
        for f in faces {
            // Wangen-Lichter links/rechts unterhalb der Augen, Schatten unters Kinn
            for side in [0.28, 0.72] {
                let cheek = CGRect(x: f.minX + f.width * side - f.width * 0.16, y: f.minY + f.height * 0.25, width: f.width * 0.32, height: f.height * 0.24)
                fx = Self.blend(fx, fx.applyingFilter("CIExposureAdjust", parameters: [kCIInputEVKey: 0.3]), mask: Self.spot(cheek, in: e))
            }
            let chin = CGRect(x: f.midX - f.width * 0.3, y: f.minY - f.height * 0.18, width: f.width * 0.6, height: f.height * 0.22)
            fx = Self.blend(fx, fx.applyingFilter("CIExposureAdjust", parameters: [kCIInputEVKey: -0.35]), mask: Self.spot(chin, in: e))
        }
        if l == .contour || l == .stage || l == .stageMono {
            // Schatten an den Gesichtsseiten + Rand rund ums Gesicht abdunkeln, mehr lokaler Kontrast
            for f in faces {
                for x in [f.minX - f.width * 0.05, f.maxX - f.width * 0.25] {
                    let edge = CGRect(x: x, y: f.minY + f.height * 0.1, width: f.width * 0.3, height: f.height * 0.75)
                    fx = Self.blend(fx, fx.applyingFilter("CIExposureAdjust", parameters: [kCIInputEVKey: -0.55]), mask: Self.spot(edge, in: e))
                }
            }
            var keep = faceMask
            if let m = depth.matte { keep = Self.fit(m, to: e).applyingFilter("CILightenBlendMode", parameters: [kCIInputBackgroundImageKey: faceMask]) }
            let dark = fx.applyingFilter("CIExposureAdjust", parameters: [kCIInputEVKey: -0.6])
            fx = Self.blend(dark, fx, mask: keep.applyingFilter("CIGaussianBlur", parameters: [kCIInputRadiusKey: e.width / 60]).cropped(to: e))
            fx = fx.applyingFilter("CIUnsharpMask", parameters: [kCIInputRadiusKey: e.width / 120, kCIInputIntensityKey: 0.25])
        }
        // nach Stärke mischen
        var out = fx
        if st < 0.999 { out = input.applyingFilter("CIDissolveTransition", parameters: ["inputTargetImage": fx, kCIInputTimeKey: st]) }
        // Bühne: Hintergrund schwarz, High-Key: weiß – über die Personen-Maske (weiche Schwelle), unabhängig von der Stärke
        if l == .stage || l == .stageMono || l == .highKeyMono, let m = depth.matte {
            let person = Self.fit(m, to: e).applyingFilter("CIColorControls", parameters: [kCIInputContrastKey: 1.6])
                .applyingFilter("CIColorClamp").cropped(to: e)
            if l == .highKeyMono { out = out.applyingFilter("CIExposureAdjust", parameters: [kCIInputEVKey: 0.25]) }
            let ground = CIImage(color: l == .highKeyMono ? .white : .black).cropped(to: e)
            out = Self.blend(ground, out.applyingFilter("CISharpenLuminance", parameters: [kCIInputSharpnessKey: 0.3]), mask: person)
        }
        if l == .stageMono || l == .highKeyMono { out = Self.mono(out) }
        return out.cropped(to: e)
    }

    /// Bild auf ein Zielrechteck strecken (Tiefenkarte/Matte haben eine kleinere Auflösung als das Foto).
    static func fit(_ m: CIImage, to t: CGRect) -> CIImage {
        let s = m.extent
        return m.transformed(by: CGAffineTransform(translationX: -s.minX, y: -s.minY)
            .concatenating(CGAffineTransform(scaleX: t.width / s.width, y: t.height / s.height))
            .concatenating(CGAffineTransform(translationX: t.minX, y: t.minY)))
    }

    /// Tiefe der Person: Mittel der Tiefenkarte unter der Porträt-Matte, ohne Matte am größten Gesicht (Vision).
    /// Einmal je Foto gerechnet.
    private var focusCache: (ObjectIdentifier, Double?)?
    private let focusLock = NSLock()
    private func focusDisparity(_ img: CIImage, depth: DepthMaps) -> Double? {
        let disparity = depth.disparity, de = disparity.extent, ext = CIVector(cgRect: de)
        let key = ObjectIdentifier(disparity)
        if let c = focusLock.withLock({ focusCache }), c.0 == key { return c.1 }
        var value: Double?
        if let matte = depth.matte {
            let m = Self.fit(matte, to: de)
            if let num = pixel(disparity.applyingFilter("CIMultiplyCompositing", parameters: [kCIInputBackgroundImageKey: m])
                                .applyingFilter("CIAreaAverage", parameters: [kCIInputExtentKey: ext])),
               let den = pixel(m.applyingFilter("CIAreaAverage", parameters: [kCIInputExtentKey: ext])), den[0] > 0.001 {
                value = Double(num[0] / den[0])
            }
        }
        let e = img.extent, scale = 640 / max(e.width, e.height)
        if value == nil, let cg = context.createCGImage(img.transformed(by: CGAffineTransform(scaleX: scale, y: scale)),
                                                        from: e.applying(CGAffineTransform(scaleX: scale, y: scale))) {
            let faces = VNDetectFaceRectanglesRequest()
            try? VNImageRequestHandler(cgImage: cg).perform([faces])
            if let box = (faces.results ?? []).max(by: { $0.boundingBox.width * $0.boundingBox.height < $1.boundingBox.width * $1.boundingBox.height })?.boundingBox {
                // Vision und Core Image zählen beide von unten links → Box direkt auf die Tiefenkarte legen (innere Hälfte)
                let r = CGRect(x: de.minX + (box.minX + box.width * 0.25) * de.width, y: de.minY + (box.minY + box.height * 0.25) * de.height,
                               width: box.width * 0.5 * de.width, height: box.height * 0.5 * de.height)
                value = pixel(disparity.applyingFilter("CIAreaAverage", parameters: [kCIInputExtentKey: CIVector(cgRect: r)])).map { Double($0[0]) }
            }
        }
        focusLock.withLock { focusCache = (key, value) }
        return value
    }

    /// Liegt der Punkt auf der Person (Porträt-Matte)? Ohne Matte: ja.
    private func onPerson(_ depth: DepthMaps, at p: CGPoint) -> Bool {
        guard let m = depth.matte else { return true }
        let e = m.extent
        let r = CGRect(x: e.minX + p.x * e.width - 2, y: e.minY + (1 - p.y) * e.height - 2, width: 4, height: 4).intersection(e)
        guard !r.isEmpty else { return false }
        return (pixel(m.applyingFilter("CIAreaAverage", parameters: [kCIInputExtentKey: CIVector(cgRect: r)]))?[0] ?? 1) > 0.5
    }

    /// Fokus per Tippen wie Fotos: im Quadrat von etwa 20 % der Bildbreite um den Punkt wird das 75-%-Quantil der Nähe
    /// zur Schärfeebene (eher das Nähere im Ausschnitt, nicht der Mittelwert).
    private func tapDisparity(_ depth: DepthMaps, at p: CGPoint) -> Double? {
        let de = depth.disparity.extent
        let w = de.width * 0.2, h = min(de.height, w)
        let cx = de.minX + p.x * de.width, cy = de.minY + (1 - p.y) * de.height   // Core Image zählt von unten
        let r = CGRect(x: cx - w / 2, y: cy - h / 2, width: w, height: h).intersection(de).integral
        guard r.width >= 1, r.height >= 1 else { return nil }
        let n = Int(r.width) * Int(r.height)
        var px = [Float](repeating: 0, count: n * 4)
        context.render(depth.disparity, toBitmap: &px, rowBytes: Int(r.width) * 16, bounds: r, format: .RGBAf, colorSpace: nil)
        let vals = stride(from: 0, to: px.count, by: 4).map { px[$0] }.filter { $0.isFinite }.sorted()
        guard !vals.isEmpty else { return nil }
        return Double(vals[min(vals.count - 1, Int(Double(vals.count) * 0.75))])
    }

    /// Ein Pixel (RGBA float) aus einem 1×1-Ergebnis lesen.
    private func pixel(_ img: CIImage) -> [Float]? {
        var px = [Float](repeating: 0, count: 4)
        context.render(img, toBitmap: &px, rowBytes: 16, bounds: CGRect(x: img.extent.minX, y: img.extent.minY, width: 1, height: 1),
                       format: .RGBAf, colorSpace: nil)
        return px
    }

    /// Markierungen (PencilKit) über das fertige Bild legen – in der Größe des angezeigten Bildes gezeichnet.
    func markup(_ img: CIImage, data: Data, canvas: CGSize) -> CIImage {
        guard let drawing = try? PKDrawing(data: data), canvas.width > 0 else { return img }
        let e = img.extent
        let scale = e.width / canvas.width
        let ui = drawing.image(from: CGRect(origin: .zero, size: canvas), scale: scale)
        #if canImport(UIKit)
        guard let cg = ui.cgImage else { return img }
        #else
        guard let cg = ui.cgImage(forProposedRect: nil, context: nil, hints: nil) else { return img }   // Mac: NSImage
        #endif
        let over = CIImage(cgImage: cg).transformed(by: CGAffineTransform(scaleX: e.width / CGFloat(cg.width), y: e.height / CGFloat(cg.height)))
            .transformed(by: CGAffineTransform(translationX: e.minX, y: e.minY))
        return over.composited(over: img).cropped(to: e)
    }

    /// Begradigen (dreht und vergrößert, damit keine Ecken leer bleiben) + Perspektive.
    func geometry(_ input: CIImage, _ s: EditState) -> CIImage {
        var img = input
        let e = img.extent
        if s.perspV != 0 || s.perspH != 0 {
            let dv = CGFloat(s.perspV) * e.width * 0.18, dh = CGFloat(s.perspH) * e.height * 0.18
            let f = CIFilter.perspectiveTransform(); f.inputImage = img
            f.topLeft = CGPoint(x: e.minX + max(0, dv), y: e.maxY - max(0, -dh))
            f.topRight = CGPoint(x: e.maxX - max(0, dv), y: e.maxY - max(0, dh))
            f.bottomLeft = CGPoint(x: e.minX + max(0, -dv), y: e.minY + max(0, -dh))
            f.bottomRight = CGPoint(x: e.maxX - max(0, -dv), y: e.minY + max(0, dh))
            if let out = f.outputImage {
                // leere Ränder abschneiden, dann auf Ausgangsgröße bringen
                let inset = e.insetBy(dx: abs(dv), dy: abs(dh))
                img = out.cropped(to: inset).transformed(by: CGAffineTransform(translationX: -inset.minX, y: -inset.minY))
                    .transformed(by: CGAffineTransform(scaleX: e.width / inset.width, y: e.height / inset.height))
            }
        }
        if s.straighten != 0 {
            let f = CIFilter.straighten(); f.inputImage = img; f.angle = Float(-s.straighten * .pi / 180)
            img = (f.outputImage ?? img).cropped(to: img.extent)
        }
        return img
    }

    func color(_ input: CIImage, _ s: EditState) -> CIImage {
        var img = input
        let extent = img.extent
        let v = s.value
        // Radien in Pixeln an die Bildgröße koppeln, damit Vorschau (≈1440 px) und Endfassung gleich aussehen
        let k = max(extent.width, extent.height) / 1440

        if v(.exposure) != 0 { let f = CIFilter.exposureAdjust(); f.inputImage = img; f.ev = Float(v(.exposure) * 1.2); img = f.outputImage ?? img }

        // Brillanz hellt Schatten auf und holt Lichter zurück; Glanzlichter ↓ / Schatten über Licht-Schatten-Ausgleich
        let shadow = v(.shadows) * 0.75 + v(.brilliance) * 0.45
        let highlight = 1 - max(0, -v(.highlights)) * 0.9 - max(0, v(.brilliance)) * 0.35
        if shadow != 0 || highlight != 1 {
            let f = CIFilter.highlightShadowAdjust(); f.inputImage = img
            f.shadowAmount = Float(min(1, max(-1, shadow))); f.highlightAmount = Float(min(1, max(0, highlight)))
            img = f.outputImage ?? img
        }

        // Glanzlichter ↑, Brillanz ↓ (Lichter heller) und Schwarzpunkt über eine Tonkurve
        let hlUp = max(0, v(.highlights)) * 0.5 + max(0, -v(.brilliance)) * 0.2, bp = v(.blackPoint) * 0.1
        if hlUp != 0 || bp != 0 {
            func curve(_ x: Double) -> Double {
                var y = bp > 0 ? max(0, (x - bp) / (1 - bp)) : -bp + x * (1 + bp)
                y += hlUp * 4 * y * y * (1 - y)
                return min(1, max(0, y))
            }
            let f = CIFilter.toneCurve(); f.inputImage = img
            let xs = [0, 0.25, 0.5, 0.75, 1.0].map { CGPoint(x: $0, y: curve($0)) }
            f.point0 = xs[0]; f.point1 = xs[1]; f.point2 = xs[2]; f.point3 = xs[3]; f.point4 = xs[4]
            img = f.outputImage ?? img
        }

        // Brillanz ↓ macht kontrastreicher, ↑ etwas flacher – wie bei Apple
        let contrast = v(.contrast) * 0.3 - v(.brilliance) * 0.08
        if contrast != 0 || v(.saturation) != 0 {
            let f = CIFilter.colorControls(); f.inputImage = img
            f.contrast = Float(1 + contrast); f.saturation = Float(1 + v(.saturation))
            img = f.outputImage ?? img
        }
        // Helligkeit wirkt auf die Mitteltöne, nicht als platte Aufhellung
        if v(.brightness) != 0 { let f = CIFilter.gammaAdjust(); f.inputImage = img; f.power = Float(1 - v(.brightness) * 0.4); img = f.outputImage ?? img }
        if v(.vibrance) != 0 { let f = CIFilter.vibrance(); f.inputImage = img; f.amount = Float(v(.vibrance)); img = f.outputImage ?? img }
        if v(.warmth) != 0 || v(.tint) != 0 { img = temperature(img, warm: v(.warmth), tint: v(.tint)) }
        if v(.noiseReduction) > 0 {
            let f = CIFilter.noiseReduction(); f.inputImage = img; f.noiseLevel = Float(v(.noiseReduction) * 0.04); f.sharpness = 0.4
            img = f.outputImage ?? img
        }
        // Auflösung (Definition) = lokaler Kontrast: Unscharfmaske mit großem Radius
        if v(.definition) != 0 {
            let f = CIFilter.unsharpMask(); f.inputImage = img; f.radius = Float(24 * k); f.intensity = Float(v(.definition) * 0.35)
            img = f.outputImage ?? img
        }
        if v(.sharpness) > 0 {
            let f = CIFilter.sharpenLuminance(); f.inputImage = img; f.sharpness = Float(v(.sharpness) * 0.8); f.radius = Float(1.6 * k)
            img = f.outputImage ?? img
        }
        if v(.vignette) != 0 {
            // Vignette folgt dem Bildformat (elliptisch): kurz quadratisch stauchen, abdunkeln, zurückstrecken
            let sx = extent.height / extent.width
            let f = CIFilter.vignette(); f.inputImage = img.transformed(by: CGAffineTransform(scaleX: sx, y: 1))
            f.intensity = Float(v(.vignette) * 1.2); f.radius = 1.4
            img = f.outputImage?.transformed(by: CGAffineTransform(scaleX: 1 / sx, y: 1)) ?? img
        }
        img = photoStyle(img, s)
        if s.filter != .original {
            let filtered = filter(img, s.filter)
            if s.filterAmount >= 0.999 { img = filtered }
            else { let f = CIFilter.dissolveTransition(); f.inputImage = img; f.targetImage = filtered; f.time = Float(s.filterAmount); img = f.outputImage ?? img }
        }
        return img.cropped(to: extent)
    }

    /// Fotografischer Stil: Grundstimmung, dann Ton (Tiefe der Schatten/Kontrast) und Farbe (Sättigung),
    /// Palette blendet die Stilfarben zwischen Original (0) und voll (1).
    func photoStyle(_ input: CIImage, _ s: EditState) -> CIImage {
        guard s.hasStyle else { return input }
        let b = s.style.base
        var img = input
        if b.warm != 0 || b.tint != 0 { img = temperature(img, warm: b.warm, tint: b.tint) }
        let sat = 1 + b.sat + s.styleColor * 0.45
        let con = 1 + b.con + s.styleTone * 0.22
        let cc = CIFilter.colorControls(); cc.inputImage = img; cc.saturation = Float(b.mono ? 0 : max(0, sat)); cc.contrast = Float(con)
        img = cc.outputImage ?? img
        // Ton: negativ hellt Schatten auf (flacher, „ruhig“), positiv vertieft sie
        let lift = b.lift - s.styleTone * 0.25
        if lift != 0 {
            let f = CIFilter.highlightShadowAdjust(); f.inputImage = img
            f.shadowAmount = Float(max(-1, min(1, lift))); f.highlightAmount = 1
            img = f.outputImage ?? img
        }
        if s.styleColor > 0, !b.mono { let v = CIFilter.vibrance(); v.inputImage = img; v.amount = Float(s.styleColor * 0.4); img = v.outputImage ?? img }
        if s.stylePalette < 0.999 {
            let f = CIFilter.dissolveTransition(); f.inputImage = input; f.targetImage = img; f.time = Float(s.stylePalette)
            img = f.outputImage ?? img
        }
        // Größen relativ zur Bildbreite, damit Vorschau und volle Auflösung gleich aussehen
        let ext = input.extent, unit = max(ext.width, ext.height) / 1500
        if abs(s.styleTexture) > 0.005 {
            if s.styleTexture > 0 {   // feiner lokaler Kontrast (Haut, Stoff, Blätter)
                let f = CIFilter.unsharpMask(); f.inputImage = img; f.radius = Float(2.5 * unit); f.intensity = Float(s.styleTexture * 0.9)
                img = f.outputImage ?? img
            } else {                  // weicher: feine Details leicht glätten
                let blur = img.clampedToExtent().applyingGaussianBlur(sigma: 1.6 * unit).cropped(to: ext)
                let f = CIFilter.dissolveTransition(); f.inputImage = img; f.targetImage = blur; f.time = Float(-s.styleTexture * 0.7)
                img = f.outputImage ?? img
            }
        }
        if s.styleGrain > 0.005 {
            // Filmkorn: feste Zufallsstruktur (gleich bei jedem Rendern), grau, per „Weiches Licht“ eingemischt
            let n = CIFilter.randomGenerator().outputImage!
                .transformed(by: CGAffineTransform(scaleX: max(1, unit * 1.2), y: max(1, unit * 1.2)))
                .transformed(by: CGAffineTransform(translationX: ext.minX, y: ext.minY))
            let a = CGFloat(s.styleGrain * 0.55)
            let m = CIFilter.colorMatrix(); m.inputImage = n
            // nur der Rotkanal als Grauwert, um 0,5 zentriert und auf die Stärke gedämpft
            m.rVector = CIVector(x: a, y: 0, z: 0, w: 0); m.gVector = CIVector(x: a, y: 0, z: 0, w: 0); m.bVector = CIVector(x: a, y: 0, z: 0, w: 0)
            m.aVector = CIVector(x: 0, y: 0, z: 0, w: 0); m.biasVector = CIVector(x: 0.5 - a / 2, y: 0.5 - a / 2, z: 0.5 - a / 2, w: 1)
            if let grain = m.outputImage?.cropped(to: ext) {
                let f = CIFilter.softLightBlendMode(); f.inputImage = grain; f.backgroundImage = img
                img = f.outputImage ?? img
            }
        }
        return img.cropped(to: input.extent)
    }

    /// Was „Auto“ vorschlägt – als Werte pro Regler (wie Apple, damit man sie danach verfeinern kann).
    /// Grundlage: Helligkeitsverteilung und Farbsättigung einer 64-px-Verkleinerung.
    func autoValues(for base: CIImage) -> [Adjust: Double] {
        let s = 64 / max(base.extent.width, base.extent.height)
        let small = base.transformed(by: CGAffineTransform(scaleX: s, y: s))
        let w = Int(small.extent.width.rounded(.down)), h = Int(small.extent.height.rounded(.down))
        guard w > 4, h > 4 else { return [:] }
        var px = [UInt8](repeating: 0, count: w * h * 4)
        context.render(small, toBitmap: &px, rowBytes: w * 4,
                       bounds: CGRect(x: small.extent.minX, y: small.extent.minY, width: CGFloat(w), height: CGFloat(h)),
                       format: .RGBA8, colorSpace: CGColorSpace(name: CGColorSpace.sRGB))
        var lum: [Double] = [], sat = 0.0
        lum.reserveCapacity(w * h)
        for i in stride(from: 0, to: px.count, by: 4) {
            let r = Double(px[i]) / 255, g = Double(px[i + 1]) / 255, b = Double(px[i + 2]) / 255
            lum.append(0.2126 * r + 0.7152 * g + 0.0722 * b)
            let mx = max(r, g, b), mn = min(r, g, b)
            sat += mx > 0 ? (mx - mn) / mx : 0
        }
        lum.sort()
        func pct(_ p: Double) -> Double { lum[min(lum.count - 1, Int(Double(lum.count) * p))] }
        let mean = lum.reduce(0, +) / Double(lum.count), meanSat = sat / Double(lum.count)
        let lo = pct(0.02), lo10 = pct(0.10), hi = pct(0.98), spread = hi - lo
        func clamp(_ x: Double, _ a: Double, _ b: Double) -> Double { (min(b, max(a, x)) * 100).rounded() / 100 }

        var out: [Adjust: Double] = [:]
        // Mittelwert in Richtung ≈ 0,46 ziehen (in Blendenstufen, Regler = EV / 1,2)
        out[.exposure] = clamp(log2(pow(0.46 / max(mean, 0.02), 2.2)) / 1.2 * 0.5, -0.5, 0.5)
        out[.brilliance] = spread > 0.75 ? 0.25 : 0.12
        out[.highlights] = hi > 0.94 ? clamp(-(hi - 0.9) * 4, -0.4, 0) : 0
        out[.shadows] = clamp((0.14 - lo10) * 2.5, 0, 0.4)
        out[.contrast] = spread < 0.6 ? clamp((0.6 - spread) * 0.6, 0, 0.25) : 0
        out[.blackPoint] = lo > 0.06 ? clamp(lo * 1.5, 0, 0.3) : 0
        out[.vibrance] = meanSat < 0.3 ? 0.2 : 0.1
        return out.filter { $0.value != 0 }
    }

    private func temperature(_ img: CIImage, warm: Double, tint: Double) -> CIImage {
        let f = CIFilter.temperatureAndTint(); f.inputImage = img
        f.neutral = CIVector(x: 6500, y: 0)
        f.targetNeutral = CIVector(x: 6500 + warm * 2500, y: tint * 60)
        return f.outputImage ?? img
    }

    private func filter(_ img: CIImage, _ p: PhotoFilter) -> CIImage {
        func controls(_ i: CIImage, sat: Double, con: Double) -> CIImage {
            let f = CIFilter.colorControls(); f.inputImage = i; f.saturation = Float(sat); f.contrast = Float(con); return f.outputImage ?? i
        }
        func effect(_ name: String) -> CIImage { CIFilter(name: name, parameters: [kCIInputImageKey: img])?.outputImage ?? img }
        switch p {
        case .original: return img
        case .vivid: return controls(img, sat: 1.25, con: 1.08)
        case .vividWarm: return temperature(controls(img, sat: 1.2, con: 1.08), warm: 0.35, tint: 0)
        case .vividCool: return temperature(controls(img, sat: 1.2, con: 1.08), warm: -0.35, tint: 0)
        case .dramatic: return controls(img, sat: 0.85, con: 1.3)
        case .dramaticWarm: return temperature(controls(img, sat: 0.9, con: 1.3), warm: 0.4, tint: 0)
        case .dramaticCool: return temperature(controls(img, sat: 0.9, con: 1.3), warm: -0.4, tint: 0)
        case .mono: return effect("CIPhotoEffectMono")
        case .silvertone: return effect("CIPhotoEffectTonal")
        case .noir: return effect("CIPhotoEffectNoir")
        }
    }

    func cgImage(_ img: CIImage) -> CGImage? { context.createCGImage(img, from: img.extent) }

    /// Endfassung als JPEG, Metadaten (Datum, Ort, Kamera) vom Original übernommen.
    func jpeg(_ img: CIImage, originalData: Data) -> Data? {
        guard let cg = cgImage(img) else { return nil }
        var props: [CFString: Any] = [:]
        if let src = CGImageSourceCreateWithData(originalData as CFData, nil),
           let p = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any] { props = p }
        props[kCGImagePropertyOrientation] = 1
        if var tiff = props[kCGImagePropertyTIFFDictionary] as? [CFString: Any] { tiff[kCGImagePropertyTIFFOrientation] = 1; props[kCGImagePropertyTIFFDictionary] = tiff }
        props[kCGImagePropertyPixelWidth] = cg.width; props[kCGImagePropertyPixelHeight] = cg.height
        props[kCGImageDestinationLossyCompressionQuality] = 0.92
        let out = NSMutableData()
        guard let dst = CGImageDestinationCreateWithData(out, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(dst, cg, props as CFDictionary)
        return CGImageDestinationFinalize(dst) ? out as Data : nil
    }
}

/// „Bearbeitungen kopieren / einsetzen“ wie Fotos (REA: PUPhotoEditCopyEdits / PastingEdits): nur Licht, Farbe,
/// Filter und Stil wandern mit – Zuschnitt, Markierungen, Bereinigen, Schlüsselbild und Tiefe gehören zum einzelnen Foto.
enum EditClipboard {
    private static let key = "edit.clipboard"

    static var current: EditState? {
        UserDefaults.standard.data(forKey: key).flatMap { try? JSONDecoder().decode(EditState.self, from: $0) }
    }
    static var hasEdits: Bool { current != nil }

    /// Nur die übertragbaren Teile merken; false = nichts Übertragbares (nur Zuschnitt o. Ä.).
    @discardableResult
    static func copy(_ s: EditState) -> Bool {
        var c = EditState()
        c.values = s.values; c.auto = s.auto; c.autoStrength = s.autoStrength; c.disabled = s.disabled
        c.filter = s.filter; c.filterAmount = s.filterAmount
        c.style = s.style; c.styleTone = s.styleTone; c.styleColor = s.styleColor; c.stylePalette = s.stylePalette
        c.styleTexture = s.styleTexture; c.styleGrain = s.styleGrain
        c.curves = s.curves; c.levels = s.levels; c.selective = s.selective
        guard c.hasColor || c.auto else { return false }
        UserDefaults.standard.set(try? JSONEncoder().encode(c), forKey: key)
        return true
    }

    /// Übertragbare Teile in `s` übernehmen; Auto rechnet für das Zielbild neu.
    static func apply(_ c: EditState, to s: inout EditState, autoValues: () -> [Adjust: Double]) {
        s.values = c.values; s.auto = c.auto; s.autoStrength = c.autoStrength; s.disabled = c.disabled
        s.filter = c.filter; s.filterAmount = c.filterAmount
        s.style = c.style; s.styleTone = c.styleTone; s.styleColor = c.styleColor; s.stylePalette = c.stylePalette
        s.styleTexture = c.styleTexture; s.styleGrain = c.styleGrain
        s.curves = c.curves; s.levels = c.levels; s.selective = c.selective
        s.autoValues = c.auto ? autoValues() : [:]
    }

    /// Einsetzen auf mehrere Fotos: jedes wird wie im Editor gerechnet und als bearbeitete Fassung gestapelt.
    @MainActor
    static func paste(on assets: [Asset], app: AppModel, timeline: TimelineStore) async {
        guard let clip = current else { return }
        let photos = assets.filter(\.isImage)
        var done = 0
        for (i, a) in photos.enumerated() {
            app.busy = photos.count == 1 ? String(localized: "Bearbeitungen werden eingesetzt …") : String(localized: "Bearbeitungen einsetzen … \(i + 1) von \(photos.count)")
            let session = EditSession(asset: a)
            await session.load()
            guard session.error == nil, let base = session.base else { continue }
            EditClipboard.apply(clip, to: &session.state) { session.renderer.autoValues(for: base) }
            if (try? await session.save()) != nil { done += 1 }
        }
        app.busy = nil
        await timeline.reload()
        app.toast(done == 0 ? String(localized: "Bearbeitungen konnten nicht eingesetzt werden")
                  : done == 1 ? String(localized: "Bearbeitungen eingesetzt") : String(localized: "Bearbeitungen auf \(done) Fotos eingesetzt"))
    }

    /// „Bearbeitungen kopieren“ aus Mediathek/Einzelansicht: gespeicherten Stand des Fotos holen.
    @MainActor
    static func copy(from a: Asset, app: AppModel) async {
        let session = EditSession(asset: a)
        await session.load()
        app.toast(copy(session.state) ? String(localized: "Bearbeitungen kopiert") : String(localized: "Dieses Foto hat keine Licht- oder Farbbearbeitungen"))
    }
}

/// Lädt, merkt sich Herkunft (Server-Zuschnitt oder gestapelte Fassung) und sichert.
@MainActor @Observable
final class EditSession {
    let asset: Asset
    var state = EditState()
    var initial = EditState()
    var base: CIImage?            // unbearbeitete Vorschau (≈1440 px)
    var preview: UIImage?         // gerenderte Vorschau
    var fullPreview: UIImage?     // ganzes Bild ohne Zuschnitt (Zuschneiden-Ansicht)
    var filterThumbs: [PhotoFilter: UIImage] = [:]
    var styleThumbs: [PhotoStyle: UIImage] = [:]
    /// Tiefenkarte (Porträtfotos) – dann gibt es die Blende
    private(set) var disparity: DepthMaps?
    var hasDepth: Bool { disparity != nil }
    /// Porträtlicht braucht die Personen-Maske (Bühne/High-Key stellen die Person frei)
    var hasMatte: Bool { disparity?.matte != nil }
    /// Live Photo: Standbilder des Videos (Auswahlleiste) und Länge
    var liveFrames: [UIImage] = []
    var liveDuration: Double = 0
    private var liveFile: URL?
    /// unbearbeitete Vorschau des Originalfotos (wenn ein anderes Schlüsselbild gewählt ist, liegt in `base` das Videobild)
    private var photoBase: CIImage?
    /// Ausgangsbild vor dem Bereinigen (Foto oder gewähltes Schlüsselbild) und Ergebnisse je Anzahl Striche
    private var sourceBase: CIImage?
    private var cleaned: [Int: CIImage] = [:]
    var cleaning = false
    var cleanError: String?
    /// unbearbeitetes (aber bereinigtes) Bild für die Bereinigen-Ansicht
    var cleanupPreview: UIImage?
    var loading = true
    var saving = false
    var error: String?
    /// Ist das gezeigte Objekt eine bearbeitete Fassung? Dann ID des Originals.
    private(set) var originalID: String
    private(set) var isCopy = false
    private var stackID: String?
    private var hadServerEdits = false
    let renderer = EditRenderer()

    init(asset: Asset) { self.asset = asset; originalID = asset.id }

    var canRestore: Bool { isCopy || hadServerEdits }
    var changed: Bool { state != initial }

    func load() async {
        let api = ImmichClient.shared
        if let meta = await api.metadata(asset.id, key: "fotos.edit"), let orig = meta["originalId"] as? String {
            originalID = orig; isCopy = true
            if let js = meta["state"] as? String, let d = js.data(using: .utf8), let s = try? JSONDecoder().decode(EditState.self, from: d) { state = s }
            stackID = (try? await api.asset(asset.id))?.stack?.id
        }
        guard let url = try? api.url("assets/\(originalID)/thumbnail", query: ["size": "preview", "edited": "false"]),
              let data = try? await api.data(url), let ci = CIImage(data: data, options: [.applyOrientationProperty: true]) else {
            error = String(localized: "Bild konnte nicht geladen werden"); loading = false; return
        }
        base = ci; sourceBase = ci
        if !isCopy, let edits = try? await serverEdits(), !edits.isEmpty {
            hadServerEdits = true
            state = edits.toState(imageSize: await originalPixelSize(ci))
        }
        // ältere Bearbeitungen kannten nur „Auto an/aus“ ohne Einzelwerte
        if state.auto && state.autoValues.isEmpty { state.autoValues = renderer.autoValues(for: ci) }
        initial = state
        loading = false
        await render()
        await renderFilterThumbs()
        await renderStyleThumbs()
        await loadDepth()
        await loadLive()
    }

    /// Live-Video einmal laden: Leiste mit Standbildern fürs Schlüsselbild (wie Apple PXLivePhotoTrimScrubber).
    private func loadLive() async {
        guard let v = asset.livePhotoVideoId, let f = await LiveClip.file(v) else { return }
        liveFile = f
        let av = AVURLAsset(url: f)
        liveDuration = (try? await av.load(.duration).seconds) ?? 0
        let gen = AVAssetImageGenerator(asset: av); gen.appliesPreferredTrackTransform = true
        gen.maximumSize = CGSize(width: 120, height: 120)
        let n = 14
        let times = (0..<n).map { CMTime(seconds: liveDuration * (Double($0) + 0.5) / Double(n), preferredTimescale: 600) }
        var out: [UIImage] = []
        for await r in gen.images(for: times) { if let cg = try? r.image { out.append(UIImage(cgImage: cg)) } }
        liveFrames = out
        if let k = state.keyFrame { await useKeyFrame(k) }
    }

    /// Bereinigen anwenden (alle Striche auf einmal, Ergebnis je Stand gemerkt → Widerrufen ist sofort da).
    func applyCleanup() async {
        guard let src = sourceBase else { return }
        let strokes = state.cleanup
        if strokes.isEmpty { base = src }
        else if let c = cleaned[strokes.count], cleanedFor[strokes.count] == strokes { base = c }
        else {
            cleaning = true; defer { cleaning = false }
            cleanError = nil
            if let out = await Self.serverClean(src, strokes, renderer) { cleaned[strokes.count] = out; cleanedFor[strokes.count] = strokes; base = out }
            else { cleanError = String(localized: "Bereinigen nicht erreichbar – läuft der Server?"); state.cleanup.removeLast() ; return }
        }
        if let b = base, let cg = renderer.cgImage(b) { cleanupPreview = UIImage(cgImage: cg) }
        await render()
    }
    private var cleanedFor: [Int: [CleanStroke]] = [:]

    /// Bild + Maske an den Bereinigen-Dienst (Port 2285 neben Immich).
    nonisolated static func serverClean(_ img: CIImage, _ strokes: [CleanStroke], _ r: EditRenderer) async -> CIImage? {
        let size = img.extent.size
        guard let cg = r.cgImage(img), let jpg = UIImage(cgImage: cg).jpegData(compressionQuality: 0.95),
              let mask = CleanMask.png(strokes, size: size),
              let data = await ImmichClient.shared.cleanup(image: jpg, mask: mask) else { return nil }
        return CIImage(data: data)
    }

    /// Bild aus dem Live-Video in voller Videoauflösung (nil = Sekunde fehlt).
    func liveFrame(at t: Double, preview: Bool) async -> CIImage? {
        guard let f = liveFile else { return nil }
        let gen = AVAssetImageGenerator(asset: AVURLAsset(url: f)); gen.appliesPreferredTrackTransform = true
        gen.requestedTimeToleranceBefore = .zero; gen.requestedTimeToleranceAfter = .zero
        if preview { gen.maximumSize = CGSize(width: 1440, height: 1440) }
        guard let cg = try? await gen.image(at: CMTime(seconds: t, preferredTimescale: 600)).image else { return nil }
        return CIImage(cgImage: cg)
    }

    /// Schlüsselbild setzen (nil = zurück zum Foto) – Vorschau rechnet ab jetzt mit diesem Bild.
    func useKeyFrame(_ t: Double?) async {
        if photoBase == nil { photoBase = base }
        if let t, let img = await liveFrame(at: t, preview: true) { sourceBase = img } else { sourceBase = photoBase }
        state.keyFrame = t
        cleaned = [:]
        await applyCleanup()
    }

    /// Porträtfotos haben im Original eine Tiefenkarte (HEIC) – nur dann zeigt der Editor die Blende.
    private func loadDepth() async {
        guard asset.isImage, let url = ImmichClient.shared.originalURL(originalID, edited: false),
              let data = try? await ImmichClient.shared.data(url) else { return }
        disparity = await Task.detached(priority: .utility) { DepthMaps(data: data) }.value
    }

    /// Automatisch begradigen wie Apple (_suggestedStraightenAngle): Horizont mit Vision erkennen.
    func suggestedStraighten() async -> Double? {
        guard let base, let cg = renderer.cgImage(base) else { return nil }
        return await Task.detached(priority: .userInitiated) { () -> Double? in
            let req = VNDetectHorizonRequest()
            try? VNImageRequestHandler(cgImage: cg).perform([req])
            guard let a = req.results?.first?.angle else { return nil }
            let deg = Double(a) * 180 / .pi
            return abs(deg) < 0.3 || abs(deg) > 30 ? nil : (deg * 10).rounded() / 10
        }.value
    }

    func renderStyleThumbs() async {
        guard let base else { return }
        let small = base.transformed(by: CGAffineTransform(scaleX: 160 / base.extent.width, y: 160 / base.extent.width))
        let r = renderer
        for st in PhotoStyle.allCases {
            var s = EditState(); s.style = st
            let cg = await Task.detached { r.cgImage(r.apply(small, s)) }.value
            if let cg { styleThumbs[st] = UIImage(cgImage: cg) }
        }
    }

    /// Auto an/aus. Beim ersten Einschalten werden die Vorschläge fürs Bild berechnet.
    func toggleAuto() {
        if !state.auto, state.autoValues.isEmpty, let base { state.autoValues = renderer.autoValues(for: base) }
        state.auto.toggle()
    }

    func render() async {
        guard let base else { return }
        let s = state, r = renderer, d = disparity
        let (a, b) = await Task.detached(priority: .userInitiated) { () -> (CGImage?, CGImage?) in
            (r.cgImage(r.apply(base, s, disparity: d)), r.cgImage(r.apply(base, s, crop: false, disparity: d)))
        }.value
        if let a { preview = UIImage(cgImage: a) }
        if let b { fullPreview = UIImage(cgImage: b) }
    }

    func renderFilterThumbs() async {
        guard let base else { return }
        let small = base.transformed(by: CGAffineTransform(scaleX: 200 / base.extent.width, y: 200 / base.extent.width))
        let r = renderer
        for f in PhotoFilter.allCases {
            var s = state; s.filter = f
            let cg = await Task.detached { r.cgImage(r.apply(small, s)) }.value
            if let cg { filterThumbs[f] = UIImage(cgImage: cg) }
        }
    }

    // MARK: Sichern

    /// Gibt das Objekt zurück, das danach angezeigt werden soll.
    func save() async throws -> Asset {
        saving = true; defer { saving = false }
        let api = ImmichClient.shared
        if !state.hasColor && !isCopy {
            // Nur Geometrie → der Server bearbeitet nicht-destruktiv (gleiche ID).
            let oldHash = try? await api.asset(asset.id).thumbhash
            if state.hasGeometry {
                let size = await originalPixelSize(base!)
                try await api.setEdits(asset.id, state.serverEdits(size: size))
                try? await api.tag([asset.id], with: "Kategorie/Bearbeitet")
            } else if hadServerEdits {
                try await api.removeEdits(asset.id)
            }
            await waitForPreview(asset.id, oldHash: oldHash ?? nil)
            ImageCache.shared.bump(asset.id)
            return ((try? await api.asset(asset.id))?.asset) ?? asset
        }
        if state.isIdentity { return try await restore() }
        // Licht/Farbe → volle Auflösung rechnen, als neue Fassung hochladen und mit dem Original stapeln.
        guard let ourl = api.originalURL(originalID, edited: false) else { throw APIError.badURL }
        let data = try await api.data(ourl)
        let s = state, r = renderer
        let key = s.keyFrame == nil ? nil : await liveFrame(at: s.keyFrame!, preview: false)
        var cleanedFull: CIImage?
        if !s.cleanup.isEmpty, let src = key ?? CIImage(data: data, options: [.applyOrientationProperty: true]) {
            cleanedFull = await Self.serverClean(src, s.cleanup, r)
            if cleanedFull == nil { throw APIError.http(0, String(localized: "Bereinigen in voller Auflösung fehlgeschlagen")) }
        }
        let jpeg = await Task.detached(priority: .userInitiated) { () -> Data? in
            guard let full = cleanedFull ?? key ?? CIImage(data: data, options: [.applyOrientationProperty: true]) else { return nil }
            let depth = s.hasPortrait ? DepthMaps(data: data) : nil
            return r.jpeg(r.apply(full, s, disparity: depth), originalData: data)
        }.value
        guard let jpeg else { throw APIError.http(0, String(localized: "Bild konnte nicht berechnet werden")) }
        let orig = try await api.asset(originalID)
        let name = ((orig.originalFileName ?? "IMG") as NSString).deletingPathExtension + Category.editedSuffix + ".jpg"
        let newID = try await api.upload(jpeg, filename: name, created: orig.fileCreatedAt)
        Self.keepCaptureTime(newID, of: orig)
        if isCopy { try await dropCopy() }
        if hadServerEdits { try? await api.removeEdits(originalID) }
        let stateJSON = String(data: try JSONEncoder().encode(state), encoding: .utf8) ?? "{}"
        try await api.setMetadata(newID, key: "fotos.edit", value: ["originalId": originalID, "state": stateJSON])
        try? await api.createStack([newID, originalID])
        try? await api.tag([newID], with: "Kategorie/Bearbeitet")
        if !state.cleanup.isEmpty { try? await api.tag([newID], with: "Kategorie/Bereinigt") }
        if asset.isFavorite { try? await api.setFavorite(newID, true) }
        // Der Server liest Datum/Ort erst nach ein paar Sekunden aus → Werte vom Original übernehmen.
        let r0 = base.map { $0.extent.width / $0.extent.height } ?? asset.ratio
        let cropped = r0 * state.crop.width / state.crop.height
        let ratio = state.angle % 180 == 0 ? cropped : 1 / cropped
        return Asset(id: newID, isImage: true, isFavorite: asset.isFavorite, date: asset.date, ratio: ratio,
                     durationMs: nil, livePhotoVideoId: nil, city: asset.city, country: asset.country)
    }

    /// Aufnahmezeit des Originals mit Zeitzone übernehmen (wie beim Kürzen von Videos). Sonst gilt `fileCreatedAt`
    /// (UTC), wenn die Datei selbst keine Zeitzone trägt (Bildschirmfotos, PNG, iCloud-Importe) → Uhrzeit verschoben.
    /// Setzen + prüfen übernimmt `setCaptureTime` (der Server liest die Datei erst nach dem Hochladen aus).
    private static func keepCaptureTime(_ id: String, of orig: AssetDTO) {
        guard let when = orig.captureTimeWithZone else { return }
        ImmichClient.shared.setCaptureTime(id, when)
    }

    /// Der Server rechnet die neue Vorschau im Hintergrund – warten, bis sich ihr Fingerabdruck (Thumbhash) ändert.
    private func waitForPreview(_ id: String, oldHash: String?) async {
        for _ in 0..<20 {
            if let dto = try? await ImmichClient.shared.asset(id), dto.thumbhash != oldHash { return }
            try? await Task.sleep(for: .milliseconds(750))
        }
    }

    /// „Als Duplikat sichern“ – neue, eigenständige Datei; das Original bleibt unverändert.
    func saveAsDuplicate() async throws -> Asset {
        saving = true; defer { saving = false }
        let api = ImmichClient.shared
        guard let ourl = api.originalURL(originalID, edited: false) else { throw APIError.badURL }
        let data = try await api.data(ourl)
        let s = state, r = renderer
        let key = s.keyFrame == nil ? nil : await liveFrame(at: s.keyFrame!, preview: false)
        var cleanedFull: CIImage?
        if !s.cleanup.isEmpty, let src = key ?? CIImage(data: data, options: [.applyOrientationProperty: true]) {
            cleanedFull = await Self.serverClean(src, s.cleanup, r)
            if cleanedFull == nil { throw APIError.http(0, String(localized: "Bereinigen in voller Auflösung fehlgeschlagen")) }
        }
        let jpeg = await Task.detached(priority: .userInitiated) { () -> Data? in
            guard let full = cleanedFull ?? key ?? CIImage(data: data, options: [.applyOrientationProperty: true]) else { return nil }
            let depth = s.hasPortrait ? DepthMaps(data: data) : nil
            return r.jpeg(r.apply(full, s, disparity: depth), originalData: data)
        }.value
        guard let jpeg else { throw APIError.http(0, String(localized: "Bild konnte nicht berechnet werden")) }
        let orig = try await api.asset(originalID)
        let name = ((orig.originalFileName ?? "IMG") as NSString).deletingPathExtension + "_kopie.jpg"
        let id = try await api.upload(jpeg, filename: name, created: orig.fileCreatedAt)
        Self.keepCaptureTime(id, of: orig)
        try? await api.tag([id], with: "Kategorie/Bearbeitet")
        return try await api.asset(id).asset
    }

    // „Änderungen kopieren/einsetzen“ – bleibt bis zum nächsten Kopieren gespeichert
    static var copiedEdits: EditState? {
        guard let d = UserDefaults.standard.data(forKey: "copiedEdits") else { return nil }
        return try? JSONDecoder().decode(EditState.self, from: d)
    }
    static func copyEdits(_ s: EditState) {
        UserDefaults.standard.set(try? JSONEncoder().encode(s), forKey: "copiedEdits")
    }

    /// „Original wiederherstellen“
    func restore() async throws -> Asset {
        let api = ImmichClient.shared
        if isCopy { try await dropCopy() }
        if hadServerEdits || !isCopy {
            let oldHash = try? await api.asset(originalID).thumbhash
            try? await api.removeEdits(originalID)
            await waitForPreview(originalID, oldHash: oldHash ?? nil)
        }
        ImageCache.shared.bump(originalID)
        return try await api.asset(originalID).asset
    }

    private func dropCopy() async throws {
        let api = ImmichClient.shared
        if let stackID { try? await api.raw("stacks/\(stackID)", method: "DELETE") }
        try await api.trash([asset.id])
    }

    private func serverEdits() async throws -> [ServerEdit] {
        let d = try await ImmichClient.shared.raw("assets/\(asset.id)/edits")
        return (try JSONDecoder().decode(ServerEditsDTO.self, from: d)).edits
    }

    /// Pixelgröße des Originals (Server-Zuschnitt rechnet in Original-Pixeln).
    private func originalPixelSize(_ preview: CIImage) async -> CGSize {
        let dto = try? await ImmichClient.shared.asset(originalID)
        let long = max(dto?.exifInfo?.exifImageWidth ?? 0, dto?.exifInfo?.exifImageHeight ?? 0)
        let w = preview.extent.width, h = preview.extent.height
        guard long > 0 else { return CGSize(width: w, height: h) }
        return w >= h ? CGSize(width: long, height: (long * h / w).rounded()) : CGSize(width: (long * w / h).rounded(), height: long)
    }
}

// MARK: - Server-Bearbeitungen (crop/rotate/mirror)

struct ServerEditsDTO: Decodable { let edits: [ServerEdit] }
struct ServerEdit: Decodable {
    let action: String
    let parameters: Params
    struct Params: Decodable { let x: Double?; let y: Double?; let width: Double?; let height: Double?; let angle: Int?; let axis: String? }
}

extension Array where Element == ServerEdit {
    func toState(imageSize: CGSize) -> EditState {
        var s = EditState()
        for e in self {
            switch e.action {
            case "crop":
                let p = e.parameters
                s.crop = CGRect(x: (p.x ?? 0) / imageSize.width, y: (p.y ?? 0) / imageSize.height,
                                width: (p.width ?? imageSize.width) / imageSize.width, height: (p.height ?? imageSize.height) / imageSize.height)
            case "rotate": s.angle = e.parameters.angle ?? 0
            case "mirror": s.mirrored = true
            default: break
            }
        }
        return s
    }
}

extension EditState {
    /// Reihenfolge wie vom Server verlangt: Zuschnitt zuerst.
    func serverEdits(size: CGSize) -> [[String: Any]] {
        var out: [[String: Any]] = []
        if !crop.isApprox(Self.unit) {
            out.append(["action": "crop", "parameters": [
                "x": Int((crop.minX * size.width).rounded()), "y": Int((crop.minY * size.height).rounded()),
                "width": max(1, Int((crop.width * size.width).rounded())), "height": max(1, Int((crop.height * size.height).rounded()))]])
        }
        if angle % 360 != 0 { out.append(["action": "rotate", "parameters": ["angle": angle % 360]]) }
        if mirrored { out.append(["action": "mirror", "parameters": ["axis": "horizontal"]]) }
        return out
    }
}
