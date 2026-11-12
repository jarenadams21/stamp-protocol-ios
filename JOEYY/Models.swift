import Foundation
import Observation

struct Place: Identifiable, Hashable {
    var initials: String {
        name.split(separator: " ").prefix(2).compactMap(\.first).map(String.init).joined()
    }
    let id: String
    let clientID: String
    let name: String
    let neighborhood: String
    let address: String
    let requiredPunches: Int
    let rewardDescription: String
    let website: String
    let cardStyle: CardStyle

    static let punchRange = 3...12

    static let samples: [Place] = [
        Place(
            id: "monorail-pike", clientID: "6A2E3D81-7B49-4F12-A0C3-819D62E00101",
            name: "Monorail Espresso", neighborhood: "Seattle / Pike St",
            address: "510 Pike St, Seattle",
            requiredPunches: 8, rewardDescription: "Espresso",
            website: "https://monorailespresso.com/pages/pike-st", cardStyle: .rail
        ),
        Place(
            id: "cloud-city", clientID: "7B3F4E92-8C50-4023-B1D4-92AE73F00202",
            name: "Cloud City Coffee", neighborhood: "Seattle / Maple Leaf",
            address: "8801 Roosevelt Way NE, Seattle",
            requiredPunches: 6, rewardDescription: "Brewed coffee",
            website: "https://www.cloudcitycoffee.com/pages/where-to-find-cloud-city", cardStyle: .cloud
        ),
        Place(
            id: "five-stones-kirkland", clientID: "8C405FA3-9D61-4134-82E5-A3BF84000303",
            name: "5 Stones Coffee Co", neighborhood: "Kirkland / Central Way",
            address: "312 Central Way, Kirkland",
            requiredPunches: 10, rewardDescription: "Latte",
            website: "https://5stonescoffeeco.com/pages/kirkland", cardStyle: .stone
        )
    ]

    static let discoverable: [Place] = [
        Place(
            id: "saint-bread", clientID: "9D516AB4-AE72-4245-93F6-B4C095000404",
            name: "Saint Bread", neighborhood: "Seattle / Portage Bay",
            address: "1421 NE Boat St, Seattle",
            requiredPunches: 8, rewardDescription: "Pastry",
            website: "https://www.saintbread.com", cardStyle: .rail
        ),
        Place(
            id: "book-larder", clientID: "AE627BC5-BF83-4356-A407-C5D1A6000505",
            name: "Book Larder", neighborhood: "Seattle / Fremont",
            address: "4252 Fremont Ave N, Seattle",
            requiredPunches: 6, rewardDescription: "10% off one book",
            website: "https://booklarder.com", cardStyle: .stone
        ),
        Place(
            id: "gloom-coffee", clientID: "BF738CD6-C094-4467-B518-D6E2B7000606",
            name: "Gloom Coffee", neighborhood: "Seattle / Pioneer Square",
            address: "240 2nd Ave S, Seattle",
            requiredPunches: 8, rewardDescription: "Espresso",
            website: "https://gloom.coffee", cardStyle: .cloud
        )
    ]

    static let catalog = samples + discoverable

    func matchesCollectionSearch(_ query: String) -> Bool {
        let query = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return query.isEmpty || name.localizedCaseInsensitiveContains(query) ||
            neighborhood.localizedCaseInsensitiveContains(query)
    }

    static func search(_ query: String) -> [Place] {
        let value = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return [] }
        if let identifier = UUID(uuidString: value) {
            return catalog.filter { UUID(uuidString: $0.clientID) == identifier }
        }
        return catalog.filter { $0.name.localizedCaseInsensitiveContains(value) }
    }
}

enum CardStyle: CaseIterable {
    case rail, cloud, stone
}

struct VisitEvent: Identifiable, Codable, Hashable {
    enum Kind: String, Codable {
        case joined, stamp, reward
    }

    var id = UUID()
    let kind: Kind
    let date: Date
    let rewardTitle: String?
    let stampCost: Int?

    init(kind: Kind, date: Date, rewardTitle: String? = nil, stampCost: Int? = nil) {
        self.kind = kind
        self.date = date
        self.rewardTitle = rewardTitle
        self.stampCost = stampCost
    }
}

