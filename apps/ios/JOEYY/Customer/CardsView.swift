import SwiftUI

struct HomeView: View {
    @Environment(LoyaltyStore.self) private var store
    @Binding var tab: AppTab
    @State private var showingArchive = false
    @State private var showingGroups = false
    @State private var choosingGroup = false
    @State private var showingSearch = false
    @State private var filter = CollectionFilter.all
    @State private var query = ""
    @State private var editingGroup: PlaceGroup?
    @State private var groupPage = 0
    @Environment(\.reduceCardMotion) private var reduceMotion

    private var selectedGroup: PlaceGroup? {
        guard case .group(let id) = filter else { return nil }
        return store.groups.first { $0.id == id }
    }

    private var quickGroups: [PlaceGroup] {
        var groups = Array(store.groups.prefix(6))
        if let selectedGroup, !groups.contains(where: { $0.id == selectedGroup.id }) {
            groups[groups.count - 1] = selectedGroup
        }
        return groups
    }

    private var places: [Place] {
        let collection = selectedGroup.map { store.places(in: $0) } ?? store.ordered(store.activePlaces, in: .home)
        return collection.filter { place in
            place.matchesCollectionSearch(query) &&
                (filter != .favorites || store.membership(for: place)?.isFavorite == true)
        }
    }

    private var groups: [PlaceGroup] {
        let query = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return store.groups.filter {
            query.isEmpty || $0.name.localizedCaseInsensitiveContains(query)
        }
    }

    private var collectionName: String {
        switch filter {
        case .all: "Your places"
        case .favorites: "Favorites"
        case .groups: "All groups"
        case .group: selectedGroup?.name ?? "Your places"
        }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 20) {
                    HStack(alignment: .top, spacing: 12) {
                        collectionPicker.layoutPriority(1)
                        Spacer()
                        Button {
                            withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.2)) {
                                showingSearch.toggle()
                                if !showingSearch { query = "" }
                            }
                        } label: {
                            Image(systemName: showingSearch ? "xmark" : "magnifyingglass")
                                .font(.system(size: 20))
                                .frame(width: 44, height: 44)
                        }
                        .accessibilityLabel(showingSearch ? "Close search" : "Find your places")
                        .accessibilityIdentifier("home.search")
                    }
                    if showingSearch {
                        CollectionSearchField(
                            prompt: filter == .groups ? "Find a group" : "Find your places",
                            query: $query, identifier: "home.query", autofocus: true
                        )
                        .transition(.opacity)
                    }
                    if filter == .groups {
                        if groups.isEmpty {
                            ContentUnavailableView(
                                query.isEmpty ? "No groups" : "No matching groups",
                                systemImage: "folder"
                            )
                        }
                        let window = CollectionWindow(count: groups.count, page: groupPage, size: 3)
                        ForEach(Array(groups[window.range])) { group in
                            PlaceStack(
                                title: group.name, places: store.places(in: group),
                                identifier: "group.stack.\(group.id)",
                                cardPrefix: "group.card.\(group.id)",
                                titleIdentifier: "home.group.\(group.name)",
                                orderCollection: .group(group.id),
                                edit: { editingGroup = group }
                            )
                        }
                        CollectionPager(page: $groupPage, count: groups.count, size: 3,
                                        identifier: "home.groups")
                    } else if let selectedGroup, places.isEmpty {
                        ContentUnavailableView {
                            Text(query.isEmpty ? "No active places in this group" : "No matching places")
                        } actions: {
                            Button("Edit group") { editingGroup = selectedGroup }
                        }
                    } else if store.activePlaces.isEmpty {
                        ContentUnavailableView {
                            Label("No cards", systemImage: "rectangle.stack")
                        } actions: {
                            Button("Search for a business") { tab = .search }
                        }
                    } else if places.isEmpty {
                        ContentUnavailableView {
                            Text(query.isEmpty && filter == .favorites ? "No favorites" : "No matching places")
                        }
                    } else {
                        PlaceStack(
                            title: collectionName,
                            places: places, identifier: "home.stack", cardPrefix: "card",
                            showsTitle: false,
                            orderCollection: selectedGroup.map { .group($0.id) } ?? .home,
                            edit: selectedGroup == nil ? nil : { editingGroup = selectedGroup }
                        )
                        .id(filter)
                    }
                }
                .padding(24)
                .frame(maxWidth: 720)
                .frame(maxWidth: .infinity)
            }
            .scrollDismissesKeyboard(.interactively)
            .background { AppBackground() }
            .toolbar(.hidden, for: .navigationBar)
            .navigationDestination(for: Place.self) { PlaceDetailView(place: $0) }
            .sheet(isPresented: $showingArchive) { MemoriesView() }
            .sheet(isPresented: $showingGroups) { GroupsView() }
            .sheet(isPresented: $choosingGroup) {
                GroupsView(selectedGroupID: selectedGroup?.id, onSelect: { filter = .group($0.id) })
            }
            .sheet(item: $editingGroup) { GroupEditorView(group: $0) }
            .onChange(of: filter) { query = "" }
            .onChange(of: query) { groupPage = 0 }
            .onChange(of: store.groups) {
                if filter == .groups && store.groups.isEmpty { filter = .all }
                if case .group(let id) = filter, !store.groups.contains(where: { $0.id == id }) {
                    filter = .all
                }
            }
        }
    }

    private var collectionPicker: some View {
        Menu {
            Button("Manage groups", systemImage: "folder") { showingGroups = true }
                .accessibilityIdentifier("home.groups")
            Button("Memories", systemImage: "rectangle.stack") { showingArchive = true }
                .accessibilityIdentifier("home.memories")
            Divider()
            Picker("Collection", selection: $filter) {
                Text("All places").tag(CollectionFilter.all)
                Text("Favorites").tag(CollectionFilter.favorites)
                Text("All groups").tag(CollectionFilter.groups)
                ForEach(quickGroups) { group in
                    Text(group.name).tag(CollectionFilter.group(group.id))
                }
            }
            if store.groups.count > 6 {
                Button("Find a group", systemImage: "magnifyingglass") { choosingGroup = true }
                    .accessibilityIdentifier("home.chooseGroup")
            }
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                PageTitle(text: collectionName)
                Image(systemName: "chevron.down").font(.caption.weight(.medium))
            }
            .frame(minHeight: 44)
            .contentShape(Rectangle())
            .accessibilityHidden(true)
        }
        .accessibilityLabel(collectionName)
        .accessibilityHint("Choose a collection, manage groups, or open Memories.")
        .accessibilityIdentifier("home.collection")
    }
}

