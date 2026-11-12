import SwiftUI

struct RedeemedView: View {
    @State private var showingMemories = false
    @State private var collection = CardHistoryCollection.Kind.available

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 28) {
                    ViewThatFits(in: .horizontal) {
                        HStack { PageTitle(text: "Redeemed"); Spacer(); memoriesButton }
                        VStack(alignment: .leading, spacing: 12) {
                            PageTitle(text: "Redeemed")
                            memoriesButton
                        }
                    }
                    Picker("Rewards", selection: $collection) {
                        Text("Available").tag(CardHistoryCollection.Kind.available)
                        Text("Used").tag(CardHistoryCollection.Kind.used)
                    }
                    .pickerStyle(.segmented)
                    .accessibilityIdentifier("redeemed.collection")
                    CardHistoryCollection(collection: collection)
                        .id(collection)
                }
                .padding(24)
                .frame(maxWidth: 620)
                .frame(maxWidth: .infinity)
            }
            .background { AppBackground() }
            .toolbar(.hidden, for: .navigationBar)
            .sheet(isPresented: $showingMemories) { MemoriesView() }
        }
    }

    private var memoriesButton: some View {
        Button("Memories", systemImage: "rectangle.stack") { showingMemories = true }
            .fixedSize(horizontal: true, vertical: false)
            .frame(minHeight: 44)
            .accessibilityIdentifier("redeemed.memories")
    }

}

struct CardHistoryCollection: View {
    enum Kind: Hashable {
        case memories, available, used
    }

    let collection: Kind
    @Environment(LoyaltyStore.self) private var store
    @Environment(MerchantBrandingStore.self) private var branding
    @State private var query = ""
    @State private var page = 0
    @State private var failure: String?

    private var entries: [CardMemory] {
        store.memories.filter {
            let included: Bool
            switch collection {
            case .memories: included = true
            case .available: included = $0.redemption?.isAvailable == true
            case .used: included = $0.redemption?.coupon?.usedAt != nil
            }
            let query = query.trimmingCharacters(in: .whitespacesAndNewlines)
            return included && ($0.place.matchesCollectionSearch(query) ||
                                $0.reward.localizedCaseInsensitiveContains(query))
        }
    }

    private var places: [Place] {
        var seen: Set<String> = []
        let places = entries.compactMap { seen.insert($0.place.id).inserted ? $0.place : nil }
        return collection == .memories ? places : store.ordered(places, in: .redeemed)
    }

    private var prefix: String { collection == .memories ? "memory" : "coupon" }
    private var cardDropHandler: ((CardOrderTransfer, Int) -> Bool)? {
        guard collection != .memories else { return nil }
        return { moveToPage($0, $1) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            CollectionSearchField(prompt: "Find a place", query: $query, identifier: "\(prefix).query")
            if places.isEmpty {
                ContentUnavailableView(
                    query.isEmpty ? emptyTitle : "No matching cards", systemImage: "rectangle.stack"
                )
            }
            let window = CollectionWindow(count: places.count, page: page, size: 3)
            ForEach(Array(places[window.range])) { place in
                let cards = entries.filter { $0.place == place }
                if let first = cards.first {
                    NavigationLink {
                        CardHistoryStack(place: place, cards: cards)
                    } label: {
                        MemoryStackCover(memory: first, count: cards.count)
                            .accessibilityElement(children: .ignore)
                            .accessibilityHidden(true)
                    }
                    .buttonStyle(CardPressStyle(allowsMotion: branding.theme(for: place).allowsMotion))
                    .accessibilityLabel("\(place.name), \(cards.count) \(cards.count == 1 ? "card" : "cards")")
                    .accessibilityValue(summary(first))
                    .accessibilityIdentifier("\(prefix).\(place.id).stack")
                    .modifier(CardOrderModifier(placeID: place.id, places: places, collection: .redeemed,
                                                enabled: collection != .memories))
                }
            }
            CollectionPager(page: $page, count: places.count, size: 3, identifier: prefix,
                            onCardDrop: cardDropHandler)
        }
        .onChange(of: query) { page = 0 }
        .alert("Couldn't reorder cards", isPresented: Binding(
            get: { failure != nil }, set: { if !$0 { failure = nil } }
        )) {
            Button("OK") { failure = nil }
        } message: { Text(failure ?? "") }
    }

