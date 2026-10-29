import SwiftUI

struct ProfileView: View {
    @Environment(LoyaltyStore.self) private var store
    @AppStorage("appearance") private var appearance = "System"
    @AppStorage("accent") private var accent = AppAccent.orange.rawValue
    @AppStorage("rewardReminders") private var rewardReminders = false
    @AppStorage("newsAndOffers") private var newsAndOffers = false
    @State private var confirmingReset = false
    @State private var confirmingDelete = false
    @State private var showingWelcome = false
    @State private var showingBusiness = false
    @State private var exportedFile: URL?
    @State private var exportError: String?
    @State private var feedback: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    VStack(alignment: .leading, spacing: 12) {
                        PageTitle(text: "You")
                    }
                    .padding(.vertical, 12)
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 4, trailing: 0))
                }

                if let feedback {
                    Section {
                        Label(feedback, systemImage: "checkmark.circle")
                            .font(.subheadline)
                    }
                }

                Section {
                    Picker("Appearance", selection: $appearance) {
                        ForEach(["System", "Light", "Dark"], id: \.self) {
                            Text($0).tag($0)
                        }
                    }
                    .accessibilityIdentifier("settings.appearance")
                    VStack(alignment: .leading, spacing: 14) {
                        HStack {
                            Text("Accent color")
                            Spacer()
                            Text(accent).font(.subheadline).foregroundStyle(Color.muted)
                        }
                        LazyVGrid(columns: [GridItem(.adaptive(minimum: 64), spacing: 12)], spacing: 16) {
                            ForEach(AppAccent.allCases) { option in
                                Button {
                                    accent = option.rawValue
                                } label: {
                                    VStack(spacing: 7) {
                                        Circle()
                                            .fill(option.solidColor)
                                            .frame(width: 36, height: 36)
                                            .overlay {
                                                if accent == option.rawValue {
                                                    Image(systemName: "checkmark")
                                                        .font(.body.weight(.semibold))
                                                        .foregroundStyle(option.onSolidColor)
                                                }
                                            }
                                        Text(option.rawValue)
                                            .font(.caption)
                                            .foregroundStyle(.primary)
                                    }
                                    .frame(maxWidth: .infinity, minHeight: 64)
                                    .contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)
                                .accessibilityLabel(option.rawValue + " accent")
                                .accessibilityAddTraits(accent == option.rawValue ? .isSelected : [])
                                .accessibilityIdentifier("settings.accent.\(option.rawValue)")
                            }
                        }
                    }
                    .padding(.vertical, 8)
                } header: {
                    Text("Appearance").foregroundStyle(.tint)
                } footer: {
                    Text("Your accent applies throughout the app, including background fades. Text size and reduced motion follow system settings.")
                }

                Section {
                    Toggle("Reward reminders", isOn: $rewardReminders)
                    Toggle("News & offers", isOn: $newsAndOffers)
                } header: {
                    Text("Notifications").foregroundStyle(.tint)
                } footer: {
                    Text("Notifications aren't implemented yet. These preferences stay on your device.")
                }

                Section {
                    NavigationLink {
                        PrivacyView()
                    } label: {
                        Label("Data & privacy", systemImage: "hand.raised")
                    }
                    Button {
                        exportCards()
                    } label: {
                        Label("Export your demo activity", systemImage: "square.and.arrow.up")
                    }
                    if let exportedFile {
                        ShareLink(item: exportedFile) {
                            Label("Share activity file", systemImage: "doc.text")
                        }
                    }
                    Button(role: .destructive) {
                        confirmingDelete = true
                    } label: {
                        Label("Delete cards, coupons & activity", systemImage: "trash")
                    }
                    .accessibilityIdentifier("profile.delete")
                } header: {
                    Text("Data").foregroundStyle(.tint)
                } footer: {
                    Text("Deletion removes this device's cards, coupons, and activity. Appearance and preferences stay.")
                }

                Section {
                    Button("Replay the welcome") { showingWelcome = true }
                    Button("Reset the demo cards") { confirmingReset = true }
                        .accessibilityIdentifier("profile.reset")
                    Button("For businesses", systemImage: "storefront") { showingBusiness = true }
                } header: {
                    Text("Prototype").foregroundStyle(.tint)
                } footer: {
                    Text("JOEYY / Customer preview 0.1\nSeattle setting. All loyalty programs and offers are fictional. No affiliation with named businesses. No payments, live Wallet passes, analytics, or location tracking.")
                }
            }
            .scrollContentBackground(.hidden)
            .background { AppBackground() }
            .toolbar(.hidden, for: .navigationBar)
            .confirmationDialog("Reset your demo cards?", isPresented: $confirmingReset, titleVisibility: .visible) {
                Button("Reset demo cards", role: .destructive) {
                    store.resetDemo()
                    clearExport()
                    feedback = "Demo cards reset."
                }
            } message: {
                Text("Replaces local cards, coupons, and activity with sample data. Your appearance and preferences stay.")
            }
            .confirmationDialog("Delete this device's demo data?", isPresented: $confirmingDelete, titleVisibility: .visible) {
                Button("Delete demo data", role: .destructive) {
                    store.deleteLocalCards()
                    clearExport()
                    feedback = "Cards, coupons, and activity deleted."
                }
            } message: {
                Text("Cards, coupons, and activity will be removed. This cannot be undone. Appearance and preferences stay.")
            }
            .fullScreenCover(isPresented: $showingWelcome) {
                WelcomeView { showingWelcome = false }
            }
            .sheet(isPresented: $showingBusiness) {
                NavigationStack {
                    VStack(alignment: .leading, spacing: 24) {
                        Image(systemName: "storefront").font(.largeTitle).foregroundStyle(.tint)
                        PageTitle(text: "Business workspace")
                        Text("Business sign-in and program management aren't implemented yet.")
                            .foregroundStyle(Color.muted)
                    }
                    .padding(28)
                    .frame(maxWidth: 560)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background { AppBackground() }
                    .toolbar {
                        ToolbarItem(placement: .confirmationAction) {
                            Button("Done") { showingBusiness = false }
                        }
                    }
                }
                .presentationDetents([.large])
            }
            .alert("Couldn't export your activity", isPresented: Binding(
                get: { exportError != nil },
                set: { if !$0 { exportError = nil } }
            )) {
                Button("OK") { exportError = nil }
            } message: {
                Text(exportError ?? "")
            }
        }
    }

    private func exportCards() {
        do {
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            encoder.dateEncodingStrategy = .iso8601
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("JOEYY-demo-activity.json")
            try encoder.encode(store.memberships).write(to: url, options: .atomic)
            exportedFile = url
        } catch {
            exportError = error.localizedDescription
        }
    }

    private func clearExport() {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("JOEYY-demo-activity.json")
        if FileManager.default.fileExists(atPath: url.path) {
            do {
                try FileManager.default.removeItem(at: url)
            } catch {
                exportError = "Cards were updated, but the temporary export could not be removed: \(error.localizedDescription)"
            }
        }
        exportedFile = nil
    }
}

