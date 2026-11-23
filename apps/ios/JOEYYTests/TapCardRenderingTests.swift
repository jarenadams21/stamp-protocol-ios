import SwiftUI
import XCTest
@testable import JOEYY

@MainActor
final class TapCardRenderingTests: XCTestCase {
    func testPersonalCardRendersInBothAppearancesAndExpandsForLargeText() throws {
        let suite = "TapCardRenderingTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let branding = MerchantBrandingStore(
            defaults: defaults,
            directory: URL.temporaryDirectory.appendingPathComponent(suite)
        )
        let card = LiveCard(id: UUID(), cafeId: UUID(), cafeName: "Sunday Coffee",
                            stamps: 5, target: 8, rewardsAvailable: 1,
                            updatedAt: "2026-11-13T21:00:00Z")
        for scheme in [ColorScheme.light, .dark] {
            var regularHeight: CGFloat = 0
            for size in [DynamicTypeSize.large, .accessibility3] {
                let content = TapLiveCard(card: card, busy: false, updateWallet: {})
                    .padding(24)
                    .background(Color.paper)
                    .environment(branding)
                    .environment(\.colorScheme, scheme)
                    .environment(\.dynamicTypeSize, size)
                    .environment(\.simulatingReducedMotion, true)
                let renderer = ImageRenderer(content: content)
                renderer.proposedSize = ProposedViewSize(width: 390, height: nil)
                renderer.scale = 2
                let image = try XCTUnwrap(renderer.uiImage)
                XCTAssertEqual(image.size.width, 390, accuracy: 1)
                XCTAssertGreaterThan(image.size.height, 300)
                if size == .large { regularHeight = image.size.height }
                else { XCTAssertGreaterThan(image.size.height, regularHeight) }
                let attachment = XCTAttachment(image: image)
                attachment.name = "Personal card - \(scheme) - \(size)"
                attachment.lifetime = .keepAlways
                add(attachment)
            }
        }
    }
}
