import XCTest
import SwiftUI
@testable import JOEYY

@MainActor
final class LoyaltyStoreTests: XCTestCase {
    private var defaults: UserDefaults!
    private var suite: String!
    private var store: LoyaltyStore!

    override func setUp() async throws {
        suite = "JOEYYTests.\(UUID().uuidString)"
        defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        store = LoyaltyStore(defaults: defaults)
    }

    override func tearDown() async throws {
        defaults.removePersistentDomain(forName: suite)
        store = nil
        defaults = nil
    }

    func testSeattleSeedAndRewardOptions() {
        XCTAssertEqual(store.activePlaces.map(\.name), ["Dick's Drive-In", "Cozy Cafe", "Jango Smoothies"])
        XCTAssertEqual(store.memberships.map(\.stamps), [5, 6, 2])
        XCTAssertEqual(store.redemptions.count, 3)
        XCTAssertTrue(store.redemptions.allSatisfy(\.isAvailable))
        XCTAssertEqual(store.redemptions.map(\.event.rewardTitle), ["Regular burger", "Regular coffee", "Regular smoothie"])
        XCTAssertEqual(Place.samples[1].rewards.map(\.cost), [5, 10])
        for place in Place.samples {
            XCTAssertGreaterThan(place.rewards.count, 1)
            XCTAssertEqual(Set(place.rewards.map(\.id)).count, place.rewards.count)
            XCTAssertTrue(place.rewards.allSatisfy { $0.cost > 0 })
            XCTAssertNotNil(UUID(uuidString: place.clientID))
        }
        XCTAssertEqual(Set(Place.samples.map(\.clientID)).count, Place.samples.count)
    }

    func testBalanceCanGrowBeyondAllRewardCostsAndPersists() throws {
        let place = try XCTUnwrap(Place.samples.first)
        for _ in 0..<12 { try store.addStamp(to: place) }
        XCTAssertEqual(store.membership(for: place)?.stamps, 17)
        let restored = LoyaltyStore(defaults: defaults)
        XCTAssertNil(restored.storageError)
        XCTAssertEqual(restored.membership(for: place)?.stamps, 17)
        XCTAssertEqual(restored.membership(for: place)?.events.first?.kind, .stamp)
    }

    func testRedemptionDeductsOnlySelectedCostAndRecordsTheReward() throws {
        let place = Place.samples[1]
        let coffee = place.rewards[0]
        let previousCount = try XCTUnwrap(store.membership(for: place)).events.count
        let coupon = try store.redeem(coffee, at: place)
        let membership = try XCTUnwrap(store.membership(for: place))
        XCTAssertEqual(membership.stamps, 1)
        XCTAssertEqual(membership.events.count, previousCount + 1)
        XCTAssertEqual(membership.events.first?.kind, .reward)
        XCTAssertEqual(membership.events.first?.rewardTitle, coffee.title)
        XCTAssertEqual(membership.events.first?.stampCost, 5)
        XCTAssertEqual(membership.coupons.first?.id, coupon.id)
        XCTAssertEqual(store.redemptions.first?.id, coupon.id)
        XCTAssertTrue(try XCTUnwrap(store.redemptions.first).isAvailable)
        XCTAssertEqual(LoyaltyStore(defaults: defaults).membership(for: place), membership)
        XCTAssertThrowsError(try store.redeem(coffee, at: place))
        XCTAssertEqual(store.membership(for: place), membership)
    }

    func testCanSaveForLargerRewardInsteadOfRedeemingSmallerReward() throws {
        let place = Place.samples[1]
        let sandwich = place.rewards[1]
        let before = store.membership(for: place)
        XCTAssertThrowsError(try store.redeem(sandwich, at: place))
        XCTAssertEqual(store.membership(for: place), before)
        for _ in 0..<4 { try store.addStamp(to: place) }
        try store.redeem(sandwich, at: place)
        XCTAssertEqual(store.membership(for: place)?.stamps, 0)
        XCTAssertEqual(store.membership(for: place)?.events.first?.rewardTitle, "Sandwich")
    }

    func testMultipleDifferentRewardsShareOneBalance() throws {
        let place = Place.samples[1]
        for _ in 0..<12 { try store.addStamp(to: place) }
        try store.redeem(place.rewards[0], at: place)
        XCTAssertEqual(store.membership(for: place)?.stamps, 13)
        try store.redeem(place.rewards[1], at: place)
        XCTAssertEqual(store.membership(for: place)?.stamps, 3)
        let events = try XCTUnwrap(store.membership(for: place)).events
        XCTAssertEqual(events[0].stampCost, 10)
        XCTAssertEqual(events[1].stampCost, 5)
    }

