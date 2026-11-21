import AVFoundation

/// Video mit Ton auch bei Stummschalter wie Apple Fotos (Kategorie „Wiedergabe“); stumme Vorschauen im Raster
/// rufen das nie auf. Nach dem Ende wieder freigeben, damit Musik anderer Apps weiterläuft.
/// Idee aus dem Fork vands2013/HomeRoll (PlaybackAudioSession).
@MainActor enum PlaybackAudioSession {
    private static var active = false
    static func activate() {
        guard !active else { return }
        let s = AVAudioSession.sharedInstance()
        try? s.setCategory(.playback, mode: .moviePlayback)
        try? s.setActive(true)
        active = true
    }
    static func release() {
        guard active else { return }
        active = false
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}
