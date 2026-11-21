// Zeichnet das App-Symbol (Berge mit Sonne auf blauem Verlauf) als 1024×1024-PNG.
// Aufruf: swift tools/make_icon.swift Resources/Assets.xcassets/AppIcon.appiconset/AppIcon.png
import AppKit

let size: CGFloat = 1024
let out = CommandLine.arguments.dropFirst().first ?? "AppIcon.png"

let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(size), pixelsHigh: Int(size),
                           bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                           colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
let ctx = NSGraphicsContext.current!.cgContext
let rgb = CGColorSpaceCreateDeviceRGB()

// Hintergrund: Verlauf von Türkis (unten) nach Blau (oben); iOS rundet die Ecken selbst ab
let sky = CGGradient(colorsSpace: rgb, colors: [CGColor(red: 0.10, green: 0.78, blue: 0.80, alpha: 1),
                                                CGColor(red: 0.16, green: 0.36, blue: 0.95, alpha: 1)] as CFArray,
                     locations: [0, 1])!
ctx.drawLinearGradient(sky, start: CGPoint(x: 0, y: 0), end: CGPoint(x: 0, y: size), options: [])

// Sonne
ctx.setFillColor(CGColor(red: 1, green: 0.85, blue: 0.35, alpha: 1))
ctx.fillEllipse(in: CGRect(x: 610, y: 600, width: 190, height: 190))

// Berge: hinten heller, vorne weiß
func mountain(_ pts: [CGPoint], _ color: CGColor) {
    ctx.beginPath(); ctx.move(to: pts[0]); for p in pts.dropFirst() { ctx.addLine(to: p) }
    ctx.closePath(); ctx.setFillColor(color); ctx.fillPath()
}
mountain([CGPoint(x: 0, y: 220), CGPoint(x: 330, y: 610), CGPoint(x: 560, y: 360), CGPoint(x: 1024, y: 700),
          CGPoint(x: 1024, y: 0), CGPoint(x: 0, y: 0)], CGColor(red: 1, green: 1, blue: 1, alpha: 0.45))
mountain([CGPoint(x: 0, y: 140), CGPoint(x: 420, y: 520), CGPoint(x: 620, y: 330), CGPoint(x: 820, y: 470),
          CGPoint(x: 1024, y: 300), CGPoint(x: 1024, y: 0), CGPoint(x: 0, y: 0)], CGColor(red: 1, green: 1, blue: 1, alpha: 1))

NSGraphicsContext.current = nil
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: out))
print("geschrieben:", out)