private enum CollectionFilter: Hashable {
    case all, favorites, groups
    case group(UUID)
}

struct CollectionSearchField: View {
    let prompt: String
    @Binding var query: String
    let identifier: String
    var autofocus = false
    @FocusState private var focused: Bool
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if typeSize.isAccessibilitySize {
                Text(prompt).font(.headline)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityHidden(true)
            }
            input
        }
    }

    private var input: some View {
        HStack(spacing: 12) {
            Image(systemName: "magnifyingglass").font(.system(size: 18))
                .foregroundStyle(Color.muted)
                .accessibilityHidden(true)
            TextField(typeSize.isAccessibilitySize ? "Search" : prompt, text: $query)
                .focused($focused)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.search)
                .onSubmit { focused = false }
                .onAppear { if autofocus { focused = true } }
                .accessibilityLabel(prompt)
                .accessibilityIdentifier(identifier)
            if !query.isEmpty {
                Button { query = "" } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 18))
                        .foregroundStyle(Color.muted)
                        .frame(width: 44, height: 44)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Clear search")
                .accessibilityIdentifier("\(identifier).clear")
            }
        }
        .padding(.leading, 16)
        .padding(.trailing, 8)
        .frame(minHeight: 56)
        .background(Color.surface, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color.rule))
    }
}