    func testUnknownAndAlteredRewardOptionsDoNotMutateBalanceOrHistory() {
        let place = Place.samples[1]
        let before = store.membership(for: place)
        let invalid = [
            Place.samples[2].rewards[0],
            RewardOption(id: "coffee", title: "Regular coffee", cost: 0),
            RewardOption(id: "coffee", title: "Regular coffee", cost: -5),
            RewardOption(id: "coffee", title: "Regular coffee", cost: 1)
        ]
        for reward in invalid {
            XCTAssertThrowsError(try store.redeem(reward, at: place))
            XCTAssertEqual(store.membership(for: place), before)
        }
    }

    func testUnjoinedAndArchivedCardsCannotRedeem() {
        let unjoined = Place.samples[3]
        XCTAssertThrowsError(try store.redeem(unjoined.rewards[0], at: unjoined))
        let place = Place.samples[1]
        store.setArchived(true, for: place)
        let before = store.membership(for: place)
        XCTAssertThrowsError(try store.redeem(place.rewards[0], at: place))
        XCTAssertEqual(store.membership(for: place), before)
    }

    func testLegacyCardsAndEventsArePreservedWithoutNewRewardFields() throws {
        let legacy = """
        [{"id":"cozy","stamps":6,"archived":false,"events":[
        {"id":"00000000-0000-0000-0000-000000000001","kind":"reward","date":0}
        ]}]
        """
        defaults.set(Data(legacy.utf8), forKey: "joeyy.memberships.v1")
        let restored = LoyaltyStore(defaults: defaults)
        let place = Place.samples[1]
        XCTAssertNil(restored.storageError)
        XCTAssertEqual(restored.membership(for: place)?.stamps, 6)
        let legacyEvent = try XCTUnwrap(restored.membership(for: place)?.events.first)
        XCTAssertEqual(legacyEvent.id.uuidString, "00000000-0000-0000-0000-000000000001")
        XCTAssertNil(legacyEvent.rewardTitle)
        XCTAssertNil(legacyEvent.stampCost)
        XCTAssertNil(restored.redemptions.first?.coupon)
        XCTAssertFalse(try XCTUnwrap(restored.redemptions.first).isAvailable)
        try restored.redeem(place.rewards[0], at: place)
        let reloaded = LoyaltyStore(defaults: defaults)
        XCTAssertEqual(reloaded.membership(for: place)?.stamps, 1)
        XCTAssertEqual(reloaded.membership(for: place)?.events.last, legacyEvent)
        XCTAssertEqual(reloaded.membership(for: place)?.events.first?.stampCost, 5)
    }

    func testCouponCanBeUsedOnlyOnceWithoutDeductingMoreStamps() throws {
        let place = Place.samples[1]
        let coupon = try store.redeem(place.rewards[0], at: place)
        let events = try XCTUnwrap(store.membership(for: place)).events
        try store.useCoupon(coupon.id)
        let entry = try XCTUnwrap(store.redemptions.first { $0.id == coupon.id })
        XCTAssertNotNil(entry.coupon?.usedAt)
        XCTAssertFalse(entry.isAvailable)
        XCTAssertEqual(store.membership(for: place)?.stamps, 1)
        XCTAssertEqual(store.membership(for: place)?.events, events)
        XCTAssertThrowsError(try store.useCoupon(coupon.id))
        XCTAssertEqual(store.redemptions.first { $0.id == coupon.id }, entry)
        XCTAssertEqual(LoyaltyStore(defaults: defaults).redemptions.first { $0.id == coupon.id }, entry)
    }

    func testArchivingDoesNotRemoveOrInvalidateAnIssuedCoupon() throws {
        let entry = try XCTUnwrap(store.redemptions.first)
        store.setArchived(true, for: entry.place)
        XCTAssertFalse(store.activePlaces.contains(entry.place))
        XCTAssertTrue(store.redemptions.contains { $0.id == entry.id && $0.isAvailable })
        try store.useCoupon(entry.id)
        XCTAssertNotNil(store.redemptions.first { $0.id == entry.id }?.coupon?.usedAt)
    }

    func testUnknownCouponDoesNotChangeAnyData() {
        let before = store.memberships
        XCTAssertThrowsError(try store.useCoupon(UUID()))
        XCTAssertEqual(store.memberships, before)
    }

