import SwiftUI
import CoreImage
import CoreMotion
import Vision

/// „Räumliche Szene“ wie Apple (PhotosSpatialMedia: GyroCameraAnimator): Vordergrund (Person laut Tiefenkarte/Matte)
/// und Hintergrund bewegen sich beim Neigen des iPhones unterschiedlich weit – das Foto wirkt räumlich.
/// Ohne Lagesensor (Simulator) neigt man mit dem Finger.
struct SpatialSceneView: View {
    let layers: SpatialLayers
    let close: () -> Void
    @State private var tilt: CGSize = .zero          // −1 … 1
    @State private var motion = CMMotionManager()
    @State private var reference: CMAttitude?
    /// sauberer Hintergrund vom Server (LaMa, wie Apples generatives Füllen) – kommt nach ein paar Sekunden
    @State private var cleanBackground: UIImage?

    var body: some View {
        GeometryReader { geo in
            let shift = min(geo.size.width, geo.size.height) * 0.045
            ZStack {
                Color.black.ignoresSafeArea()
                // wie Apple: das Motiv bleibt fast stehen, der Hintergrund wandert dahinter – man schaut „um“ die Person herum
                // (vorher bewegten sich beide gegeneinander, dadurch rutschte die Person sichtbar hin und her)
                // Tiefenstufen: je weiter weg, desto weiter wandert es – Nahes (z. B. der Stein, auf dem jemand sitzt)
                // bleibt beim Motiv, statt mit dem fernen Hintergrund unter ihm wegzurutschen
                ZStack {
                    Image(uiImage: cleanBackground ?? layers.background).resizable().aspectRatio(contentMode: .fit)
                        .scaleEffect(1.12)
                        .offset(x: -tilt.width * shift, y: -tilt.height * shift)
                    ForEach(Array(layers.bands.enumerated()), id: \.offset) { _, b in
                        if b.far >= 0 { band(b, shift) }
                    }
                    Image(uiImage: layers.foreground).resizable().aspectRatio(contentMode: .fit)
                        .scaleEffect(1.12)
                        .shadow(color: .black.opacity(0.25), radius: 8)
                    // was näher ist als das Motiv, liegt davor und wandert in die Gegenrichtung (Drehpunkt = Motiv, wie Apple)
                    ForEach(Array(layers.bands.enumerated()), id: \.offset) { _, b in
                        if b.far < 0 { band(b, shift) }
                    }
                }
                .rotation3DEffect(.degrees(Double(tilt.width) * 4), axis: (x: 0, y: 1, z: 0), perspective: 0.5)
                .rotation3DEffect(.degrees(Double(-tilt.height) * 4), axis: (x: 1, y: 0, z: 0), perspective: 0.5)
            }
            .frame(width: geo.size.width, height: geo.size.height)
            .clipped()
            .contentShape(Rectangle())
            .gesture(DragGesture(minimumDistance: 0)
                .onChanged { v in
                    tilt = CGSize(width: max(-1, min(1, v.translation.width / 150)), height: max(-1, min(1, v.translation.height / 150)))
                }
                .onEnded { _ in withAnimation(.spring(duration: 0.6)) { tilt = .zero } })
        }
        .overlay(alignment: .topLeading) {
            Button(action: close) {
                Image(systemName: "xmark").font(.system(size: 18, weight: .semibold)).foregroundStyle(.white).frame(width: 46, height: 46).contentShape(.rect)
            }
            .glassEffect(.regular.interactive(), in: .circle)
            .padding(.leading, 16).padding(.top, 8)
            .accessibilityLabel(String(localized: "Schließen"))
        }
        .overlay(alignment: .bottom) {
            Text(motion.isDeviceMotionAvailable ? String(localized: "iPhone neigen") : String(localized: "Zum Neigen ziehen"))
                .font(.footnote).foregroundStyle(.secondary).padding(.bottom, 30)
        }
        .onAppear(perform: startMotion)
        .task {
            guard let png = layers.maskPNG, let jpg = layers.sourceJPEG,
                  let d = await ImmichClient.shared.cleanup(image: jpg, mask: png), let img = UIImage(data: d) else { return }
            withAnimation(.easeInOut(duration: 0.4)) { cleanBackground = img }
        }
        .onDisappear { motion.stopDeviceMotionUpdates() }
        .statusBarHidden()
    }

    private func band(_ b: (image: UIImage, far: CGFloat), _ shift: CGFloat) -> some View {
        Image(uiImage: b.image).resizable().aspectRatio(contentMode: .fit)
            .scaleEffect(1.12)
            .offset(x: -tilt.width * shift * b.far, y: -tilt.height * shift * b.far)
    }

