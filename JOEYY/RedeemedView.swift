import SwiftUI

struct RedeemedView: View {
    @Environment(LoyaltyStore.self) private var store

    private var available: [Redemption] { store.redemptions.filter(\.isAvailable) }
    private var used: [Redemption] { store.redemptions.filter { $0.coupon?.usedAt != nil } }
    private var earlier: [Redemption] { store.redemptions.filter { $0.coupon == nil } }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 28) {
                    PageTitle(text: "Redeemed")
                    if store.redemptions.isEmpty {
                        ContentUnavailableView(
                            "No coupons", systemImage: "ticket",
                            description: Text("Redeem stamps from a business card.")
                        )
                    } else {
                        if !available.isEmpty {
                            couponSection("Available", entries: available)
                        }
                        if !used.isEmpty {
                            couponSection("Used", entries: used)
                        }
                        if !earlier.isEmpty {
                            VStack(alignment: .leading, spacing: 16) {
                                SectionHeading(title: "Earlier redemptions")
                                ForEach(earlier) { entry in
                                    VStack(alignment: .leading, spacing: 8) {
                                        Text(entry.place.name)
                                            .font(.caption).foregroundStyle(.tint)
                                        HistoryRow(event: entry.event)
                                    }
                                    .padding(18)
                                    .background(Color.surface, in: RoundedRectangle(cornerRadius: 8))
                                }
                            }
                        }
                    }
                }
                .padding(24)
                .frame(maxWidth: 620)
                .frame(maxWidth: .infinity)
            }
            .background { AppBackground() }
            .toolbar(.hidden, for: .navigationBar)
            .navigationDestination(for: Redemption.self) { entry in
                CouponDetailView(couponID: entry.id)
            }
        }
    }

    private func couponSection(_ title: String, entries: [Redemption]) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            SectionHeading(title: title)
            ForEach(entries) { entry in
                NavigationLink(value: entry) {
                    HStack(spacing: 16) {
                        PlaceMark(place: entry.place, size: 30)
                            .foregroundStyle(.tint).frame(width: 44)
                        VStack(alignment: .leading, spacing: 7) {
                            Text(entry.event.rewardTitle ?? "Reward")
                                .font(.headline.weight(.medium)).foregroundStyle(.tint)
                            Text(entry.place.name)
                                .font(.subheadline).foregroundStyle(Color.muted)
                            Text(entry.event.date, format: .dateTime.month(.abbreviated).day().year())
                                .font(.caption).foregroundStyle(Color.muted)
                        }
                        .fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 0)
                        Image(systemName: "chevron.right")
                            .font(.caption2).foregroundStyle(Color.muted)
                    }
                    .padding(20)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.surface, in: RoundedRectangle(cornerRadius: 8))
                    .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color.rule))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("coupon.\(entry.place.id).\(entry.id.uuidString)")
            }
        }
    }
}

struct CouponDetailView: View {
    let couponID: UUID
    @Environment(LoyaltyStore.self) private var store
    @State private var confirmingUse = false
    @State private var showingWallet = false
    @State private var failure: String?

    private var redemption: Redemption? { store.redemptions.first { $0.id == couponID } }

    var body: some View {
        ScrollView {
            if let entry = redemption, let coupon = entry.coupon {
                VStack(alignment: .leading, spacing: 26) {
                    VStack(alignment: .leading, spacing: 24) {
                        HStack {
                            Eyebrow(text: coupon.usedAt == nil ? "Available" : "Used")
                                .foregroundStyle(.tint)
                                .accessibilityIdentifier("coupon.status")
                            Spacer()
                            PlaceMark(place: entry.place, size: 34).foregroundStyle(.tint)
                        }
                        PageTitle(text: entry.event.rewardTitle ?? "Reward", size: 32)
                            .accessibilityIdentifier("coupon.title")
                        Divider()
                        VStack(spacing: 16) {
                            fact("Redeemed", value: Text(
                                entry.event.date, format: .dateTime.month(.abbreviated).day().year()
                            ))
                            if let cost = entry.event.stampCost {
                                fact("Stamps used", value: Text("\(cost)"))
                            }
                            if let usedAt = coupon.usedAt {
                                fact("Used", value: Text(
                                    usedAt, format: .dateTime.month(.abbreviated).day().hour().minute()
                                ))
                            }
                        }
                        .font(.subheadline)
                        .foregroundStyle(Color.muted)
                        Text("Demo coupon. NFC and counter verification aren't implemented yet.")
                            .font(.footnote).foregroundStyle(Color.muted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(24)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.surface, in: RoundedRectangle(cornerRadius: 8))
                    .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color.rule))

                    if coupon.usedAt == nil {
                        Button("Mark as used") { confirmingUse = true }
                            .buttonStyle(PrimaryButton())
                            .accessibilityIdentifier("coupon.use")
                        Button("Apple Wallet") { showingWallet = true }
                            .buttonStyle(SecondaryButton())
                            .accessibilityIdentifier("coupon.wallet")
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
        .sheet(isPresented: $showingWallet) {
            WalletStatusView(message: "Apple Wallet coupon passes aren't implemented yet.")
        }
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
            Text("This only updates the demo app. It doesn't verify a purchase or issue a real reward.")
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

    private func fact(_ label: String, value: Text) -> some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 16) {
                Text(label).fixedSize()
                Spacer(minLength: 0)
                value.fixedSize()
            }
            VStack(alignment: .leading, spacing: 6) {
                Text(label).fixedSize(horizontal: false, vertical: true)
                value.fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}