struct Membership: Identifiable, Codable, Equatable {
    var id: String
    var stamps: Int
    var archived = false
    var events: [VisitEvent]
    var coupons: [Coupon] = []
    var isFavorite = false
    var pendingStamps: [StampUpdate] = []
    var savedCards: [SavedCard] = []
}

struct SavedCard: Identifiable, Codable, Hashable {
    var id = UUID()
    let stamps: Int
    let target: Int
    let reward: String
    let savedAt: Date?
}

struct CardMemory: Identifiable, Hashable {
    let place: Place
    let id: UUID
    let stamps: Int?
    let target: Int?
    let reward: String
    let savedAt: Date?
    let redemption: Redemption?

    var status: String {
        guard let redemption else { return "Saved" }
        guard let coupon = redemption.coupon else { return "Completed" }
        return coupon.usedAt == nil ? "Available" : "Used"
    }
}

struct CollectionWindow {
    let index: Int
    let pages: Int
    let range: Range<Int>

    init(count: Int, page: Int, size: Int) {
        precondition(count >= 0 && size > 0)
        pages = max(1, count / size + (count % size == 0 ? 0 : 1))
        index = min(max(0, page), pages - 1)
        let start = index * size
        range = start..<min(start + size, count)
    }
}

struct StampUpdate: Identifiable, Codable, Equatable {
    let id: UUID
    let receivedAt: Date
}

extension Membership {
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            id: try values.decode(String.self, forKey: .id),
            stamps: try values.decode(Int.self, forKey: .stamps),
            archived: try values.decode(Bool.self, forKey: .archived),
            events: try values.decode([VisitEvent].self, forKey: .events),
            coupons: try values.decodeIfPresent([Coupon].self, forKey: .coupons) ?? [],
            isFavorite: try values.decodeIfPresent(Bool.self, forKey: .isFavorite) ?? false,
            pendingStamps: try values.decodeIfPresent([StampUpdate].self, forKey: .pendingStamps) ?? [],
            savedCards: try values.decodeIfPresent([SavedCard].self, forKey: .savedCards) ?? []
        )
    }
}

struct PlaceGroup: Identifiable, Codable, Equatable {
    let id: UUID
    var name: String
    var placeIDs: [String]
}

enum CardOrderCollection: Hashable {
    case home, group(UUID), redeemed

    var key: String {
        switch self {
        case .home: "home"
        case .group(let id): "group.\(id.uuidString)"
        case .redeemed: "redeemed"
        }
    }
}

struct LoyaltyExport: Codable {
    let memberships: [Membership]
    let groups: [PlaceGroup]
}

struct Coupon: Identifiable, Codable, Hashable {
    let id: UUID
    var usedAt: Date?
}

struct Redemption: Identifiable, Hashable {
    let place: Place
    let event: VisitEvent
    let coupon: Coupon?

    var id: UUID { event.id }
    var isAvailable: Bool { coupon.map { $0.usedAt == nil } ?? false }
}

enum DemoError: LocalizedError {
    case notJoined, insufficientStamps, unknownProgram, cardComplete, archivedCard
    case couponNotFound, couponAlreadyUsed
    case invalidGroupName, duplicateGroupName, invalidGroup
    case unreadableStorage, invalidStampUpdate
    case invalidCardOrder, unreadableCardOrder

    var errorDescription: String? {
        switch self {
        case .notJoined: "Join this card first."
        case .insufficientStamps: "Fill this card before claiming the reward."
        case .unknownProgram: "This program could not be found."
        case .cardComplete: "This card is full. Claim the reward before collecting again."
        case .archivedCard: "Return this card from Memories before collecting stamps or claiming a reward."
        case .couponNotFound: "This coupon could not be found."
        case .couponAlreadyUsed: "This coupon has already been used."
        case .invalidGroupName: "Use a group name between 1 and 40 characters."
        case .duplicateGroupName: "A group with this name already exists."
        case .invalidGroup: "This group or one of its cards could not be found."
        case .unreadableStorage: "Saved cards could not be read. They have not been changed."
        case .invalidStampUpdate: "This stamp update has an invalid date or an ID already assigned to another record."
        case .invalidCardOrder: "These cards cannot be rearranged in this collection."
        case .unreadableCardOrder: "Saved card order could not be read. It has not been changed."
        }
    }
}

