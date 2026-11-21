import WidgetKit
import SwiftUI

/// Widgets wie Apples „Fotos“: Rückblicke („Heute vor 2 Jahren“) und ausgewählte Fotos, stündlich wechselnd.
/// Bilder und Titel legt die App in den gemeinsamen Speicher – das Widget selbst braucht keinen Server.
@main
struct FotosWidgets: WidgetBundle {
    var body: some Widget {
        MemoriesWidget()
        PhotosWidget()
    }
}

struct PhotoEntry: TimelineEntry {
    let date: Date
    let item: WidgetSnapshot.Item?
    let image: UIImage?
}

struct Provider: TimelineProvider {
    let memories: Bool
    func placeholder(in context: Context) -> PhotoEntry { PhotoEntry(date: Date(), item: nil, image: nil) }
    func getSnapshot(in context: Context, completion: @escaping (PhotoEntry) -> Void) { completion(entries(1).first ?? placeholder(in: context)) }
    func getTimeline(in context: Context, completion: @escaping (Timeline<PhotoEntry>) -> Void) {
        let list = entries(12)
        completion(Timeline(entries: list.isEmpty ? [placeholder(in: context)] : list, policy: .atEnd))
    }
    /// Jede Stunde das nächste Bild (wie Apples Fotos-Widget).
    private func entries(_ n: Int) -> [PhotoEntry] {
        guard let snap = WidgetSnapshot.load(), let dir = WidgetSnapshot.folder else { return [] }
        let items = memories ? (snap.memories.isEmpty ? snap.photos : snap.memories) : snap.photos
        guard !items.isEmpty else { return [] }
        let start = Calendar.current.dateInterval(of: .hour, for: Date())?.start ?? Date()
        let offset = Int(start.timeIntervalSince1970 / 3600)
        return (0..<min(n, max(items.count, 1) * 2)).map { h in
            let it = items[(offset + h) % items.count]
            return PhotoEntry(date: start.addingTimeInterval(Double(h) * 3600), item: it,
                              image: UIImage(contentsOfFile: dir.appendingPathComponent(it.file).path))
        }
    }
}

struct PhotoWidgetView: View {
    let entry: PhotoEntry
    @Environment(\.widgetFamily) private var family
    var body: some View {
        ZStack(alignment: .bottomLeading) {
            if entry.item != nil {
                LinearGradient(colors: [.clear, .black.opacity(0.6)], startPoint: .center, endPoint: .bottom)
                VStack(alignment: .leading, spacing: 2) {
                    Text(entry.item?.title ?? "").font(family == .systemSmall ? .headline : .title3.bold()).lineLimit(2)
                    if family != .systemSmall || (entry.item?.memory ?? false) {
                        Text(entry.item?.subtitle ?? "").font(.caption.weight(.semibold)).opacity(0.85).lineLimit(1)
                    }
                }
                .foregroundStyle(.white).shadow(radius: 4).padding(14)
            } else {
                VStack(alignment: .leading, spacing: 6) {
                    Image(systemName: "photo.on.rectangle.angled").font(.title)
                    Text(String(localized: "Öffne die Fotos-App, damit hier Bilder erscheinen.")).font(.caption)
                }
                .foregroundStyle(.secondary).padding(14)
            }
        }
        .containerBackground(for: .widget) {
            if let img = entry.image { Image(uiImage: img).resizable().scaledToFill() } else { Color(.secondarySystemBackground) }
        }
        .widgetURL(entry.item.map { URL(string: "homeroll://\($0.memory ? "memory" : "asset")/\($0.id)")! })
    }
}

struct MemoriesWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "rueckblicke", provider: Provider(memories: true)) { PhotoWidgetView(entry: $0) }
            .configurationDisplayName(String(localized: "Rückblicke"))
            .description(String(localized: "Erinnerungen wie „Heute vor 2 Jahren“ aus deiner Mediathek."))
            .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
            .contentMarginsDisabled()
    }
}

struct PhotosWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "fotos", provider: Provider(memories: false)) { PhotoWidgetView(entry: $0) }
            .configurationDisplayName(String(localized: "Ausgewählte Fotos"))
            .description(String(localized: "Jede Stunde ein anderes deiner Lieblingsfotos."))
            .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
            .contentMarginsDisabled()
    }
}
