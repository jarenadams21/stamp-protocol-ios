import XCTest

@MainActor
/// Business-side flows. Named to run after CustomerFlowTests, whose timing-sensitive checks
/// are steadiest on a freshly booted simulator.
final class MerchantFlowTests: XCTestCase {
    /// Opens the setup landing and chooses Business, as a new business owner would.
    private func launchBusiness(extra: [String] = []) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-ui-testing", "-reset-demo"] + extra
        app.launch()
        let business = app.buttons["setup.business"]
        XCTAssertTrue(business.waitForExistence(timeout: 10))
        for _ in 0..<6 where !business.isHittable { app.swipeUp() }
        business.tap()
        return app
    }

    private func launchSample() -> XCUIApplication {
        let app = launchBusiness()
        let sample = app.buttons["business.sample"]
        XCTAssertTrue(sample.waitForExistence(timeout: 10))
        for _ in 0..<6 where !sample.isHittable { app.swipeUp() }
        sample.tap()
        XCTAssertTrue(app.descendants(matching: .any)["overview.metric.enrolled"].waitForExistence(timeout: 10))
        return app
    }

    private func scrollTo(_ element: XCUIElement, in app: XCUIApplication) {
        for _ in 0..<10 where !(element.exists && element.isHittable) { app.swipeUp() }
    }

    private func capture(_ name: String, app: XCUIApplication) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func audit(_ app: XCUIApplication) throws {
        do {
            try performAudit(app)
        } catch let error as NSError where error.code == -56 {
            // "Audit failed to complete in time" is a runner timeout on long forms; retry once.
            try performAudit(app)
        }
    }

    private func performAudit(_ app: XCUIApplication) throws {
        try app.performAccessibilityAudit(for: [.contrast, .textClipped]) { issue in
            guard issue.auditType == .contrast, let element = issue.element else { return false }
            let underTabBar = app.tabBars.firstMatch.exists &&
                element.frame.intersects(app.tabBars.firstMatch.frame)
            let underScrollEdge = app.images.matching(identifier: "AdditionalDimmingOverlay")
                .allElementsBoundByIndex.contains { element.frame.intersects($0.frame) }
            // iOS also fades scrolling content just above the floating tab bar.
            let tabBarTop = app.tabBars.firstMatch.exists ? app.tabBars.firstMatch.frame.minY : .infinity
            let inTabBarFade = element.frame.maxY > tabBarTop - 100
            // Native floating bars and scroll-edge overlays fade underlying content.
            if underTabBar || underScrollEdge || inTabBarFade { return true }
            let attachment = XCTAttachment(string: "\(issue.detailedDescription)\n\(element.debugDescription)")
            attachment.name = "App-owned contrast issue"
            attachment.lifetime = .keepAlways
            self.add(attachment)
            return false
        }
    }

    func testSampleWalkthroughPublishesNewVersion() throws {
        let app = launchSample()
        XCTAssertTrue(app.staticTexts["Norema Cafe"].exists)
        XCTAssertTrue(app.buttons["overview.program"].exists)
        let waiting = app.descendants(matching: .any).matching(identifier: "overview.rewardsWaiting").firstMatch
        XCTAssertTrue(waiting.waitForExistence(timeout: 10))
        XCTAssertTrue(waiting.label.contains("rewards to redeem"))
        capture("Business - Overview", app: app)

        app.tabBars.buttons["Card"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["card.preview"].waitForExistence(timeout: 10))
        capture("Business - Card designer", app: app)

        let stepper = app.steppers["card.punches"]
        scrollTo(stepper, in: app)
        let decrement = stepper.buttons.element(boundBy: 0)
        decrement.tap()
        decrement.tap()

        let publish = app.buttons["card.publish"]
        scrollTo(publish, in: app)
        XCTAssertEqual(publish.label, "Publish version 2")
        publish.tap()
        let confirm = app.buttons.matching(
            NSPredicate(format: "label == %@ AND identifier != %@", "Publish version 2", "card.publish")
        ).firstMatch
        XCTAssertTrue(confirm.waitForExistence(timeout: 10))
        confirm.tap()

        let feedback = app.descendants(matching: .any).matching(identifier: "card.feedback").firstMatch
        XCTAssertTrue(feedback.waitForExistence(timeout: 10))
        XCTAssertTrue(feedback.label.contains("Version 2 published."))

        app.tabBars.buttons["Overview"].tap()
        let finishing = app.descendants(matching: .any).matching(identifier: "overview.finishing").firstMatch
        XCTAssertTrue(finishing.waitForExistence(timeout: 10))
        XCTAssertTrue(finishing.label.contains("still finishing older versions"))
    }

    func testFirstTimeSetupCreatesBusiness() {
        let app = launchBusiness()
        app.buttons["business.setup"].tap()
        let name = app.textFields["business.name"]
        XCTAssertTrue(name.waitForExistence(timeout: 10))
        name.tap()
        name.typeText("Norema Cafe")
        app.buttons["business.save"].tap()
        XCTAssertTrue(app.tabBars.buttons["Card"].waitForExistence(timeout: 10))
        app.buttons["overview.design"].tap()
        let publish = app.buttons["card.publish"]
        scrollTo(publish, in: app)
        XCTAssertTrue(publish.exists)
        XCTAssertFalse(publish.isEnabled, "A reward is required before publishing")
    }

    func testBugButtonOpensPrefilledReport() {
        let app = launchSample()
        let bug = app.buttons["bug.report"].firstMatch
        XCTAssertTrue(bug.waitForExistence(timeout: 10))
        bug.tap()
        XCTAssertTrue(app.textFields["bug.title"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["bug.continue"].isEnabled)
        app.textFields["bug.title"].tap()
        app.textFields["bug.title"].typeText("Sample issue")
        XCTAssertTrue(app.buttons["bug.continue"].isEnabled)
        app.buttons["Cancel"].tap()
    }

    func testSwitchingExperiencesPreservesBothDataSetsAcrossRelaunch() {
        let app = launchSample()
        let enrolled = app.descendants(matching: .any)["overview.metric.enrolled"].label
        app.tabBars.buttons["You"].tap()
        let setup = app.buttons["settings.setup"]
        scrollTo(setup, in: app)
        setup.tap()
        app.buttons["setup.customer"].tap()
        XCTAssertTrue(app.buttons["home.collection"].waitForExistence(timeout: 10))
        let card = app.buttons["card.cloud-city"]
        scrollTo(card, in: app)
        card.tap()
        let progress = app.descendants(matching: .any)["card.progress"]
        XCTAssertEqual(progress.label, "6 of 6 stamps")
        app.buttons["Card options"].tap()
        app.buttons["Favorite"].tap()
        app.buttons["Card options"].tap()
        app.buttons["detail.queueStamp"].tap()
        XCTAssertEqual(app.staticTexts["detail.pendingStamps"].label, "1 stamp queued")
        app.buttons["detail.claim"].tap()
        app.alerts.buttons["Claim reward"].tap()
        XCTAssertTrue(app.staticTexts["coupon.title"].waitForExistence(timeout: 10))
        app.buttons["coupon.use"].tap()
        app.alerts.buttons["Mark as used"].tap()
        XCTAssertEqual(app.staticTexts["coupon.status"].label, "USED")
        app.buttons["Done"].tap()
        XCTAssertEqual(progress.label, "1 of 6 stamps")
        app.tabBars.buttons["You"].tap()
        let customerSetup = app.buttons["settings.setup"]
        scrollTo(customerSetup, in: app)
        customerSetup.tap()
        app.buttons["setup.business"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["overview.metric.enrolled"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Norema Cafe"].exists)
        XCTAssertEqual(app.descendants(matching: .any)["overview.metric.enrolled"].label, enrolled)
        app.terminate()
        app.launchArguments = ["-ui-testing"]
        app.launch()
        XCTAssertTrue(app.descendants(matching: .any)["overview.metric.enrolled"].waitForExistence(timeout: 10))
        XCTAssertEqual(app.descendants(matching: .any)["overview.metric.enrolled"].label, enrolled)
        app.tabBars.buttons["You"].tap()
        scrollTo(setup, in: app)
        setup.tap()
        app.buttons["setup.customer"].tap()
        XCTAssertTrue(app.buttons["home.collection"].waitForExistence(timeout: 10))
        scrollTo(card, in: app)
        XCTAssertTrue((card.value as? String)?.contains("Favorite") == true)
        card.tap()
        XCTAssertEqual(progress.label, "1 of 6 stamps")
        XCTAssertFalse(app.staticTexts["detail.pendingStamps"].exists)
        app.tabBars.buttons["Redeemed"].tap()
        app.segmentedControls["redeemed.collection"].buttons["Used"].tap()
        app.buttons["coupon.cloud-city.stack"].tap()
        XCTAssertEqual(app.staticTexts["coupon.status"].label, "USED")
        XCTAssertFalse(app.buttons["coupon.use"].exists)
    }

    func testBusinessScreensContrastInLightAndDark() throws {
        let app = launchSample()
        for mode in ["Light", "Dark"] {
            app.tabBars.buttons["You"].tap()
            app.buttons["settings.appearance"].tap()
            app.buttons[mode].tap()
            for tab in ["Overview", "Card", "Business", "You"] {
                app.tabBars.buttons[tab].tap()
                settle()
                capture("Business \(tab) - \(mode)", app: app)
                try audit(app)
            }
        }
    }

    /// Lets appearance cross-fades and tab transitions finish so the audit measures final colors.
    private func settle() {
        let idle = expectation(description: "Transitions finish")
        idle.isInverted = true
        wait(for: [idle], timeout: 1)
    }
}
