import SwiftUI

struct HomeView: View {
    @Environment(LoyaltyStore.self) private var store
    @Binding var tab: AppTab
    @State private var showingArchive = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 28) {
                    HStack {
                        PageTitle(text: "Home").accessibilityIdentifier("heading.home")
                        Spacer()
                        Button {
                            showingArchive = true
                        } label: {
                            Image(systemName: "archivebox").frame(width: 44, height: 44)
                        }
                        .accessibilityLabel("Archived cards")
                    }
                    if store.activePlaces.isEmpty {
                        ContentUnavailableView {
                            Label("No cards", systemImage: "rectangle.stack")
                        } actions: {
                            Button("Search for a business") { tab = .search }
                        }
                    } else {
                        VStack(spacing: 0) {
                            ForEach(store.activePlaces) { place in
                                NavigationLink(value: place) {
                                    ClientRow(place: place, stamps: store.membership(for: place)?.stamps)
                                }
                                .buttonStyle(.plain)
                                .accessibilityIdentifier("card.\(place.id)")
                                if place.id != store.activePlaces.last?.id {
                                    Divider().padding(.horizontal, 18)
                                }
                            }
                        }
                        .background(Color.surface, in: RoundedRectangle(cornerRadius: 8))
                        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color.rule))
                        Button("Add a business") {
                            tab = .search
                        }
                        .font(.subheadline)
                        .frame(minHeight: 44)
                        .buttonStyle(TextButton())
                    }
                }
                .padding(24)
                .frame(maxWidth: 620)
                .frame(maxWidth: .infinity)
            }
            .background { AppBackground() }
            .toolbar(.hidden, for: .navigationBar)
            .navigationDestination(for: Place.self) { PlaceDetailView(place: $0) }
            .sheet(isPresented: $showingArchive) { ArchiveView() }
        }
    }
}

struct ArchiveView: View {
    @Environment(LoyaltyStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    private var archived: [Place] {
        Place.samples.filter { store.membership(for: $0)?.archived == true }
    }

    var body: some View {
        NavigationStack {
            List {
                if archived.isEmpty {
                    ContentUnavailableView(
                        "No archived cards", systemImage: "archivebox",
                        description: Text("Archived cards retain their stamps and activity.")
                    )
                    .listRowBackground(Color.clear)
                }
                ForEach(archived) { place in
                    HStack {
                        VStack(alignment: .leading, spacing: 5) {
                            Text(place.name).font(.headline.weight(.medium)).foregroundStyle(.tint)
                            Text("\(store.membership(for: place)?.stamps ?? 0) stamps")
                                .font(.caption).foregroundStyle(Color.muted)
                        }
                        Spacer()
                        Button("Restore") { store.join(place) }.buttonStyle(.bordered)
                    }
                    .listRowBackground(Color.surface)
                }
            }
            .scrollContentBackground(.hidden)
            .background { AppBackground() }
            .appNavigationTitle("Archived cards")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}

struct SearchView: View {
    @Environment(LoyaltyStore.self) private var store
    @State private var query = ""

    private var matches: [Place] { Place.search(query) }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    PageTitle(text: "Search")
                    HStack(spacing: 12) {
                        Image(systemName: "magnifyingglass").foregroundStyle(Color.muted)
                        TextField("Business name or client ID", text: $query)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .submitLabel(.search)
                            .accessibilityIdentifier("search.query")
                        if !query.isEmpty {
                            Button {
                                query = ""
                            } label: {
                                Image(systemName: "xmark.circle.fill")
                                    .foregroundStyle(Color.muted)
                                    .frame(width: 44, height: 44)
                            }
                            .accessibilityLabel("Clear search")
                        }
                    }
                    .padding(.leading, 16)
                    .padding(.trailing, 8)
                    .frame(minHeight: 56)
                    .background(Color.surface, in: RoundedRectangle(cornerRadius: 8))
                    .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color.rule))

                    if !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        if matches.isEmpty {
                            ContentUnavailableView(
                                "No matching business", systemImage: "magnifyingglass",
                                description: Text("Check the name or client ID.")
                            )
                        } else {
                            VStack(spacing: 0) {
                                ForEach(matches) { place in
                                    NavigationLink(value: place) {
                                        ClientRow(place: place)
                                    }
                                    .buttonStyle(.plain)
                                    .accessibilityIdentifier("search.\(place.id)")
                                    if place.id != matches.last?.id {
                                        Divider().padding(.horizontal, 18)
                                    }
                                }
                            }
                            .background(Color.surface, in: RoundedRectangle(cornerRadius: 8))
                        }
                    }
                }
                .padding(24)
                .frame(maxWidth: 620)
                .frame(maxWidth: .infinity)
            }
            .scrollDismissesKeyboard(.interactively)
            .background { AppBackground() }
            .toolbar(.hidden, for: .navigationBar)
            .navigationDestination(for: Place.self) { PlaceDetailView(place: $0) }
        }
    }
}
