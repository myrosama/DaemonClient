// Renders DaemonClient brand assets for the Photos app from one logo PNG:
// iOS app icons, the iOS launch image, and the in-app logo / wordmark images.
// Usage: swift render-apple-and-app.swift <logo.png> <outdir>
// Source logo: drive/public/logo.png (536x446, the only copy in the repo).
// Where each output goes: see README.md in this folder.
import AppKit
import ImageIO
import UniformTypeIdentifiers

let args = CommandLine.arguments
let logo = NSImage(contentsOfFile: args[1])!
let out = args[2]
var logoRect = CGRect(origin: .zero, size: logo.size)
let logoCG = logo.cgImage(forProposedRect: &logoRect, context: nil, hints: nil)!
let logoAspect = CGFloat(logoCG.width) / CGFloat(logoCG.height)

func context(_ w: Int, _ h: Int, opaque: Bool) -> CGContext {
    let info = opaque ? CGImageAlphaInfo.noneSkipLast.rawValue : CGImageAlphaInfo.premultipliedLast.rawValue
    let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                        space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: info)!
    ctx.interpolationQuality = .high
    return ctx
}

func save(_ ctx: CGContext, _ name: String) {
    let url = URL(fileURLWithPath: out).appendingPathComponent(name)
    let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(dest, ctx.makeImage()!, nil)
    CGImageDestinationFinalize(dest)
}

/// Draws the logo as large as fits in `box`, centred, keeping its aspect.
func drawLogo(_ ctx: CGContext, in box: CGRect) {
    let k = min(box.width / CGFloat(logoCG.width), box.height / CGFloat(logoCG.height))
    let w = CGFloat(logoCG.width) * k, h = CGFloat(logoCG.height) * k
    ctx.draw(logoCG, in: CGRect(x: box.midX - w / 2, y: box.midY - h / 2, width: w, height: h))
}

/// Draws `text` left-aligned at `x`, vertically centred in a canvas of height `h`.
func drawText(_ ctx: CGContext, _ text: String, x: CGFloat, h: CGFloat, size: CGFloat, color: NSColor) -> CGFloat {
    let font = NSFont.systemFont(ofSize: size, weight: .bold)
    let str = NSAttributedString(string: text, attributes: [.font: font, .foregroundColor: color])
    let b = str.size()
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(cgContext: ctx, flipped: false)
    str.draw(at: CGPoint(x: x, y: (h - b.height) / 2))
    NSGraphicsContext.restoreGraphicsState()
    return b.width
}

func textWidth(_ text: String, size: CGFloat) -> CGFloat {
    NSAttributedString(string: text, attributes: [.font: NSFont.systemFont(ofSize: size, weight: .bold)]).size().width
}

let navy = NSColor(srgbRed: 0.09, green: 0.13, blue: 0.24, alpha: 1)   // text on light backgrounds
let white = NSColor.white                                              // text on dark backgrounds
let word = "DaemonClient"

// 1. iOS app icons: opaque white square, logo at 72% width (App Store icons may not have alpha).
for n in [16, 20, 29, 32, 40, 48, 50, 55, 57, 58, 60, 64, 66, 72, 76, 80, 87, 88, 92, 100, 102, 114, 120,
          128, 144, 152, 167, 172, 180, 196, 216, 256, 512, 1024] {
    let ctx = context(n, n, opaque: true)
    ctx.setFillColor(CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 1))
    ctx.fill(CGRect(x: 0, y: 0, width: n, height: n))
    let side = CGFloat(n) * 0.72
    drawLogo(ctx, in: CGRect(x: (CGFloat(n) - side) / 2, y: (CGFloat(n) - side) / 2, width: side, height: side))
    save(ctx, "icon-\(n).png")
}

// 2. Launch image (transparent, centred) at 1x/2x/3x of 80 pt.
for (n, suffix) in [(80, ""), (160, "@2x"), (240, "@3x")] {
    let ctx = context(n, n, opaque: false)
    drawLogo(ctx, in: CGRect(x: 0, y: 0, width: n, height: n).insetBy(dx: CGFloat(n) * 0.05, dy: CGFloat(n) * 0.05))
    save(ctx, "LaunchImage\(suffix).png")
}

// 3. Square transparent logo (replaces assets/immich-logo.png).
do {
    let ctx = context(1024, 1024, opaque: false)
    drawLogo(ctx, in: CGRect(x: 0, y: 0, width: 1024, height: 1024))
    save(ctx, "logo-1024.png")
}

// 4. Wordmark alone (replaces assets/immich-text-{light,dark}.png): light theme = navy text.
for (name, color) in [("text-light.png", navy), ("text-dark.png", white)] {
    let h: CGFloat = 400, size: CGFloat = 300, pad: CGFloat = 20
    let w = Int(textWidth(word, size: size) + pad * 2)
    let ctx = context(w, Int(h), opaque: false)
    _ = drawText(ctx, word, x: pad, h: h, size: size, color: color)
    save(ctx, name)
}

// 5. Inline logo + wordmark (replaces assets/immich-logo-inline-{light,dark}.{png,svg}).
for (name, color) in [("inline-light.png", navy), ("inline-dark.png", white)] {
    let h: CGFloat = 600, logoH = h * 0.86, size: CGFloat = 360, gap: CGFloat = 60
    let logoW = logoH * logoAspect
    let w = Int(logoW + gap + textWidth(word, size: size) + 20)
    let ctx = context(w, Int(h), opaque: false)
    drawLogo(ctx, in: CGRect(x: 0, y: (h - logoH) / 2, width: logoW, height: logoH))
    _ = drawText(ctx, word, x: logoW + gap, h: h, size: size, color: color)
    save(ctx, name)
}
print("done")
