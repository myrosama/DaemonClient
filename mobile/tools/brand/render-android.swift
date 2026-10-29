// Android launcher icons and splash images from the DaemonClient logo.
// Usage: swift render-android.swift <logo.png> <outdir>
// Source logo: drive/public/logo.png. Where each output goes: README.md here.
import AppKit
import ImageIO
import UniformTypeIdentifiers
let a = CommandLine.arguments
let img = NSImage(contentsOfFile: a[1])!
var r = CGRect(origin: .zero, size: img.size)
let logo = img.cgImage(forProposedRect: &r, context: nil, hints: nil)!
func ctx(_ n: Int, opaque: Bool) -> CGContext {
    let c = CGContext(data: nil, width: n, height: n, bitsPerComponent: 8, bytesPerRow: 0,
                      space: CGColorSpace(name: CGColorSpace.sRGB)!,
                      bitmapInfo: (opaque ? CGImageAlphaInfo.noneSkipLast : CGImageAlphaInfo.premultipliedLast).rawValue)!
    c.interpolationQuality = .high
    return c
}
func draw(_ c: CGContext, _ n: Int, fraction: CGFloat) {
    let box = CGFloat(n) * fraction
    let k = min(box / CGFloat(logo.width), box / CGFloat(logo.height))
    let w = CGFloat(logo.width) * k, h = CGFloat(logo.height) * k
    c.draw(logo, in: CGRect(x: (CGFloat(n) - w) / 2, y: (CGFloat(n) - h) / 2, width: w, height: h))
}
func save(_ c: CGContext, _ name: String) {
    let d = CGImageDestinationCreateWithURL(URL(fileURLWithPath: a[2]).appendingPathComponent(name) as CFURL,
                                            UTType.png.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(d, c.makeImage()!, nil); CGImageDestinationFinalize(d)
}
for (d, legacy, fg) in [("mdpi", 48, 108), ("hdpi", 72, 162), ("xhdpi", 96, 216), ("xxhdpi", 144, 324), ("xxxhdpi", 192, 432)] {
    // Adaptive foreground: transparent; only a centred 66 dp circle of the 108 dp canvas (61%) is guaranteed
    // visible. A 1.2:1 logo 46% wide has a 60% diagonal, so it fits, and fills the circle about as iOS (72%).
    let f = ctx(fg, opaque: false); draw(f, fg, fraction: 0.46); save(f, "android-\(d)-foreground.png")
    // Legacy icon (Android < 8; minSdk is 26, so rarely shown): white square, logo at 72% like iOS.
    let l = ctx(legacy, opaque: true); l.setFillColor(CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 1))
    l.fill(CGRect(x: 0, y: 0, width: legacy, height: legacy)); draw(l, legacy, fraction: 0.72); save(l, "android-\(d)-legacy.png")
}
for (d, n) in [("mdpi", 80), ("hdpi", 120), ("xhdpi", 160), ("xxhdpi", 240), ("xxxhdpi", 320)] {
    // Pre-Android-12 launch screen (launch_background.xml centres it): transparent, 80 dp like iOS LaunchImage.
    let s = ctx(n, opaque: false); draw(s, n, fraction: 0.9); save(s, "android-\(d)-splash.png")
}
for (d, n) in [("mdpi", 288), ("hdpi", 432), ("xhdpi", 576), ("xxhdpi", 864), ("xxxhdpi", 1152)] {
    // Android 12+ splash icon: 288 dp canvas, only a centred circle of 192 dp shows. A 1.2:1 logo whose
    // long side is 48% of the canvas has a diagonal of 62.5% < 66.7%, so no corner is clipped.
    let s = ctx(n, opaque: false); draw(s, n, fraction: 0.48); save(s, "android-\(d)-android12splash.png")
}
print("done")
