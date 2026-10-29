import Foundation
import Observation

struct Place: Identifiable, Hashable {
    let id: String
    let clientID: String
    let name: String
    let neighborhood: String
    let address: String
    let icon: PlaceIcon
    let rewards: [RewardOption]
    let story: String
    let rule: String

    static let samples: [Place] = [
        Place(
            id: "dicks", clientID: "19BFF0A1-7EB3-4E8A-A02D-8FA39CC00101", name: "Dick's Drive-In",
            neighborhood: "Queen Anne", address: "Queen Anne, Seattle / demo location",
            icon: .burger,
            rewards: [
                RewardOption(id: "fries", title: "Fries", cost: 3),
                RewardOption(id: "burger", title: "Regular burger", cost: 5),
                RewardOption(id: "meal", title: "Burger and fries", cost: 10)
            ],
            story: "Burgers in Queen Anne, Seattle.",
            rule: "One stamp per qualifying burger purchase. Drinks and extras are not included with rewards."
        ),
        Place(
            id: "cozy", clientID: "29BFF0A1-7EB3-4E8A-A02D-8FA39CC00102", name: "Cozy Cafe",
            neighborhood: "Capitol Hill", address: "Capitol Hill, Seattle / demo location",
            icon: .system("cup.and.saucer.fill"),
            rewards: [
                RewardOption(id: "coffee", title: "Regular coffee", cost: 5),
                RewardOption(id: "sandwich", title: "Sandwich", cost: 10)
            ],
            story: "Coffee in Capitol Hill, Seattle.",
            rule: "One stamp per qualifying coffee purchase. Extras are not included with rewards."
        ),
        Place(
            id: "jango", clientID: "39BFF0A1-7EB3-4E8A-A02D-8FA39CC00103", name: "Jango Smoothies",
            neighborhood: "Fremont", address: "Fremont, Seattle / demo location",
            icon: .system("takeoutbag.and.cup.and.straw.fill"),
            rewards: [
                RewardOption(id: "smoothie", title: "Regular smoothie", cost: 5),
                RewardOption(id: "bowl", title: "Smoothie bowl", cost: 10)
            ],
            story: "Smoothies in Fremont, Seattle.",
            rule: "One stamp per qualifying smoothie purchase. Add-ins are not included with rewards."
        ),
        Place(
            id: "common-ground", clientID: "49BFF0A1-7EB3-4E8A-A02D-8FA39CC00104", name: "Common Ground",
            neighborhood: "Ballard", address: "Ballard, Seattle / demo location",
            icon: .system("mug.fill"),
            rewards: [
                RewardOption(id: "drink", title: "Regular hot drink", cost: 5),
                RewardOption(id: "pastry", title: "Coffee and pastry", cost: 10)
            ],
            story: "Coffee in Ballard, Seattle.",
            rule: "One stamp per qualifying drink purchase. Extras are not included with rewards."
        ),
        Place(
            id: "the-neat", clientID: "59BFF0A1-7EB3-4E8A-A02D-8FA39CC00105", name: "The Neat",
            neighborhood: "West Seattle", address: "West Seattle / demo location",
            icon: .system("scissors"),
            rewards: [
                RewardOption(id: "trim", title: "Beard trim", cost: 5),
                RewardOption(id: "haircut", title: "Haircut", cost: 12)
            ],
            story: "Haircuts in West Seattle.",
            rule: "One stamp per full-price haircut. Rewards require an appointment."
        )
    ]

    static func search(_ query: String) -> [Place] {
        let value = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return [] }
        if let identifier = UUID(uuidString: value) {
            return samples.filter { UUID(uuidString: $0.clientID) == identifier }
        }
        return samples.filter { $0.name.localizedCaseInsensitiveContains(value) }
    }
}

struct RewardOption: Identifiable, Hashable {
    let id: String
    let title: String
    let cost: Int
}

enum PlaceIcon: Hashable {
    case burger
    case system(String)
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
}

extension Membership {
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            id: try values.decode(String.self, forKey: .id),
            stamps: try values.decode(Int.self, forKey: .stamps),
            archived: try values.decode(Bool.self, forKey: .archived),
            events: try values.decode([VisitEvent].self, forKey: .events),
            coupons: try values.decodeIfPresent([Coupon].self, forKey: .coupons) ?? []
        )
    }
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
    case notJoined, insufficientStamps, unknownReward, stampLimit, archivedCard
    case couponNotFound, couponAlreadyUsed

    var errorDescription: String? {
        switch self {
        case .notJoined: "Join this card first."
        case .insufficientStamps: "Not enough stamps for this reward."
        case .unknownReward: "This reward is not part of this business's program."
        case .stampLimit: "The stamp balance is too large to update."
        case .archivedCard: "Restore this card before collecting a stamp or using a reward."
        case .couponNotFound: "This coupon could not be found."
        case .couponAlreadyUsed: "This coupon has already been used."
        }
    }
}