private struct PrivacyView: View {
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 26) {
                Notice(
                    symbol: "iphone",
                    title: "Stored on this device",
                    message: "Your joined cards, stamps, coupons, redemption history, and preferences live on this device. Nothing is sent to a server."
                )
                Notice(
                    symbol: "storefront",
                    title: "Merchant access",
                    message: "Nothing in this prototype. The proposed live experience should limit each business to activity within its own program, not your activity elsewhere."
                )
                Notice(
                    symbol: "hand.raised",
                    title: "Not collected",
                    message: "No birthday, contacts, payment details, precise location, or marketing sign-up."
                )
                Notice(
                    symbol: "slider.horizontal.3",
                    title: "Export & deletion",
                    message: "Export or delete cards, coupons, and activity in You. Appearance and reminder preferences are stored separately. Resetting the demo restores sample data."
                )
                Text("This describes the prototype, not a production privacy policy. Account recovery, retention periods, consent wording, and merchant access require review before launch.")
                    .font(.footnote).foregroundStyle(Color.muted)
            }
            .padding(24)
            .frame(maxWidth: 620)
            .frame(maxWidth: .infinity)
        }
        .background { AppBackground() }
        .appNavigationTitle("Data & privacy")
        .toolbar(.visible, for: .navigationBar)
    }
}
