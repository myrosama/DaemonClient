import CoreSpotlight
import UniformTypeIdentifiers
import UIKit

/// iPhone-Suche (Spotlight) wie Fotos (REA: PXPhotoKitAssetSpotlightActionPerformer): Alben, benannte Personen und
/// Rückblicke sind dort auffindbar; Tippen öffnet sie hier (homeroll://album|person|memory/<id>).
/// Nur Namen und Titel, keine Fotos – die bleiben auf dem Server. Je Konto: beim Wechsel wird alles ersetzt.
@MainActor
enum SpotlightIndex {
    private static let domain = "homeroll"

    static func update(albums: [AlbumDTO], people: [PersonDTO], memories: [Memory], account: String) {
        guard !account.isEmpty else { return }
        var items: [CSSearchableItem] = []
        for a in albums {
            let attr = CSSearchableItemAttributeSet(contentType: .content)
            attr.title = a.albumName
            attr.contentDescription = String(localized: "Album in Fotos")
            attr.keywords = ["Album", a.albumName]
            items.append(item("album/\(a.id)", attr))
        }
        for p in people where !p.name.isEmpty {
            let attr = CSSearchableItemAttributeSet(contentType: .content)
            attr.title = p.name
            attr.contentDescription = String(localized: "Person in Fotos")
            attr.keywords = ["Person", "Fotos von \(p.name)", p.name]
            items.append(item("person/\(p.id)?name=\(p.name.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? "")", attr))
        }
        for m in memories.prefix(30) {
            let attr = CSSearchableItemAttributeSet(contentType: .content)
            attr.title = m.title
            attr.contentDescription = String(localized: "Rückblick") + " · " + m.subtitle
            attr.keywords = ["Rückblick", m.title]
            items.append(item("memory/\(m.id)", attr))
        }
        let index = CSSearchableIndex.default()
        let index2 = { index.indexSearchableItems(items) { _ in } }
        // anderes Konto: alte Einträge weg (sonst führen sie zu fremden Alben)
        if UserDefaults.standard.string(forKey: "spotlight.account") != account {
            index.deleteSearchableItems(withDomainIdentifiers: [domain]) { _ in index2() }
        } else {
            index2()
        }
        UserDefaults.standard.set(account, forKey: "spotlight.account")
    }

    /// Abmelden: nichts mehr in der iPhone-Suche
    static func clear() {
        UserDefaults.standard.removeObject(forKey: "spotlight.account")
        CSSearchableIndex.default().deleteSearchableItems(withDomainIdentifiers: [domain]) { _ in }
    }

    private static func item(_ path: String, _ attr: CSSearchableItemAttributeSet) -> CSSearchableItem {
        let i = CSSearchableItem(uniqueIdentifier: "homeroll://" + path, domainIdentifier: domain, attributeSet: attr)
        i.expirationDate = Date().addingTimeInterval(60 * 86_400)
        return i
    }
}
