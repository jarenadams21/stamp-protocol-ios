import SwiftUI
import UIKit

struct PlaceDetailView: View {
    let place: Place
    @Environment(LoyaltyStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var sheet: DetailSheet?
    @State private var selectedReward: RewardOption?
    @State private var confirmingRedemption = false
    @State private var confirmingArchive = false
    @State private var feedback: String?
    @State private var failure: String?

    private var membership: Membership? { store.membership(for: place) }
    private var stamps: Int { membership?.stamps ?? 0 }
    private var active: Bool { membership?.archived == false }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 26) {
                Text(place.neighborhood).font(.caption).foregroundStyle(Color.muted)

                if membership != nil {
                    StampBalance(place: place, stamps: stamps)
                }

                if active {
                    HStack(spacing: 16) {
                        Button("Show card") {
                            sheet = .showCard
                        }
                        .accessibilityIdentifier("detail.showCard")
                        Button("Apple Wallet") {
                            sheet = .wallet
                        }
                        .accessibilityIdentifier("detail.wallet")
                    }
                    .buttonStyle(SecondaryButton())
                } else {
                    VStack(alignment: .leading, spacing: 14) {
                        Text(membership == nil ? place.story : "Restore this card to collect or use stamps.")
                            .font(.subheadline).foregroundStyle(Color.muted)
                        Button(membership == nil ? "Add card" : "Restore card") {
                            store.join(place)
                        }
                        .buttonStyle(PrimaryButton())
                        .accessibilityIdentifier("detail.join")
                    }
                }

                if let feedback {
                    Label(feedback, systemImage: "checkmark.circle")
                        .font(.footnote).foregroundStyle(.tint)
                        .accessibilityIdentifier("detail.feedback")
                }

                VStack(alignment: .leading, spacing: 16) {
                    SectionHeading(title: "Rewards")
                    VStack(spacing: 0) {
                        ForEach(place.rewards) { reward in
                            Button {
                                selectedReward = reward
                                confirmingRedemption = true
                            } label: {
                                ViewThatFits(in: .horizontal) {
                                    HStack(spacing: 16) {
                                        Text(reward.title).fixedSize()
                                        Spacer(minLength: 0)
                                        rewardCost(reward)
                                    }
                                    VStack(alignment: .leading, spacing: 10) {
                                        Text(reward.title).fixedSize(horizontal: false, vertical: true)
                                        rewardCost(reward)
                                    }
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                }
                                .font(.subheadline)
                                .padding(18)
                                .frame(maxWidth: .infinity, minHeight: 64)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(TextButton())
                            .disabled(!active || stamps < reward.cost)
                            .accessibilityIdentifier("reward.\(reward.id)")
                            if reward.id != place.rewards.last?.id {
                                Divider().padding(.horizontal, 18)
                            }
                        }
                    }
                    .background(Color.surface, in: RoundedRectangle(cornerRadius: 8))
                }

                DisclosureGroup {
                    VStack(alignment: .leading, spacing: 18) {
                        Text(place.address)
                        Text(place.rule)
                        Text("Stamps stay with this business. Redeeming subtracts the reward's cost; the rest stays on your card. No expiry in this demo.")
                        VStack(alignment: .leading, spacing: 8) {
                            Text("Client ID").font(.caption).foregroundStyle(.tint)
                            Text(place.clientID)
                                .font(.footnote.monospaced())
                                .textSelection(.enabled)
                                .accessibilityIdentifier("detail.clientID")
                            Button("Copy client ID", systemImage: "doc.on.doc") {
                                UIPasteboard.general.string = place.clientID
                                feedback = "Client ID copied."
                            }
                            .frame(minHeight: 44)
                        }
                    }
                    .font(.subheadline)
                    .foregroundStyle(Color.muted)
                    .padding(.top, 16)
                    .frame(maxWidth: .infinity, alignment: .leading)
                } label: {
                    Text("Program details").font(.subheadline.weight(.medium))
                }
                .padding(20)
                .background(Color.surface, in: RoundedRectangle(cornerRadius: 8))

                if let membership {
                    VStack(alignment: .leading, spacing: 18) {
                        SectionHeading(title: "Activity")
                        ForEach(membership.events.prefix(3)) { HistoryRow(event: $0) }
                        if membership.events.count > 3 {
                            Button("See all activity") { sheet = .history }
                                .font(.subheadline).frame(minHeight: 44)
                        }
                    }
                    if active {
                        VStack(alignment: .leading, spacing: 8) {
                            Button("Add demo stamp", systemImage: "plus.circle") {
                                withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.2)) {
                                    do {
                                        try store.addStamp(to: place)
                                        feedback = "Stamp added."
                                    } catch {
                                        failure = error.localizedDescription
                                    }
                                }
                            }
                            .font(.subheadline).frame(minHeight: 44)
                            .accessibilityIdentifier("detail.simulateVisit")
                            Text("Saved locally. No purchase is verified.")
                                .font(.caption).foregroundStyle(Color.muted)
                        }
                    }
                }
            }
            .padding(24)
            .frame(maxWidth: 620)
            .frame(maxWidth: .infinity)
        }
        .background { AppBackground() }
        .appNavigationTitle(place.name)
        .toolbar(.visible, for: .navigationBar)
        .toolbar {
            if active {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button("Archive card", systemImage: "archivebox") { confirmingArchive = true }
                    } label: {
                        Image(systemName: "ellipsis").frame(width: 44, height: 44)
                    }
                    .accessibilityLabel("Card options")
                }
            }
        }
        .sheet(item: $sheet) { item in
            switch item {
            case .wallet:
                WalletStatusView()
            case .showCard:
                CounterCardView(place: place)
            case .history:
                NavigationStack {
                    List(membership?.events ?? []) { event in
                        HistoryRow(event: event).listRowBackground(Color.surface)
                    }
                    .scrollContentBackground(.hidden)
                    .background { AppBackground() }
                    .appNavigationTitle("Activity")
                    .toolbar {
                        ToolbarItem(placement: .confirmationAction) {
                            Button("Done") { sheet = nil }
                        }
                    }
                }
            case .coupon(let id):
                NavigationStack {
                    CouponDetailView(couponID: id)
                        .toolbar {
                            ToolbarItem(placement: .confirmationAction) {
                                Button("Done") { sheet = nil }
                            }
                        }
                }
            }
        }
        .alert(
            "Redeem \(selectedReward?.title ?? "reward")?",
            isPresented: $confirmingRedemption,
            presenting: selectedReward
        ) { reward in
            Button("Use \(reward.cost) stamps") {
                do {
                    let coupon = try store.redeem(reward, at: place)
                    feedback = "Saved in Redeemed."
                    sheet = .coupon(coupon.id)
                } catch {
                    failure = error.localizedDescription
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: { reward in
            Text("\(stamps - reward.cost) stamps will remain. A demo coupon will be saved in Redeemed.")
        }
        .confirmationDialog("Archive this card?", isPresented: $confirmingArchive, titleVisibility: .visible) {
            Button("Archive card") {
                store.setArchived(true, for: place)
                dismiss()
            }
        } message: {
            Text("Stamps and activity are retained. Restore the card from Archived cards on Home.")
        }
        .alert("Unable to update card", isPresented: Binding(
            get: { failure != nil },
            set: { if !$0 { failure = nil } }
        )) {
            Button("OK") { failure = nil }
        } message: {
            Text(failure ?? "")
        }
    }

    private func rewardCost(_ reward: RewardOption) -> some View {
        HStack(spacing: 8) {
            Text("\(reward.cost) stamps").monospacedDigit().fixedSize()
            Image(systemName: active && stamps >= reward.cost ? "arrow.up.right" : "lock")
                .font(.caption)
        }
    }
}

private enum DetailSheet: Identifiable {
    case wallet, showCard, history
    case coupon(UUID)

    var id: String {
        switch self {
        case .wallet: "wallet"
        case .showCard: "showCard"
        case .history: "history"
        case .coupon(let id): "coupon.\(id.uuidString)"
        }
    }
}

struct HistoryRow: View {
    let event: VisitEvent
    @Environment(\.appAccent) private var accent

    private var title: String {
        switch event.kind {
        case .joined: "Program joined"
        case .stamp: "Stamp collected"
        case .reward: event.rewardTitle ?? "Reward redeemed"
        }
    }

    private var change: String {
        switch event.kind {
        case .joined: "Joined"
        case .stamp: "+1"
        case .reward: event.stampCost.map { "-\($0)" } ?? "Used"
        }
    }

    var body: some View {
        HStack(spacing: 14) {
            Image(systemName: event.kind == .reward ? "gift" : event.kind == .joined ? "plus.circle" : "checkmark.seal")
                .foregroundStyle(.tint).frame(width: 25)
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.subheadline)
                Text(event.date, format: .dateTime.month(.abbreviated).day().year())
                    .font(.caption).foregroundStyle(Color.muted)
            }
            Spacer()
            Text(change).font(.subheadline.weight(.medium).monospacedDigit())
                .foregroundStyle(accent.color)
        }
        .padding(.vertical, 3)
    }
}

struct WalletStatusView: View {
    var message = "Apple Wallet isn't implemented yet."
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 24) {
                Image(systemName: "wallet.bifold").font(.largeTitle).foregroundStyle(.tint)
                PageTitle(text: message, size: 28)
                    .accessibilityIdentifier("wallet.status")
            }
            .padding(28)
            .frame(maxWidth: 560, maxHeight: .infinity, alignment: .topLeading)
            .frame(maxWidth: .infinity)
            .background { AppBackground() }
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}

private struct CounterCardView: View {
    let place: Place
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    PlaceMark(place: place, size: 44).foregroundStyle(.tint)
                    PageTitle(text: place.name, size: 30)
                    Text("Customer codes aren't implemented yet.")
                        .foregroundStyle(Color.muted)
                }
                .padding(28)
                .frame(maxWidth: 560)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .background { AppBackground() }
            .appNavigationTitle("Customer card")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}