    private func moveToPage(_ item: CardOrderTransfer, _ destination: Int) -> Bool {
        let window = CollectionWindow(count: places.count, page: destination, size: 3)
        guard destination == window.index, item.collection == CardOrderCollection.redeemed.key,
              places.contains(where: { $0.id == item.placeID }),
              let target = places[window.range].first else { return false }
        do {
            try store.moveCard(item.placeID, to: target.id, in: .redeemed)
            return true
        } catch {
            failure = error.localizedDescription
            return false
        }
    }

    private func summary(_ memory: CardMemory) -> String {
        guard let stamps = memory.stamps, let target = memory.target else { return memory.status }
        return "\(memory.status), \(stamps) of \(target) punches"
    }

    private var emptyTitle: String {
        switch collection {
        case .memories: "No memories yet"
        case .available: "No available rewards"
        case .used: "No used rewards"
        }
    }
}

private struct MemoryStackCover: View {
    let memory: CardMemory
    let count: Int
    @Environment(MerchantBrandingStore.self) private var branding

    var body: some View {
        let theme = branding.theme(for: memory.place)
        let isTicket = memory.redemption?.coupon != nil
        let stock = isTicket
            ? AnyShape(TicketShape())
            : AnyShape(RoundedRectangle(cornerRadius: 16))
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 12) {
                if isTicket {
                    PlaceMark(place: memory.place, size: 30)
                        .accessibilityHidden(true)
                }
                Text(memory.place.name)
                    .font(.system(.headline, design: theme.fontDesign))
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Label("\(count)", systemImage: "rectangle.stack")
                    .font(.subheadline.monospacedDigit())
                    .fixedSize(horizontal: true, vertical: false)
            }
            if let stamps = memory.stamps, let target = memory.target {
                PunchCard(place: memory.place, stamps: stamps, compact: true,
                          title: memory.status, reward: memory.reward, target: target)
            } else {
                Text(memory.status).font(.subheadline)
                Text(memory.reward).font(.subheadline)
            }
        }
        .foregroundStyle(theme.ink)
        .padding(18)
        .background {
            stock.fill(theme.paper)
                .shadow(color: .black.opacity(isTicket ? 0.12 : 0), radius: 6, x: 0, y: 4)
        }
        .overlay(stock.stroke(theme.ink.opacity(0.2)))
        .background {
            if count > 1 {
                stock
                    .fill(theme.paper)
                    .overlay(stock.stroke(theme.ink.opacity(0.2)))
                    .padding(.horizontal, 6)
                    .offset(y: -7)
            }
        }
        .padding(.top, count > 1 ? 7 : 0)
    }
}

private struct CardHistoryStack: View {
    let place: Place
    @State private var ids: [UUID]
    @State private var page = 0
    @State private var failure: String?
    @Environment(LoyaltyStore.self) private var store

    init(place: Place, cards: [CardMemory]) {
        self.place = place
        _ids = State(initialValue: cards.map(\.id))
    }

    private var cards: [CardMemory] {
        let memories = Dictionary(uniqueKeysWithValues: store.memories.map { ($0.id, $0) })
        return ids.compactMap { memories[$0] }
    }

