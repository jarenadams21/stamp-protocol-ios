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
                VStack(alignment: .leading, spacing: 22) {
                    Text("Real cafe visits").font(.largeTitle.bold())
                    Text("These verified cards are separate from your local demo cards.")
                        .foregroundStyle(.secondary)
                    Label("Hardware test only — factory zero-key tags are not secure for production rewards.",
                          systemImage: "exclamationmark.triangle")
                        .font(.footnote)
                        .padding()
                        .background(Color.orange.opacity(0.12), in: .rect(cornerRadius: 12))
                    if store.isSignedIn {
                        accountControls
                        realCards
                    } else {
                        signIn
                    }
                    if store.isBusy { ProgressView("Contacting loyalty service…") }
                    if let message = store.message {
                        Text(message).font(.callout).accessibilityIdentifier("tap.status")
                    }
                    if let message = wallet.message {
                        Text(message).font(.callout).accessibilityIdentifier("tap.walletStatus")
                    }
                    Text("NFC requires a supported iPhone. Wallet passes are signed by the service; adding requires Apple’s confirmation. Existing entitled passes can be updated while this app is open. This is not an Apple Pay payment.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                .padding(24)
                .frame(maxWidth: 720)
                .frame(maxWidth: .infinity)
            }
            .background { AppBackground() }
            .navigationTitle("Tap")
            .navigationBarTitleDisplayMode(.inline)
            .task { await store.refresh() }
            .onChange(of: scenePhase) {
                if scenePhase == .active { Task { await store.refresh() } }
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

    private var signIn: some View {
        VStack(alignment: .leading, spacing: 14) {
            Picker("Account", selection: $createAccount) {
                Text("Create account").tag(true)
                Text("Sign in").tag(false)
            }
            .pickerStyle(.segmented)
            TextField("Username", text: $username)
                .textContentType(.username)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .textFieldStyle(.roundedBorder)
            SecureField("Password (12+ characters)", text: $password)
                .textContentType(createAccount ? .newPassword : .password)
                .textFieldStyle(.roundedBorder)
            Button(createAccount ? "Create account" : "Sign in") {
                Task {
                    await store.authenticate(username: username, password: password, create: createAccount)
                    password = ""
                }
            }
            .buttonStyle(.borderedProminent)
            .disabled(busy)
            Text("Username: 3–40 ASCII letters, digits, dot, underscore or hyphen. Keep your password to return to the same cards.")
                .font(.footnote).foregroundStyle(.secondary)
            if store.session != nil {
                Button("Sign out on this device", role: .destructive) { Task { await store.logout() } }
                    .disabled(busy)
            }
        }
    }

    private var accountControls: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Signed in as \(store.session?.username ?? "")").font(.headline)
            if store.pending != nil {
                Text("A tap is awaiting confirmation. Retry without rescanning; it cannot award twice for the same request.")
                Button("Retry pending tap") {
                    Task {
                        wallet.message = nil
                        if let card = await store.retry() { await updateWallet(for: card, onlyIfInstalled: true) }
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(busy)
                Button("Discard pending tap", role: .destructive) { discardConfirmation = true }
                    .disabled(busy)
            } else {
                Button("Scan cafe tag", systemImage: "wave.3.right") { Task { await scan() } }
                    .buttonStyle(.borderedProminent)
                    .disabled(busy)
            }
            if isScanning {
                Button("Cancel scan") { scanner.cancel() }
            }
            HStack {
                Button("Refresh cards", systemImage: "arrow.clockwise") { Task { await store.refresh() } }
                Spacer()
                Button("Sign out", role: .destructive) {
                    Task {
                        await store.logout()
                        wallet.message = nil
                        password = ""
                    }
                }
            }
            .disabled(busy)
        }
    }

    @ViewBuilder private var realCards: some View {
        if store.cards.isEmpty {
            ContentUnavailableView("No verified cards yet", systemImage: "wave.3.right",
                                   description: Text("Your first verified scan enrolls you automatically."))
        } else {
            ForEach(store.cards) { card in
                VStack(alignment: .leading, spacing: 12) {
                    PunchCard(place: card.place, stamps: card.stamps)
                    Text("\(card.stamps) / \(card.target) stamps · \(card.rewardsAvailable) rewards available")
                        .font(.headline)
                    Button("Add / Update Apple Wallet", systemImage: "wallet.pass") {
                        Task { await updateWallet(for: card, onlyIfInstalled: false) }
                    }
                    .buttonStyle(.bordered)
                    .disabled(busy)
                }
            }
        }
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
