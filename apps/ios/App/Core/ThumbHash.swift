#if canImport(UIKit)
import UIKit
#else
import CoreGraphics
import Foundation
#endif

/// ThumbHash → kleines unscharfes Vorschaubild (≤ 32 px), wie Apple Fotos es vor dem echten Bild zeigt.
/// Immich liefert den Hash (base64, ~25 Byte) in jeder Zeitleisten-Antwort mit; fehlt er, hat der Server
/// noch keine Vorschau gerechnet. Verfahren: Evan Wallace, „ThumbHash“ (MIT), hier nach Swift übertragen.
enum ThumbHash {
    #if canImport(UIKit)
    static func image(base64: String) -> UIImage? { cgImage(base64: base64).map { UIImage(cgImage: $0) } }
    #endif

    static func cgImage(base64: String) -> CGImage? {
        guard let data = Data(base64Encoded: base64), data.count >= 5,
              let (w, h, rgba) = decode([UInt8](data)) else { return nil }
        let provider = CGDataProvider(data: Data(rgba) as CFData)!
        guard let cg = CGImage(width: w, height: h, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: w * 4,
                               space: CGColorSpaceCreateDeviceRGB(),
                               bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
                               provider: provider, decode: nil, shouldInterpolate: true, intent: .defaultIntent)
        else { return nil }
        return cg
    }

    static func decode(_ hash: [UInt8]) -> (Int, Int, [UInt8])? {
        let h24 = Int(hash[0]) | Int(hash[1]) << 8 | Int(hash[2]) << 16
        let h16 = Int(hash[3]) | Int(hash[4]) << 8
        let lDC = Float(h24 & 63) / 63
        let pDC = Float((h24 >> 6) & 63) / 31.5 - 1
        let qDC = Float((h24 >> 12) & 63) / 31.5 - 1
        let lScale = Float((h24 >> 18) & 31) / 31
        let hasAlpha = (h24 >> 23) != 0
        let pScale = Float((h16 >> 3) & 63) / 63
        let qScale = Float((h16 >> 9) & 63) / 63
        let landscape = (h16 >> 15) != 0
        let lx = max(3, landscape ? (hasAlpha ? 5 : 7) : h16 & 7)
        let ly = max(3, landscape ? h16 & 7 : (hasAlpha ? 5 : 7))
        let aDC: Float = hasAlpha ? Float(hash[5] & 15) / 15 : 1
        let aScale = hasAlpha ? Float(hash[5] >> 4) / 15 : 0
        let acStart = hasAlpha ? 6 : 5
        var acIndex = 0

        func channel(_ nx: Int, _ ny: Int, _ scale: Float) -> [Float]? {
            var ac: [Float] = []
            for cy in 0..<ny {
                var cx = cy > 0 ? 0 : 1
                while cx * ny < nx * (ny - cy) {
                    let i = acStart + (acIndex >> 1)
                    guard i < hash.count else { return nil }
                    ac.append((Float((Int(hash[i]) >> ((acIndex & 1) << 2)) & 15) / 7.5 - 1) * scale)
                    acIndex += 1; cx += 1
                }
            }
            return ac
        }
        guard let lAC = channel(lx, ly, lScale), let pAC = channel(3, 3, pScale * 1.25),
              let qAC = channel(3, 3, qScale * 1.25) else { return nil }
        let aAC = hasAlpha ? (channel(5, 5, aScale) ?? []) : []

        let ratio = Float(lx) / Float(ly)
        let w = Int((ratio > 1 ? 32 : 32 * ratio).rounded())
        let h = Int((ratio > 1 ? 32 / ratio : 32).rounded())
        var rgba = [UInt8](repeating: 0, count: w * h * 4)
        let cxStop = max(lx, hasAlpha ? 5 : 3), cyStop = max(ly, hasAlpha ? 5 : 3)
        var fx = [Float](repeating: 0, count: cxStop), fy = [Float](repeating: 0, count: cyStop)
        var i = 0
        for y in 0..<h {
            for cy in 0..<cyStop { fy[cy] = cos(Float.pi / Float(h) * (Float(y) + 0.5) * Float(cy)) }
            for x in 0..<w {
                var l = lDC, p = pDC, q = qDC, a = aDC
                for cx in 0..<cxStop { fx[cx] = cos(Float.pi / Float(w) * (Float(x) + 0.5) * Float(cx)) }
                var j = 0
                for cy in 0..<ly {
                    var cx = cy > 0 ? 0 : 1; let fy2 = fy[cy] * 2
                    while cx * ly < lx * (ly - cy) { l += lAC[j] * fx[cx] * fy2; j += 1; cx += 1 }
                }
                j = 0
                for cy in 0..<3 {
                    var cx = cy > 0 ? 0 : 1; let fy2 = fy[cy] * 2
                    while cx < 3 - cy { let f = fx[cx] * fy2; p += pAC[j] * f; q += qAC[j] * f; j += 1; cx += 1 }
                }
                if hasAlpha {
                    j = 0
                    for cy in 0..<5 {
                        var cx = cy > 0 ? 0 : 1; let fy2 = fy[cy] * 2
                        while cx < 5 - cy { a += aAC[j] * fx[cx] * fy2; j += 1; cx += 1 }
                    }
                }
                let b = l - 2 / 3 * p
                let r = (3 * l - b + q) / 2
                let g = r - q
                let alpha = max(0, min(1, a))
                rgba[i] = UInt8(max(0, min(1, r)) * 255 * alpha)
                rgba[i + 1] = UInt8(max(0, min(1, g)) * 255 * alpha)
                rgba[i + 2] = UInt8(max(0, min(1, b)) * 255 * alpha)
                rgba[i + 3] = UInt8(alpha * 255)
                i += 4
            }
        }
        return (w, h, rgba)
    }
}
