import XCTest

@MainActor
final class CustomerFlowTests: XCTestCase {
    private func launch(welcome: Bool = false) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-ui-testing", "-reset-demo"]
        if !welcome { app.launchArguments.append("-skip-welcome") }
        app.launch()
        return app
    }

    private func capture(_ name: String, app: XCUIApplication) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func expectBalance(_ value: String, in app: XCUIApplication) {
        let expectation = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "label == %@", value),
            object: app.staticTexts["detail.balance"]
        )
        XCTAssertEqual(XCTWaiter.wait(for: [expectation], timeout: 3), .completed)
    }

    func testHomeShowsAllStarterCardsWithoutScrolling() {
        let app = launch()
        XCTAssertTrue(app.tabBars.buttons["Home"].exists)
        XCTAssertTrue(app.tabBars.buttons["Search"].exists)
        XCTAssertTrue(app.tabBars.buttons["Redeemed"].exists)
        XCTAssertTrue(app.tabBars.buttons["You"].exists)
        for id in ["dicks", "cozy", "jango"] {
            let card = app.buttons["card.\(id)"]
            XCTAssertTrue(card.isHittable)
            XCTAssertLessThan(card.frame.maxY, app.tabBars.firstMatch.frame.minY)
        }
        XCTAssertFalse(app.staticTexts["Reward ready"].exists)
        XCTAssertFalse(app.staticTexts["6/6"].exists)
        capture("Home - compact balances", app: app)
    }

    func testCoffeeRedemptionKeepsRemainingStampsAndCanBeCancelled() {
        let app = launch()
        app.buttons["card.cozy"].tap()
        XCTAssertEqual(app.staticTexts["detail.balance"].label, "6 stamps")
        XCTAssertTrue(app.buttons["reward.coffee"].isEnabled)
        XCTAssertFalse(app.buttons["reward.sandwich"].isEnabled)
        capture("Cozy Cafe - reward choices", app: app)
        app.buttons["reward.coffee"].tap()
        app.buttons["Cancel"].tap()
        XCTAssertEqual(app.staticTexts["detail.balance"].label, "6 stamps")
        app.buttons["reward.coffee"].tap()
        app.buttons["Use 5 stamps"].tap()
        XCTAssertTrue(app.staticTexts["coupon.title"].waitForExistence(timeout: 3))
        XCTAssertEqual(app.staticTexts["coupon.title"].label, "Regular coffee")
        app.buttons["Done"].tap()
        expectBalance("1 stamp", in: app)
        XCTAssertFalse(app.buttons["reward.coffee"].isEnabled)
        XCTAssertTrue(app.staticTexts["Saved in Redeemed."].exists)
        app.tabBars.buttons["Redeemed"].tap()
        XCTAssertEqual(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'coupon.cozy.'")).count, 2)
    }

    func testCanKeepCollectingAndChooseTheLargerReward() {
        let app = launch()
        app.buttons["card.cozy"].tap()
        let visit = app.buttons["detail.simulateVisit"]
        for _ in 0..<8 where !visit.isHittable { app.swipeUp() }
        for _ in 0..<4 { visit.tap() }
        let sandwich = app.buttons["reward.sandwich"]
        for _ in 0..<8 where !sandwich.isHittable { app.swipeDown() }
        XCTAssertTrue(sandwich.isEnabled)
        XCTAssertEqual(app.staticTexts["detail.balance"].label, "10 stamps")
        sandwich.tap()
        app.buttons["Use 10 stamps"].tap()
        XCTAssertTrue(app.staticTexts["coupon.title"].waitForExistence(timeout: 3))
        XCTAssertEqual(app.staticTexts["coupon.title"].label, "Sandwich")
        app.buttons["Done"].tap()
        expectBalance("0 stamps", in: app)
    }

    func testRedeemedShowsSamplesAndCouponCanBeMarkedUsed() {
        let app = launch()
        app.tabBars.buttons["Redeemed"].tap()
        for id in ["dicks", "cozy", "jango"] {
            XCTAssertEqual(app.buttons.matching(NSPredicate(
                format: "identifier BEGINSWITH %@", "coupon.\(id)."
            )).count, 1)
        }
        capture("Redeemed - available sample coupons", app: app)
        app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'coupon.cozy.'")).firstMatch.tap()
        XCTAssertEqual(app.staticTexts["coupon.title"].label, "Regular coffee")
        app.buttons["coupon.wallet"].tap()
        XCTAssertTrue(app.staticTexts["Apple Wallet coupon passes aren't implemented yet."].waitForExistence(timeout: 3))
        app.buttons["Done"].tap()
        app.buttons["coupon.use"].tap()
        app.alerts.buttons["Cancel"].tap()
        XCTAssertEqual(app.staticTexts["coupon.status"].label, "AVAILABLE")
        capture("Coupon - available at the counter", app: app)
        app.buttons["coupon.use"].tap()
        app.alerts.buttons["Mark as used"].tap()
        let used = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "label == 'USED'"),
            object: app.staticTexts["coupon.status"]
        )
        XCTAssertEqual(XCTWaiter.wait(for: [used], timeout: 3), .completed)
        XCTAssertFalse(app.buttons["coupon.use"].exists)
        app.navigationBars.buttons["Back"].tap()
        XCTAssertTrue(app.staticTexts["Used"].exists)
        capture("Redeemed - available and used coupons", app: app)
    }

    func testRedeemedContrastAndTextClipping() throws {
        let app = launch()
        app.tabBars.buttons["Redeemed"].tap()
        try audit(app)
        app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'coupon.dicks.'")).firstMatch.tap()
        try audit(app)
        capture("Coupon - light", app: app)
        app.navigationBars.buttons["Back"].tap()
        app.tabBars.buttons["You"].tap()
        app.buttons["settings.appearance"].tap()
        app.buttons["Dark"].tap()
        app.tabBars.buttons["Redeemed"].tap()
        try audit(app)
        capture("Redeemed - dark", app: app)
        app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'coupon.jango.'")).firstMatch.tap()
        try audit(app)
        capture("Coupon - dark", app: app)
    }

    func testLargestTextSizeCanOpenAndUseCoupon() {
        let app = XCUIApplication()
        app.launchArguments = [
            "-ui-testing", "-reset-demo", "-skip-welcome",
            "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"
        ]
        app.launch()
        app.tabBars.buttons["Redeemed"].tap()
        let coupon = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'coupon.dicks.'")).firstMatch
        for _ in 0..<8 where !coupon.isHittable { app.swipeUp() }
        coupon.tap()
        XCTAssertTrue(app.staticTexts["coupon.title"].waitForExistence(timeout: 3))
        let use = app.buttons["coupon.use"]
        for _ in 0..<8 where !use.isHittable || use.frame.maxY > app.tabBars.firstMatch.frame.minY {
            app.swipeUp()
        }
        XCTAssertTrue(use.isHittable)
        XCTAssertLessThanOrEqual(use.frame.maxY, app.tabBars.firstMatch.frame.minY)
        capture("Coupon - largest accessibility text", app: app)
        use.tap()
        XCTAssertTrue(app.alerts.buttons["Mark as used"].waitForExistence(timeout: 3))
        app.alerts.buttons["Cancel"].tap()
    }

    func testSearchByNameJoinAndDirectWalletStatus() {
        let app = launch()
        app.tabBars.buttons["Search"].tap()
        XCTAssertFalse(app.buttons["search.common-ground"].exists)
        let search = app.textFields["search.query"]
        search.tap()
        search.typeText("Common")
        app.buttons["search.common-ground"].tap()
        app.buttons["detail.join"].tap()
        XCTAssertEqual(app.staticTexts["detail.balance"].label, "0 stamps")
        app.buttons["detail.wallet"].tap()
        XCTAssertTrue(app.staticTexts["Apple Wallet isn't implemented yet."].waitForExistence(timeout: 3))
        XCTAssertFalse(app.buttons["wallet.preview"].exists)
        capture("Apple Wallet - not implemented", app: app)
    }

    func testSearchByClientIDAndNotNeighborhoodOrCategory() {
        let app = launch()
        app.tabBars.buttons["Search"].tap()
        let search = app.textFields["search.query"]
        search.tap()
        search.typeText("29bff0a1-7eb3-4e8a-a02d-8fa39cc00102")
        XCTAssertTrue(app.buttons["search.cozy"].waitForExistence(timeout: 3))
        XCTAssertFalse(app.buttons["search.dicks"].exists)
        capture("Search - exact client ID", app: app)
        app.buttons["Clear search"].tap()
        search.tap()
        search.typeText("Fremont")
        XCTAssertTrue(app.staticTexts["No matching business"].exists)
        XCTAssertFalse(app.buttons["search.jango"].exists)
        app.buttons["Clear search"].tap()
        search.tap()
        search.typeText("Coffee")
        XCTAssertTrue(app.staticTexts["No matching business"].exists)
    }

    func testProgramDetailsRetainClientIDAndActivity() {
        let app = launch()
        app.buttons["card.cozy"].tap()
        app.buttons["Program details"].tap()
        let identifier = app.staticTexts["detail.clientID"]
        for _ in 0..<4 where !identifier.isHittable { app.swipeUp() }
        XCTAssertEqual(identifier.label, "29BFF0A1-7EB3-4E8A-A02D-8FA39CC00102")
        XCTAssertTrue(app.buttons["Copy client ID"].exists)
        let activity = app.buttons["See all activity"]
        for _ in 0..<4 where !activity.isHittable { app.swipeUp() }
        activity.tap()
        XCTAssertTrue(app.staticTexts["Activity"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.staticTexts["Program joined"].exists)
    }

    func testSimulatedVisitUpdatesBalance() {
        let app = launch()
        app.buttons["card.dicks"].tap()
        let visit = app.buttons["detail.simulateVisit"]
        for _ in 0..<8 where !visit.isHittable { app.swipeUp() }
        visit.tap()
        let balance = app.staticTexts["detail.balance"]
        for _ in 0..<8 where !balance.isHittable { app.swipeDown() }
        XCTAssertEqual(balance.label, "6 stamps")
        XCTAssertTrue(app.staticTexts["Stamp added."].exists)
    }

    func testWelcomeCanBeCompleted() {
        let app = launch(welcome: true)
        let continueButton = app.buttons["welcome.continue"]
        for _ in 0..<4 where !continueButton.isHittable { app.swipeUp() }
        continueButton.tap()
        XCTAssertTrue(app.staticTexts["heading.home"].waitForExistence(timeout: 3))
    }

    func testYouShowsSettingsWithoutPlaceholderProfile() {
        let app = launch()
        app.tabBars.buttons["You"].tap()
        XCTAssertFalse(app.staticTexts["Local profile"].exists)
        XCTAssertFalse(app.staticTexts["No sign-in"].exists)
        XCTAssertFalse(app.textFields["profile.nickname"].exists)
        XCTAssertTrue(app.buttons["settings.appearance"].isHittable)
        XCTAssertTrue(app.buttons["settings.accent.Orange"].isHittable)
        capture("You - settings without a profile", app: app)
    }

    func testAppearanceAndAccentPersistAcrossLaunch() {
        let app = launch()
        app.tabBars.buttons["You"].tap()
        app.buttons["settings.appearance"].tap()
        app.buttons["Dark"].tap()
        app.buttons["settings.accent.Moss"].tap()
        app.terminate()
        app.launchArguments = ["-ui-testing", "-skip-welcome"]
        app.launch()
        app.tabBars.buttons["You"].tap()
        XCTAssertTrue(app.buttons["settings.appearance"].label.contains("Dark"))
        XCTAssertTrue(app.buttons["settings.accent.Moss"].isSelected)
        app.tabBars.buttons["Home"].tap()
        capture("Home - dark moss fade", app: app)
        app.buttons["card.cozy"].tap()
        let wallet = app.buttons["detail.wallet"]
        let visible = XCTNSPredicateExpectation(
            predicate: NSPredicate { _, _ in wallet.exists && app.frame.contains(wallet.frame) },
            object: nil
        )
        XCTAssertEqual(XCTWaiter.wait(for: [visible], timeout: 3), .completed)
        capture("Cozy Cafe - dark moss", app: app)
    }

    func testPrivacyKeepsItsBackNavigation() {
        let app = launch()
        app.tabBars.buttons["You"].tap()
        let privacy = app.buttons["Data & privacy"]
        for _ in 0..<6 where !privacy.isHittable { app.swipeUp() }
        privacy.tap()
        XCTAssertTrue(app.staticTexts["Stored on this device"].waitForExistence(timeout: 3))
        app.navigationBars.buttons["Back"].tap()
        XCTAssertTrue(app.buttons["profile.delete"].waitForExistence(timeout: 3))
    }

    func testArchiveCanBeRestored() {
        let app = launch()
        app.buttons["card.dicks"].tap()
        app.buttons["Card options"].tap()
        app.buttons["Archive card"].tap()
        app.buttons["Archive card"].tap()
        app.buttons["Archived cards"].tap()
        app.buttons["Restore"].tap()
        XCTAssertTrue(app.staticTexts["No archived cards"].waitForExistence(timeout: 3))
        app.buttons["Done"].tap()
        XCTAssertTrue(app.buttons["card.dicks"].exists)
    }

    func testDeletedCardsShowEmptyStateAndCanBeRejoined() {
        let app = launch()
        app.tabBars.buttons["You"].tap()
        let delete = app.buttons["profile.delete"]
        for _ in 0..<7 where !delete.isHittable { app.swipeUp() }
        delete.tap()
        app.buttons["Delete demo data"].tap()
        app.tabBars.buttons["Redeemed"].tap()
        XCTAssertTrue(app.staticTexts["No coupons"].waitForExistence(timeout: 3))
        app.tabBars.buttons["Home"].tap()
        XCTAssertTrue(app.staticTexts["No cards"].waitForExistence(timeout: 3))
        app.buttons["Search for a business"].tap()
        let search = app.textFields["search.query"]
        search.tap()
        search.typeText("Dick")
        app.buttons["search.dicks"].tap()
        app.buttons["detail.join"].tap()
        XCTAssertEqual(app.staticTexts["detail.balance"].label, "0 stamps")
    }

    func testHomeAndRewardsContrastAndTextClipping() throws {
        let app = launch()
        try audit(app)
        app.buttons["card.cozy"].tap()
        try audit(app)
    }

    private func audit(_ app: XCUIApplication) throws {
        try app.performAccessibilityAudit(for: [.contrast, .textClipped]) { issue in
            guard issue.auditType == .contrast, let element = issue.element else { return false }
            let underTabBar = app.tabBars.firstMatch.exists &&
                element.frame.intersects(app.tabBars.firstMatch.frame)
            let underScrollEdge = app.images.matching(identifier: "AdditionalDimmingOverlay")
                .allElementsBoundByIndex.contains { element.frame.intersects($0.frame) }
            XCTContext.runActivity(named: "Contrast audit element") { activity in
                activity.add(XCTAttachment(string: element.debugDescription))
            }
            // Native floating bars and scroll-edge overlays deliberately fade underlying content.
            return underTabBar || underScrollEdge
        }
    }

    func testLargestTextSizeCanReachAndUseCard() {
        let app = XCUIApplication()
        app.launchArguments = [
            "-ui-testing", "-reset-demo", "-skip-welcome",
            "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"
        ]
        app.launch()
        let card = app.buttons["card.dicks"]
        for _ in 0..<8 where !card.isHittable { app.swipeUp() }
        card.tap()
        let reward = app.buttons["reward.burger"]
        for _ in 0..<8 where !reward.isHittable { app.swipeUp() }
        XCTAssertTrue(reward.isHittable)
        capture("Largest text - reward choices", app: app)
        let showCard = app.buttons["detail.showCard"]
        for _ in 0..<8 where !showCard.isHittable { app.swipeDown() }
        showCard.tap()
        XCTAssertTrue(app.staticTexts["Customer card"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.staticTexts["Customer codes aren't implemented yet."].exists)
    }

    func testRequestedAccentPreviews() {
        let app = launch()
        for color in ["Orange", "Yellow", "Purple", "Green"] {
            app.tabBars.buttons["You"].tap()
            let option = app.buttons["settings.accent.\(color)"]
            for _ in 0..<4 where !option.isHittable { app.swipeUp() }
            option.tap()
            XCTAssertTrue(option.isSelected)
            app.tabBars.buttons["Home"].tap()
            XCTAssertTrue(app.staticTexts["heading.home"].exists)
            capture("\(color) - Home background fade", app: app)
        }
        app.buttons["card.dicks"].tap()
        XCTAssertTrue(app.buttons["detail.showCard"].exists)
        capture("Green - balance and burger mark", app: app)
    }
}
