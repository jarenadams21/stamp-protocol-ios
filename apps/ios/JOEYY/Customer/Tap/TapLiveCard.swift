import SwiftUI

struct TapLiveCard: View {
    let card: LiveCard
    let busy: Bool
    let updateWallet: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            VStack(alignment: .leading, spacing: 6) {
                Eyebrow(text: "Cafe card").foregroundStyle(Color.muted)
                Text(card.cafeName)
                    .font(.title2.weight(.medium))
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
            }
            PunchCard(place: card.place, stamps: card.stamps)
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .firstTextBaseline, spacing: 16) {
                    progress
                    Spacer(minLength: 0)
                    rewards
                }
                VStack(alignment: .leading, spacing: 8) { progress; rewards }
            }
            .font(.subheadline)
            .foregroundStyle(Color.muted)
            Button("Add / Update Apple Wallet", systemImage: "wallet.pass", action: updateWallet)
                .buttonStyle(SecondaryButton())
                .disabled(busy)
                .accessibilityIdentifier("tap.wallet.\(card.id)")
        }
        .padding(.vertical, 8)
    }

    private var progress: some View {
        Text("\(card.stamps) / \(card.target) stamps").monospacedDigit()
            .fixedSize(horizontal: false, vertical: true)
    }

    private var rewards: some View {
        Label("\(card.rewardsAvailable) \(card.rewardsAvailable == 1 ? "reward" : "rewards") available",
              systemImage: "gift")
            .fixedSize(horizontal: false, vertical: true)
    }
}