struct GroupsView: View {
    var selectedGroupID: UUID?
    var onSelect: ((PlaceGroup) -> Void)?
    @Environment(LoyaltyStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var editing: PlaceGroup?
    @State private var creating = false
    @State private var query = ""
    @State private var page = 0

    private var matches: [PlaceGroup] {
        let query = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return store.groups.filter { query.isEmpty || $0.name.localizedCaseInsensitiveContains(query) }
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                CollectionSearchField(prompt: "Find a group", query: $query, identifier: "groups.query")
                    .padding(.horizontal, 24)
                    .padding(.vertical, 12)
                List {
                    if matches.isEmpty {
                        Text(store.groups.isEmpty ? "No groups" : "No matching groups").foregroundStyle(Color.muted)
                    }
                    let window = CollectionWindow(count: matches.count, page: page, size: 6)
                    ForEach(Array(matches[window.range])) { group in
                        Button {
                            if let onSelect {
                                onSelect(group)
                                dismiss()
                            } else {
                                editing = group
                            }
                        } label: {
                            if typeSize.isAccessibilitySize {
                                VStack(alignment: .leading, spacing: 8) {
                                    Text(group.name).fixedSize(horizontal: false, vertical: true)
                                    if selectedGroupID == group.id {
                                        Image(systemName: "checkmark").accessibilityHidden(true)
                                    }
                                    Text("\(store.places(in: group).count) places")
                                        .font(.subheadline).foregroundStyle(Color.muted)
                                }
                                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                                .contentShape(Rectangle())
                            } else {
                                HStack {
                                    Text(group.name).fixedSize(horizontal: false, vertical: true)
                                    Spacer()
                                    if selectedGroupID == group.id {
                                        Image(systemName: "checkmark").accessibilityHidden(true)
                                    }
                                    Text("\(store.places(in: group).count) places").foregroundStyle(Color.muted)
                                }
                                .frame(minHeight: 44)
                                .contentShape(Rectangle())
                            }
                        }
                        .buttonStyle(.plain)
                        .accessibilityAddTraits(selectedGroupID == group.id ? .isSelected : [])
                        .accessibilityIdentifier("group.\(onSelect == nil ? "edit" : "choose").\(group.name)")
                    }
                    CollectionPager(page: $page, count: matches.count, size: 6, identifier: "groups")
                    if onSelect == nil {
                        Button("New group") { creating = true }
                            .frame(minHeight: 44)
                            .accessibilityIdentifier("group.create")
                    }
                }
                .listStyle(.plain)
                .scrollDismissesKeyboard(.interactively)
            }
            .scrollDismissesKeyboard(.interactively)
            .appNavigationTitle(onSelect == nil ? "Groups" : "Choose a group")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .sheet(item: $editing) { GroupEditorView(group: $0) }
            .sheet(isPresented: $creating) { GroupEditorView(group: nil) }
            .onChange(of: query) { page = 0 }
        }
    }
}

struct GroupMembershipView: View {
    let places: [Place]
    @Environment(LoyaltyStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var creating = false
    @State private var failure: String?
    @State private var query = ""
    @State private var selectedOnly = false
    @State private var page = 0

    init(place: Place) { places = [place] }
    init(places: [Place]) { self.places = places }

    private func includesSelection(_ group: PlaceGroup) -> Bool {
        !places.isEmpty && places.allSatisfy { group.placeIDs.contains($0.id) }
    }

    private func containsSelection(_ group: PlaceGroup) -> Bool {
        places.contains { group.placeIDs.contains($0.id) }
    }

    private var matches: [PlaceGroup] {
        let query = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return store.groups.filter {
            (query.isEmpty || $0.name.localizedCaseInsensitiveContains(query)) &&
                (!selectedOnly || containsSelection($0))
        }
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 12) {
                CollectionSearchField(
                    prompt: "Find a group", query: $query, identifier: "membership.query"
                )
                .padding(.horizontal, 24)
                Picker("Groups", selection: $selectedOnly) {
                    Text("All").tag(false)
                    Text("Added").tag(true)
                }
                .pickerStyle(.segmented)
                .padding(.horizontal, 24)
                .accessibilityIdentifier("membership.selectedOnly")
                List {
                    let window = CollectionWindow(count: matches.count, page: page, size: 6)
                    ForEach(Array(matches[window.range])) { group in
                        SelectionRow(
                            title: group.name, selected: includesSelection(group),
                            partiallySelected: containsSelection(group) && !includesSelection(group),
                            identifier: "group.membership.\(group.name)"
                        ) {
                            let selectedIDs = Set(places.map(\.id))
                            let ids = includesSelection(group)
                                ? Set(group.placeIDs).subtracting(selectedIDs)
                                : Set(group.placeIDs).union(selectedIDs)
                            do { try store.saveGroup(id: group.id, name: group.name, placeIDs: ids.sorted()) }
                            catch { failure = error.localizedDescription }
                        }
                    }
                    if matches.isEmpty { Text("No matching groups").foregroundStyle(Color.muted) }
                    CollectionPager(page: $page, count: matches.count, size: 6, identifier: "membership")
                    Button("New group") { creating = true }
                }
                .listStyle(.plain)
            }
            .scrollDismissesKeyboard(.interactively)
            .appNavigationTitle("Groups")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .sheet(isPresented: $creating) { GroupEditorView(group: nil, initialPlaceIDs: places.map(\.id)) }
            .onChange(of: query) { page = 0 }
            .onChange(of: selectedOnly) { page = 0 }
            .alert("Couldn't update group", isPresented: Binding(
                get: { failure != nil }, set: { if !$0 { failure = nil } }
            )) {
                Button("OK") { failure = nil }
            } message: { Text(failure ?? "") }
        }
    }
}