    func testDeletingCouponsPersistsAndResetRestoresSamples() {
        store.deleteLocalCards()
        XCTAssertTrue(store.redemptions.isEmpty)
        XCTAssertTrue(LoyaltyStore(defaults: defaults).redemptions.isEmpty)
        store.resetDemo()
        XCTAssertEqual(store.redemptions.count, 3)
        XCTAssertTrue(store.redemptions.allSatisfy(\.isAvailable))
        XCTAssertEqual(store.memberships.map(\.stamps), [5, 6, 2])
    }

    func testExistingInstallReceivesSamplesOnceWithoutResettingBalances() throws {
        let legacy = """
        [{"id":"dicks","stamps":17,"archived":false,"events":[]},
        {"id":"cozy","stamps":1,"archived":true,"events":[]},
        {"id":"jango","stamps":2,"archived":false,"events":[]}]
        """
        defaults.set(Data(legacy.utf8), forKey: "joeyy.memberships.v1")
        defaults.removeObject(forKey: "joeyy.coupon-samples.v1")
        let upgraded = LoyaltyStore(defaults: defaults)
        XCTAssertNil(upgraded.storageError)
        XCTAssertEqual(upgraded.memberships.map(\.stamps), [17, 1, 2])
        XCTAssertEqual(upgraded.membership(for: Place.samples[1])?.archived, true)
        XCTAssertEqual(upgraded.redemptions.count, 3)
        XCTAssertEqual(LoyaltyStore(defaults: defaults).memberships, upgraded.memberships)
    }

    func testCouponsWithMissingOrDuplicateRedemptionRecordsAreRejected() throws {
        var missing = store.memberships
        missing[0].coupons.append(Coupon(id: UUID()))
        var duplicate = store.memberships
        let event = try XCTUnwrap(duplicate[0].events.first { $0.kind == .reward })
        let coupon = try XCTUnwrap(duplicate[0].coupons.first)
        duplicate[1].events.append(event)
        duplicate[1].coupons.append(coupon)
        for invalid in [missing, duplicate] {
            defaults.set(try JSONEncoder().encode(invalid), forKey: "joeyy.memberships.v1")
            let restored = LoyaltyStore(defaults: defaults)
            XCTAssertNotNil(restored.storageError)
            XCTAssertTrue(restored.redemptions.isEmpty)
        }
    }

    func testOverflowIsRejectedWithoutChangingTheCard() throws {
        let place = Place.samples[0]
        let member = Membership(id: place.id, stamps: Int.max, events: [])
        defaults.set(try JSONEncoder().encode([member]), forKey: "joeyy.memberships.v1")
        let restored = LoyaltyStore(defaults: defaults)
        XCTAssertNil(restored.storageError)
        XCTAssertThrowsError(try restored.addStamp(to: place))
        XCTAssertEqual(restored.membership(for: place), member)
        try restored.redeem(place.rewards[0], at: place)
        XCTAssertEqual(restored.membership(for: place)?.stamps, Int.max - 3)
    }

    func testInvalidSavedMembershipsAreNotReplacedBySeedData() throws {
        let valid = Membership(id: "cozy", stamps: 6, events: [])
        let invalid = [
            [Membership(id: "cozy", stamps: -1, events: [])],
            [valid, valid],
            [Membership(id: "unknown", stamps: 6, events: [])]
        ]
        for members in invalid {
            let data = try JSONEncoder().encode(members)
            defaults.set(data, forKey: "joeyy.memberships.v1")
            let restored = LoyaltyStore(defaults: defaults)
            XCTAssertNotNil(restored.storageError)
            XCTAssertTrue(restored.memberships.isEmpty)
            XCTAssertEqual(defaults.data(forKey: "joeyy.memberships.v1"), data)
        }
    }

    func testSearchUsesOnlyBusinessNamesOrExactClientIDs() {
        XCTAssertEqual(Place.search("  cOzY  ").map(\.id), ["cozy"])
        XCTAssertEqual(Place.search("Jango Smoothies").map(\.id), ["jango"])
        XCTAssertTrue(Place.search("").isEmpty)
        XCTAssertTrue(Place.search(" \n ").isEmpty)
        XCTAssertTrue(Place.search("Fremont").isEmpty)
        XCTAssertTrue(Place.search("Seattle").isEmpty)
        XCTAssertTrue(Place.search("Coffee").isEmpty)
        XCTAssertTrue(Place.search("Burger").isEmpty)
        for place in Place.samples {
            XCTAssertEqual(Place.search(" \(place.clientID.lowercased()) "), [place])
        }
        XCTAssertTrue(Place.search("29BFF0A1").isEmpty)
        XCTAssertTrue(Place.search("00000000-0000-0000-0000-000000000000").isEmpty)
    }

