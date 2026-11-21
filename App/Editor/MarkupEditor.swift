import SwiftUI
import PencilKit

/// Markieren wie in Fotos: mit Stift, Marker, Radierer, Lineal und Farben auf das Foto zeichnen (PencilKit).
/// Die Zeichnung wird in den Bearbeitungsstand übernommen und beim Sichern ins Bild gerechnet.
struct MarkupEditor: View {
    let image: UIImage
    let drawing: Data?
    let canvas: CGSize?
    let done: (Data?, CGSize) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var model = MarkupModel()

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Button(String(localized: "Abbrechen")) { dismiss() }
                Spacer()
                Text(String(localized: "Markieren")).font(.headline)
                Spacer()
                Button(String(localized: "Fertig")) {
                    let d = model.canvas.drawing
                    done(d.strokes.isEmpty ? nil : d.dataRepresentation(), model.size)
                    dismiss()
                }
                .bold().foregroundStyle(.yellow)
            }
            .padding(.horizontal, 20).frame(height: 52)
            GeometryReader { g in
                let fit = fitted(image.size, in: g.size)
                ZStack {
                    Image(uiImage: image).resizable().frame(width: fit.width, height: fit.height)
                    CanvasView(model: model).frame(width: fit.width, height: fit.height)
                }
                .frame(width: g.size.width, height: g.size.height)
                .onAppear { model.load(drawing, from: canvas, to: fit) }
            }
            .padding(.bottom, 90)       // Platz für die Werkzeugleiste
        }
        .background(Color.black.ignoresSafeArea())
        .preferredColorScheme(.dark)
    }

    private func fitted(_ img: CGSize, in box: CGSize) -> CGSize {
        let s = min(box.width / img.width, box.height / img.height)
        return CGSize(width: img.width * s, height: img.height * s)
    }
}

@MainActor
final class MarkupModel {
    let canvas = PKCanvasView()
    let picker = PKToolPicker()
    private(set) var size: CGSize = .zero

    /// Frühere Zeichnung auf die aktuelle Größe umrechnen (Zeichenfläche kann anders groß sein).
    func load(_ data: Data?, from old: CGSize?, to new: CGSize) {
        size = new
        guard let data, var d = try? PKDrawing(data: data) else { return }
        if let old, old.width > 0 { d.transform(using: CGAffineTransform(scaleX: new.width / old.width, y: new.height / old.height)) }
        canvas.drawing = d
    }
}

private struct CanvasView: UIViewRepresentable {
    let model: MarkupModel
    func makeUIView(context: Context) -> PKCanvasView {
        let c = model.canvas
        c.backgroundColor = .clear; c.isOpaque = false
        c.drawingPolicy = .anyInput          // auch mit dem Finger
        c.tool = PKInkingTool(.pen, color: .systemRed, width: 6)
        model.picker.setVisible(true, forFirstResponder: c)
        model.picker.addObserver(c)
        DispatchQueue.main.async { c.becomeFirstResponder() }
        return c
    }
    func updateUIView(_ uiView: PKCanvasView, context: Context) {}
}