struct GroupEditorView: View {
    let group: PlaceGroup?
    @Environment(LoyaltyStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var name: String
    @State private var selected: Set<String>
    @State private var confirmingDeletion = false
    @State private var failure: String?
    @State private var query = ""
    @State private var page = 0

    init(group: PlaceGroup?, initialPlaceIDs: [String] = []) {
        self.group = group
        _name = State(initialValue: group?.name ?? "")
        _selected = State(initialValue: Set(group?.placeIDs ?? initialPlaceIDs))
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 12) {
                TextField("Group name", text: $name, axis: typeSize.isAccessibilitySize ? .vertical : .horizontal)
                    .font(.title2.weight(.medium))
                    .lineLimit(1...3)
                    .padding(.horizontal, 24)
                    .frame(minHeight: 44)
                    .accessibilityIdentifier("group.name")
                CollectionSearchField(
                    prompt: "Find a place", query: $query, identifier: "group.query"
                )
                .padding(.horizontal, 24)
                List {
                    let matches = Place.catalog.filter {
                        store.membership(for: $0) != nil && $0.matchesCollectionSearch(query)
                    }
                    let window = CollectionWindow(count: matches.count, page: page, size: 6)
                    ForEach(Array(matches[window.range])) { place in
                        SelectionRow(
                            title: place.name,
                            subtitle: store.membership(for: place)?.archived == true ? "In Memories" : nil,
                            selected: selected.contains(place.id),
                            identifier: "group.place.\(place.id)"
                        ) {
                            if selected.contains(place.id) { selected.remove(place.id) }
                            else { selected.insert(place.id) }
                        }
                    }
                    if matches.isEmpty { Text("No matching places").foregroundStyle(Color.muted) }
                    CollectionPager(page: $page, count: matches.count, size: 6, identifier: "group.places")
                }
                .listStyle(.plain)
            }
            .scrollDismissesKeyboard(.interactively)
            .appNavigationTitle(group == nil ? "New group" : "Edit group")
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if group != nil {
                    Button("Delete group", systemImage: "trash", role: .destructive) {
                        confirmingDeletion = true
                    }
                    .frame(maxWidth: .infinity, minHeight: 44)
                    .padding(.horizontal, 24)
                    .padding(.vertical, 8)
                    .background(Color.surface)
                    .accessibilityIdentifier("group.delete")
                }
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        do {
                            try store.saveGroup(id: group?.id, name: name, placeIDs: selected.sorted())
                            dismiss()
                        } catch { failure = error.localizedDescription }
                    }
                    .accessibilityIdentifier("group.save")
                }
            }
            .alert("Delete this group?", isPresented: $confirmingDeletion) {
                if let group {
                    Button("Delete group", role: .destructive) {
                        do {
                            try store.deleteGroup(group)
                            dismiss()
                        } catch { failure = error.localizedDescription }
                    }
                    .accessibilityIdentifier("group.confirmDelete")
                }
                Button("Cancel", role: .cancel) {}
                    .accessibilityIdentifier("group.cancelDelete")
            } message: { Text("Cards, punches, favorites, and coupons stay.") }
            .alert("Couldn't update group", isPresented: Binding(
                get: { failure != nil }, set: { if !$0 { failure = nil } }
            )) {
                Button("OK") { failure = nil }
            } message: { Text(failure ?? "") }
            .onChange(of: query) { page = 0 }
        }
    }
}

struct MemoriesView: View {
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                CardHistoryCollection(collection: .memories)
                    .padding(24)
                    .frame(maxWidth: 620)
                    .frame(maxWidth: .infinity)
            }
            .background { AppBackground() }
            .appNavigationTitle("Memories")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}

struct SearchView: View {
    @State private var query = ""

    private var matches: [Place] { Place.search(query) }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    PageTitle(text: "Search")
                    CollectionSearchField(
                        prompt: "Business name or client ID", query: $query, identifier: "search.query"
                    )
                    if query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        DiscoveryGallery(
                            title: "Discoverable", places: Place.discoverable,
                            identifier: "discovery.gallery", cardPrefix: "discover"
                        )
                    } else if matches.isEmpty {
                        ContentUnavailableView("No matching business", systemImage: "magnifyingglass")
                    } else {
                        DiscoveryGallery(
                            title: "Matching places", places: matches,
                            identifier: "search.gallery", cardPrefix: "search"
                        )
                    }
                }
                .padding(24)
                .frame(maxWidth: 720)
                .frame(maxWidth: .infinity)
            }
            .scrollDismissesKeyboard(.interactively)
            .background { AppBackground() }
            .toolbar(.hidden, for: .navigationBar)
            .navigationDestination(for: Place.self) { PlaceDetailView(place: $0) }
        }
    }
}
