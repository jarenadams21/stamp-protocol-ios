import XCTest

extension XCTestCase {
    @MainActor
    func auditVisibleContent(in app: XCUIApplication,
                             types: XCUIAccessibilityAuditType = [.contrast, .textClipped]) throws {
        settleForAudit(0.8)
        do {
            try performVisibleContentAudit(in: app, types: types)
        } catch {
            // Appearance cross-fades can report intermediate colors; persistent issues still fail.
            settleForAudit(2)
            try performVisibleContentAudit(in: app, types: types)
        }
    }

    @MainActor
    private func settleForAudit(_ seconds: TimeInterval) {
        let idle = XCTestExpectation(description: "settle appearance")
        idle.isInverted = true
        _ = XCTWaiter.wait(for: [idle], timeout: seconds)
    }

    @MainActor
    private func performVisibleContentAudit(in app: XCUIApplication,
                                           types: XCUIAccessibilityAuditType) throws {
        try app.performAccessibilityAudit(for: types) { issue in
            guard let element = issue.element else { return false }
            // Floating system bars intentionally occlude scrollable content underneath them.
            if app.tabBars.firstMatch.exists && element.frame.intersects(app.tabBars.firstMatch.frame) {
                return true
            }
            if issue.auditType == .contrast &&
                app.images.matching(identifier: "AdditionalDimmingOverlay")
                    .allElementsBoundByIndex.contains(where: { element.frame.intersects($0.frame) }) {
                return true
            }
            let attachment = XCTAttachment(string: "\(issue.detailedDescription)\n\(element.debugDescription)")
            attachment.name = "Visible content accessibility issue"
            attachment.lifetime = .keepAlways
            self.add(attachment)
            return false
        }
    }
}