@MainActor
@Observable
final class LoyaltyStore {
    private(set) var memberships: [Membership] = []
    private(set) var storageError: String?
    private let defaults: UserDefaults
    private let key = "joeyy.memberships.v1"
    private let couponSamplesKey = "joeyy.coupon-samples.v1"

    init(defaults: UserDefaults = .standard, reset: Bool = false) {
        self.defaults = defaults
        if reset {
            resetDemo()
        } else if let data = defaults.data(forKey: key) {
            do {
                let saved = try JSONDecoder().decode([Membership].self, from: data)
                let couponIDs = saved.flatMap { $0.coupons.map(\.id) }
                let redemptionIDs = saved.flatMap { $0.events.filter { $0.kind == .reward }.map(\.id) }
                guard Set(saved.map(\.id)).count == saved.count,
                      Set(couponIDs).count == couponIDs.count,
                      Set(redemptionIDs).count == redemptionIDs.count,
                      saved.allSatisfy({ member in
                          Place.samples.contains {
                              $0.id == member.id && member.stamps >= 0
                          } &&
                          Set(member.coupons.map(\.id)).count == member.coupons.count &&
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
                    storageError = "Saved demo cards could not be read. Reset the demo in You to start again."
                    return
                }
                memberships = saved
                if !defaults.bool(forKey: couponSamplesKey) {
                    seedDemoCoupons()
                    save()
                    if storageError == nil { defaults.set(true, forKey: couponSamplesKey) }
                }
            } catch {
                storageError = "Saved demo cards could not be read: \(error.localizedDescription). Reset the demo in You to start again."
            }
        } else {
            resetDemo()
        }
    }

    var activePlaces: [Place] {
        memberships.filter { !$0.archived }.compactMap { member in
            Place.samples.first { $0.id == member.id }
        }
    }

    var redemptions: [Redemption] {
        memberships.flatMap { member -> [Redemption] in
            guard let place = Place.samples.first(where: { $0.id == member.id }) else { return [] }
            return member.events.filter { $0.kind == .reward }.map { event in
                Redemption(place: place, event: event, coupon: member.coupons.first { $0.id == event.id })
            }
        }
        .sorted { $0.event.date > $1.event.date }
    }

    func membership(for place: Place) -> Membership? {
        memberships.first { $0.id == place.id }
    }

    func join(_ place: Place) {
        if let index = memberships.firstIndex(where: { $0.id == place.id }) {
            memberships[index].archived = false
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
        guard let index = memberships.firstIndex(where: { $0.id == place.id }) else {
            throw DemoError.notJoined
        }
        guard !memberships[index].archived else { throw DemoError.archivedCard }
        guard memberships[index].stamps < Int.max else { throw DemoError.stampLimit }
        memberships[index].stamps += 1
        memberships[index].events.insert(VisitEvent(kind: .stamp, date: .now), at: 0)
        save()
    }

    @discardableResult
    func redeem(_ reward: RewardOption, at place: Place) throws -> Coupon {
        guard let index = memberships.firstIndex(where: { $0.id == place.id }) else {
            throw DemoError.notJoined
        }
        guard !memberships[index].archived else { throw DemoError.archivedCard }
        guard reward.cost > 0, place.rewards.contains(reward) else { throw DemoError.unknownReward }
        guard memberships[index].stamps >= reward.cost else { throw DemoError.insufficientStamps }
        let event = VisitEvent(kind: .reward, date: .now, rewardTitle: reward.title, stampCost: reward.cost)
        let coupon = Coupon(id: event.id)
        memberships[index].stamps -= reward.cost
        memberships[index].events.insert(event, at: 0)
        memberships[index].coupons.insert(coupon, at: 0)
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
        guard let index = memberships.firstIndex(where: { $0.id == place.id }) else { return }
        memberships[index].archived = archived
        save()
    }

    func resetDemo() {
        let calendar = Calendar.current
        memberships = zip(Place.samples.prefix(3), [5, 6, 2]).map { place, count in
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
        if storageError == nil { defaults.set(true, forKey: couponSamplesKey) }
    }

    func deleteLocalCards() {
        memberships = []
        save()
    }

    private func seedDemoCoupons() {
        let examples = [(Place.samples[0], 1), (Place.samples[1], 0), (Place.samples[2], 0)]
        for (offset, (place, rewardIndex)) in examples.enumerated() {
            guard let index = memberships.firstIndex(where: { $0.id == place.id }) else { continue }
            let reward = place.rewards[rewardIndex]
            let date = Calendar.current.date(byAdding: .day, value: -9 - offset, to: .now) ?? .now
            let event = VisitEvent(kind: .reward, date: date, rewardTitle: reward.title, stampCost: reward.cost)
            memberships[index].coupons.append(Coupon(id: event.id))
            memberships[index].events.append(event)
            memberships[index].events.sort { $0.date > $1.date }
        }
    }

    private func save() {
        do {
            defaults.set(try JSONEncoder().encode(memberships), forKey: key)
            storageError = nil
        } catch {
            storageError = "Your changes could not be saved: \(error.localizedDescription)."
        }
    }
}
