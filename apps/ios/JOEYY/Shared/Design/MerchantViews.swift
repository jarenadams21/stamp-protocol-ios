import PhotosUI
import SwiftUI

extension MerchantTheme {
    var paper: Color { .adaptive(light: lightPaper, dark: darkPaper) }
    var ink: Color { .adaptive(light: lightInk, dark: darkInk) }
    var fontDesign: Font.Design {
        switch typeface {
        case .standard: .default
        case .rounded: .rounded
        case .serif: .serif
        case .monospaced: .monospaced
        }
    }

    var stackCoverHeight: CGFloat {
        switch artwork {
        case .rail: 180
        case .cloud: 210
        case .stone: 190
        }
    }
}

struct MerchantCover: View {
    let place: Place
    var canRetry = true
    var poster = false
    @Environment(MerchantBrandingStore.self) private var branding
    @State private var image: UIImage?
    @State private var failure: String?
    @State private var retry = 0

    private var theme: MerchantTheme { branding.theme(for: place) }
    private var source: String {
        "\(branding.coverURL(for: place)?.absoluteString ?? "")-\(branding.revision(for: place)?.uuidString ?? "")-\(retry)"
    }

    var body: some View {
        GeometryReader { geometry in
            ZStack {
                if let image {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFill()
                        .frame(width: geometry.size.width, height: geometry.size.height)
                } else {
                    if poster {
                        DiscoveryArtwork(theme: theme)
                    } else {
                        MerchantArtwork(theme: theme)
                        if Place.discoverable.contains(place) {
                            Text(place.initials)
                                .font(.system(
                                    size: min(geometry.size.width, geometry.size.height) * 0.46,
                                    weight: .medium
                                ))
                                .tracking(-4)
                                .foregroundStyle(theme.ink)
                        }
                    }
                    if branding.coverURL(for: place) != nil {
                        if failure != nil && !canRetry {
                            Text("Image unavailable")
                                .font(.caption)
                                .foregroundStyle(theme.ink)
                                .padding(8)
                                .background(theme.paper)
                                .frame(maxHeight: .infinity, alignment: .bottom)
                        } else if failure == nil {
                            ProgressView().tint(theme.ink)
                        }
                    }
                }
            }
            .frame(width: geometry.size.width, height: geometry.size.height)
            .clipped()
        }
        .accessibilityHidden(true)
        .task(id: source) {
            image = nil
            failure = nil
            guard let url = branding.coverURL(for: place) else { return }
            do {
                let data = try await ArtworkLoader.shared.load(url)
                try Task.checkCancellation()
                guard let decoded = UIImage(data: data) else { throw BrandingError.invalidImage }
                image = decoded
            } catch is CancellationError {
                // A reused card no longer needs its previous image.
            } catch {
                guard !Task.isCancelled else { return }
                failure = error.localizedDescription
            }
        }
        .overlay(alignment: .bottomLeading) {
            if let failure, canRetry {
                Button {
                    retry += 1
                } label: {
                    Text("Retry image").font(.caption).padding(10)
                }
                .foregroundStyle(theme.ink)
                .frame(minHeight: 44)
                .background(theme.paper, in: RoundedRectangle(cornerRadius: 6))
                .accessibilityHint(failure)
                .accessibilityIdentifier("cover.retry.\(place.id)")
                .padding(8)
            }
        }
        .accessibilityElement(children: .contain)
    }
}

struct MerchantArtwork: View {
    let theme: MerchantTheme

    var body: some View {
        ZStack {
            theme.paper
            Canvas { context, size in
                switch theme.artwork {
                case .rail:
                    for index in 0..<7 {
                        var line = Path()
                        let x = CGFloat(index) * size.width / 5 - size.width / 4
                        line.move(to: CGPoint(x: x, y: 0))
                        line.addLine(to: CGPoint(x: x + size.width * 0.6, y: size.height))
                        context.stroke(line, with: .color(theme.ink.opacity(0.13)), lineWidth: 14)
                    }
                case .cloud:
                    for index in 0..<3 {
                        let diameter = size.width * 0.7
                        let rect = CGRect(
                            x: CGFloat(index) * size.width * 0.3 - diameter / 3,
                            y: size.height * (index.isMultiple(of: 2) ? 0.15 : 0.48),
                            width: diameter, height: diameter
                        )
                        context.fill(Path(ellipseIn: rect), with: .color(theme.ink.opacity(0.09)))
                    }
                case .stone:
                    for index in 0..<5 {
                        let width = size.width / 4
                        let rect = CGRect(
                            x: CGFloat(index) * width * 0.83 - width / 3,
                            y: size.height * 0.15 + CGFloat(index % 2) * size.height * 0.2,
                            width: width, height: size.height * 0.85
                        )
                        context.stroke(
                            Path(roundedRect: rect, cornerRadius: width * 0.4),
                            with: .color(theme.ink.opacity(0.2)), lineWidth: 2
                        )
                    }
                }
            }
        }
    }
}

