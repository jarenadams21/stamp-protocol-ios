import SwiftUI

@main
struct JOEYYApp: App {
    @State private var store: LoyaltyStore
    private let defaults: UserDefaults
    @AppStorage("appearance") private var appearance = "System"
    @AppStorage("accent") private var accent = AppAccent.orange.rawValue

    init() {
        let arguments = ProcessInfo.processInfo.arguments
        let defaults: UserDefaults
        if arguments.contains("-ui-testing"),
           let testDefaults = UserDefaults(suiteName: "com.joeyy.ui-tests") {
            if arguments.contains("-reset-demo") {
                testDefaults.removePersistentDomain(forName: "com.joeyy.ui-tests")
            }
            defaults = testDefaults
        } else {
            defaults = .standard
        }
        self.defaults = defaults
        _appearance = AppStorage(wrappedValue: "System", "appearance", store: defaults)
        _accent = AppStorage(wrappedValue: AppAccent.orange.rawValue, "accent", store: defaults)
        _store = State(initialValue: LoyaltyStore(
            defaults: defaults, reset: arguments.contains("-reset-demo")
        ))
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(store)
                .defaultAppStorage(defaults)
                .environment(\.appAccent, AppAccent(rawValue: accent) ?? .orange)
                .tint((AppAccent(rawValue: accent) ?? .orange).color)
                .accentColor((AppAccent(rawValue: accent) ?? .orange).color)
                .fontDesign(.default)
                .preferredColorScheme(appearance == "System" ? nil : appearance == "Dark" ? .dark : .light)
        }
    }
}

enum AppTab: Hashable {
    case home, search, redeemed, you
}

struct RootView: View {
    @Environment(LoyaltyStore.self) private var store
    @AppStorage("hasSeenWelcome") private var hasSeenWelcome = false
    @State private var tab = AppTab.home
    @State private var showingWelcome = false

    var body: some View {
        TabView(selection: $tab) {
            Tab("Home", systemImage: "house", value: .home) {
                HomeView(tab: $tab)
            }
            Tab("Search", systemImage: "magnifyingglass", value: .search) {
                SearchView()
            }
            Tab("Redeemed", systemImage: "ticket", value: .redeemed) {
                RedeemedView()
            }
            .badge(store.redemptions.filter(\.isAvailable).count)
            Tab("You", systemImage: "person.crop.circle", value: .you) {
                ProfileView()
            }
        }
        .onAppear {
            showingWelcome = !hasSeenWelcome && !ProcessInfo.processInfo.arguments.contains("-skip-welcome")
        }
        .fullScreenCover(isPresented: $showingWelcome) {
            WelcomeView {
                hasSeenWelcome = true
                showingWelcome = false
            }
        }
        .safeAreaInset(edge: .top, spacing: 0) {
            if let error = store.storageError {
                Text(error)
                    .font(.footnote)
                    .padding()
                    .frame(maxWidth: .infinity)
                    .background(Color.surface)
                    .accessibilityAddTraits(.isStaticText)
            }
        }
    }
}

struct WelcomeView: View {
    let continueAction: () -> Void

    var body: some View {
        GeometryReader { geometry in
            ScrollView {
                VStack(alignment: .leading, spacing: 28) {
                    BrandMark()
                    Spacer(minLength: 12)
                    PageTitle(text: "Stamp cards", size: 40)
                    Text("Find a business, collect stamps, and choose a reward.")
                        .font(.body)
                        .foregroundStyle(Color.muted)
                        .lineSpacing(4)
                    ClientRow(place: Place.samples[0], stamps: 5)
                        .background(Color.surface, in: RoundedRectangle(cornerRadius: 8))
                    Spacer(minLength: 0)
                    Button("Continue", action: continueAction)
                        .buttonStyle(PrimaryButton())
                        .accessibilityIdentifier("welcome.continue")
                    Text("Seattle prototype / Fictional offers")
                        .font(.caption)
                        .foregroundStyle(Color.muted)
                        .frame(maxWidth: .infinity)
                        .multilineTextAlignment(.center)
                }
                .padding(28)
                .frame(minHeight: geometry.size.height, alignment: .topLeading)
                .frame(maxWidth: 560)
                .frame(maxWidth: .infinity)
            }
            .background { AppBackground() }
        }
    }
}
