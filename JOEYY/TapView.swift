import SwiftUI

struct TapView: View {
    @Environment(\.scenePhase) private var scenePhase
    @State private var store = TapStore()
    @State private var scanner = NFCTagScanner()
    @State private var wallet = TapWallet()
    @State private var username = ""
    @State private var password = ""
    @State private var createAccount = true
    @State private var isScanning = false
    @State private var discardConfirmation = false

    private var busy: Bool { store.isBusy || isScanning || wallet.presentation != nil }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 28) {
                    TapWelcomeHeader(signedIn: store.isSignedIn)
                    if store.isSignedIn {
                        accountControls
                        realCards
                    } else {
                        TapSignInForm(username: $username, password: $password,
                                      createAccount: $createAccount, busy: busy,
                                      authenticate: authenticate)
                        if store.session != nil {
                            Button("Sign out on this device", role: .destructive) {
                                Task { await store.logout() }
                            }
                            .frame(minHeight: 44)
                            .disabled(busy)
                        }
                    }
                    if store.isBusy && store.cardLoadState != .loading {
                        ProgressView("Contacting loyalty service...")
                            .font(.subheadline)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    if let message = store.message {
                        TapStatusMessage(message: message, identifier: "tap.status")
                    }
                    if let message = wallet.message {
                        TapStatusMessage(message: message, identifier: "tap.walletStatus")
                    }
                    TapTestInformation()
                }
                .padding(24)
                .frame(maxWidth: 560)
                .frame(maxWidth: .infinity)
            }
            .background { AppBackground() }
            .scrollDismissesKeyboard(.interactively)
            .toolbarVisibility(.hidden, for: .navigationBar)
            .task { await store.refresh() }
            .onChange(of: scenePhase) {
                if scenePhase == .active && !busy { Task { await store.refresh() } }
            }
            .sheet(item: $wallet.presentation, onDismiss: { wallet.finished() }) { item in
                AddLoyaltyPassSheet(pass: item.pass) { wallet.finished() }
            }
            .confirmationDialog("Discard pending tap?", isPresented: $discardConfirmation) {
                Button("Discard pending tap", role: .destructive) { store.discardPending() }
            } message: {
                Text("A visit may already have been accepted. Retrying is safest and reuses the same request ID. Discarding does not undo a visit.")
            }
        }
    }

    private var accountControls: some View {
        VStack(alignment: .leading, spacing: 20) {
            HStack(spacing: 12) {
                Label(store.session?.username ?? "", systemImage: "person.crop.circle")
                    .font(.subheadline)
                    .foregroundStyle(Color.muted)
                    .lineLimit(nil)
                Spacer(minLength: 0)
                Menu("Account options", systemImage: "ellipsis") {
                    Button("Refresh cards", systemImage: "arrow.clockwise") {
                        Task { await store.refresh() }
                    }
                    Button("Sign out", systemImage: "rectangle.portrait.and.arrow.right", role: .destructive) {
                        Task { await signOut() }
                    }
                }
                .buttonStyle(UtilityButton())
                .disabled(busy)
            }
            if store.pending != nil {
                Text("Finish your last tap").font(.headline)
                Text("Retry without scanning again. The same request cannot award a second stamp.")
                    .font(.subheadline).foregroundStyle(Color.muted)
                Button("Retry pending tap") {
                    Task {
                        wallet.message = nil
                        if let card = await store.retry() { await updateWallet(for: card, onlyIfInstalled: true) }
                    }
                }
                .buttonStyle(PrimaryButton())
                .disabled(busy)
                Button("Discard pending tap", role: .destructive) { discardConfirmation = true }
                    .frame(minHeight: 44)
                    .disabled(busy)
            } else {
                Button("Scan cafe tag", systemImage: "wave.3.right") { Task { await scan() } }
                    .buttonStyle(PrimaryButton())
                    .disabled(busy)
            }
            if isScanning {
                Button("Cancel scan") { scanner.cancel() }
                    .frame(minHeight: 44)
            }
        }
        .padding(20)
        .modifier(SurfacePanel())
    }

    @ViewBuilder private var realCards: some View {
        if !store.cards.isEmpty {
            ForEach(store.cards) { card in
                TapLiveCard(card: card, busy: busy) {
                    Task { await updateWallet(for: card, onlyIfInstalled: false) }
                }
            }
        } else if store.pending != nil {
            ContentUnavailableView(
                "Tap awaiting confirmation", systemImage: "clock.arrow.circlepath",
                description: Text("Your chip read is saved. Retry when the service is available so it can confirm your balance without awarding twice.")
            )
            .accessibilityIdentifier("tap.pendingState")
        } else {
            switch store.cardLoadState {
            case .notLoaded, .loading:
                ProgressView("Loading your cards...")
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityIdentifier("tap.loadingCards")
            case .failed:
                ContentUnavailableView(
                    "Cards unavailable", systemImage: "wifi.exclamationmark",
                    description: Text("We couldn't check your balances. Refresh your cards when the loyalty service is available.")
                )
                .accessibilityIdentifier("tap.unavailableCards")
            case .loaded:
                ContentUnavailableView("No verified cards yet", systemImage: "wave.3.right",
                                       description: Text("Your first verified scan enrolls you automatically."))
                    .accessibilityIdentifier("tap.emptyCards")
            }
        }
    }

    private func authenticate() {
        Task {
            await store.authenticate(username: username, password: password, create: createAccount)
            password = ""
        }
    }

    private func signOut() async {
        await store.logout()
        wallet.message = nil
        password = ""
    }

    private func scan() async {
        guard !busy else { return }
        isScanning = true
        wallet.message = nil
        do {
            let url = try await scanner.scan()
            isScanning = false
            if let card = await store.submit(url: url) {
                await updateWallet(for: card, onlyIfInstalled: true)
            }
        } catch {
            isScanning = false
            store.message = (error as? TapError)?.errorDescription ?? "Could not scan this tag. Please try again."
        }
    }

    private func updateWallet(for card: LiveCard, onlyIfInstalled: Bool) async {
        wallet.message = nil
        if let data = await store.passData(for: card) {
            wallet.accept(data, onlyIfInstalled: onlyIfInstalled)
        }
    }
}