    private func startMotion() {
        guard motion.isDeviceMotionAvailable else { return }
        motion.deviceMotionUpdateInterval = 1 / 60
        motion.startDeviceMotionUpdates(to: .main) { m, _ in
            guard let m else { return }
            if reference == nil { reference = m.attitude.copy() as? CMAttitude }
            let a = m.attitude.copy() as! CMAttitude
            if let r = reference { a.multiply(byInverseOf: r) }
            // ±20° Neigung = voller Ausschlag; geglättet, sonst zittert das Bild mit der Hand
            let t = CGSize(width: max(-1, min(1, a.roll / 0.35)), height: max(-1, min(1, a.pitch / 0.35)))
            tilt = CGSize(width: tilt.width * 0.8 + t.width * 0.2, height: tilt.height * 0.8 + t.height * 0.2)
        }
    }
}

/// Vorder- und Hintergrund aus Foto + Tiefenkarte (nah = Vordergrund, weicher Übergang an den Kanten).
struct SpatialLayers {
    /// Motiv-Maske aus Vision (weiß = Motiv), als Graubild. nil, wenn Vision nichts findet.
    static func subjectMask(_ image: CIImage) -> CIImage? {
        let h = VNImageRequestHandler(ciImage: image)
        var raw: CIImage?
        let fg = VNGenerateForegroundInstanceMaskRequest()
        if (try? h.perform([fg])) != nil, let o = fg.results?.first, !o.allInstances.isEmpty,
           let pb = try? o.generateScaledMaskForImage(forInstances: o.allInstances, from: h) {
            raw = CIImage(cvPixelBuffer: pb)
        } else {
            let p = VNGeneratePersonSegmentationRequest(); p.qualityLevel = .accurate
            if (try? h.perform([p])) != nil, let pb = p.results?.first?.pixelBuffer { raw = CIImage(cvPixelBuffer: pb) }
        }
        guard let raw else { return nil }
        // einkanalig → grau (Rot in alle Kanäle), damit Weichzeichnen, Umkehren und Mischen wie bei der Matte arbeiten
        let one = CIVector(x: 1, y: 0, z: 0, w: 0)
        return raw.applyingFilter("CIColorMatrix", parameters: ["inputRVector": one, "inputGVector": one, "inputBVector": one,
                                                                "inputAVector": CIVector(x: 0, y: 0, z: 0, w: 0),
                                                                "inputBiasVector": CIVector(x: 0, y: 0, z: 0, w: 1)])
            .cropped(to: raw.extent)
    }

    let foreground: UIImage
    let background: UIImage
    /// Tiefenstufen (von fern nach nah), `far` = Anteil der Hintergrund-Bewegung; negativ = vor dem Motiv, Gegenrichtung
    var bands: [(image: UIImage, far: CGFloat)] = []
    /// für das Füllen auf dem Server: Foto (JPEG) und Motiv-Maske (weiß = entfernen)
    var sourceJPEG: Data? = nil
    var maskPNG: Data? = nil

