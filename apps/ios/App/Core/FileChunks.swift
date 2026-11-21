import Foundation

extension FileHandle {
    /// Datei stückweise lesen (4 MB), jedes Stück in einem eigenen autoreleasepool – sonst bleiben alle gelesenen
    /// Stücke bis zum Ende der Schleife im Speicher: eine 5,4-GB-Bildschirmaufnahme brauchte so über 2 GB und iOS
    /// beendete die App beim Backup jedes Mal nach wenigen Sekunden (07.11.2026). Mit Pool bleibt es bei ~30 MB.
    func forEachChunk(_ body: (Data) throws -> Void) throws {
        while true {
            let more: Bool = try autoreleasepool {
                guard let c = try read(upToCount: 4 << 20), !c.isEmpty else { return false }
                try body(c)
                return true
            }
            if !more { return }
        }
    }
}