@MainActor
@Observable
final class LoyaltyStore {
    private(set) var memberships: [Membership] = []
    private(set) var groups: [PlaceGroup] = []
    private(set) var storageError: String?
    private let defaults: UserDefaults
    private let key = "joeyy.memberships.v2"
    private let groupsKey = "joeyy.groups.v1"
    private let ordersKey = "joeyy.card-orders.v1"
    private(set) var cardOrders: [String: [String]] = [:]
    private var canSaveOrders = true
    private var canSaveMemberships = true

    init(defaults: UserDefaults = .standard, reset: Bool = false) {
        self.defaults = defaults
        if reset {
            resetDemo()
        } else if let data = defaults.data(forKey: key) {
            do {
                let saved = try JSONDecoder().decode([Membership].self, from: data)
                let couponIDs = saved.flatMap { $0.coupons.map(\.id) }
                let redemptionIDs = saved.flatMap { $0.events.filter { $0.kind == .reward }.map(\.id) }
                let updateIDs = saved.flatMap { $0.pendingStamps.map(\.id) }
                let eventIDs = saved.flatMap { $0.events.map(\.id) }
                let savedIDs = saved.flatMap { $0.savedCards.map(\.id) }
                guard Set(saved.map(\.id)).count == saved.count,
                      Set(couponIDs).count == couponIDs.count,
                      Set(redemptionIDs).count == redemptionIDs.count,
                      Set(updateIDs).count == updateIDs.count,
                      Set(eventIDs).count == eventIDs.count,
                      Set(savedIDs).count == savedIDs.count,
                      Set(savedIDs).isDisjoint(with: eventIDs + updateIDs),
                      Set(updateIDs).isDisjoint(with: eventIDs),
                      saved.allSatisfy({ member in
                          Place.catalog.contains {
                              $0.id == member.id && (0...$0.requiredPunches).contains(member.stamps)
                          } &&
                          Set(member.coupons.map(\.id)).count == member.coupons.count &&
                          Set(member.events.map(\.id)).count == member.events.count &&
                          member.events.allSatisfy {
                              $0.stampCost.map { Place.punchRange.contains($0) } ?? true
                          } &&
                          member.savedCards.allSatisfy {
                              Place.punchRange.contains($0.target) &&
                              (0...$0.target).contains($0.stamps) &&
                              !$0.reward.isEmpty &&
                              ($0.savedAt.map { $0.timeIntervalSinceReferenceDate.isFinite } ?? true)
                          } &&
                          member.coupons.allSatisfy { coupon in
                              member.events.filter { $0.id == coupon.id }.count == 1 &&
                              member.events.contains { event in
                                  event.id == coupon.id && event.kind == .reward &&
                                  event.rewardTitle?.isEmpty == false &&
                                  (event.stampCost ?? 0) > 0 &&
                                  (coupon.usedAt.map { $0 >= event.date } ?? true)
                              }
                          }
                      }) else {
                    storageError = "Saved cards could not be read."
                    canSaveMemberships = false
                    return
                }
                memberships = saved
            } catch {
                storageError = "Saved cards could not be read: \(error.localizedDescription)"
                canSaveMemberships = false
            }
        } else {
            // The new programs have new identities; old demo balances must not be reassigned.
            resetDemo()
        }
        let beforeProcessing = memberships
        if canSaveMemberships {
            for index in memberships.indices {
                if memberships[index].archived, memberships[index].savedCards.isEmpty,
                   let place = Place.catalog.first(where: { $0.id == memberships[index].id }) {
                    // Legacy records did not record when a card was put away.
                    memberships[index].savedCards.append(SavedCard(
                        stamps: memberships[index].stamps, target: place.requiredPunches,
                        reward: place.rewardDescription, savedAt: nil
                    ))
                }
                applyPendingStamps(at: index)
            }
            if memberships != beforeProcessing { save() }
        }
        if let data = defaults.data(forKey: groupsKey) {
            do {
                let saved = try JSONDecoder().decode([PlaceGroup].self, from: data)
                guard Set(saved.map(\.id)).count == saved.count,
                      Set(saved.map { $0.name.lowercased() }).count == saved.count,
                      saved.allSatisfy({ group in
                          !group.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
                          group.name.count <= 40 &&
                          Set(group.placeIDs).count == group.placeIDs.count &&
                          group.placeIDs.allSatisfy { id in memberships.contains { $0.id == id } }
                      }) else { throw DemoError.invalidGroup }
                groups = saved
            } catch {
                storageError = "Saved groups could not be read: \(error.localizedDescription)"
            }
        }
        if defaults.object(forKey: ordersKey) != nil {
            do {
                guard let data = defaults.data(forKey: ordersKey) else { throw DemoError.invalidCardOrder }
                let saved = try JSONDecoder().decode([String: [String]].self, from: data)
                guard saved.values.allSatisfy({ ids in
                    Set(ids).count == ids.count && ids.allSatisfy { id in Place.catalog.contains { $0.id == id } }
                }) else { throw DemoError.invalidCardOrder }
                cardOrders = saved
            } catch {
                canSaveOrders = false
                storageError = "Saved card order could not be read: \(error.localizedDescription)"
            }
        }
    }

