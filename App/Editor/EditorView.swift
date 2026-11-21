import SwiftUI

/// Bearbeiten wie in Fotos (iOS 26): Anpassen · Filter · Zuschneiden, mit Widerrufen/Wiederholen und „…“-Menü.
struct EditorView: View {
    /// Breite der Reglerleiste (Fenster statt Bildschirm – iPad/Split View, GitHub #47)
    @State private var dialWidth: CGFloat = 390
    let asset: Asset
    let onDone: (Asset) -> Void
    @State private var session: EditSession
    @State private var mode: Mode = .adjust
    @State private var current: DialItem? = .adjust(.exposure)
    @State private var scrubbing = false
    @State private var confirmDiscard = false
    @State private var geo: Geo = .straighten
    @State private var showOriginal = false
    @State private var aspect: AspectChoice = .free
    @State private var confirmRestore = false
    @State private var undo: [EditState] = []
    @State private var redo: [EditState] = []
    @State private var committed: EditState?
    /// Porträt: Blende statt der Regler zeigen
    @State private var depthMode = false
    @State private var portraitPane: PortraitPane = .aperture
    @State private var focusMark: CGPoint?
    @State private var markingUp = false
    @State private var straightenNote: String?
    @State private var brush: Double = 0.06
    @Environment(\.dismiss) private var dismiss
    @Environment(AppModel.self) private var app

    enum Mode: String, CaseIterable { case live = "Live", adjust = "Anpassen", filter = "Filter", styles = "Stile", cleanup = "Bereinigen", crop = "Zuschneiden" }
    enum Geo: String, CaseIterable { case straighten = "Begradigen", vertical = "Vertikal", horizontal = "Horizontal" }

    init(asset: Asset, onDone: @escaping (Asset) -> Void) {
        self.asset = asset; self.onDone = onDone
        _session = State(initialValue: EditSession(asset: asset))
    }

