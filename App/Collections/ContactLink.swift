import SwiftUI
import ContactsUI

/// Person mit einem Kontakt verknüpfen (wie Fotos): Name und Geburtstag kommen aus dem Kontakt.
/// Der Kontakt-Auswahlbogen läuft außerhalb der App – dafür braucht es keine Kontakte-Freigabe.
/// Die Verknüpfung merkt sich die App je Person auf diesem iPhone.
enum ContactLinks {
    private static let key = "contactLinks"
    static func contact(for person: String) -> String? {
        (UserDefaults.standard.dictionary(forKey: key) as? [String: String])?[person]
    }
    static func set(_ contact: String?, for person: String) {
        var d = (UserDefaults.standard.dictionary(forKey: key) as? [String: String]) ?? [:]
        d[person] = contact
        UserDefaults.standard.set(d, forKey: key)
    }
}

struct ContactPicker: UIViewControllerRepresentable {
    let onPick: (CNContact) -> Void
    func makeCoordinator() -> Coordinator { Coordinator(onPick) }
    func makeUIViewController(context: Context) -> CNContactPickerViewController {
        let p = CNContactPickerViewController()
        p.delegate = context.coordinator
        p.displayedPropertyKeys = [CNContactBirthdayKey]
        return p
    }
    func updateUIViewController(_ vc: CNContactPickerViewController, context: Context) {}
    final class Coordinator: NSObject, CNContactPickerDelegate {
        let onPick: (CNContact) -> Void
        init(_ f: @escaping (CNContact) -> Void) { onPick = f }
        func contactPicker(_ picker: CNContactPickerViewController, didSelect contact: CNContact) { onPick(contact) }
    }
}