    var activePlaces: [Place] {
        memberships.filter { !$0.archived }.compactMap { member in
            Place.catalog.first { $0.id == member.id }
        }
    }

    var redemptions: [Redemption] {
        memberships.flatMap { member -> [Redemption] in
            guard let place = Place.catalog.first(where: { $0.id == member.id }) else { return [] }
            return member.events.filter { $0.kind == .reward }.map { event in
                Redemption(place: place, event: event, coupon: member.coupons.first { $0.id == event.id })
            }
        }
        .sorted { $0.event.date > $1.event.date }
    }

    var memories: [CardMemory] {
        let saved = memberships.flatMap { member -> [CardMemory] in
            guard let place = Place.catalog.first(where: { $0.id == member.id }) else { return [] }
            return member.savedCards.map {
                CardMemory(
                    place: place, id: $0.id, stamps: $0.stamps, target: $0.target,
                    reward: $0.reward, savedAt: $0.savedAt, redemption: nil
                )
            }
        }
        let completed = redemptions.map {
            CardMemory(
                place: $0.place, id: $0.id, stamps: $0.event.stampCost,
                target: $0.event.stampCost, reward: $0.event.rewardTitle ?? "Reward",
                savedAt: $0.event.date, redemption: $0
            )
        }
        return (saved + completed).sorted {
            if $0.savedAt != $1.savedAt {
                return ($0.savedAt ?? .distantPast) > ($1.savedAt ?? .distantPast)
            }
            return $0.id.uuidString < $1.id.uuidString
        }
    }

    func membership(for place: Place) -> Membership? {
        memberships.first { $0.id == place.id }
    }

    func setFavorite(_ favorite: Bool, for place: Place) throws {
        guard let index = memberships.firstIndex(where: { $0.id == place.id }) else {
            throw DemoError.notJoined
        }
        memberships[index].isFavorite = favorite
        save()
    }

    func places(in group: PlaceGroup) -> [Place] {
        ordered(activePlaces.filter { group.placeIDs.contains($0.id) }, in: .group(group.id))
    }

    func ordered(_ places: [Place], in collection: CardOrderCollection) -> [Place] {
        let ids = cardOrders[collection.key] ?? (collection == .redeemed ? rewardPlaces.map(\.id) : [])
        let byID = Dictionary(uniqueKeysWithValues: places.map { ($0.id, $0) })
        let positioned = Set(ids)
        return ids.compactMap { byID[$0] } + places.filter { !positioned.contains($0.id) }
    }

    private var rewardPlaces: [Place] {
        var seen: Set<String> = []
        return redemptions.filter { $0.coupon != nil }
            .compactMap { seen.insert($0.place.id).inserted ? $0.place : nil }
    }

    func moveCard(_ id: String, to target: String, in collection: CardOrderCollection) throws {
        guard canSaveOrders else { throw DemoError.unreadableCardOrder }
        let places: [Place]
        switch collection {
        case .home:
            places = memberships.compactMap { member in Place.catalog.first { $0.id == member.id } }
        case .group(let groupID):
            guard let group = groups.first(where: { $0.id == groupID }) else { throw DemoError.invalidGroup }
            places = memberships.compactMap { member in
                Place.catalog.first { $0.id == member.id && group.placeIDs.contains($0.id) }
            }
        case .redeemed:
            places = rewardPlaces
        }
        var ids = ordered(places, in: collection).map(\.id)
        guard let source = ids.firstIndex(of: id), let destination = ids.firstIndex(of: target) else {
            throw DemoError.invalidCardOrder
        }
        guard source != destination else { return }
        ids.remove(at: source)
        ids.insert(id, at: destination)
        var updated = cardOrders
        updated[collection.key] = ids
        defaults.set(try JSONEncoder().encode(updated), forKey: ordersKey)
        cardOrders = updated
    }

