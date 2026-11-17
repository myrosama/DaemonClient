// P1 task 1.6, Gate 2 (run by examples/serve.rs): open a video from the
// core's media server the way AVPlayer does — AVFoundation picks the demuxer
// from Content-Type and reads the file's index with range requests — and
// draw a frame from the middle. Prints timings only.
import AVFoundation
import Foundation

guard CommandLine.arguments.count == 2, let url = URL(string: CommandLine.arguments[1]) else {
    print("usage: avplayer_check <video url>")
    exit(2)
}
let started = Date()
let asset = AVURLAsset(url: url)
do {
    let duration = try await asset.load(.duration)
    let opened = Date().timeIntervalSince(started)
    let generator = AVAssetImageGenerator(asset: asset)
    generator.appliesPreferredTrackTransform = true
    let middle = CMTime(seconds: duration.seconds / 2, preferredTimescale: 600)
    let (image, at) = try await generator.image(at: middle)
    print(String(
        format: "AVFoundation: opened in %.2f s (%.1f s long); a %dx%d frame at %.1f s, %.2f s in all",
        opened, duration.seconds, image.width, image.height, at.seconds, Date().timeIntervalSince(started)))
} catch {
    let error = error as NSError
    let cause = (error.userInfo[NSUnderlyingErrorKey] as? NSError).map { " — \($0.domain) \($0.code): \($0.localizedDescription)" } ?? ""
    print(String(format: "AVFoundation failed after %.1f s: %@ %d: %@%@",
        Date().timeIntervalSince(started), error.domain, error.code, error.localizedDescription, cause))
    exit(1)
}