    var body: some View {
        let window = CollectionWindow(count: cards.count, page: page, size: 1)
        Group {
            if let memory = cards[window.range].first {
                if let redemption = memory.redemption, redemption.coupon != nil {
                    CouponDetailView(couponID: redemption.id)
                } else {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 24) {
                            Eyebrow(text: memory.status)
                            if let stamps = memory.stamps, let target = memory.target {
                                PunchCard(place: place, stamps: stamps,
                                          reward: memory.reward, target: target)
                            } else {
                                Text(memory.reward).font(.title2)
                                Text("The original punch count was not recorded.")
                                    .font(.subheadline).foregroundStyle(Color.muted)
                            }
                            if let date = memory.savedAt {
                                Text(date, format: .dateTime.month(.abbreviated).day().year())
                                    .font(.subheadline).foregroundStyle(Color.muted)
                            }
                            if store.membership(for: place)?.archived == true,
                               store.membership(for: place)?.savedCards.first?.id == memory.id {
                                Button("Return to Home") {
                                    store.join(place)
                                    failure = store.storageError
                                }
                                .buttonStyle(PrimaryButton())
                                .accessibilityIdentifier("memory.restore")
                            }
                        }
                        .padding(24)
                        .frame(maxWidth: 620)
                        .frame(maxWidth: .infinity)
                    }
                    .background { AppBackground() }
                }
            } else {
                ContentUnavailableView("Card not found", systemImage: "rectangle.stack")
            }
        }
        .safeAreaInset(edge: .top) {
            if cards.count > 1 {
                CollectionPager(page: $page, count: cards.count, size: 1, identifier: "history")
                    .padding(.horizontal, 24)
                    .background(Color.paper)
            }
        }
        .appNavigationTitle(place.name)
        .toolbar(.visible, for: .navigationBar)
        .alert("Couldn't return card", isPresented: Binding(
            get: { failure != nil }, set: { if !$0 { failure = nil } }
        )) {
            Button("OK") { failure = nil }
        } message: { Text(failure ?? "") }
    }
}

struct CouponDetailView: View {
    let couponID: UUID
    @Environment(LoyaltyStore.self) private var store
    @Environment(MerchantBrandingStore.self) private var branding
    @State private var confirmingUse = false
    @State private var failure: String?

    private var redemption: Redemption? { store.redemptions.first { $0.id == couponID } }

    var body: some View {
        ScrollView {
            if let entry = redemption, let coupon = entry.coupon {
                VStack(alignment: .leading, spacing: 26) {
                    VStack(alignment: .leading, spacing: 24) {
                        HStack {
                            Eyebrow(text: coupon.usedAt == nil ? "Available" : "Used")
                                .accessibilityIdentifier("coupon.status")
                            Spacer()
                            PlaceMark(place: entry.place, size: 34)
                        }
                        if let cost = entry.event.stampCost {
                            PunchCard(
                                place: entry.place, stamps: cost,
                                reward: entry.event.rewardTitle, target: cost,
                                rewardIdentifier: "coupon.title"
                            )
                        } else {
                            Text(entry.event.rewardTitle ?? "Reward")
                                .font(.title2)
                                .accessibilityIdentifier("coupon.title")
                            Text("The original punch count was not recorded.")
                                .font(.subheadline)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        Text(coupon.usedAt ?? entry.event.date,
                             format: .dateTime.month(.abbreviated).day().year())
                            .font(.subheadline.weight(.medium))
                            .foregroundStyle(branding.theme(for: entry.place).ink)
                            .background(branding.theme(for: entry.place).paper)
                    }
                    .padding(24)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .foregroundStyle(branding.theme(for: entry.place).ink)
                    .background {
                        TicketShape()
                            .fill(branding.theme(for: entry.place).paper)
                            .shadow(color: .black.opacity(0.12), radius: 8, x: 0, y: 5)
                    }
                    .overlay(TicketShape().stroke(branding.theme(for: entry.place).ink.opacity(0.2)))

                    if coupon.usedAt == nil {
                        Button("Mark as used") { confirmingUse = true }
                            .buttonStyle(PrimaryButton())
                            .accessibilityIdentifier("coupon.use")
                    }
                }
                .padding(24)
                .frame(maxWidth: 620)
                .frame(maxWidth: .infinity)
            } else {
                ContentUnavailableView("Coupon not found", systemImage: "ticket")
            }
        }
        .background { AppBackground() }
        .appNavigationTitle(redemption?.place.name ?? "Coupon")
        .toolbar(.visible, for: .navigationBar)
        .alert("Mark this coupon as used?", isPresented: $confirmingUse) {
            Button("Mark as used") {
                do {
                    try store.useCoupon(couponID)
                } catch {
                    failure = error.localizedDescription
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This ticket will move to Used and cannot be used again.")
        }
        .alert("Unable to use coupon", isPresented: Binding(
            get: { failure != nil },
            set: { if !$0 { failure = nil } }
        )) {
            Button("OK") { failure = nil }
        } message: {
            Text(failure ?? "")
        }
    }

}