private struct DiscoveryArtwork: View {
    let theme: MerchantTheme

    var body: some View {
        GeometryReader { geometry in
            ZStack {
                theme.paper
                Circle()
                    .strokeBorder(theme.ink.opacity(0.14), lineWidth: 1)
                    .padding(geometry.size.width * 0.14)
                Image(systemName: symbol)
                    .font(.system(size: min(geometry.size.width, geometry.size.height) * 0.32,
                                  weight: .light))
                    .foregroundStyle(theme.ink)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .accessibilityHidden(true)
    }

    private var symbol: String {
        switch theme.artwork {
        case .rail: "takeoutbag.and.cup.and.straw"
        case .stone: "books.vertical"
        case .cloud: "cup.and.saucer"
        }
    }
}

struct WalletPlaceTile: View {
    let place: Place
    let stamps: Int
    @Environment(MerchantBrandingStore.self) private var branding

    var body: some View {
        let theme = branding.theme(for: place)
        HStack(alignment: .top, spacing: 16) {
            MerchantCover(place: place, canRetry: false)
                .frame(width: 64, height: 64)
                .clipShape(RoundedRectangle(cornerRadius: 8))
            VStack(alignment: .leading, spacing: 7) {
                Text(place.name).font(.system(.headline, design: theme.fontDesign))
                Text(place.neighborhood).font(.caption)
                Text("\(stamps) of \(place.requiredPunches) punches")
                    .font(.subheadline.monospacedDigit())
            }
            .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 30)
        }
        .padding(20)
        .padding(.bottom, 16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .foregroundStyle(theme.ink)
        .background(theme.paper, in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(theme.ink.opacity(0.25)))
        .shadow(color: .black.opacity(0.12), radius: 4, y: -2)
        .contentShape(RoundedRectangle(cornerRadius: 16))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(place.name), \(place.rewardDescription)")
        .accessibilityValue("\(stamps) of \(place.requiredPunches) punches")
    }
}

struct PlaceStack: View {
    let title: String
    let places: [Place]
    let identifier: String
    let cardPrefix: String
    var discovery = false
    var titleIdentifier = ""
    var showsTitle = true
    var orderCollection: CardOrderCollection = .home
    var edit: (() -> Void)?
    @Environment(LoyaltyStore.self) private var store
    @Environment(MerchantBrandingStore.self) private var branding
    @Environment(\.reduceCardMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var expanded = false
    @State private var selecting = false
    @State private var selected: Set<String> = []
    @State private var showingGroups = false
    @State private var confirmingMemories = false
    @State private var failure: String?
    @State private var page = 0

    private var spread: Bool { expanded || typeSize.isAccessibilitySize }
    private var visiblePlaces: [Place] {
        let window = CollectionWindow(count: places.count, page: page, size: spread ? 6 : 3)
        return Array(places[window.range])
    }
    private var selectedPlaces: [Place] { store.activePlaces.filter { selected.contains($0.id) } }
    private var allowsMotion: Bool {
        !reduceMotion && places.allSatisfy { branding.theme(for: $0).allowsMotion }
    }
    private var cardDropHandler: ((CardOrderTransfer, Int) -> Bool)? {
        guard !selecting && !discovery else { return nil }
        return { moveToPage($0, $1) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            ViewThatFits(in: .horizontal) {
                HStack { heading; Spacer(minLength: 12); controls }
                VStack(alignment: .leading, spacing: 8) { heading; controls }
            }
            if places.isEmpty {
                Text("No active places in this group").foregroundStyle(Color.muted)
            } else {
                LazyVStack(spacing: spread ? 20 : -16) {
                    ForEach(visiblePlaces) { place in
                        card(place, compact: selecting || typeSize.isAccessibilitySize ||
                             (!spread && place != visiblePlaces.last))
                    }
                }
            }
            if selecting { selectionActions }
            CollectionPager(page: $page, count: places.count, size: spread ? 6 : 3, identifier: identifier,
                            onCardDrop: cardDropHandler)
        }
        .sheet(isPresented: $showingGroups, onDismiss: finishSelection) {
            GroupMembershipView(places: selectedPlaces)
        }
        .confirmationDialog("Move these cards to Memories?", isPresented: $confirmingMemories,
                            titleVisibility: .visible) {
            Button("Move to Memories") {
                for place in selectedPlaces { store.setArchived(true, for: place) }
                if let error = store.storageError { failure = error }
                else { finishSelection() }
            }
        } message: {
            Text("Keep their current punches. Available rewards remain usable.")
        }
        .alert("Couldn't update cards", isPresented: Binding(
            get: { failure != nil }, set: { if !$0 { failure = nil } }
        )) {
            Button("OK") { failure = nil }
        } message: { Text(failure ?? "") }
    }

    private var heading: some View {
        VStack(alignment: .leading, spacing: 4) {
            if showsTitle {
                Text(title).font(.title3.weight(.semibold))
                    .accessibilityAddTraits(.isHeader)
                    .accessibilityIdentifier(titleIdentifier)
            }
            Text("\(places.count) places")
                .font(.caption).foregroundStyle(Color.muted)
        }
    }

    private var controls: some View {
        HStack(spacing: 12) {
            if places.count > 1 && !typeSize.isAccessibilitySize {
                Button(expanded ? "Collapse" : "Expand") {
                    withAnimation(allowsMotion ? .spring(response: 0.32, dampingFraction: 0.88) : nil) {
                        expanded.toggle()
                        page = 0
                    }
                }
                .frame(minHeight: 44)
                .accessibilityLabel(expanded ? "Collapse \(title)" : "Expand \(title)")
                .accessibilityValue(expanded ? "Expanded" : "Collapsed")
                .accessibilityIdentifier("\(identifier).expand")
            }
            if !discovery && !places.isEmpty {
                Button {
                    if selecting { finishSelection() }
                    else { selecting = true }
                } label: {
                    Image(systemName: selecting ? "checkmark.circle.fill" : "checkmark.circle")
                        .font(.system(size: 20))
                        .frame(width: 44, height: 44)
                }
                .accessibilityLabel(selecting ? "Done selecting cards" : "Select cards in \(title)")
                .accessibilityIdentifier("\(identifier).select")
            }
            if let edit {
                Button(action: edit) {
                    Image(systemName: "square.and.pencil").frame(width: 44, height: 44)
                }
                .accessibilityLabel("Edit \(title)")
                .accessibilityIdentifier("\(identifier).edit")
            }
        }
    }

    private func card(_ place: Place, compact: Bool) -> some View {
        let joined = store.membership(for: place)?.archived == false
        return Group {
            if selecting {
                Button {
                    if selected.contains(place.id) { selected.remove(place.id) }
                    else { selected.insert(place.id) }
                } label: {
                    tile(place, compact: compact, joined: joined)
                        .overlay(alignment: .topTrailing) {
                            Image(systemName: selected.contains(place.id) ? "checkmark.circle.fill" : "circle")
                                .font(.system(size: 24))
                                .foregroundStyle(branding.theme(for: place).ink)
                                .frame(width: 44, height: 44)
                                .background(branding.theme(for: place).paper, in: Circle())
                                .padding(8)
                        }
                        .accessibilityHidden(true)
                }
                .accessibilityLabel(place.name)
                .accessibilityValue(selected.contains(place.id) ? "Selected" : "Not selected")
                .accessibilityAddTraits(selected.contains(place.id) ? .isSelected : [])
                .accessibilityIdentifier("\(cardPrefix).\(place.id)")
            } else {
                NavigationLink(value: place) { tile(place, compact: compact, joined: joined) }
            }
        }
        .buttonStyle(CardPressStyle(allowsMotion: branding.theme(for: place).allowsMotion))
        .accessibilityIdentifier("\(cardPrefix).\(place.id)")
        .modifier(CardOrderModifier(placeID: place.id, places: places, collection: orderCollection,
                                    enabled: !selecting && !discovery))
    }

    private func tile(_ place: Place, compact: Bool, joined: Bool) -> some View {
        StackPlaceTile(
            place: place, stamps: store.membership(for: place)?.stamps ?? 0,
            compact: compact, discovery: discovery, isAdded: joined,
            selecting: selecting, isFavorite: store.membership(for: place)?.isFavorite == true
        )
    }

    private var selectionActions: some View {
        ViewThatFits(in: .horizontal) {
            HStack { selectedCount; Spacer(); actionButtons }
            VStack(alignment: .leading, spacing: 8) { selectedCount; actionButtons }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(Color.surface, in: RoundedRectangle(cornerRadius: 14))
    }

    private var selectedCount: some View {
        Text("\(selected.count) selected").font(.subheadline)
            .fixedSize()
            .accessibilityIdentifier("\(identifier).selectedCount")
    }

    private var actionButtons: some View {
        HStack(spacing: 12) {
            let allFavorite = !selectedPlaces.isEmpty &&
                selectedPlaces.allSatisfy { store.membership(for: $0)?.isFavorite == true }
            Button {
                do {
                    for place in selectedPlaces { try store.setFavorite(!allFavorite, for: place) }
                    if let error = store.storageError { failure = error }
                    else { finishSelection() }
                } catch { failure = error.localizedDescription }
            } label: {
                Image(systemName: allFavorite ? "star.slash" : "star")
                    .frame(width: 44, height: 44)
            }
            .accessibilityLabel(allFavorite ? "Remove favorites" : "Favorite selected cards")
            .accessibilityIdentifier("\(identifier).favorite")
            Button { showingGroups = true } label: {
                Image(systemName: "folder.badge.plus").frame(width: 44, height: 44)
            }
            .accessibilityLabel("Add selected cards to groups")
            .accessibilityIdentifier("\(identifier).groups")
            Button { confirmingMemories = true } label: {
                Image(systemName: "tray.and.arrow.down").frame(width: 44, height: 44)
            }
            .accessibilityLabel("Move selected cards to Memories")
            .accessibilityIdentifier("\(identifier).memories")
        }
        .font(.system(size: 20))
        .disabled(selectedPlaces.isEmpty)
    }

    private func finishSelection() {
        selecting = false
        selected = []
    }

    private func moveToPage(_ item: CardOrderTransfer, _ destination: Int) -> Bool {
        let size = spread ? 6 : 3
        let window = CollectionWindow(count: places.count, page: destination, size: size)
        guard destination == window.index, item.collection == orderCollection.key,
              places.contains(where: { $0.id == item.placeID }),
              let target = places[window.range].first else { return false }
        do {
            try store.moveCard(item.placeID, to: target.id, in: orderCollection)
            return true
        } catch {
            failure = error.localizedDescription
            return false
        }
    }
}

struct DiscoveryGallery: View {
    let title: String
    let places: [Place]
    let identifier: String
    let cardPrefix: String
    @Environment(LoyaltyStore.self) private var store
    @Environment(MerchantBrandingStore.self) private var branding
    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var page = 0
    @State private var focusedPlace: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            SectionHeading(title: title)
            let window = CollectionWindow(count: places.count, page: page, size: 6)
            ScrollView(.horizontal) {
                HStack(alignment: .top, spacing: 16) {
                    ForEach(Array(places[window.range])) { place in
                        NavigationLink(value: place) {
                            DiscoveryTile(
                                place: place,
                                isAdded: store.membership(for: place)?.archived == false
                            )
                        }
                        .buttonStyle(CardPressStyle(allowsMotion: branding.theme(for: place).allowsMotion))
                        .containerRelativeFrame(.horizontal) { width, _ in
                            typeSize.isAccessibilitySize || window.range.count == 1 ? width : width * 0.88
                        }
                        .accessibilityIdentifier("\(cardPrefix).\(place.id)")
                    }
                }
                .scrollTargetLayout()
                .padding(.vertical, 14)
            }
            .scrollIndicators(.hidden)
            .scrollClipDisabled()
            .scrollTargetBehavior(.viewAligned)
            .scrollPosition(id: $focusedPlace)
            .sensoryFeedback(.selection, trigger: focusedPlace)
            .accessibilityIdentifier(identifier)
            .id(page)
            CollectionPager(page: $page, count: places.count, size: 6, identifier: identifier)
        }
        .onChange(of: places) {
            page = 0
            focusedPlace = places.first?.id
        }
        .onChange(of: page) { focusedPlace = nil }
    }
}

private struct DiscoveryTile: View {
    let place: Place
    let isAdded: Bool
    @Environment(MerchantBrandingStore.self) private var branding
    @Environment(\.reduceCardMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var typeSize

    private var theme: MerchantTheme { branding.theme(for: place) }
    private var allowsMotion: Bool { !reduceMotion && theme.allowsMotion }

    var body: some View {
        let allowsMotion = self.allowsMotion
        Group {
            if typeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: 0) {
                    MerchantCover(place: place, canRetry: false, poster: true)
                        .frame(height: 120)
                    caption.foregroundStyle(theme.ink)
                }
            } else {
                ZStack(alignment: .bottomLeading) {
                    GeometryReader { geometry in
                        MerchantCover(place: place, canRetry: false, poster: true)
                            .frame(width: geometry.size.width, height: geometry.size.height)
                            .scaleEffect(allowsMotion ? 1.12 : 1)
                            .scrollTransition(.interactive, axis: .horizontal) { content, phase in
                                content.offset(x: allowsMotion ? phase.value * -24 : 0)
                            }
                    }
                    VStack(spacing: 0) {
                        Spacer(minLength: 235)
                        caption
                            .foregroundStyle(.white)
                            .background {
                                VStack(spacing: 0) {
                                    LinearGradient(
                                        colors: [.clear, .black.opacity(0.9)],
                                        startPoint: .top, endPoint: .bottom
                                    )
                                    .frame(height: 80)
                                    Color.black.opacity(0.9)
                                }
                                .padding(.top, -80)
                            }
                    }
                }
            }
        }
        .background(theme.paper)
        .clipShape(RoundedRectangle(cornerRadius: 22))
        .overlay(alignment: .topTrailing) {
            if isAdded {
                Image(systemName: "checkmark")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(theme.ink)
                    .padding(12)
                    .background(theme.paper, in: Circle())
                    .padding(16)
                    .accessibilityHidden(true)
            }
        }
        .overlay(RoundedRectangle(cornerRadius: 22).strokeBorder(theme.ink.opacity(0.14)))
        .shadow(color: theme.ink.opacity(0.16), radius: 12, x: 0, y: 8)
        .contentShape(RoundedRectangle(cornerRadius: 22))
        .scrollTransition(.interactive, axis: .horizontal) { content, phase in
            content
                .scaleEffect(allowsMotion ? 1 - abs(phase.value) * 0.06 : 1)
                .rotation3DEffect(
                    .degrees(allowsMotion ? phase.value * -8 : 0),
                    axis: (x: 0, y: 1, z: 0), perspective: 0.35
                )
                .offset(y: allowsMotion ? abs(phase.value) * 8 : 0)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(place.name), \(place.neighborhood)")
        .accessibilityValue(
            "\(place.requiredPunches) stamps, \(place.rewardDescription)\(isAdded ? ", card added" : "")"
        )
        .accessibilityHint("Opens the place and its card.")
    }

    private var caption: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(place.name)
                .font(.system(typeSize.isAccessibilitySize ? .headline : .title,
                              design: theme.fontDesign).weight(.semibold))
            Text(place.neighborhood).font(.caption)
            Text("\(place.requiredPunches) stamps / \(place.rewardDescription)")
                .font(.subheadline)
        }
        .fixedSize(horizontal: false, vertical: true)
        .padding(24)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct StackPlaceTile: View {
    let place: Place
    let stamps: Int
    let compact: Bool
    let discovery: Bool
    let isAdded: Bool
    var selecting = false
    var isFavorite = false
    @Environment(MerchantBrandingStore.self) private var branding
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        let theme = branding.theme(for: place)
        VStack(alignment: .leading, spacing: 0) {
            if typeSize.isAccessibilitySize {
                MerchantCover(place: place, canRetry: false, poster: discovery)
                    .frame(width: 44, height: 44)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                    .padding([.top, .horizontal], 20)
            }
            HStack(alignment: .top, spacing: 12) {
                if compact && !typeSize.isAccessibilitySize {
                    MerchantCover(place: place, canRetry: false, poster: discovery)
                        .frame(width: 44, height: 44)
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                }
                VStack(alignment: .leading, spacing: 8) {
                    Text(place.name)
                        .font(.system(compact ? .headline : .title2, design: theme.fontDesign).weight(.medium))
                    if !compact { Text(place.neighborhood).font(.caption) }
                    Text(discovery
                         ? "\(place.requiredPunches) stamps / \(place.rewardDescription)\(isAdded ? " / Added" : "")"
                         : stamps == place.requiredPunches ? "Full card" : "\(stamps) of \(place.requiredPunches) punches")
                        .font(.subheadline.monospacedDigit())
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .fixedSize(horizontal: false, vertical: true)
            .padding(.trailing, selecting && !typeSize.isAccessibilitySize ? 44 : 0)
            .padding(20)
            .padding(.bottom, compact ? 16 : 0)
            .frame(maxWidth: .infinity, alignment: .leading)
            .foregroundStyle(theme.ink)
            if !compact {
                MerchantCover(place: place, canRetry: false, poster: discovery)
                    .frame(height: theme.stackCoverHeight)
            }
        }
        .background(theme.paper)
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(theme.ink.opacity(0.18)))
        .shadow(color: .black.opacity(0.08), radius: 5, y: 3)
        .contentShape(RoundedRectangle(cornerRadius: 14))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(place.name), \(place.rewardDescription)")
        .accessibilityValue(discovery
            ? "\(place.requiredPunches) stamps\(isAdded ? ", card added" : "")"
            : "\(stamps) of \(place.requiredPunches) punches\(isFavorite ? ", Favorite" : "")")
        .accessibilityHint("Opens the place and its card.")
    }
}

struct BrandingPreviewView: View {
    let place: Place
    @Environment(MerchantBrandingStore.self) private var branding
    @Environment(\.dismiss) private var dismiss
    @State private var selection: PhotosPickerItem?
    @State private var remoteURL = ""
    @State private var loading = false
    @State private var failure: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    MerchantCover(place: place).frame(height: 200).listRowInsets(EdgeInsets())
                }
                Section {
                    PhotosPicker(selection: $selection, matching: .images, photoLibrary: .shared()) {
                        Text("Choose cover photo")
                            .frame(minHeight: 44)
                    }
                    .disabled(loading)
                    .accessibilityIdentifier("branding.choosePhoto")
                    if loading { ProgressView("Preparing image...") }
                    if branding.hasLocalPreview(for: place) {
                        Button("Remove local photo", role: .destructive) {
                            do { try branding.removeLocalPreview(for: place) }
                            catch { failure = error.localizedDescription }
                        }
                    }
                } footer: {
                    Text("Local preview only. This photo stays on this device and is not uploaded.")
                }
                Section {
                    TextField("https://", text: $remoteURL)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .accessibilityIdentifier("branding.coverURL")
                    Button("Preview server image") {
                        do {
                            let value = remoteURL.trimmingCharacters(in: .whitespacesAndNewlines)
                            guard let url = URL(string: value) else { throw BrandingError.invalidURL }
                            try branding.previewRemoteCover(url, for: place)
                        } catch { failure = error.localizedDescription }
                    }
                    .accessibilityIdentifier("branding.applyURL")
                    Button("Use original artwork") {
                        do {
                            try branding.previewRemoteCover(nil, for: place)
                            remoteURL = ""
                        } catch { failure = error.localizedDescription }
                    }
                } header: {
                    Text("Published image URL")
                } footer: {
                    Text("The merchant app uploads to your server. Customers load the published HTTPS image; they never receive upload credentials.")
                }
            }
            .appNavigationTitle("Preview branding")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }.disabled(loading)
                }
            }
            .onAppear { remoteURL = branding.theme(for: place).coverURL?.absoluteString ?? "" }
            .task(id: selection) {
                guard let selection else { return }
                loading = true
                defer { loading = false }
                do {
                    guard let data = try await selection.loadTransferable(type: Data.self) else {
                        throw BrandingError.invalidImage
                    }
                    try await branding.savePreview(data, for: place)
                } catch is CancellationError {
                    // Closing a picker leaves the previous cover unchanged.
                } catch { failure = error.localizedDescription }
            }
            .alert("Couldn't update artwork", isPresented: Binding(
                get: { failure != nil }, set: { if !$0 { failure = nil } }
            )) {
                Button("OK") { failure = nil }
            } message: { Text(failure ?? "") }
        }
        .interactiveDismissDisabled(loading)
    }
}