    var body: some View {
        VStack(spacing: 0) {
            topBar
            ZStack {
                if mode == .cleanup, let img = session.cleanupPreview ?? session.fullOriginal {
                    CleanupCanvas(image: img, strokes: session.state.cleanup, brush: brush) { st in
                        session.state.cleanup.append(st)
                    }
                    .padding(.horizontal, 12)
                    if session.cleaning {
                        VStack(spacing: 10) { ProgressView().tint(.white); Text(String(localized: "Wird bereinigt …")).font(.headline) }
                            .padding(22).glassEffect(.regular, in: .rect(cornerRadius: 20))
                    }
                } else if mode == .crop, let img = session.fullPreview {
                    CropCanvas(image: img, crop: session.state.displayCrop, aspect: aspect.ratio(img.size)) {
                        session.state.displayCrop = $0
                    }
                    .padding(28)
                } else if let img = showOriginal ? session.fullOriginal : session.preview {
                    Image(uiImage: img).resizable().scaledToFit()
                        .overlay {
                            // Fokus per Tippen (nur ohne Drehen/Spiegeln, damit der Punkt eindeutig im Original liegt)
                            if depthMode, portraitActive, session.state.angle % 360 == 0, !session.state.mirrored {
                                GeometryReader { g in
                                    Color.clear.contentShape(Rectangle())
                                        .onTapGesture { p in setFocus(p, in: g.size) }
                                    if let m = focusMark {
                                        RoundedRectangle(cornerRadius: 4).stroke(Color.yellow, lineWidth: 1.5)
                                            .frame(width: 75, height: 75).position(m).allowsHitTesting(false)
                                            .transition(.scale(scale: 1.3).combined(with: .opacity))
                                    }
                                }
                            }
                        }
                        .padding(.horizontal, 12)
                        .onLongPressGesture(minimumDuration: 0.15, perform: {}, onPressingChanged: { showOriginal = $0 })
                } else if session.loading {
                    ProgressView().tint(.white)
                } else if let e = session.error {
                    ContentUnavailableView(e, systemImage: "exclamationmark.triangle")
                }
                if session.saving {
                    VStack(spacing: 10) { ProgressView().tint(.white); Text(String(localized: "Wird gesichert …")).font(.headline) }
                        .padding(24).glassEffect(.regular, in: .rect(cornerRadius: 22))
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            controls
            modeBar.opacity(scrubbing ? 0 : 1)
        }
        .animation(.easeInOut(duration: 0.2), value: scrubbing)
        .background(Color.black.ignoresSafeArea())
        .preferredColorScheme(.dark)
        .task { await session.load(); committed = session.state }
        // Bereinigen: bei jedem neuen/entfernten Strich (auch Widerrufen) neu rechnen lassen
        .task(id: session.state.cleanup) { if !session.loading { await session.applyCleanup() } }
        .task(id: session.state) {
            guard !session.loading else { return }
            try? await Task.sleep(for: .milliseconds(30))   // schnelles Schieben bündeln
            await session.render()
            // Verlauf für Widerrufen: erst festhalten, wenn der Regler kurz ruht
            try? await Task.sleep(for: .milliseconds(400))
            if let c = committed, c != session.state { undo.append(c); redo.removeAll(); committed = session.state }
        }
        .fullScreenCover(isPresented: $markingUp) {
            if let img = session.preview {
                MarkupEditor(image: img, drawing: session.state.markup, canvas: session.state.markupCanvas) { data, size in
                    session.state.markup = data; session.state.markupCanvas = data == nil ? nil : size
                }
            }
        }
        .confirmationDialog(String(localized: "Original wiederherstellen?"), isPresented: $confirmRestore, titleVisibility: .visible) {
            Button(String(localized: "Original wiederherstellen"), role: .destructive) {
                Task { if let a = try? await session.restore() { onDone(a) }; dismiss() }
            }
        } message: { Text(String(localized: "Alle Änderungen an diesem Foto werden entfernt.")) }
    }

    // MARK: Kopf

    private var topBar: some View {
        HStack(spacing: 12) {
            circle("xmark") { if session.changed { confirmDiscard = true } else { dismiss() } }
                .confirmationDialog(String(localized: "Möchtest du deine Änderungen wirklich verwerfen?"), isPresented: $confirmDiscard, titleVisibility: .visible) {
                    Button(String(localized: "Änderungen verwerfen"), role: .destructive) { dismiss() }
                }
            if mode == .crop {
                HStack(spacing: 0) {
                    capsuleItem("arrow.left.and.right.righttriangle.left.righttriangle.right") { session.state.mirrored.toggle() }
                    capsuleItem("rotate.left") { rotate() }
                }
                .glassEffect(.regular.interactive(), in: .capsule)
                Spacer()
                HStack(spacing: 0) {
                    Menu {
                        Picker(String(localized: "Format"), selection: $aspect) { ForEach(AspectChoice.allCases) { Text($0.title).tag($0) } }
                    } label: { capsuleLabel("aspectratio") }
                    Menu {
                        Button(String(localized: "Zuschneiden zurücksetzen"), systemImage: "arrow.counterclockwise") {
                            withAnimation {
                                session.state.crop = EditState.unit; session.state.angle = 0; session.state.mirrored = false
                                session.state.straighten = 0; session.state.perspV = 0; session.state.perspH = 0; aspect = .free
                            }
                        }
                    } label: { capsuleLabel("ellipsis") }
                }
                .glassEffect(.regular.interactive(), in: .capsule)
            } else {
                if session.hasDepth {
                    Button { withAnimation(.snappy) { depthMode.toggle(); mode = .adjust } } label: {
                        Text(portraitActive ? "ƒ " + Self.fText(session.state.aperture ?? 4.5) : "ƒ")
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(portraitActive ? Color.black : .white)
                            .padding(.horizontal, 12).frame(height: 46)
                            .background { if portraitActive { Capsule().fill(Color.yellow) } }
                    }
                    .glassEffect(.regular.interactive(), in: .capsule)
                    .accessibilityLabel(String(localized: "Porträt-Blende"))
                }
                HStack(spacing: 0) {
                    capsuleItem("arrow.uturn.backward", disabled: undo.isEmpty) { undoStep() }
                    capsuleItem("arrow.uturn.forward", disabled: redo.isEmpty) { redoStep() }
                }
                .glassEffect(.regular.interactive(), in: .capsule)
                Spacer()
                Menu { moreMenu } label: { capsuleLabel("ellipsis").frame(width: 46) }
                    .glassEffect(.regular.interactive(), in: .circle)
            }
            Button {
                Task {
                    if let a = try? await session.save() { onDone(a) }
                    dismiss()
                }
            } label: {
                Image(systemName: "checkmark").font(.system(size: 18, weight: .bold))
                    .foregroundStyle(session.changed ? Color.black : .white.opacity(0.4)).frame(width: 46, height: 46).contentShape(.rect)
                    .background { if session.changed { Circle().fill(Color.yellow) } }
            }
            .glassEffect(.regular.interactive(), in: .circle)
            .disabled(!session.changed || session.saving)
        }
        .foregroundStyle(.white)
        .padding(.horizontal, 16).padding(.top, 6).padding(.bottom, 8)
        .opacity(scrubbing ? 0 : 1)
    }

    @ViewBuilder private var moreMenu: some View {
        Button(String(localized: "Änderungen kopieren"), systemImage: "slider.horizontal.below.square.and.square.filled") { EditSession.copyEdits(session.state) }
            .disabled(!session.state.hasColor)
        Button(String(localized: "Änderungen einsetzen"), systemImage: "slider.horizontal.below.square.filled.and.square") {
            if let c = EditSession.copiedEdits { session.state.pasteColor(from: c) }
        }
        .disabled(EditSession.copiedEdits == nil)
        Divider()
        Button(String(localized: "Markieren"), systemImage: "pencil.tip.crop.circle") { markingUp = true }
        if session.state.markup != nil {
            Button(String(localized: "Markierungen entfernen"), systemImage: "pencil.slash", role: .destructive) {
                session.state.markup = nil; session.state.markupCanvas = nil
            }
        }
        Divider()
        Button("Bearbeitungen kopieren", systemImage: "doc.on.doc") {
            app.toast(EditClipboard.copy(session.state) ? String(localized: "Bearbeitungen kopiert") : String(localized: "Nur Licht, Farbe, Filter und Stil lassen sich kopieren"))
        }
        .disabled(!(session.state.hasColor || session.state.auto))
        if let clip = EditClipboard.current {
            Button("Bearbeitungen einsetzen", systemImage: "doc.on.clipboard") {
                withAnimation {
                    EditClipboard.apply(clip, to: &session.state) { session.base.map { session.renderer.autoValues(for: $0) } ?? [:] }
                }
            }
        }
        Divider()
        Button(String(localized: "Als Duplikat sichern"), systemImage: "plus.square.on.square") {
            Task {
                if (try? await session.saveAsDuplicate()) != nil { app.toast(String(localized: "Als Duplikat gesichert")) }
                dismiss()
            }
        }
        .disabled(!session.changed)
        Divider()
        Button(String(localized: "Widerrufen"), systemImage: "arrow.uturn.backward") { undoStep() }.disabled(undo.isEmpty)
        Button(String(localized: "Wiederholen"), systemImage: "arrow.uturn.forward") { redoStep() }.disabled(redo.isEmpty)
        if session.changed || session.canRestore {
            Divider()
            if session.changed {
                Button(String(localized: "Alle Änderungen verwerfen"), systemImage: "arrow.counterclockwise") {
                    withAnimation { session.state = session.initial }
                }
            }
            if session.canRestore {
                Button(String(localized: "Original wiederherstellen"), systemImage: "arrow.uturn.backward.circle", role: .destructive) { confirmRestore = true }
            }
        }
    }

    private func undoStep() {
        guard let prev = undo.popLast() else { return }
        redo.append(session.state); committed = prev
        withAnimation(.snappy) { session.state = prev }
    }
    private func redoStep() {
        guard let next = redo.popLast() else { return }
        undo.append(session.state); committed = next
        withAnimation(.snappy) { session.state = next }
    }

    private func circle(_ icon: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: icon).font(.system(size: 18, weight: .semibold)).frame(width: 46, height: 46).contentShape(.rect)
        }
        .glassEffect(.regular.interactive(), in: .circle)
    }
    private func capsuleItem(_ icon: String, disabled: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) { capsuleLabel(icon) }.disabled(disabled).opacity(disabled ? 0.4 : 1)
    }
    private func capsuleLabel(_ icon: String) -> some View {
        Image(systemName: icon).font(.system(size: 18, weight: .semibold)).frame(width: 50, height: 46)
    }

    // MARK: Werkzeuge

    @ViewBuilder private var controls: some View {
        switch mode {
        case .adjust: if depthMode && session.hasDepth { depthControls } else { adjustControls }
        case .filter: filterControls
        case .styles: styleControls
        case .live: liveControls
        case .cleanup: cleanupControls
        case .crop: cropControls
        }
    }

    /// Wie Fotos: der Knopf in der Mitte ist der aktive Regler. Wischen wählt, Tippen auf die Mitte schaltet aus/ein,
    /// beim Schieben verschwindet alles außer dem aktiven Knopf und dem Lineal.
    private var adjustControls: some View {
        let item = current ?? .adjust(.exposure)
        let s = session.state
        return VStack(spacing: 14) {
            Text(item.title.uppercased())
                .font(.system(size: 15, weight: .medium)).foregroundStyle(.secondary)
                .contentTransition(.opacity)
            ScrollView(.horizontal) {
                HStack(spacing: dialSpacing) {
                    ForEach(DialItem.all, id: \.self) { d in
                        AdjustDial(item: d, state: s, centered: d == item)
                            .contentShape(Circle())
                            .onTapGesture {
                                if d == item { toggle(d) } else { withAnimation(.snappy) { current = d } }
                            }
                            .opacity(scrubbing && d != item ? 0 : 1)
                    }
                }
                .scrollTargetLayout()
            }
            .contentMargins(.horizontal, max(0, (dialWidth - AdjustDial.size) / 2), for: .scrollContent)
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { dialWidth = $0 }
            .scrollTargetBehavior(.viewAligned)
            .scrollPosition(id: $current, anchor: .center)
            .scrollIndicators(.hidden)
            .scrollDisabled(scrubbing)
            .frame(height: AdjustDial.size + 4)
            .sensoryFeedback(.selection, trigger: current)
            .onAppear {
                // scrollPosition springt beim ersten Aufbau nicht von selbst zum gewählten Knopf
                let start = current ?? .adjust(.exposure); current = nil
                Task { @MainActor in current = start }
            }
            TickScrubber(value: scrubBinding(item), range: item.range, enabled: isOn(item)) { scrubbing = $0 }
                .frame(height: 44)
        }
        .padding(.vertical, 12)
    }

    private let dialSpacing: CGFloat = 20

    private func isOn(_ d: DialItem) -> Bool {
        switch d {
        case .auto: session.state.auto
        case .adjust(let a): !session.state.disabled.contains(a)
        }
    }
    private func toggle(_ d: DialItem) {
        switch d {
        case .auto: session.toggleAuto()
        case .adjust(let a):
            // Wie Apple: nur ein Regler mit Wert lässt sich aus- und wieder einschalten
            guard session.state.storedValue(a) != 0 else { return }
            if session.state.disabled.contains(a) { session.state.disabled.remove(a) } else { session.state.disabled.insert(a) }
        }
    }
    private func scrubBinding(_ d: DialItem) -> Binding<Double> {
        switch d {
        case .auto:
            return Binding(get: { session.state.autoStrength },
                           set: { if !session.state.auto { session.toggleAuto() }; session.state.autoStrength = $0 })
        case .adjust(let a):
            return Binding(get: { session.state.storedValue(a) },
                           set: { session.state.disabled.remove(a); session.state.values[a] = $0 })
        }
    }

    private var filterControls: some View {
        VStack(spacing: 10) {
            filterStrip
            if session.state.filter != .original {
                Text("\(session.state.filter.title.uppercased())  \(Int((session.state.filterAmount * 100).rounded()))")
                    .font(.system(size: 13, weight: .semibold)).foregroundStyle(.secondary)
                TickScrubber(value: $session.state.filterAmount, range: 0...1) { scrubbing = $0 }.frame(height: 40)
            }
        }
    }

    private var filterStrip: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 10) {
                ForEach(PhotoFilter.allCases) { f in
                    Button { session.state.filter = f } label: {
                        VStack(spacing: 6) {
                            Group {
                                if let t = session.filterThumbs[f] { Image(uiImage: t).resizable().scaledToFill() } else { Color(white: 0.15) }
                            }
                            .frame(width: 72, height: 72).clipShape(RoundedRectangle(cornerRadius: 10))
                            .overlay(RoundedRectangle(cornerRadius: 10).stroke(session.state.filter == f ? Color.yellow : .clear, lineWidth: 2.5))
                            Text(f.title).font(.system(size: 11, weight: .medium))
                                .foregroundStyle(session.state.filter == f ? .yellow : .secondary).lineLimit(1)
                        }
                        .frame(width: 80)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 16)
        }
        .scrollIndicators(.hidden)
        .padding(.vertical, 14)
    }

    /// Bereinigen wie Apple: über Störendes wischen, der Server füllt die Stelle passend auf.
    private var cleanupControls: some View {
        VStack(spacing: 10) {
            Text(session.cleanError ?? (session.state.cleanup.isEmpty ? String(localized: "Über ein Objekt wischen, um es zu entfernen")
                                                                         : String(localized: "\(session.state.cleanup.count) entfernt · Widerrufen oben links")))
                .font(.system(size: 13, weight: .semibold)).foregroundStyle(session.cleanError == nil ? Color.secondary : .orange)
                .multilineTextAlignment(.center).padding(.horizontal, 20)
            HStack(spacing: 14) {
                Image(systemName: "circle.fill").font(.system(size: 8))
                Slider(value: $brush, in: 0.02...0.15)
                Image(systemName: "circle.fill").font(.system(size: 20))
            }
            .foregroundStyle(.secondary).padding(.horizontal, 40)
            Text(String(localized: "PINSELGRÖSSE")).font(.system(size: 11, weight: .semibold)).foregroundStyle(.secondary)
        }
        .padding(.vertical, 12)
    }

    /// Live Photo: Schlüsselbild aus dem Video wählen (wie Apple), „Original“ springt zurück zum Foto.
    private var liveControls: some View {
        VStack(spacing: 12) {
            Text(session.state.keyFrame == nil ? String(localized: "SCHLÜSSELBILD: ORIGINAL") : String(localized: "NEUES SCHLÜSSELBILD"))
                .font(.system(size: 13, weight: .semibold)).foregroundStyle(.secondary)
            GeometryReader { g in
                let w = g.size.width, d = max(session.liveDuration, 0.01)
                ZStack(alignment: .leading) {
                    HStack(spacing: 0) {
                        ForEach(Array(session.liveFrames.enumerated()), id: \.offset) { _, f in
                            Image(uiImage: f).resizable().scaledToFill()
                                .frame(width: w / CGFloat(max(1, session.liveFrames.count)), height: 52).clipped()
                        }
                    }
                    .frame(width: w, height: 52).clipShape(RoundedRectangle(cornerRadius: 6))
                    if let k = session.state.keyFrame {
                        RoundedRectangle(cornerRadius: 4).stroke(Color.yellow, lineWidth: 3)
                            .frame(width: 34, height: 60).offset(x: CGFloat(k / d) * (w - 34))
                    }
                }
                .contentShape(Rectangle())
                .gesture(DragGesture(minimumDistance: 0).onEnded { v in
                    let t = max(0, min(d, Double(v.location.x / w) * d))
                    Task { await session.useKeyFrame(t) }
                })
            }
            .frame(height: 60).padding(.horizontal, 20)
            if session.liveFrames.isEmpty { ProgressView().tint(.white) }
            Button(String(localized: "Original-Schlüsselbild")) { Task { await session.useKeyFrame(nil) } }
                .font(.system(size: 13, weight: .semibold)).foregroundStyle(.yellow)
                .disabled(session.state.keyFrame == nil)
        }
        .padding(.vertical, 10)
    }

    /// Fotografische Stile wie Apple: Vorlagen, Steuerfeld (Ton ↕, Farbe ↔) und Palette.
    private var styleControls: some View {
        VStack(spacing: 10) {
            ScrollView(.horizontal) {
                HStack(spacing: 10) {
                    ForEach(PhotoStyle.allCases) { st in
                        Button { withAnimation(.snappy) { session.state.style = st } } label: {
                            VStack(spacing: 5) {
                                Group {
                                    if let t = session.styleThumbs[st] { Image(uiImage: t).resizable().scaledToFill() } else { Color(white: 0.15) }
                                }
                                .frame(width: 58, height: 58).clipShape(RoundedRectangle(cornerRadius: 10))
                                .overlay(RoundedRectangle(cornerRadius: 10).stroke(session.state.style == st ? Color.yellow : .clear, lineWidth: 2.5))
                                Text(st.title).font(.system(size: 10, weight: .medium)).lineLimit(1)
                                    .foregroundStyle(session.state.style == st ? .yellow : .secondary)
                            }
                            .frame(width: 70)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, 16)
            }
            .scrollIndicators(.hidden)
            HStack(spacing: 18) {
                StylePad(tone: $session.state.styleTone, color: $session.state.styleColor) { scrubbing = $0 }
                    .frame(width: 104, height: 104)
                VStack(alignment: .leading, spacing: 6) {
                    Text(String(localized: "PALETTE  \(Int((session.state.stylePalette * 100).rounded()))"))
                        .font(.system(size: 12, weight: .semibold)).foregroundStyle(.secondary)
                    TickScrubber(value: $session.state.stylePalette, range: 0...1) { scrubbing = $0 }.frame(height: 40)
                    Text(String(format: String(localized: "Ton %+d · Farbe %+d"), Int(session.state.styleTone * 100), Int(session.state.styleColor * 100)))
                        .font(.system(size: 11)).foregroundStyle(.secondary)
                    Button(String(localized: "Zurücksetzen")) {
                        withAnimation {
                            session.state.styleTone = 0; session.state.styleColor = 0; session.state.stylePalette = 1
                            session.state.styleTexture = 0; session.state.styleGrain = 0
                        }
                    }
                    .font(.system(size: 12, weight: .semibold)).foregroundStyle(.yellow)
                }
            }
            .padding(.horizontal, 20)
            // Fotografische Stile 3: Textur und Körnung
            HStack(spacing: 16) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(String(localized: "TEXTUR  \(Int((session.state.styleTexture * 100).rounded()))"))
                        .font(.system(size: 12, weight: .semibold)).foregroundStyle(.secondary)
                    TickScrubber(value: $session.state.styleTexture, range: -1...1) { scrubbing = $0 }.frame(height: 40)
                }
                VStack(alignment: .leading, spacing: 4) {
                    Text(String(localized: "KÖRNUNG  \(Int((session.state.styleGrain * 100).rounded()))"))
                        .font(.system(size: 12, weight: .semibold)).foregroundStyle(.secondary)
                    TickScrubber(value: $session.state.styleGrain, range: 0...1) { scrubbing = $0 }.frame(height: 40)
                }
            }
            .padding(.horizontal, 20)
        }
        .padding(.vertical, 8)
    }

    /// Porträt: Blende wie Apple (ƒ1,4 … ƒ16), Tippen auf den Knopf schaltet die Tiefenunschärfe aus/ein.
    private var portraitActive: Bool { session.state.aperture != nil && !session.state.portraitOff }

    /// Porträt wie in Fotos: Schalter „PORTRÄT“ (merkt sich alles), Blende in Drittelstufen mit „AUS“, Porträtlicht mit Stärke.
    private var depthControls: some View {
        VStack(spacing: 12) {
            HStack(spacing: 14) {
                Button {
                    withAnimation(.snappy) {
                        if session.state.aperture == nil { session.state.aperture = 4.5; session.state.portraitOff = false }
                        else { session.state.portraitOff.toggle() }
                    }
                } label: {
                    Text(String(localized: "PORTRÄT")).font(.system(size: 13, weight: .bold))
                        .foregroundStyle(portraitActive ? Color.black : .white)
                        .padding(.horizontal, 14).frame(height: 30)
                        .background(Capsule().fill(portraitActive ? Color.yellow : Color(white: 0.2)))
                }
                .buttonStyle(.plain)
                .accessibilityLabel(String(localized: "Porträtsteuerungen"))
                // Unterbereiche: Licht | Blende (Licht nur mit Personen-Maske, wie Fotos)
                if session.hasMatte {
                    Picker("", selection: $portraitPane) {
                        Image(systemName: "cube.transparent").tag(PortraitPane.light)
                        Text(session.state.aperture.map { "ƒ " + Self.fText($0) } ?? "ƒ").tag(PortraitPane.aperture)
                    }
                    .pickerStyle(.segmented).frame(width: 150)
                }
            }
            if portraitPane == .aperture || !session.hasMatte {
                Text(portraitActive ? String(localized: "Tippe ins Foto, um den Fokus zu setzen") : String(localized: "Porträt ist aus"))
                    .font(.system(size: 12)).foregroundStyle(.secondary)
                ApertureDial(value: Binding(get: { portraitActive ? session.state.aperture : nil },
                                            set: { f in
                                                if let f { session.state.aperture = f; session.state.portraitOff = false }
                                                else { session.state.portraitOff = true }   // „AUS“ = ganzes Porträt aus
                                            })) { scrubbing = $0 }
                    .frame(height: 56)
            } else {
                lightControls
            }
        }
        .padding(.vertical, 10)
    }

    @ViewBuilder private var lightControls: some View {
        let light = session.state.light
        Text(light.title).font(.system(size: 12, weight: .bold)).foregroundStyle(.yellow)
        ScrollView(.horizontal) {
            HStack(spacing: 10) {
                ForEach(PortraitLight.allCases) { l in
                    Button {
                        withAnimation(.snappy) {
                            session.state.light = l
                            if session.state.aperture == nil { session.state.aperture = 4.5 }
                            session.state.portraitOff = false   // Effekt wählen schaltet das Porträt wieder ein (wie Fotos)
                        }
                    } label: {
                        Image(systemName: l.symbol).font(.system(size: 18))
                            .foregroundStyle(light == l && portraitActive ? Color.black : .white)
                            .frame(width: 48, height: 48)
                            .background(Circle().fill(light == l && portraitActive ? Color.yellow : Color(white: 0.18)))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(l.title)
                }
            }
            .padding(.horizontal, 20)
        }
        .scrollIndicators(.hidden)
        if light != .natural {
            TickScrubber(value: Binding(get: { session.state.strength(light) },
                                        set: { session.state.lightStrength[light] = max(0, min(1, $0)) }),
                         range: 0...1, enabled: portraitActive) { scrubbing = $0 }
                .frame(height: 40)
        }
    }

    /// Tippunkt (Anzeige, nach Zuschnitt) → Punkt im unbearbeiteten Bild, Rahmen kurz zeigen
    private func setFocus(_ p: CGPoint, in size: CGSize) {
        guard size.width > 0, size.height > 0 else { return }
        let u = p.x / size.width, v = p.y / size.height
        guard (0...1).contains(u), (0...1).contains(v) else { return }
        let c = session.state.crop
        session.state.focus = CGPoint(x: c.minX + u * c.width, y: c.minY + v * c.height)
        withAnimation(.snappy) { focusMark = p }
        Task { try? await Task.sleep(for: .seconds(1.2)); withAnimation { focusMark = nil } }
    }

    /// „4.5“, „16“ – Punkt als Trenner auch auf Deutsch, ab 10 ohne Nachkommastelle (wie Fotos)
    static func fText(_ f: Double) -> String { f >= 10 ? String(Int(f.rounded())) : String(format: "%.1f", locale: Locale(identifier: "en_US_POSIX"), f) }

    /// Begradigen / Perspektive vertikal / horizontal – runde Knöpfe + Lineal wie bei Apple.
    private var cropControls: some View {
        VStack(spacing: 14) {
            HStack(spacing: 10) {
                Text(L(geo.rawValue).uppercased() + "  " + geoValueText)
                    .font(.system(size: 13, weight: .semibold)).foregroundStyle(.secondary)
                // wie Apple: „AUTO“ richtet den Horizont aus
                Button {
                    Task {
                        if let a = await session.suggestedStraighten() {
                            withAnimation(.snappy) { session.state.straighten = max(-45, min(45, a)); geo = .straighten }
                            straightenNote = nil
                        } else { straightenNote = String(localized: "Kein schiefer Horizont gefunden") }
                    }
                } label: {
                    Text("AUTO").font(.system(size: 12, weight: .bold)).foregroundStyle(.yellow)
                        .padding(.horizontal, 10).frame(height: 24)
                        .overlay(Capsule().stroke(Color.yellow, lineWidth: 1.2))
                }
                .buttonStyle(.plain)
            }
            if let n = straightenNote { Text(n).font(.system(size: 12)).foregroundStyle(.secondary) }
            HStack(spacing: 18) {
                ForEach(Geo.allCases, id: \.self) { g in
                    Button { geo = g } label: {
                        Image(systemName: g == .straighten ? "level" : g == .vertical ? "trapezoid.and.line.vertical" : "trapezoid.and.line.horizontal")
                            .font(.system(size: 19))
                            .foregroundStyle(geo == g ? .yellow : .white)
                            .frame(width: 52, height: 52)
                            .background(Circle().fill(Color(white: 0.15)))
                            .overlay { if geoValue(g) != 0 { Circle().stroke(Color.white, lineWidth: 2) } }
                    }
                    .buttonStyle(.plain)
                }
            }
            TickScrubber(value: Binding(get: { geoValue(geo) }, set: { setGeo(geo, $0) })).frame(height: 44)
        }
        .padding(.vertical, 12)
        .onChange(of: aspect) { applyAspect() }
    }

    private func geoValue(_ g: Geo) -> Double {
        switch g {
        case .straighten: session.state.straighten / 45
        case .vertical: session.state.perspV
        case .horizontal: session.state.perspH
        }
    }
    private func setGeo(_ g: Geo, _ v: Double) {
        switch g {
        case .straighten: session.state.straighten = (v * 45).rounded()
        case .vertical: session.state.perspV = v
        case .horizontal: session.state.perspH = v
        }
    }
    private var geoValueText: String {
        geo == .straighten ? (session.state.straighten == 0 ? "" : "\(Int(session.state.straighten))°") : valueText(geoValue(geo))
    }

    /// Schmale Kapsel in der Mitte, gewählter Modus mit gelbem Punkt darüber (wie iOS 26).
    private var modeBar: some View {
        HStack(spacing: 6) {
            ForEach(Mode.allCases.filter { $0 != .live || asset.isLivePhoto }, id: \.self) { m in
                Button { withAnimation(.snappy) { mode = m } } label: {
                    VStack(spacing: 3) {
                        Image(systemName: "arrowtriangle.down.fill").font(.system(size: 7))
                            .foregroundStyle(.yellow).opacity(mode == m ? 1 : 0)
                        Image(systemName: m == .live ? "livephoto" : m == .cleanup ? "eraser" : m == .adjust ? "dial.medium.fill" : m == .filter ? "camera.filters"
                              : m == .styles ? "square.grid.2x2.fill" : "crop.rotate")
                            .font(.system(size: 20))
                        Text(L(m.rawValue)).font(.system(size: 12, weight: .medium))
                    }
                    .foregroundStyle(mode == m ? Color.white : .secondary)
                    .padding(.horizontal, 10).frame(height: 62)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 12)
        .glassEffect(.regular, in: .capsule)
        .padding(.bottom, 6)
    }

    private func valueText(_ v: Double) -> String { v == 0 ? "" : String(Int((v * 100).rounded())) }

    private func rotate() {
        // Apple dreht gegen den Uhrzeigersinn → im Uhrzeigersinn 270°
        withAnimation(.snappy) { session.state.angle = (session.state.angle + 270) % 360 }
    }

    private func applyAspect() {
        guard let img = session.fullPreview, let r = aspect.ratio(img.size) else { return }
        // größtmöglicher Ausschnitt im gewünschten Format, mittig
        let W = img.size.width, H = img.size.height
        var w = W, h = W / r
        if h > H { h = H; w = H * r }
        session.state.displayCrop = CGRect(x: (1 - w / W) / 2, y: (1 - h / H) / 2, width: w / W, height: h / H)
    }
}

extension EditSession {
    /// Für „gedrückt halten = Original zeigen“
    var fullOriginal: UIImage? {
        guard let base, let cg = renderer.cgImage(base) else { return nil }
        return UIImage(cgImage: cg)
    }
}

enum AspectChoice: String, CaseIterable, Identifiable {
    case free, original, square, r916, r45, r57, r34, r35, r23
    var id: String { rawValue }
    var title: String {
        switch self {
        case .free: String(localized: "Frei"); case .original: String(localized: "Original"); case .square: String(localized: "Quadrat"); case .r916: "9:16"
        case .r45: "4:5"; case .r57: "5:7"; case .r34: "3:4"; case .r35: "3:5"; case .r23: "2:3"
        }
    }
    /// Breite/Höhe; Hochformat-Verhältnisse kippen bei Querformat-Bildern mit.
    func ratio(_ size: CGSize) -> CGFloat? {
        let land = size.width > size.height
        func r(_ a: CGFloat, _ b: CGFloat) -> CGFloat { land ? b / a : a / b }
        switch self {
        case .free: return nil
        case .original: return size.width / size.height
        case .square: return 1
        case .r916: return r(9, 16); case .r45: return r(4, 5); case .r57: return r(5, 7)
        case .r34: return r(3, 4); case .r35: return r(3, 5); case .r23: return r(2, 3)
        }
    }
}

/// Eintrag in der Reglerreihe: zuerst „Auto“, dann die 15 Regler.
enum DialItem: Hashable {
    case auto
    case adjust(Adjust)
    static let all: [DialItem] = [.auto] + Adjust.allCases.map(DialItem.adjust)
    var title: String {
        switch self { case .auto: String(localized: "Auto"); case .adjust(let a): a.title }
    }
    var range: ClosedRange<Double> {
        switch self { case .auto: -1...1; case .adjust(let a): a.range }
    }
}

/// Runder Regler-Knopf wie in Fotos: grauer Ring, bei Wert ≠ 0 gelber Bogen (Auto-Vorschlag: weißer Bogen),
/// der Knopf in der Mitte zeigt statt des Symbols die Zahl. Ausgeschaltet = blass.
struct AdjustDial: View {
    static let size: CGFloat = 50
    let item: DialItem
    let state: EditState
    let centered: Bool

    var body: some View {
        Group {
            switch item {
            case .auto:
                let on = state.auto
                ZStack {
                    Circle().fill(on ? Color.white : Color(white: 0.24))
                    Image(systemName: "wand.and.sparkles").font(.system(size: 21, weight: .medium))
                        .foregroundStyle(on ? Color.black : .white)
                }
            case .adjust(let a):
                let on = !state.disabled.contains(a)
                let v = state.storedValue(a)
                let tint: Color = state.isAuto(a) ? .white : .yellow
                ZStack {
                    Circle().fill(Color(white: 0.11))
                    if v != 0 && on {
                        Circle().stroke(tint.opacity(0.3), lineWidth: 2)
                        Circle().trim(from: 0, to: abs(v))
                            .stroke(tint, style: StrokeStyle(lineWidth: 2.5, lineCap: .round))
                            .rotationEffect(.degrees(-90))
                            .scaleEffect(x: v < 0 ? -1 : 1)
                    } else {
                        Circle().stroke(Color(white: 0.42), lineWidth: 2)
                    }
                    if centered && v != 0 && on {
                        Text("\(Int((v * 100).rounded()))").font(.system(size: 17, weight: .regular).monospacedDigit())
                            .foregroundStyle(tint)
                    } else {
                        AdjustGlyph(adjust: a).frame(width: 21, height: 21)
                    }
                }
                .opacity(on ? 1 : 0.35)
            }
        }
        .frame(width: Self.size, height: Self.size)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(item.title)
        .accessibilityAddTraits(.isButton)
    }
}

/// Die Symbole aus Fotos, wo es kein passendes SF-Symbol gibt, selbst gezeichnet.
struct AdjustGlyph: View {
    let adjust: Adjust
    private let line: CGFloat = 1.4

    var body: some View {
        switch adjust {
        case .exposure: sf("plusminus.circle")
        case .brilliance:
            GeometryReader { g in
                let d = g.size.width, bg = Color(white: 0.11)
                ZStack {
                    Rectangle().fill(.white).frame(width: d / 2, height: d).offset(x: d / 4)
                    Circle().fill(.white).frame(width: d / 2, height: d / 2).offset(y: -d / 4)
                    Circle().fill(bg).frame(width: d / 2, height: d / 2).offset(y: d / 4)
                    Circle().fill(bg).frame(width: d / 7, height: d / 7).offset(y: -d / 4)
                    Circle().fill(.white).frame(width: d / 7, height: d / 7).offset(y: d / 4)
                }
                .frame(width: d, height: d)
                .clipShape(Circle())
                .overlay(Circle().stroke(.white, lineWidth: line))
            }
        case .highlights: halfCircle(leftStriped: true, rightFilled: false)
        case .shadows: halfCircle(leftStriped: false, rightFilled: true)
        case .contrast: sf("circle.lefthalf.filled")
        case .brightness: sf("sun.min.fill")
        case .blackPoint:
            ZStack { Circle().fill(.white); Circle().fill(Color(white: 0.11)).frame(width: 6, height: 6) }
        case .saturation:
            Circle().fill(LinearGradient(colors: Self.rainbow, startPoint: .leading, endPoint: .trailing))
        case .vibrance:
            Canvas { ctx, size in
                let n = 9, w = size.width / CGFloat(n)
                ctx.clip(to: Path(ellipseIn: CGRect(origin: .zero, size: size)))
                for i in 0..<n {
                    let c = Self.rainbow[i * (Self.rainbow.count - 1) / (n - 1)]
                    ctx.fill(Path(CGRect(x: CGFloat(i) * w + w * 0.25, y: 0, width: w * 0.5, height: size.height)), with: .color(c))
                }
            }
        case .warmth: sf("thermometer.medium")
        case .tint: sf("drop.halffull")
        case .sharpness: sf("righttriangle.fill")
        case .definition: sf("righttriangle")
        case .noiseReduction:
            Canvas { ctx, size in
                let r = CGRect(origin: .zero, size: size)
                ctx.stroke(Path(ellipseIn: r.insetBy(dx: line / 2, dy: line / 2)), with: .color(.white), lineWidth: line)
                // untere rechte Hälfte gerastert
                var half = Path(); half.move(to: CGPoint(x: size.width, y: 0)); half.addLine(to: CGPoint(x: 0, y: size.height))
                half.addLine(to: CGPoint(x: size.width, y: size.height)); half.closeSubpath()
                ctx.clip(to: Path(ellipseIn: r)); ctx.clip(to: half)
                let c: CGFloat = 2.2
                for yi in 0..<Int(size.height / c) + 1 {
                    for xi in 0..<Int(size.width / c) + 1 where (xi + yi) % 2 == 0 {
                        ctx.fill(Path(CGRect(x: CGFloat(xi) * c, y: CGFloat(yi) * c, width: c, height: c)), with: .color(.white))
                    }
                }
            }
        case .vignette:
            ZStack {
                Circle().stroke(.white, lineWidth: line)
                Circle().stroke(.white, style: StrokeStyle(lineWidth: line, dash: [1.4, 2])).padding(4.5)
            }
        }
    }

    static let rainbow: [Color] = [.red, .orange, .yellow, .green, .cyan, .blue, .purple, .pink]

    private func sf(_ name: String) -> some View {
        Image(systemName: name).resizable().scaledToFit().fontWeight(.medium).foregroundStyle(.white)
    }

    /// Kreis halb gestreift / halb gefüllt (Glanzlichter, Schatten).
    private func halfCircle(leftStriped: Bool, rightFilled: Bool) -> some View {
        Canvas { ctx, size in
            let r = CGRect(origin: .zero, size: size)
            ctx.stroke(Path(ellipseIn: r.insetBy(dx: line / 2, dy: line / 2)), with: .color(.white), lineWidth: line)
            ctx.clip(to: Path(ellipseIn: r))
            let leftHalf = CGRect(x: 0, y: 0, width: size.width / 2, height: size.height)
            let rightHalf = CGRect(x: size.width / 2, y: 0, width: size.width / 2, height: size.height)
            if rightFilled { ctx.fill(Path(leftHalf), with: .color(.white)) }
            let striped = leftStriped ? leftHalf : rightHalf
            var y: CGFloat = 1.5
            while y < size.height {
                ctx.fill(Path(CGRect(x: striped.minX, y: y, width: striped.width, height: 1)), with: .color(.white))
                y += 2.6
            }
            ctx.fill(Path(CGRect(x: size.width / 2 - line / 2, y: 0, width: line, height: size.height)), with: .color(.white))
        }
    }
}

/// Strich-Lineal wie in Fotos: 5er-Schritte pro Strich, lange Striche bei 0/±50/±100, nur so weit gezeichnet
/// wie der Regler reicht, grauer Punkt markiert die 0, rastet bei 0 mit Haptik ein.
struct TickScrubber: View {
    @Binding var value: Double
    var range: ClosedRange<Double> = -1...1
    var enabled = true
    var onEditing: (Bool) -> Void = { _ in }
    @State private var start: Double?

    private let spacing: CGFloat = 9      // Punkte pro Strich
    private let step = 0.05               // Wert pro Strich (= 5 von 100)

    var body: some View {
        Canvas { ctx, size in
            let mid = size.width / 2, cur = value / step
            let lo = Int((range.lowerBound / step).rounded()), hi = Int((range.upperBound / step).rounded())
            let active = start != nil
            for i in lo...hi {
                let x = mid + (CGFloat(i) - CGFloat(cur)) * spacing
                guard x > -2 && x < size.width + 2 else { continue }
                let major = i % 10 == 0
                // beim Schieben werden die Striche nahe der Mitte größer (wie bei Apple)
                let boost = active ? max(0, 1 - abs(x - mid) / 40) * 10 : 0
                let h: CGFloat = (major ? 22 : 16) + boost
                ctx.fill(Path(CGRect(x: x - 0.9, y: size.height - 6 - h, width: 1.8, height: h)),
                         with: .color(.white.opacity(major ? 0.75 : 0.42)))
            }
            if value != 0 {
                let x0 = mid - CGFloat(cur) * spacing
                if x0 > 0 && x0 < size.width { ctx.fill(Path(ellipseIn: CGRect(x: x0 - 3, y: 0, width: 6, height: 6)), with: .color(.gray)) }
            }
            // Mittelstrich: weiß bei 0, gelb sobald ein Wert gesetzt ist (wie Apple)
            ctx.fill(Path(CGRect(x: mid - 1.25, y: 4, width: 2.5, height: size.height - 10)),
                     with: .color(value != 0 ? .yellow : .white))
        }
        .mask(LinearGradient(stops: [.init(color: .clear, location: 0), .init(color: .black, location: 0.12),
                                     .init(color: .black, location: 0.88), .init(color: .clear, location: 1)],
                             startPoint: .leading, endPoint: .trailing))
        .opacity(enabled || start != nil ? 1 : 0.45)
        .contentShape(Rectangle())
        .gesture(DragGesture(minimumDistance: 0)
            .onChanged { g in
                if start == nil { start = value; onEditing(true) }
                var v = (start ?? 0) - Double(g.translation.width / spacing) * step
                v = min(range.upperBound, max(range.lowerBound, v))
                if abs(v) < 0.02 { v = 0 }
                value = (v * 100).rounded() / 100
            }
            .onEnded { _ in start = nil; onEditing(false) })
        .sensoryFeedback(.impact(weight: .light), trigger: value == 0) { _, isZero in isZero }
    }
}

/// Zuschnitt-Rahmen mit Eck-Griffen über dem ganzen (gedrehten) Bild.
struct CropCanvas: View {
    let image: UIImage
    let crop: CGRect                 // normiert, in Anzeige-Koordinaten
    let aspect: CGFloat?
    let onChange: (CGRect) -> Void
    @State private var startRect: CGRect?

    var body: some View {
        GeometryReader { geo in
            let fit = fitted(image.size, in: geo.size)
            let frame = CGRect(x: fit.minX + crop.minX * fit.width, y: fit.minY + crop.minY * fit.height,
                               width: crop.width * fit.width, height: crop.height * fit.height)
            ZStack(alignment: .topLeading) {
                Image(uiImage: image).resizable().frame(width: fit.width, height: fit.height).offset(x: fit.minX, y: fit.minY)
                // abgedunkelter Bereich außerhalb des Rahmens
                Color.black.opacity(0.6)
                    .mask {
                        ZStack(alignment: .topLeading) {
                            Rectangle()
                            Rectangle().frame(width: frame.width, height: frame.height)
                                .offset(x: frame.minX, y: frame.minY).blendMode(.destinationOut)
                        }
                        .compositingGroup()
                    }
                    .allowsHitTesting(false)
                // Drittel-Raster + Rahmen
                Path { p in
                    for i in 1...2 {
                        let x = frame.minX + frame.width * CGFloat(i) / 3, y = frame.minY + frame.height * CGFloat(i) / 3
                        p.move(to: CGPoint(x: x, y: frame.minY)); p.addLine(to: CGPoint(x: x, y: frame.maxY))
                        p.move(to: CGPoint(x: frame.minX, y: y)); p.addLine(to: CGPoint(x: frame.maxX, y: y))
                    }
                }
                .stroke(Color.white.opacity(0.35), lineWidth: 0.7).allowsHitTesting(false)
                Rectangle().stroke(Color.white, lineWidth: 1.5).frame(width: frame.width, height: frame.height)
                    .offset(x: frame.minX, y: frame.minY).allowsHitTesting(false)
                ForEach(0..<4, id: \.self) { corner in
                    handle(corner, frame: frame, fit: fit)
                }
            }
        }
    }

    private func handle(_ c: Int, frame: CGRect, fit: CGRect) -> some View {
        let x = c % 2 == 0 ? frame.minX : frame.maxX, y = c < 2 ? frame.minY : frame.maxY
        return Corner(index: c)
            .frame(width: 44, height: 44)
            .contentShape(Rectangle())
            .position(x: x, y: y)
            .gesture(DragGesture()
                .onChanged { g in
                    if startRect == nil { startRect = crop }
                    guard var r = startRect else { return }
                    let dx = g.translation.width / fit.width, dy = g.translation.height / fit.height
                    let minS: CGFloat = 0.08
                    if c % 2 == 0 { let nx = min(max(0, r.minX + dx), r.maxX - minS); r.size.width = r.maxX - nx; r.origin.x = nx }
                    else { r.size.width = min(max(minS, r.width + dx), 1 - r.minX) }
                    if c < 2 { let ny = min(max(0, r.minY + dy), r.maxY - minS); r.size.height = r.maxY - ny; r.origin.y = ny }
                    else { r.size.height = min(max(minS, r.height + dy), 1 - r.minY) }
                    if let a = aspect {
                        // Format halten: Höhe aus Breite ableiten (im Pixel-Verhältnis des Bildes)
                        let wantH = r.width * fit.width / a / fit.height
                        if c < 2 { r.origin.y = r.maxY - min(wantH, r.maxY) }
                        r.size.height = min(wantH, 1 - r.minY)
                    }
                    onChange(r)
                }
                .onEnded { _ in startRect = nil })
    }

    private func fitted(_ img: CGSize, in box: CGSize) -> CGRect {
        let s = min(box.width / img.width, box.height / img.height)
        let w = img.width * s, h = img.height * s
        return CGRect(x: (box.width - w) / 2, y: (box.height - h) / 2, width: w, height: h)
    }
}

private struct Corner: View {
    let index: Int
    var body: some View {
        Path { p in
            let l: CGFloat = 18
            p.move(to: CGPoint(x: 22, y: 22 + (index < 2 ? l : -l))); p.addLine(to: CGPoint(x: 22, y: 22))
            p.addLine(to: CGPoint(x: 22 + (index % 2 == 0 ? l : -l), y: 22))
        }
        .stroke(Color.white, style: StrokeStyle(lineWidth: 4, lineCap: .square))
    }
}


extension Double {
    func rounded(toPlaces p: Int) -> Double { let m = pow(10, Double(p)); return (self * m).rounded() / m }
}

/// Steuerfeld der Fotografischen Stile (Apple: PhotoStyleDPad): senkrecht Ton, waagerecht Farbe, Punkteraster.
struct StylePad: View {
    @Binding var tone: Double
    @Binding var color: Double
    var onEditing: (Bool) -> Void = { _ in }
    @State private var active = false

    var body: some View {
        GeometryReader { g in
            let w = g.size.width, h = g.size.height
            ZStack {
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .fill(LinearGradient(colors: [Color(white: 0.22), Color(white: 0.1)], startPoint: .top, endPoint: .bottom))
                // Punkteraster 7 × 7
                Canvas { ctx, size in
                    for i in 0..<7 { for j in 0..<7 {
                        let x = size.width * (CGFloat(i) + 0.5) / 7, y = size.height * (CGFloat(j) + 0.5) / 7
                        ctx.fill(Path(ellipseIn: CGRect(x: x - 1.2, y: y - 1.2, width: 2.4, height: 2.4)), with: .color(.white.opacity(0.35)))
                    } }
                }
                Circle().fill(Color.yellow).frame(width: active ? 22 : 16, height: active ? 22 : 16)
                    .shadow(color: .black.opacity(0.4), radius: 3)
                    .position(x: w / 2 + CGFloat(color) * (w / 2 - 12), y: h / 2 - CGFloat(tone) * (h / 2 - 12))
            }
            .contentShape(Rectangle())
            .gesture(DragGesture(minimumDistance: 0)
                .onChanged { v in
                    if !active { active = true; onEditing(true) }
                    // in kleine Schritte zerlegt: sonst meldet der Compiler im neuen SDK "ambiguous use of operator"
                    let nx: CGFloat = max(-1, min(1, (v.location.x - w / 2) / (w / 2 - 12)))
                    let ny: CGFloat = max(-1, min(1, -(v.location.y - h / 2) / (h / 2 - 12)))
                    color = Double(nx * 100).rounded() / 100
                    tone = Double(ny * 100).rounded() / 100
                }
                .onEnded { _ in active = false; onEditing(false) })
            .onTapGesture(count: 2) { withAnimation(.snappy) { tone = 0; color = 0 } }
            .sensoryFeedback(.selection, trigger: Int(tone * 10) * 100 + Int(color * 10))
        }
        .accessibilityElement()
        .accessibilityLabel(String(localized: "Steuerfeld Ton und Farbe"))
        .accessibilityValue(String(localized: "Ton \(Int(tone * 100)), Farbe \(Int(color * 100))"))
    }
}


/// Bereinigen-Fläche: zeigt das (unbearbeitete) Foto, Wischen malt halbtransparent, beim Loslassen wird entfernt.
struct CleanupCanvas: View {
    let image: UIImage
    let strokes: [CleanStroke]
    let brush: Double
    let done: (CleanStroke) -> Void
    @State private var current: [CGPoint] = []

    var body: some View {
        GeometryReader { g in
            let fit = fitted(image.size, in: g.size)
            ZStack(alignment: .topLeading) {
                Image(uiImage: image).resizable().frame(width: fit.width, height: fit.height)
                // aktueller Strich (wie Apples leuchtende Spur)
                Path { p in
                    guard let f = current.first else { return }
                    p.move(to: CGPoint(x: f.x * fit.width, y: f.y * fit.height))
                    for q in current.dropFirst() { p.addLine(to: CGPoint(x: q.x * fit.width, y: q.y * fit.height)) }
                }
                .stroke(Color.white.opacity(0.55), style: StrokeStyle(lineWidth: brush * fit.width, lineCap: .round, lineJoin: .round))
                .blendMode(.plusLighter)
            }
            .frame(width: fit.width, height: fit.height)
            .contentShape(Rectangle())
            .gesture(DragGesture(minimumDistance: 0)
                .onChanged { v in current.append(CGPoint(x: min(1, max(0, v.location.x / fit.width)), y: min(1, max(0, v.location.y / fit.height)))) }
                .onEnded { _ in
                    if !current.isEmpty { done(CleanStroke(points: current, width: brush)) }
                    current = []
                })
            .frame(width: g.size.width, height: g.size.height)
        }
    }
    private func fitted(_ img: CGSize, in box: CGSize) -> CGSize {
        let s = min(box.width / img.width, box.height / img.height)
        return CGSize(width: img.width * s, height: img.height * s)
    }
}

enum PortraitPane { case light, aperture }

/// Blendenregler wie in Fotos: Drittelstufen ƒ1.4 … ƒ16, ganze Blenden als lange Striche, ganz rechts „AUS“ (= nil).
struct ApertureDial: View {
    @Binding var value: Double?
    var onEditing: (Bool) -> Void = { _ in }
    static let stops: [Double] = [1.4, 1.6, 1.8, 2.0, 2.2, 2.5, 2.8, 3.2, 3.5, 4.0, 4.5, 5.0, 5.6, 6.3, 7.1, 8, 9, 10, 11, 13, 14, 16]
    static let full: Set<Double> = [1.4, 2.0, 2.8, 4.0, 5.6, 8, 11, 16]
    private let spacing: CGFloat = 16
    @State private var start: (x: CGFloat, index: Int)?

    /// Index der aktuellen Stufe; stops.count = „AUS“
    private var index: Int {
        guard let v = value else { return Self.stops.count }
        return Self.stops.enumerated().min { abs($0.element - v) < abs($1.element - v) }?.offset ?? 10
    }

    var body: some View {
        Canvas { ctx, size in
            let mid = size.width / 2
            for i in 0...Self.stops.count {
                let x = mid + CGFloat(i - index) * spacing
                guard x > -10 && x < size.width + 10 else { continue }
                if i == Self.stops.count {
                    ctx.draw(Text(String(localized: "AUS")).font(.system(size: 11, weight: .bold)).foregroundColor(.white.opacity(0.8)),
                             at: CGPoint(x: x, y: size.height - 14))
                    continue
                }
                let f = Self.stops[i], major = Self.full.contains(f)
                let h: CGFloat = major ? 20 : 12
                ctx.fill(Path(CGRect(x: x - 0.9, y: size.height - 24 - h, width: 1.8, height: h)), with: .color(.white.opacity(major ? 0.8 : 0.45)))
                if major {
                    ctx.draw(Text(EditorView.fText(f)).font(.system(size: 10)).foregroundColor(.white.opacity(0.6)), at: CGPoint(x: x, y: size.height - 8))
                }
            }
            ctx.fill(Path(CGRect(x: mid - 1.25, y: 0, width: 2.5, height: size.height - 22)), with: .color(value == nil ? .white : .yellow))
        }
        .mask(LinearGradient(stops: [.init(color: .clear, location: 0), .init(color: .black, location: 0.12),
                                     .init(color: .black, location: 0.88), .init(color: .clear, location: 1)],
                             startPoint: .leading, endPoint: .trailing))
        .contentShape(Rectangle())
        .gesture(DragGesture(minimumDistance: 0)
            .onChanged { g in
                if start == nil { start = (g.startLocation.x, index); onEditing(true) }
                guard let s = start else { return }
                let i = max(0, min(Self.stops.count, s.index - Int(((g.location.x - s.x) / spacing).rounded())))
                if i != index {
                    value = i == Self.stops.count ? nil : Self.stops[i]
                    UISelectionFeedbackGenerator().selectionChanged()
                }
            }
            .onEnded { _ in start = nil; onEditing(false) })
        .accessibilityElement()
        .accessibilityLabel(String(localized: "Blendenöffnung"))
        .accessibilityValue(value.map { "ƒ " + EditorView.fText($0) } ?? String(localized: "AUS"))
        .accessibilityAdjustableAction { d in
            let i = d == .increment ? min(Self.stops.count, index + 1) : max(0, index - 1)
            value = i == Self.stops.count ? nil : Self.stops[i]
        }
    }
}