    @discardableResult
    func saveGroup(id: UUID? = nil, name: String, placeIDs: [String]) throws -> PlaceGroup {
        let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, name.count <= 40 else { throw DemoError.invalidGroupName }
        guard !groups.contains(where: {
            $0.id != id && $0.name.localizedCaseInsensitiveCompare(name) == .orderedSame
        }) else { throw DemoError.duplicateGroupName }
        guard Set(placeIDs).count == placeIDs.count,
              placeIDs.allSatisfy({ id in memberships.contains { $0.id == id } }),
              id == nil || groups.contains(where: { $0.id == id }) else {
            throw DemoError.invalidGroup
        }
        let group = PlaceGroup(id: id ?? UUID(), name: name, placeIDs: placeIDs)
        var updated = groups.filter { $0.id != group.id }
        updated.append(group)
        updated.sort { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
        defaults.set(try JSONEncoder().encode(updated), forKey: groupsKey)
        groups = updated
        return group
    }

    func deleteGroup(_ group: PlaceGroup) throws {
        guard groups.contains(where: { $0.id == group.id }) else { throw DemoError.invalidGroup }
        let updated = groups.filter { $0.id != group.id }
        defaults.set(try JSONEncoder().encode(updated), forKey: groupsKey)
        groups = updated
    }

    func join(_ place: Place) {
        guard canSaveMemberships else { return }
        guard Place.catalog.contains(place) else {
            storageError = DemoError.unknownProgram.localizedDescription
            return
        }
        if let index = memberships.firstIndex(where: { $0.id == place.id }) {
            memberships[index].archived = false
            applyPendingStamps(at: index)
        } else {
            memberships.insert(
                Membership(id: place.id, stamps: 0, events: [
                    VisitEvent(kind: .joined, date: .now)
                ]),
                at: 0
            )
        }
        save()
    }

    func addStamp(to place: Place) throws {
        guard Place.catalog.contains(place) else { throw DemoError.unknownProgram }
        guard let index = memberships.firstIndex(where: { $0.id == place.id }) else {
            throw DemoError.notJoined
        }
        guard !memberships[index].archived else { throw DemoError.archivedCard }
        guard memberships[index].stamps < place.requiredPunches else { throw DemoError.cardComplete }
        try enqueueStamp(to: place, id: UUID())
    }

    @discardableResult
    func enqueueStamp(to place: Place, id: UUID, receivedAt: Date = .now) throws -> Bool {
        guard canSaveMemberships else { throw DemoError.unreadableStorage }
        guard Place.catalog.contains(place) else { throw DemoError.unknownProgram }
        guard let index = memberships.firstIndex(where: { $0.id == place.id }) else {
            throw DemoError.notJoined
        }
        guard receivedAt.timeIntervalSinceReferenceDate.isFinite else { throw DemoError.invalidStampUpdate }
        guard !memberships.contains(where: { $0.savedCards.contains { $0.id == id } }) else {
            throw DemoError.invalidStampUpdate
        }
        if let owner = memberships.first(where: {
            $0.pendingStamps.contains { $0.id == id } || $0.events.contains { $0.id == id }
        }) {
            guard owner.id == place.id,
                  owner.pendingStamps.contains(where: { $0.id == id }) ||
                    owner.events.contains(where: { $0.id == id && $0.kind == .stamp }) else {
                throw DemoError.invalidStampUpdate
            }
            return false
        }
        memberships[index].pendingStamps.append(StampUpdate(id: id, receivedAt: receivedAt))
        save()
        applyPendingStamps(at: index)
        save()
        return true
    }

    private func applyPendingStamps(at index: Int) {
        guard !memberships[index].archived,
              let place = Place.catalog.first(where: { $0.id == memberships[index].id }) else { return }
        while memberships[index].stamps < place.requiredPunches,
              !memberships[index].pendingStamps.isEmpty {
            let update = memberships[index].pendingStamps.removeFirst()
            var event = VisitEvent(kind: .stamp, date: update.receivedAt)
            event.id = update.id
            memberships[index].stamps += 1
            memberships[index].events.insert(event, at: 0)
        }
    }

    @discardableResult
    func claimReward(at place: Place) throws -> Coupon {
        guard Place.catalog.contains(place) else { throw DemoError.unknownProgram }
        guard let index = memberships.firstIndex(where: { $0.id == place.id }) else {
            throw DemoError.notJoined
        }
        guard !memberships[index].archived else { throw DemoError.archivedCard }
        guard memberships[index].stamps == place.requiredPunches else { throw DemoError.insufficientStamps }
        let event = VisitEvent(
            kind: .reward, date: .now,
            rewardTitle: place.rewardDescription, stampCost: place.requiredPunches
        )
        let coupon = Coupon(id: event.id)
        memberships[index].stamps = 0
        memberships[index].events.insert(event, at: 0)
        memberships[index].coupons.insert(coupon, at: 0)
        applyPendingStamps(at: index)
        save()
        return coupon
    }

    func useCoupon(_ id: UUID) throws {
        guard let memberIndex = memberships.firstIndex(where: { member in
            member.coupons.contains { $0.id == id }
        }), let couponIndex = memberships[memberIndex].coupons.firstIndex(where: { $0.id == id }) else {
            throw DemoError.couponNotFound
        }
        guard memberships[memberIndex].coupons[couponIndex].usedAt == nil else {
            throw DemoError.couponAlreadyUsed
        }
        memberships[memberIndex].coupons[couponIndex].usedAt = .now
        save()
    }

    func setArchived(_ archived: Bool, for place: Place) {
        guard Place.catalog.contains(place) else {
            storageError = DemoError.unknownProgram.localizedDescription
            return
        }
        guard let index = memberships.firstIndex(where: { $0.id == place.id }) else { return }
        if archived, !memberships[index].archived {
            memberships[index].savedCards.insert(SavedCard(
                stamps: memberships[index].stamps, target: place.requiredPunches,
                reward: place.rewardDescription, savedAt: .now
            ), at: 0)
        }
        memberships[index].archived = archived
        if !archived { applyPendingStamps(at: index) }
        save()
    }

    func resetDemo() {
        canSaveMemberships = true
        canSaveOrders = true
        cardOrders = [:]
        defaults.removeObject(forKey: ordersKey)
        groups = []
        defaults.removeObject(forKey: groupsKey)
        let calendar = Calendar.current
        memberships = zip(Place.samples, [5, 6, 2]).map { place, count in
            let events = (0..<count).map { day in
                VisitEvent(
                    kind: .stamp,
                    date: calendar.date(byAdding: .day, value: -day - 1, to: .now) ?? .now
                )
            }
            return Membership(
                id: place.id, stamps: count,
                events: events + [VisitEvent(
                    kind: .joined,
                    date: calendar.date(byAdding: .day, value: -20, to: .now) ?? .now
                )]
            )
        }
        seedDemoCoupons()
        save()
        if storageError == nil {
            defaults.removeObject(forKey: "joeyy.memberships.v1")
            defaults.removeObject(forKey: "joeyy.coupon-samples.v1")
        }
    }

    func deleteLocalCards() {
        memberships = []
        groups = []
        cardOrders = [:]
        canSaveOrders = true
        defaults.removeObject(forKey: ordersKey)
        defaults.removeObject(forKey: groupsKey)
        save()
    }

    private func seedDemoCoupons() {
        for (offset, place) in Place.samples.enumerated() {
            guard let index = memberships.firstIndex(where: { $0.id == place.id }) else { continue }
            let date = Calendar.current.date(byAdding: .day, value: -9 - offset, to: .now) ?? .now
            let event = VisitEvent(
                kind: .reward, date: date,
                rewardTitle: place.rewardDescription, stampCost: place.requiredPunches
            )
            memberships[index].coupons.append(Coupon(id: event.id))
            memberships[index].events.append(event)
            memberships[index].events.sort { $0.date > $1.date }
        }
    }

    private func save() {
        guard canSaveMemberships else { return }
        do {
            defaults.set(try JSONEncoder().encode(memberships), forKey: key)
            storageError = nil
        } catch {
            storageError = "Your changes could not be saved: \(error.localizedDescription)."
        }
    }
}