    func testArchiveRestoreAndDuplicateJoinPreserveStamps() throws {
        let place = Place.samples[0]
        store.setArchived(true, for: place)
        XCTAssertFalse(store.activePlaces.contains(place))
        XCTAssertThrowsError(try store.addStamp(to: place))
        store.join(place)
        store.join(place)
        XCTAssertEqual(store.memberships.filter { $0.id == place.id }.count, 1)
        XCTAssertEqual(store.membership(for: place)?.stamps, 5)
        XCTAssertTrue(store.activePlaces.contains(place))
    }

    func testJoinDeleteAndReset() throws {
        let newPlace = Place.samples[3]
        XCTAssertThrowsError(try store.addStamp(to: newPlace))
        store.join(newPlace)
        XCTAssertEqual(store.membership(for: newPlace)?.stamps, 0)
        XCTAssertEqual(store.membership(for: newPlace)?.events.first?.kind, .joined)
        store.deleteLocalCards()
        XCTAssertTrue(store.memberships.isEmpty)
        XCTAssertTrue(LoyaltyStore(defaults: defaults).memberships.isEmpty)
        store.resetDemo()
        XCTAssertEqual(store.memberships.count, 3)
    }

    func testCorruptStorageReportsErrorInsteadOfSeedingOverIt() {
        defaults.set(Data("not JSON".utf8), forKey: "joeyy.memberships.v1")
        let corrupt = LoyaltyStore(defaults: defaults)
        XCTAssertNotNil(corrupt.storageError)
        XCTAssertTrue(corrupt.memberships.isEmpty)
        corrupt.resetDemo()
        XCTAssertNil(corrupt.storageError)
        XCTAssertEqual(corrupt.memberships.count, 3)
    }

    func testTextPalettesMeetNormalTextContrast() {
        for style in [UIUserInterfaceStyle.light, .dark] {
            XCTAssertGreaterThanOrEqual(contrast(.muted, .paper, style: style), 4.5)
            XCTAssertGreaterThanOrEqual(contrast(.muted, .surface, style: style), 4.5)
            for accent in AppAccent.allCases {
                XCTAssertGreaterThanOrEqual(contrast(accent.color, .paper, style: style), 4.5)
                XCTAssertGreaterThanOrEqual(contrast(accent.color, .surface, style: style), 4.5)
                XCTAssertGreaterThanOrEqual(contrast(accent.color, accent.surfaceColor, style: style), 4.5)
                XCTAssertGreaterThanOrEqual(contrast(accent.onSolidColor, accent.solidColor, style: style), 4.5)
                XCTAssertGreaterThanOrEqual(
                    contrast(accent.color, accent.washColor, style: style), 4.5,
                    "\(accent.rawValue) text on background fade in \(style)"
                )
                XCTAssertGreaterThanOrEqual(contrast(.muted, accent.washColor, style: style), 4.5)
            }
        }
    }

    func testRequestedAccentsAndBurgerIcon() {
        let names = Set(AppAccent.allCases.map(\.rawValue))
        XCTAssertTrue(Set(["Orange", "Yellow", "Purple", "Green"]).isSubset(of: names))
        XCTAssertEqual(Place.samples.first?.icon, .burger)
    }

    private func contrast(_ first: Color, _ second: Color, style: UIUserInterfaceStyle) -> Double {
        func luminance(_ color: Color) -> Double {
            let resolved = UIColor(color).resolvedColor(with: UITraitCollection(userInterfaceStyle: style))
            var red: CGFloat = 0
            var green: CGFloat = 0
            var blue: CGFloat = 0
            var alpha: CGFloat = 0
            XCTAssertTrue(resolved.getRed(&red, green: &green, blue: &blue, alpha: &alpha))
            let channels = [red, green, blue].map { channel in
                let value = Double(channel)
                return value <= 0.04045 ? value / 12.92 : pow((value + 0.055) / 1.055, 2.4)
            }
            return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
        }
        let a = luminance(first)
        let b = luminance(second)
        return (max(a, b) + 0.05) / (min(a, b) + 0.05)
    }
}
