import Foundation

// From HomeRoll's shared helpers file, whose other contents (the shared
// container and the widget's storage) went in I1 (docs/mobile/plans/I1-identity.md).

/// Translates a text known only at run time (an enum's raw value, say). Without
/// a translation the text stays as it is. Fixed texts go through
/// `String(localized:)` or SwiftUI and do not need this.
func L(_ key: String) -> String { Bundle.main.localizedString(forKey: key, value: key, table: nil) }

/// Makes a file name from the server or a shared library safe before it goes
/// into a path or a multipart header: only its last part (no "../"), without
/// control characters, line breaks, quotes or slashes, at most 200 characters.
func safeFilename(_ raw: String, fallback: String = "file") -> String {
    let bad = CharacterSet.controlCharacters.union(.newlines).union(CharacterSet(charactersIn: "\"/\\:"))
    var s = String(String.UnicodeScalarView(raw.unicodeScalars.filter { !bad.contains($0) }))
    s = s.trimmingCharacters(in: .whitespaces)
    while s.hasPrefix(".") { s.removeFirst() }          // no hidden files, no ".."
    if s.count > 200 {
        let ext = (s as NSString).pathExtension
        s = String(s.prefix(190)) + (ext.isEmpty ? "" : "." + String(ext.prefix(9)))
    }
    return s.isEmpty ? fallback : s
}