    static func make(image: CIImage, depth: DepthMaps) -> SpatialLayers? {
        let e = image.extent
        let ctx = CIContext()
        // Spanne der Disparität (groß = nah)
        let d = depth.disparity
        var mm = [Float](repeating: 0, count: 4)
        let minMax = d.applyingFilter("CIAreaMinMaxRed", parameters: [kCIInputExtentKey: CIVector(cgRect: d.extent)])
        ctx.render(minMax, toBitmap: &mm, rowBytes: 16, bounds: CGRect(x: minMax.extent.minX, y: minMax.extent.minY, width: 1, height: 1),
                   format: .RGBAf, colorSpace: nil)
        let lo = Double(min(mm[0], mm[1])), hi = Double(max(mm[0], mm[1]))
        var mask: CIImage
        // 1. wie Apple („Motiv freistellen“): ganze Person samt Kleidung, auch dunkle Stellen.
        //    Die Porträt-Maske des iPhones erfasst bei manchen Fotos nur Haut (Gesicht, Hände) – dann rutschte der Körper
        //    mit dem Hintergrund mit, statt davor zu stehen.
        if let subject = subjectMask(image) {
            mask = EditRenderer.fit(subject, to: e)
        } else if let matte = depth.matte {
            mask = EditRenderer.fit(matte, to: e)
        } else {
            // Disparität: die nächsten 40 % der Spanne gelten als Vordergrund
            guard hi - lo > 0.001 else { return nil }
            let cut = hi - (hi - lo) * 0.4, k = 1 / max(0.001, (hi - lo) * 0.1)
            mask = EditRenderer.fit(d.applyingFilter("CIColorMatrix", parameters: [
                "inputRVector": CIVector(x: k, y: 0, z: 0, w: 0), "inputGVector": CIVector(x: k, y: 0, z: 0, w: 0),
                "inputBVector": CIVector(x: k, y: 0, z: 0, w: 0), "inputAVector": CIVector(x: 0, y: 0, z: 0, w: 0),
                "inputBiasVector": CIVector(x: -cut * k, y: -cut * k, z: -cut * k, w: 1)]).applyingFilter("CIColorClamp")
                .cropped(to: d.extent), to: e)
        }
        mask = mask.clampedToExtent().applyingFilter("CIGaussianBlur", parameters: [kCIInputRadiusKey: e.width / 300]).cropped(to: e)
        let fg = image.applyingFilter("CIBlendWithMask", parameters: [kCIInputBackgroundImageKey: CIImage.empty().cropped(to: e),
                                                                      kCIInputMaskImageKey: mask])
        // Hintergrund: Lücke hinter dem Motiv mit weichgezeichnetem Umfeld füllen, damit beim Verschieben nichts doppelt wirkt
        // nur aus dem Umfeld OHNE Motiv mitteln (normierte Unschärfe: blur(Bild·Rest) / blur(Rest)), sonst bleibt ein Geist
        let grow = mask.applyingFilter("CIMorphologyMaximum", parameters: [kCIInputRadiusKey: e.width / 50]).cropped(to: e)
        let rest = grow.applyingFilter("CIColorInvert")
        let r = e.width / 18
        let num = image.applyingFilter("CIMultiplyCompositing", parameters: [kCIInputBackgroundImageKey: rest])
            .clampedToExtent().applyingFilter("CIGaussianBlur", parameters: [kCIInputRadiusKey: r]).cropped(to: e)
        let den = rest.clampedToExtent().applyingFilter("CIGaussianBlur", parameters: [kCIInputRadiusKey: r]).cropped(to: e)
            .applyingFilter("CIColorClamp", parameters: ["inputMinComponents": CIVector(x: 0.02, y: 0.02, z: 0.02, w: 1)])
        let fill = den.applyingFilter("CIDivideBlendMode", parameters: [kCIInputBackgroundImageKey: num])
        let bg = fill.applyingFilter("CIBlendWithMask", parameters: [kCIInputBackgroundImageKey: image, kCIInputMaskImageKey: grow])
        guard let f = ctx.createCGImage(fg, from: e, format: .RGBA8, colorSpace: CGColorSpace(name: CGColorSpace.sRGB)),
              let b = ctx.createCGImage(bg, from: e) else { return nil }
        // Tiefenstufen wie Apple (PhotosSpatialMediaCore: pivotPointDepth = Tiefe des Motivs): Das Motiv ist der Drehpunkt.
        // Alles auf seiner Tiefe (z. B. der Stein, auf dem jemand sitzt) bleibt mit ihm stehen, Fernes wandert mit dem
        // Hintergrund, Näheres davor in die Gegenrichtung.
        var bands: [(image: UIImage, far: CGFloat)] = []
        if hi - lo > 0.001 {
            let span = hi - lo, k = 1 / 0.08
            // „fern“ 0 (nah) … 1 (fern), auf Bildgröße
            let farImg = EditRenderer.fit(d.applyingFilter("CIColorMatrix", parameters: [
                "inputRVector": CIVector(x: -1 / span, y: 0, z: 0, w: 0), "inputGVector": CIVector(x: -1 / span, y: 0, z: 0, w: 0),
                "inputBVector": CIVector(x: -1 / span, y: 0, z: 0, w: 0), "inputAVector": CIVector(x: 0, y: 0, z: 0, w: 0),
                "inputBiasVector": CIVector(x: 1 + lo / span, y: 1 + lo / span, z: 1 + lo / span, w: 1)])
                .applyingFilter("CIColorClamp").cropped(to: d.extent), to: e)
            // Tiefe des Motivs = mittleres „fern“ unter der Maske
            func avg(_ i: CIImage) -> Double {
                var px = [Float](repeating: 0, count: 4)
                let a = i.applyingFilter("CIAreaAverage", parameters: [kCIInputExtentKey: CIVector(cgRect: e)])
                ctx.render(a, toBitmap: &px, rowBytes: 16, bounds: CGRect(x: 0, y: 0, width: 1, height: 1), format: .RGBAf, colorSpace: nil)
                return Double(px[0])
            }
            let mAvg = avg(mask)
            let fs = mAvg > 0.005 ? min(0.9, avg(farImg.applyingFilter("CIMultiplyCompositing", parameters: [kCIInputBackgroundImageKey: mask])) / mAvg) : 0.2
            let motion = { (f: Double) -> CGFloat in CGFloat((f - fs) / max(0.1, 1 - fs)) }
            let notSubject = mask.applyingFilter("CIMorphologyMaximum", parameters: [kCIInputRadiusKey: e.width / 200])
                .cropped(to: e).applyingFilter("CIColorInvert")
            // „näher als edge“-Masken; die Bewegung einer Stufe = Bewegung an ihrer fernen Kante
            let edges = [fs + 0.6 * (1 - fs), fs + 0.3 * (1 - fs), fs + 0.1 * (1 - fs), fs - 0.12].filter { $0 > 0.02 && $0 < 0.98 }
            for edge in edges {
                let near = farImg.applyingFilter("CIColorMatrix", parameters: [
                    "inputRVector": CIVector(x: -k, y: 0, z: 0, w: 0), "inputGVector": CIVector(x: -k, y: 0, z: 0, w: 0),
                    "inputBVector": CIVector(x: -k, y: 0, z: 0, w: 0), "inputAVector": CIVector(x: 0, y: 0, z: 0, w: 0),
                    "inputBiasVector": CIVector(x: k * edge + 0.5, y: k * edge + 0.5, z: k * edge + 0.5, w: 1)])
                    .applyingFilter("CIColorClamp")
                    .clampedToExtent().applyingFilter("CIGaussianBlur", parameters: [kCIInputRadiusKey: e.width / 250]).cropped(to: e)
                let m = near.applyingFilter("CIMultiplyCompositing", parameters: [kCIInputBackgroundImageKey: notSubject])
                let layer = image.applyingFilter("CIBlendWithMask", parameters: [kCIInputBackgroundImageKey: CIImage.empty().cropped(to: e),
                                                                                 kCIInputMaskImageKey: m])
                if let cg = ctx.createCGImage(layer, from: e, format: .RGBA8, colorSpace: CGColorSpace(name: CGColorSpace.sRGB)) {
                    // auf Motiv-Tiefe (±10 %) genau stillstehen
                    let f = edge < fs ? motion(edge) : (edge - fs < 0.11 * (1 - fs) ? 0 : motion(edge))
                    bands.append((UIImage(cgImage: cg), f))
                }
            }
        }
        // für den Server auf 1280 px verkleinern (LaMa: 2048 px ≈ 32 s, 1280 px ≈ ein Drittel davon)
        let ss = min(1, 1280 / max(e.width, e.height)), t = CGAffineTransform(scaleX: ss, y: ss), se = e.applying(t).integral
        let src = ctx.createCGImage(image.transformed(by: t), from: se).flatMap { UIImage(cgImage: $0).jpegData(compressionQuality: 0.92) }
        let m = ctx.createCGImage(grow.transformed(by: t), from: se).flatMap { UIImage(cgImage: $0).pngData() }
        #if DEBUG
        // Test: FOTOS_DUMP_SPATIAL=1 legt Maske, Vorder- und Hintergrund in tmp/ ab
        if ProcessInfo.processInfo.environment["FOTOS_DUMP_SPATIAL"] == "1" {
            let t = FileManager.default.temporaryDirectory
            try? UIImage(cgImage: f).pngData()?.write(to: t.appendingPathComponent("raum-vorne.png"))
            try? UIImage(cgImage: b).pngData()?.write(to: t.appendingPathComponent("raum-hinten.png"))
            for (i, band) in bands.enumerated() { try? band.image.pngData()?.write(to: t.appendingPathComponent("raum-stufe\(i).png")) }
            if let mc = ctx.createCGImage(mask, from: e) { try? UIImage(cgImage: mc).pngData()?.write(to: t.appendingPathComponent("raum-maske.png")) }
            try? "matte=\(depth.matte != nil) bild=\(e) maske=\(mask.extent) tiefe=\(depth.disparity.extent)".write(to: t.appendingPathComponent("raum-info.txt"), atomically: true, encoding: .utf8)
        }
        #endif
        return SpatialLayers(foreground: UIImage(cgImage: f), background: UIImage(cgImage: b), bands: bands, sourceJPEG: src, maskPNG: m)
    }
}
