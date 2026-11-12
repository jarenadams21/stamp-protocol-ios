import XCTest

@MainActor
final class CustomerFlowTests: XCTestCase {
    private let places = ["monorail-pike", "cloud-city", "five-stones-kirkland"]
    /// Generous so busy CI simulators don't fail; waits still return as soon as the condition holds.
    private let uiTimeout: TimeInterval = 10

    override func setUp() async throws {
        continueAfterFailure = false
    }

    /// Lets navigation, sheet, and appearance transitions finish before auditing or measuring.
    private func settle(_ seconds: TimeInterval = 0.8) {
        let idle = XCTestExpectation(description: "settle")
        idle.isInverted = true
        _ = XCTWaiter.wait(for: [idle], timeout: seconds)
    }

    private func launch(welcome: Bool = false, extra: [String] = []) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-ui-testing", "-reset-demo"] + extra
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

    private func expectProgress(_ value: String, in app: XCUIApplication) {
        let progress = app.descendants(matching: .any).matching(identifier: "card.progress").firstMatch
        let expectation = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "label == %@", value), object: progress
        )
        XCTAssertEqual(XCTWaiter.wait(for: [expectation], timeout: uiTimeout), .completed, "Expected \(value)")
    }

    private func contentBottom(in app: XCUIApplication) -> CGFloat {
        let bar = app.tabBars.firstMatch
        return bar.exists ? bar.frame.minY : app.frame.maxY
    }

    private func reach(_ element: XCUIElement, in app: XCUIApplication) {
        let bottom = contentBottom(in: app)
        let navigationBar = app.navigationBars.firstMatch
        let top = navigationBar.exists ? navigationBar.frame.maxY : app.frame.minY + 60
        for _ in 0..<10 where !element.isHittable || element.frame.maxY > bottom {
            if element.frame.minY < top { app.swipeDown() }
            else { app.swipeUp() }
        }
        XCTAssertTrue(element.isHittable)
        XCTAssertLessThanOrEqual(element.frame.maxY, bottom)
    }

    private func openCard(_ id: String, in app: XCUIApplication) {
        let heading = app.buttons["home.collection"]
        for _ in 0..<6 where !heading.isHittable { app.swipeDown() }
        let card = app.buttons["card.\(id)"]
        if !card.exists && app.buttons["home.stack.expand"].exists {
            reach(app.buttons["home.stack.expand"], in: app)
            app.buttons["home.stack.expand"].tap()
        }
        reach(card, in: app)
        card.tap()
    }

    private func revealDiscovery(_ id: String, in app: XCUIApplication) {
        let poster = app.buttons["discover.\(id)"]
        let gallery = app.scrollViews["discovery.gallery"]
        for _ in 0..<6 where poster.frame.midX > app.frame.maxX || poster.frame.midX < app.frame.minX {
            if poster.frame.midX < app.frame.minX { gallery.swipeRight() }
            else { gallery.swipeLeft() }
        }
        reach(poster, in: app)
    }

    private func search(_ value: String, field: String, in app: XCUIApplication) {
        let input = app.textFields[field]
        if field == "home.query" && !input.exists { app.buttons["home.search"].tap() }
        reach(input, in: app)
        if app.buttons["\(field).clear"].exists { app.buttons["\(field).clear"].tap() }
        input.tap()
        input.typeText(value)
        app.keyboards.buttons["Search"].tap()
    }

    private func toggle(_ identifier: String, in app: XCUIApplication) {
        let toggle = app.switches[identifier].exists ? app.switches[identifier] : app.buttons[identifier]
        reach(toggle, in: app)
        toggle.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)).tap()
    }

    private func toggleFavorite(_ id: String, in app: XCUIApplication) {
        let select = app.buttons["home.stack.select"]
        reach(select, in: app)
        select.tap()
        let card = app.buttons["card.\(id)"]
        reach(card, in: app)
        card.tap()
        let favorite = app.buttons["home.stack.favorite"]
        reach(favorite, in: app)
        favorite.tap()
        XCTAssertTrue(favorite.waitForNonExistence(timeout: 3))
    }

    private func manageGroups(in app: XCUIApplication) {
        let collection = app.buttons["home.collection"]
        reach(collection, in: app)
        collection.tap()
        app.buttons["home.groups"].tap()
    }

    private func expectCleanCard(_ id: String, card: XCUIElement, in app: XCUIApplication) {
        XCTAssertTrue(card.isHittable)
        XCTAssertFalse(app.buttons["card.options.\(id)"].exists)
        XCTAssertFalse(app.staticTexts["Organize"].exists)
        XCTAssertFalse(app.buttons["favorite.\(id)"].exists)
    }

    private func expectBefore(_ first: XCUIElement, _ second: XCUIElement) {
        let expectation = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            first.exists && second.exists && first.frame.minY < second.frame.minY
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [expectation], timeout: 5), .completed)
    }

    func testNativeCardDraggingPersistsAndKeepsGroupOrderIndependent() {
        let app = launch()
        let monorail = app.buttons["card.monorail-pike"]
        let cloud = app.buttons["card.cloud-city"]
        cloud.press(forDuration: 0.8, thenDragTo: monorail)
        expectBefore(cloud, monorail)
        monorail.tap()
        expectProgress("5 of 8 stamps", in: app)
        app.navigationBars.buttons.firstMatch.tap()

        manageGroups(in: app)
        app.buttons["group.create"].tap()
        app.textFields["group.name"].tap()
        app.textFields["group.name"].typeText("My order")
        for id in places { toggle("group.place.\(id)", in: app) }
        app.buttons["group.save"].tap()
        app.buttons["Done"].tap()
        app.buttons["home.collection"].tap()
        app.buttons["My order"].tap()
        expectBefore(monorail, cloud)
        cloud.press(forDuration: 0.8, thenDragTo: monorail)
        expectBefore(cloud, monorail)
        monorail.press(forDuration: 0.8, thenDragTo: cloud)
        expectBefore(monorail, cloud)
        app.buttons["home.collection"].tap()
        app.buttons["All places"].tap()
        expectBefore(cloud, monorail)

        app.terminate()
        app.launchArguments = ["-ui-testing", "-skip-welcome"]
        app.launch()
        expectBefore(cloud, monorail)
        app.buttons["home.collection"].tap()
        app.buttons["My order"].tap()
        expectBefore(monorail, cloud)
        capture("Independent saved card order", app: app)
    }

    func testCancelledDragAndFavoritesPreserveHomeOrderingAndSelection() {
        let app = launch()
        let monorail = app.buttons["card.monorail-pike"]
        let cloud = app.buttons["card.cloud-city"]
        cloud.press(forDuration: 0.8, thenDragTo: app.staticTexts["3 places"])
        expectBefore(monorail, cloud)
        toggleFavorite("monorail-pike", in: app)
        toggleFavorite("cloud-city", in: app)
        app.buttons["home.collection"].tap()
        app.buttons["Favorites"].tap()
        expectBefore(monorail, cloud)
        monorail.press(forDuration: 0.8, thenDragTo: cloud)
        expectBefore(cloud, monorail)
        app.buttons["home.collection"].tap()
        app.buttons["All places"].tap()
        expectBefore(cloud, monorail)
        app.buttons["home.stack.select"].tap()
        monorail.tap()
        XCTAssertEqual(monorail.value as? String, "Selected")
        XCTAssertEqual(cloud.value as? String, "Not selected")
        app.buttons["home.stack.select"].tap()
        monorail.tap()
        expectProgress("5 of 8 stamps", in: app)
    }

    func testNativeRedeemedDraggingKeepsTicketStacksAndPersists() {
        let app = launch()
        app.tabBars.buttons["Redeemed"].tap()
        let monorail = app.buttons["coupon.monorail-pike.stack"]
        let cloud = app.buttons["coupon.cloud-city.stack"]
        reach(cloud, in: app)
        cloud.press(forDuration: 0.8, thenDragTo: monorail)
        expectBefore(cloud, monorail)
        cloud.tap()
        XCTAssertTrue(app.buttons["coupon.use"].waitForExistence(timeout: 3))
        app.navigationBars.buttons.firstMatch.tap()
        app.terminate()
        app.launchArguments = ["-ui-testing", "-skip-welcome"]
        app.launch()
        app.tabBars.buttons["Redeemed"].tap()
        expectBefore(cloud, monorail)
        capture("Saved reward ticket order", app: app)
        for card in [monorail, cloud] {
            reach(card, in: app)
            card.tap()
            let use = app.buttons["coupon.use"]
            reach(use, in: app)
            use.tap()
            app.alerts.buttons["Mark as used"].tap()
            app.navigationBars.buttons.firstMatch.tap()
        }
        let used = app.segmentedControls["redeemed.collection"].buttons["Used"]
        reach(used, in: app)
        used.tap()
        expectBefore(cloud, monorail)
    }

    func testNativeDraggingCanMoveACardToAnotherPage() {
        let app = launch()
        app.tabBars.buttons["Search"].tap()
        app.buttons["discover.saint-bread"].tap()
        let join = app.buttons["detail.join"]
        reach(join, in: app)
        join.tap()
        app.tabBars.buttons["Home"].tap()
        let saint = app.buttons["card.saint-bread"]
        let next = app.buttons["home.stack.next"]
        reach(next, in: app)
        saint.press(forDuration: 0.8, thenDragTo: next)
        XCTAssertEqual(app.staticTexts["home.stack.position"].value as? String, "2 of 2")
        XCTAssertTrue(saint.waitForExistence(timeout: 3))
        XCTAssertFalse(app.buttons["card.monorail-pike"].exists)
        saint.press(forDuration: 0.8, thenDragTo: app.buttons["home.stack.previous"])
        XCTAssertEqual(app.staticTexts["home.stack.position"].value as? String, "1 of 2")
        expectBefore(saint, app.buttons["card.monorail-pike"])
        reach(next, in: app)
        saint.press(forDuration: 0.8, thenDragTo: next)
        app.buttons["home.stack.previous"].tap()
        XCTAssertFalse(saint.exists)
        app.terminate()
        app.launchArguments = ["-ui-testing", "-skip-welcome"]
        app.launch()
        XCTAssertFalse(saint.exists)
        app.buttons["home.stack.next"].tap()
        XCTAssertTrue(saint.waitForExistence(timeout: 3))
    }

    func testHomeUsesOneExpandableStackWithoutLayoutModes() {
        let app = launch()
        XCTAssertFalse(app.buttons["Add a business"].exists)
        XCTAssertTrue(app.tabBars.buttons["Search"].isHittable)
        XCTAssertFalse(app.segmentedControls["home.layout"].exists)
        XCTAssertTrue(app.buttons["home.stack.expand"].exists)
        XCTAssertLessThan(app.buttons["card.monorail-pike"].frame.height, 280)
        capture("Home - collapsed stack", app: app)
        for id in places {
            let card = app.buttons["card.\(id)"]
            reach(card, in: app)
            expectCleanCard(id, card: card, in: app)
        }
        reach(app.buttons["home.stack.expand"], in: app)
        app.buttons["home.stack.expand"].tap()
        capture("Home - expanded stack", app: app)
        for tab in ["Home", "Search", "Redeemed", "You"] {
            XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label == %@", tab)).firstMatch.exists)
        }
        for id in places {
            let card = app.buttons["card.\(id)"]
            reach(card, in: app)
            expectCleanCard(id, card: card, in: app)
            XCTAssertTrue(card.isHittable)
            XCTAssertGreaterThan(card.frame.width, min(app.frame.width * 0.8, 650))
            XCTAssertGreaterThan(card.frame.height, 280)
            XCTAssertLessThan(card.frame.maxY, contentBottom(in: app))
        }
        XCTAssertFalse(app.staticTexts["Reward ready"].exists)
        XCTAssertFalse(app.staticTexts["6/6"].exists)
        let expand = app.buttons["home.stack.expand"]
        reach(expand, in: app)
        XCTAssertEqual(expand.value as? String, "Expanded")
        expand.tap()
        XCTAssertEqual(expand.value as? String, "Collapsed")
        XCTAssertLessThan(app.buttons["card.monorail-pike"].frame.height, 280)
    }

    func testHomeSearchIsOnDemandAndClosingRestoresTheStack() {
        let app = launch()
        XCTAssertEqual(app.buttons["home.collection"].label, "Your places")
        XCTAssertFalse(app.textFields["home.query"].exists)
        XCTAssertFalse(app.buttons["home.groups"].exists)
        XCTAssertFalse(app.buttons["Archived cards"].exists)
        XCTAssertLessThan(app.buttons["card.monorail-pike"].frame.minY, app.frame.height * 0.3)
        app.buttons["home.search"].tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 3))
        search("Monorail", field: "home.query", in: app)
        XCTAssertTrue(app.buttons["card.monorail-pike"].exists)
        XCTAssertFalse(app.buttons["card.cloud-city"].exists)
        capture("Home - intentional search", app: app)
        app.buttons["home.search"].tap()
        XCTAssertTrue(app.textFields["home.query"].waitForNonExistence(timeout: 3))
        XCTAssertFalse(app.keyboards.firstMatch.exists)
        XCTAssertTrue(app.buttons["card.cloud-city"].exists)
        app.buttons["home.search"].tap()
        XCTAssertEqual(app.textFields["home.query"].value as? String, "Find your places")
        app.buttons["home.search"].tap()
    }

    func testCardFirstHomeAndSelectionControlsInBothAppearances() throws {
        for mode in ["Light", "Dark"] {
            let app = launch()
            app.tabBars.buttons["You"].tap()
            app.buttons["settings.appearance"].tap()
            app.buttons[mode].tap()
            app.tabBars.buttons["Home"].tap()
            try audit(app)
            capture("Card-first Home - \(mode)", app: app)
            app.buttons["home.stack.expand"].tap()
            try audit(app)
            capture("Card-first expanded stack - \(mode)", app: app)
            reach(app.buttons["home.stack.select"], in: app)
            app.buttons["home.stack.select"].tap()
            app.buttons["card.monorail-pike"].tap()
            reach(app.buttons["home.stack.groups"], in: app)
            XCTAssertTrue(app.buttons["home.stack.favorite"].isHittable)
            try audit(app)
            capture("Collection selection actions - \(mode)", app: app)
            app.terminate()
        }
    }

    func testQueuedStampsWaitForClaimAndCompletedCardsAppearInMemories() {
        let app = launch()
        openCard("cloud-city", in: app)
        XCTAssertFalse(app.buttons["detail.queueStamp"].exists)
        app.buttons["Card options"].tap()
        let queue = app.buttons["detail.queueStamp"]
        queue.tap()
        expectProgress("6 of 6 stamps", in: app)
        XCTAssertEqual(app.staticTexts["detail.pendingStamps"].label, "1 stamp queued")
        app.terminate()
        app.launchArguments = ["-ui-testing", "-skip-welcome"]
        app.launch()
        openCard("cloud-city", in: app)
        let claim = app.buttons["detail.claim"]
        reach(claim, in: app)
        claim.tap()
        app.alerts.buttons["Claim reward"].tap()
        XCTAssertTrue(app.staticTexts["coupon.title"].waitForExistence(timeout: 3))
        app.buttons["Done"].tap()
        expectProgress("1 of 6 stamps", in: app)
        app.tabBars.buttons["Redeemed"].tap()
        app.buttons["redeemed.memories"].tap()
        app.buttons["memory.cloud-city.stack"].tap()
        expectProgress("6 of 6 stamps", in: app)
        XCTAssertEqual(app.staticTexts["coupon.title"].label, "Brewed coffee")
        XCTAssertFalse(app.staticTexts["memories.summary"].exists)
    }

    func testDiscoveryCardPersistsWithoutRewardStackingControls() {
        let app = launch()
        app.tabBars.buttons["Search"].tap()
        XCTAssertFalse(app.segmentedControls["search.layout"].exists)
        XCTAssertFalse(app.buttons["discovery.stack.expand"].exists)
        XCTAssertTrue(app.buttons["discover.saint-bread"].exists)
        let gloom = app.buttons["discover.gloom-coffee"]
        revealDiscovery("gloom-coffee", in: app)
        gloom.tap()
        let join = app.buttons["detail.join"]
        reach(join, in: app)
        join.tap()
        expectProgress("0 of 8 stamps", in: app)
        XCTAssertFalse(app.switches["detail.stackRewards"].exists)
        app.terminate()
        app.launchArguments = ["-ui-testing", "-skip-welcome"]
        app.launch()
        openCard("gloom-coffee", in: app)
        expectProgress("0 of 8 stamps", in: app)
        XCTAssertFalse(app.switches["detail.stackRewards"].exists)
        app.tabBars.buttons["Search"].tap()
        XCTAssertFalse(app.segmentedControls["search.layout"].exists)
    }

    func testWideEstablishmentKeepsArtworkAndPunchCardSeparate() throws {
        let app = launch()
        guard app.frame.width >= 900 else { throw XCTSkip("Requires a wide iPad simulator.") }
        openCard("monorail-pike", in: app)
        let heading = app.staticTexts["Monorail Espresso"]
        let progress = app.descendants(matching: .any).matching(identifier: "card.progress").firstMatch
        XCTAssertTrue(heading.waitForExistence(timeout: uiTimeout))
        XCTAssertGreaterThan(progress.frame.minX, heading.frame.maxX)
        XCTAssertLessThan(progress.frame.midY, heading.frame.minY)
        expectProgress("5 of 8 stamps", in: app)
        capture("Wide establishment - cover and punch card", app: app)
        try audit(app)
    }

    func testFullCardWaitsForClaimAndCancellationKeepsItFull() {
        let app = launch()
        openCard("cloud-city", in: app)
        expectProgress("6 of 6 stamps", in: app)
        XCTAssertFalse(app.buttons["detail.simulateVisit"].exists)
        capture("Cloud City - complete card", app: app)
        app.buttons["detail.claim"].tap()
        app.alerts.buttons["Cancel"].tap()
        expectProgress("6 of 6 stamps", in: app)
        app.terminate()
        app.launchArguments = ["-ui-testing", "-skip-welcome"]
        app.launch()
        openCard("cloud-city", in: app)
        expectProgress("6 of 6 stamps", in: app)
        app.buttons["detail.claim"].tap()
        app.alerts.buttons["Claim reward"].tap()
        XCTAssertTrue(app.staticTexts["coupon.title"].waitForExistence(timeout: uiTimeout))
        XCTAssertEqual(app.staticTexts["coupon.title"].label, "Brewed coffee")
        capture("Cloud City - claimed coupon", app: app)
        app.buttons["Done"].tap()
        expectProgress("0 of 6 stamps", in: app)
        XCTAssertFalse(app.buttons["detail.claim"].exists)
        XCTAssertTrue(app.buttons["detail.simulateVisit"].exists)
        app.tabBars.buttons["Redeemed"].tap()
        XCTAssertEqual(app.buttons.matching(NSPredicate(
            format: "identifier BEGINSWITH 'coupon.cloud-city.'"
        )).count, 1)
        app.buttons["coupon.cloud-city.stack"].tap()
        XCTAssertEqual(app.staticTexts["history.position"].value as? String, "1 of 2")
        expectProgress("6 of 6 stamps", in: app)
    }

    func testStampOnFullCardWaitsInQueueUntilClaim() {
        let app = launch()
        openCard("cloud-city", in: app)
        expectProgress("6 of 6 stamps", in: app)
        app.buttons["Card options"].tap()
        app.buttons["detail.queueStamp"].tap()
        expectProgress("6 of 6 stamps", in: app)
        XCTAssertEqual(app.staticTexts["detail.pendingStamps"].label, "1 stamp queued")
        XCTAssertFalse(app.staticTexts["coupon.title"].exists)
        app.buttons["detail.claim"].tap()
        app.alerts.buttons["Claim reward"].tap()
        XCTAssertTrue(app.staticTexts["coupon.title"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.staticTexts["coupon.title"].label, "Brewed coffee")
        app.buttons["Done"].tap()
        expectProgress("1 of 6 stamps", in: app)
        XCTAssertFalse(app.buttons["detail.claim"].exists)
        app.tabBars.buttons["Redeemed"].tap()
        XCTAssertEqual(app.buttons.matching(NSPredicate(
            format: "identifier BEGINSWITH 'coupon.cloud-city.'"
        )).count, 1)
        app.buttons["coupon.cloud-city.stack"].tap()
        XCTAssertEqual(app.staticTexts["history.position"].value as? String, "1 of 2")
    }

    func testCollectingFillsCardWithoutAutomaticCoupon() {
        let app = launch()
        openCard("monorail-pike", in: app)
        expectProgress("5 of 8 stamps", in: app)
        for _ in 0..<3 { app.buttons["detail.simulateVisit"].tap() }
        expectProgress("8 of 8 stamps", in: app)
        XCTAssertTrue(app.buttons["detail.claim"].exists)
        XCTAssertFalse(app.buttons["detail.simulateVisit"].exists)
        capture("Monorail - full punch card", app: app)
        app.tabBars.buttons["Redeemed"].tap()
        XCTAssertEqual(app.buttons.matching(NSPredicate(
            format: "identifier BEGINSWITH 'coupon.monorail-pike.'"
        )).count, 1)
    }

    func testRedeemedSamplesCanBeUsedOnceWithoutChangingStamps() {
        let app = launch()
        app.tabBars.buttons["Redeemed"].tap()
        for id in places {
            XCTAssertEqual(app.buttons.matching(NSPredicate(
                format: "identifier BEGINSWITH %@", "coupon.\(id)."
            )).count, 1)
        }
        capture("Redeemed - sample tickets", app: app)
        XCTAssertEqual(app.buttons["coupon.cloud-city.stack"].value as? String, "Available, 6 of 6 punches")
        app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'coupon.cloud-city.'")).firstMatch.tap()
        XCTAssertEqual(app.staticTexts["coupon.title"].label, "Brewed coffee")
        XCTAssertFalse(app.staticTexts["history.position"].exists)
        XCTAssertFalse(app.buttons["history.next"].exists)
        XCTAssertFalse(app.buttons["coupon.wallet"].exists)
        XCTAssertFalse(app.staticTexts["Demo coupon. Not valid in store."].exists)
        app.buttons["coupon.use"].tap()
        app.alerts.buttons["Cancel"].tap()
        XCTAssertEqual(app.staticTexts["coupon.status"].label, "AVAILABLE")
        app.buttons["coupon.use"].tap()
        app.alerts.buttons["Mark as used"].tap()
        let used = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "label == 'USED'"), object: app.staticTexts["coupon.status"]
        )
        XCTAssertEqual(XCTWaiter.wait(for: [used], timeout: uiTimeout), .completed)
        XCTAssertFalse(app.buttons["coupon.use"].exists)
        capture("Used - fully punched ticket", app: app)
        app.navigationBars.buttons["Back"].tap()
        app.segmentedControls["redeemed.collection"].buttons["Used"].tap()
        XCTAssertTrue(app.buttons["coupon.cloud-city.stack"].exists)
        capture("Used - ticket stack overview", app: app)
        let memories = app.buttons["redeemed.memories"]
        reach(memories, in: app)
        memories.tap()
        let usedMemory = app.buttons["memory.cloud-city.stack"]
        reach(usedMemory, in: app)
        usedMemory.tap()
        XCTAssertEqual(app.staticTexts["coupon.status"].label, "USED")
        XCTAssertFalse(app.buttons["coupon.use"].exists)
        app.navigationBars.buttons["Memories"].tap()
        app.buttons["Done"].tap()
        app.tabBars.buttons["Home"].tap()
        openCard("cloud-city", in: app)
        expectProgress("6 of 6 stamps", in: app)
    }

    func testSearchUsesBusinessNameAndExactClientIDNotLocation() {
        let app = launch()
        app.tabBars.buttons["Search"].tap()
        XCTAssertFalse(app.buttons["search.monorail-pike"].exists)
        let search = app.textFields["search.query"]
        search.tap()
        search.typeText("6a2e3d81-7b49-4f12-a0c3-819d62e00101")
        XCTAssertTrue(app.buttons["search.monorail-pike"].waitForExistence(timeout: uiTimeout))
        XCTAssertFalse(app.buttons["search.cloud-city"].exists)
        app.buttons["Clear search"].tap()
        search.tap()
        search.typeText("Kirkland")
        XCTAssertTrue(app.staticTexts["No matching business"].exists)
        XCTAssertFalse(app.staticTexts["Check the name or client ID."].exists)
        app.buttons["Clear search"].tap()
        search.tap()
        search.typeText("5 Stones")
        app.buttons["search.five-stones-kirkland"].tap()
        expectProgress("2 of 10 stamps", in: app)
        XCTAssertFalse(app.buttons["detail.wallet"].exists)
    }

    func testDiscoveryGalleryAddsACardWithoutChangingExistingCards() {
        let app = launch()
        XCTAssertFalse(app.buttons["card.gloom-coffee"].exists)
        app.tabBars.buttons["Search"].tap()
        let gallery = app.scrollViews["discovery.gallery"]
        XCTAssertTrue(gallery.waitForExistence(timeout: uiTimeout))
        XCTAssertFalse(app.buttons["discovery.stack.expand"].exists)
        XCTAssertTrue(app.buttons["discover.saint-bread"].isHittable)
        XCTAssertGreaterThan(app.buttons["discover.saint-bread"].frame.height, 330)
        XCTAssertGreaterThan(app.buttons["discover.saint-bread"].frame.width, app.frame.width * 0.7)
        XCTAssertGreaterThan(app.buttons["discover.book-larder"].frame.minX,
                             app.buttons["discover.saint-bread"].frame.minX)
        XCTAssertLessThan(app.buttons["discover.book-larder"].frame.minX, app.frame.maxX)
        capture("Discovery - swipeable preview gallery", app: app)
        let gloom = app.buttons["discover.gloom-coffee"]
        revealDiscovery("gloom-coffee", in: app)
        XCTAssertTrue(gloom.isHittable)
        capture("Discoverable - Gloom Coffee", app: app)
        gloom.tap()
        expectProgress("0 of 8 stamps", in: app)
        let join = app.buttons["detail.join"]
        reach(join, in: app)
        join.tap()
        app.buttons["detail.simulateVisit"].tap()
        expectProgress("1 of 8 stamps", in: app)
        app.tabBars.buttons["Home"].tap()
        openCard("gloom-coffee", in: app)
        expectProgress("1 of 8 stamps", in: app)
        app.navigationBars.buttons["Back"].tap()
        openCard("monorail-pike", in: app)
        expectProgress("5 of 8 stamps", in: app)
        app.terminate()
        app.launchArguments = ["-ui-testing", "-skip-welcome"]
        app.launch()
        openCard("gloom-coffee", in: app)
        expectProgress("1 of 8 stamps", in: app)
    }

    func testDiscoveryStackSupportsDarkModeAndLargestTextWithReducedMotion() {
        for mode in ["Dark", "Light"] {
            let extra = mode == "Light" ? [
                "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL",
                "-reduce-motion"
            ] : []
            let app = launch(extra: extra)
            app.tabBars.buttons["You"].tap()
            app.buttons["settings.appearance"].tap()
            app.buttons[mode].tap()
            app.tabBars.buttons["Search"].tap()
            XCTAssertTrue(app.buttons["discover.saint-bread"].waitForExistence(timeout: uiTimeout))
            for id in ["saint-bread", "book-larder", "gloom-coffee"] {
                let poster = app.buttons["discover.\(id)"]
                revealDiscovery(id, in: app)
                XCTAssertGreaterThan(poster.frame.width, app.frame.width * 0.7)
                capture("Discovery gallery - \(id) - \(mode)", app: app)
            }
            app.buttons["discover.gloom-coffee"].tap()
            expectProgress("0 of 8 stamps", in: app)
            let join = app.buttons["detail.join"]
            reach(join, in: app)
            XCTAssertTrue(join.isHittable)
            app.terminate()
        }
    }

    func testSharedStacksFitLargestTextWithReducedMotion() throws {
        let app = launch(extra: [
            "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL",
            "-reduce-motion"
        ])
        XCTAssertFalse(app.segmentedControls["home.layout"].exists)
        XCTAssertFalse(app.buttons["home.stack.expand"].exists)
        let card = app.buttons["card.monorail-pike"]
        XCTAssertTrue(card.exists)
        XCTAssertLessThanOrEqual(card.frame.maxX, app.frame.maxX)
        XCTAssertGreaterThanOrEqual(card.frame.minX, app.frame.minX)
        reach(card, in: app)
        expectCleanCard("monorail-pike", card: card, in: app)
        capture("Home stack - largest text and Reduce Motion", app: app)
        try app.performAccessibilityAudit(for: [.textClipped])
        reach(app.buttons["home.stack.select"], in: app)
        app.buttons["home.stack.select"].tap()
        reach(card, in: app)
        card.tap()
        reach(app.buttons["home.stack.groups"], in: app)
        capture("Collection selection - largest text", app: app)
        try audit(app)
        app.tabBars.buttons["Search"].tap()
        XCTAssertFalse(app.segmentedControls["search.layout"].exists)
        XCTAssertFalse(app.buttons["discovery.stack.expand"].exists)
        let poster = app.buttons["discover.saint-bread"]
        XCTAssertTrue(poster.exists)
        XCTAssertLessThanOrEqual(poster.frame.maxX, app.frame.maxX)
        XCTAssertGreaterThanOrEqual(poster.frame.minX, app.frame.minX)
        reach(poster, in: app)
        capture("Discovery stack - largest text and Reduce Motion", app: app)
        try app.performAccessibilityAudit(for: [.textClipped])
    }

    func testPlaceDetailsRetainSourcesClientIDAndCollapsedActivity() {
        let app = launch()
        openCard("monorail-pike", in: app)
        XCTAssertFalse(app.buttons["See all activity"].exists)
        app.buttons["Place details"].tap()
        let identifier = app.staticTexts["detail.clientID"]
        reach(identifier, in: app)
        XCTAssertEqual(identifier.label, "6A2E3D81-7B49-4F12-A0C3-819D62E00101")
        XCTAssertTrue(app.buttons["Copy client ID"].exists)
        XCTAssertTrue(app.buttons["Business website"].exists)
        let disclosure = app.buttons["Activity"]
        reach(disclosure, in: app)
        disclosure.tap()
        let activity = app.buttons["See all activity"]
        reach(activity, in: app)
        activity.tap()
        let joined = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label BEGINSWITH %@", "Program joined")).firstMatch
        XCTAssertTrue(joined.waitForExistence(timeout: uiTimeout))
    }

    func testStreamlinedDetailsAndImplicitStacking() throws {
        let app = launch()
        for mode in ["Light", "Dark"] {
            app.tabBars.buttons["You"].tap()
            app.buttons["settings.appearance"].tap()
            app.buttons[mode].tap()
            let disclosure = app.staticTexts["settings.demoDisclosure"]
            reach(disclosure, in: app)
            XCTAssertTrue(disclosure.label.contains("not valid in store"))
            app.tabBars.buttons["Home"].tap()
            openCard("cloud-city", in: app)
            XCTAssertFalse(app.switches["detail.stackRewards"].exists)
            XCTAssertFalse(app.buttons["detail.wallet"].exists)
            XCTAssertFalse(app.buttons["detail.showCard"].exists)
            XCTAssertFalse(app.buttons["detail.queueStamp"].exists)
            XCTAssertFalse(app.buttons["See all activity"].exists)
            XCTAssertFalse(app.staticTexts["Demo program. Not a real offer."].exists)
            let claim = app.buttons["detail.claim"]
            reach(claim, in: app)
            capture("Streamlined card - \(mode)", app: app)
            try app.performAccessibilityAudit(for: [.textClipped])
            claim.tap()
            app.alerts.buttons["Claim reward"].tap()
            XCTAssertTrue(app.staticTexts["coupon.title"].waitForExistence(timeout: 3))
            XCTAssertFalse(app.buttons["coupon.wallet"].exists)
            capture("Streamlined reward ticket - \(mode)", app: app)
            try app.performAccessibilityAudit(for: [.textClipped])
            app.buttons["Done"].tap()
            expectProgress("0 of 6 stamps", in: app)
            XCTAssertEqual(app.staticTexts["detail.availableRewards"].label,
                           "\(mode == "Light" ? 2 : 3) available rewards in Redeemed")
            for _ in 0..<6 { app.buttons["detail.simulateVisit"].tap() }
            app.navigationBars.buttons["Back"].tap()
        }
        app.terminate()
        app.launchArguments = ["-ui-testing", "-skip-welcome"]
        app.launch()
        openCard("cloud-city", in: app)
        expectProgress("6 of 6 stamps", in: app)
        XCTAssertEqual(app.staticTexts["detail.availableRewards"].label, "3 available rewards in Redeemed")
    }

    func testFreshInstallChoosesCustomerAndRemembersCompletion() {
        let app = launch(welcome: true)
        XCTAssertFalse(app.staticTexts["Stamp cards"].exists)
        XCTAssertTrue(app.buttons["setup.customer"].isHittable)
        XCTAssertTrue(app.buttons["setup.business"].isHittable)
        XCTAssertFalse(app.buttons["setup.close"].exists)
        capture("Setup - Customer and Business", app: app)
        app.buttons["setup.customer"].tap()
        XCTAssertTrue(app.buttons["home.collection"].waitForExistence(timeout: uiTimeout))
        app.terminate()
        app.launchArguments = ["-ui-testing"]
        app.launch()
        XCTAssertTrue(app.buttons["home.collection"].waitForExistence(timeout: uiTimeout))
        XCTAssertFalse(app.buttons["setup.customer"].exists)
    }

    func testBusinessChoiceOpensBusinessSideAndIsRemembered() {
        let app = launch(welcome: true)
        app.buttons["setup.business"].tap()
        XCTAssertTrue(app.staticTexts["heading.businessWelcome"].waitForExistence(timeout: uiTimeout))
        capture("Setup - Business destination", app: app)
        app.terminate()
        app.launchArguments = ["-ui-testing"]
        app.launch()
        XCTAssertTrue(app.staticTexts["heading.businessWelcome"].waitForExistence(timeout: uiTimeout))
        app.buttons["business.switch"].tap()
        XCTAssertTrue(app.buttons["setup.customer"].waitForExistence(timeout: uiTimeout))
        app.buttons["setup.customer"].tap()
        XCTAssertTrue(app.buttons["home.collection"].waitForExistence(timeout: uiTimeout))
        app.terminate()
        app.launchArguments = ["-ui-testing"]
        app.launch()
        XCTAssertTrue(app.buttons["home.collection"].waitForExistence(timeout: uiTimeout))
    }

    func testSetupSupportsLargestTextAndReduceMotion() {
        let app = launch(welcome: true, extra: [
            "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL",
            "-reduce-motion"
        ])
        let business = app.buttons["setup.business"]
        for _ in 0..<6 where !business.isHittable { app.swipeUp() }
        XCTAssertTrue(business.isHittable)
        capture("Setup - largest text and Reduce Motion", app: app)
        business.tap()
        XCTAssertTrue(app.staticTexts["heading.businessWelcome"].waitForExistence(timeout: uiTimeout))
        let switchSide = app.buttons["business.switch"]
        for _ in 0..<6 where !switchSide.isHittable { app.swipeDown() }
        switchSide.tap()
        let customer = app.buttons["setup.customer"]
        XCTAssertTrue(customer.waitForExistence(timeout: uiTimeout))
        for _ in 0..<6 where !customer.isHittable { app.swipeDown() }
        XCTAssertTrue(customer.isHittable)
        customer.tap()
        XCTAssertTrue(app.buttons["home.collection"].waitForExistence(timeout: uiTimeout))
    }

    func testSetupAndSettingsContrastInLightAndDark() throws {
        let app = launch()
        for mode in ["Light", "Dark"] {
            app.tabBars.buttons["You"].tap()
            app.buttons["settings.appearance"].tap()
            app.buttons[mode].tap()
            let setup = app.buttons["settings.setup"]
            try XCTContext.runActivity(named: "Settings fully visible - \(mode)") { _ in
                reach(setup, in: app)
                capture("You - \(mode)", app: app)
                try audit(app)
            }
            setup.tap()
            XCTAssertTrue(app.buttons["setup.customer"].waitForExistence(timeout: uiTimeout))
            try audit(app)
            capture("Role landing - \(mode)", app: app)
            app.buttons["setup.business"].tap()
            XCTAssertTrue(app.staticTexts["heading.businessWelcome"].waitForExistence(timeout: uiTimeout))
            // Business dismisses the setup cover; audit once it has finished sliding away.
            XCTAssertTrue(app.buttons["setup.customer"].waitForNonExistence(timeout: uiTimeout))
            try audit(app)
            capture("Business welcome - \(mode)", app: app)
            app.buttons["business.switch"].tap()
            XCTAssertTrue(app.buttons["setup.close"].waitForExistence(timeout: uiTimeout))
            app.buttons["setup.customer"].tap()
            XCTAssertTrue(app.buttons["home.collection"].waitForExistence(timeout: uiTimeout))
        }
    }

    func testAppearanceAndAccentPersistWithoutProfileScaffolding() {
        let app = launch()
        app.tabBars.buttons["You"].tap()
        XCTAssertFalse(app.staticTexts["Local profile"].exists)
        XCTAssertFalse(app.staticTexts["No sign-in"].exists)
        app.buttons["settings.appearance"].tap()
        app.buttons["Dark"].tap()
        app.buttons["settings.accent.Purple"].tap()
        app.terminate()
        app.launchArguments = ["-ui-testing", "-skip-welcome"]
        app.launch()
        app.tabBars.buttons["You"].tap()
        XCTAssertTrue(app.buttons["settings.appearance"].label.contains("Dark"))
        XCTAssertTrue(app.buttons["settings.accent.Purple"].isSelected)
        app.tabBars.buttons["Home"].tap()
        capture("Home - dark purple", app: app)
    }

    func testYouKeepsOnlyPreferencesAndSetup() {
        let app = launch()
        app.tabBars.buttons["You"].tap()
        XCTAssertTrue(app.buttons["settings.appearance"].exists)
        XCTAssertTrue(app.switches["Reward reminders"].exists)
        XCTAssertTrue(app.switches["News & offers"].exists)
        XCTAssertTrue(app.staticTexts["Notifications aren't connected yet."].exists)
        XCTAssertFalse(app.staticTexts["Saved on this device. Notifications aren't connected yet."].exists)
        XCTAssertFalse(app.buttons["Data & privacy"].exists)
        XCTAssertFalse(app.buttons["For businesses"].exists)
        XCTAssertFalse(app.buttons["profile.delete"].exists)
        XCTAssertFalse(app.buttons["profile.reset"].exists)
        XCTAssertFalse(app.staticTexts["Prototype"].exists)
        let setup = app.buttons["settings.setup"]
        reach(setup, in: app)
        capture("You - appearance, notifications and setup", app: app)
        setup.tap()
        XCTAssertTrue(app.buttons["setup.customer"].waitForExistence(timeout: uiTimeout))
        app.buttons["setup.business"].tap()
        XCTAssertTrue(app.staticTexts["heading.businessWelcome"].waitForExistence(timeout: uiTimeout))
        app.buttons["business.switch"].tap()
        XCTAssertTrue(app.buttons["setup.customer"].waitForExistence(timeout: uiTimeout))
        app.buttons["setup.customer"].tap()
        XCTAssertTrue(app.buttons["home.collection"].waitForExistence(timeout: uiTimeout))
    }

    func testMemoriesKeepUnfinishedPunchesAfterReturningToHome() {
        let app = launch()
        openCard("monorail-pike", in: app)
        app.buttons["Card options"].tap()
        app.buttons["Move to Memories"].tap()
        app.buttons["Move to Memories"].tap()
        app.buttons["home.collection"].tap()
        app.buttons["home.memories"].tap()
        XCTAssertEqual(app.buttons["memory.monorail-pike.stack"].value as? String, "Saved, 5 of 8 punches")
        app.buttons["memory.monorail-pike.stack"].tap()
        expectProgress("5 of 8 stamps", in: app)
        capture("Memories - unfinished snapshot", app: app)
        app.buttons["memory.restore"].tap()
        XCTAssertTrue(app.buttons["memory.restore"].waitForNonExistence(timeout: 3))
        expectProgress("5 of 8 stamps", in: app)
        app.navigationBars.buttons["Memories"].tap()
        XCTAssertTrue(app.buttons["memory.monorail-pike.stack"].exists)
        app.buttons["Done"].tap()
        XCTAssertTrue(app.buttons["card.monorail-pike"].exists)
    }

    func testRepeatedRewardCardsStayInOneSearchableStackAndUseIndependently() {
        let app = launch(extra: ["-many-rewards"])
        app.tabBars.buttons["Redeemed"].tap()
        XCTAssertEqual(app.buttons.matching(NSPredicate(
            format: "identifier BEGINSWITH 'coupon.cloud-city.'"
        )).count, 1)
        search("Cloud", field: "coupon.query", in: app)
        XCTAssertFalse(app.buttons["coupon.monorail-pike.stack"].exists)
        app.buttons["coupon.cloud-city.stack"].tap()
        expectProgress("6 of 6 stamps", in: app)
        XCTAssertEqual(app.staticTexts["history.position"].value as? String, "1 of 13")
        app.buttons["history.next"].tap()
        XCTAssertEqual(app.staticTexts["history.position"].value as? String, "2 of 13")
        app.buttons["coupon.use"].tap()
        app.alerts.buttons["Mark as used"].tap()
        XCTAssertTrue(app.buttons["coupon.use"].waitForNonExistence(timeout: 3))
        expectProgress("6 of 6 stamps", in: app)
        app.buttons["history.next"].tap()
        XCTAssertEqual(app.staticTexts["coupon.status"].label, "AVAILABLE")
        expectProgress("6 of 6 stamps", in: app)
        capture("Redeemed - repeated cards, one at a time", app: app)
        app.navigationBars.buttons["Back"].tap()
        app.segmentedControls["redeemed.collection"].buttons["Used"].tap()
        app.buttons["coupon.cloud-city.stack"].tap()
        XCTAssertEqual(app.staticTexts["coupon.status"].label, "USED")
        expectProgress("6 of 6 stamps", in: app)
        app.navigationBars.buttons["Back"].tap()
        app.buttons["redeemed.memories"].tap()
        search("Cloud", field: "memory.query", in: app)
        app.buttons["memory.cloud-city.stack"].tap()
        XCTAssertEqual(app.staticTexts["history.position"].value as? String, "1 of 13")
        capture("Memories - completed card stack", app: app)
    }

    func testReplayingSetupPreservesCardsCouponsAndPreferences() {
        let app = launch()
        toggleFavorite("monorail-pike", in: app)
        app.buttons["home.collection"].tap()
        app.buttons["Favorites"].tap()
        openCard("monorail-pike", in: app)
        app.buttons["detail.simulateVisit"].tap()
        app.tabBars.buttons["You"].tap()
        let reminders = app.switches["Reward reminders"]
        reminders.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)).tap()
        XCTAssertEqual(reminders.value as? String, "1")
        let setup = app.buttons["settings.setup"]
        reach(setup, in: app)
        setup.tap()
        app.buttons["setup.customer"].tap()
        XCTAssertTrue(app.buttons["home.collection"].waitForExistence(timeout: uiTimeout))
        XCTAssertTrue(app.tabBars.buttons["Home"].isSelected)
        XCTAssertEqual(app.buttons["home.collection"].label, "Your places")
        XCTAssertFalse(app.buttons["detail.simulateVisit"].exists)
        app.tabBars.buttons["You"].tap()
        XCTAssertEqual(app.switches["Reward reminders"].value as? String, "1")
        app.tabBars.buttons["Redeemed"].tap()
        XCTAssertEqual(app.buttons.matching(NSPredicate(
            format: "identifier BEGINSWITH 'coupon.'"
        )).count, 3)
        app.tabBars.buttons["Home"].tap()
        XCTAssertTrue((app.buttons["card.monorail-pike"].value as? String)?.contains("Favorite") == true)
        openCard("monorail-pike", in: app)
        expectProgress("6 of 8 stamps", in: app)
    }

    func testHistoricalCardStacksFitLargestTextWithReducedMotion() throws {
        let app = launch(extra: [
            "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL",
            "-reduce-motion", "-many-rewards"
        ])
        app.tabBars.buttons["Redeemed"].tap()
        search("Cloud", field: "coupon.query", in: app)
        let stack = app.buttons["coupon.cloud-city.stack"]
        reach(stack, in: app)
        XCTAssertTrue(stack.label.contains("13 cards"))
        capture("Reward stack cover - largest text", app: app)
        try audit(app)
        stack.tap()
        XCTAssertEqual(app.staticTexts["history.position"].label, "Page")
        XCTAssertEqual(app.staticTexts["history.position"].value as? String, "1 of 13")
        XCTAssertTrue(app.buttons["history.next"].isHittable)
        app.buttons["history.next"].tap()
        XCTAssertEqual(app.staticTexts["history.position"].value as? String, "2 of 13")
        capture("Historical card pager - largest text", app: app)
        try audit(app)
    }

    func testCardsAndCouponsContrastAndTextClippingInLightAndDark() throws {
        for mode in ["Light", "Dark"] {
            let app = launch()
            app.tabBars.buttons["You"].tap()
            app.buttons["settings.appearance"].tap()
            app.buttons[mode].tap()
            settle(1.5)
            app.tabBars.buttons["Home"].tap()
            let heading = app.buttons["home.collection"]
            XCTAssertTrue(heading.waitForExistence(timeout: uiTimeout))
            for _ in 0..<6 where !heading.isHittable { app.swipeDown() }
            try audit(app)
            capture("Home - \(mode)", app: app)
            for id in places {
                openCard(id, in: app)
                XCTAssertTrue(app.descendants(matching: .any)["detail.cover"].waitForExistence(timeout: uiTimeout))
                try audit(app)
                capture("\(id) - \(mode)", app: app)
                app.navigationBars.buttons["Back"].tap()
                XCTAssertTrue(app.descendants(matching: .any)["detail.cover"].waitForNonExistence(timeout: uiTimeout))
            }
            app.tabBars.buttons["Redeemed"].tap()
            try audit(app)
            for id in places {
                let coupon = app.buttons.matching(NSPredicate(
                    format: "identifier BEGINSWITH %@", "coupon.\(id)."
                )).firstMatch
                XCTAssertTrue(coupon.waitForExistence(timeout: uiTimeout))
                coupon.tap()
                XCTAssertTrue(app.staticTexts["coupon.title"].waitForExistence(timeout: uiTimeout))
                try audit(app)
                capture("\(id) coupon - \(mode)", app: app)
                app.navigationBars.buttons["Back"].tap()
                XCTAssertTrue(app.staticTexts["coupon.title"].waitForNonExistence(timeout: uiTimeout))
            }
            app.terminate()
        }
    }

    func testLargestTextSizeCanClaimAndUseCoupon() throws {
        let app = launch(extra: [
            "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"
        ])
        let card = app.buttons["card.cloud-city"]
        reach(card, in: app)
        card.tap()
        let claim = app.buttons["detail.claim"]
        reach(claim, in: app)
        capture("Cloud City - largest text", app: app)
        claim.tap()
        app.alerts.buttons["Claim reward"].tap()
        XCTAssertTrue(app.staticTexts["coupon.title"].waitForExistence(timeout: uiTimeout))
        let use = app.buttons["coupon.use"]
        reach(use, in: app)
        capture("Coupon - largest text", app: app)
        use.tap()
        XCTAssertTrue(app.alerts.buttons["Mark as used"].waitForExistence(timeout: uiTimeout))
        app.alerts.buttons["Cancel"].tap()
        app.buttons["Done"].tap()
        expectProgress("0 of 6 stamps", in: app)
        let progress = app.descendants(matching: .any).matching(identifier: "card.progress").firstMatch
        reach(progress, in: app)
        capture("Cloud City - unpunched card at largest text", app: app)
        try app.performAccessibilityAudit(for: [.textClipped])
    }

    func testReduceMotionCanCollectAndClaim() {
        let app = launch(extra: ["-reduce-motion"])
        openCard("monorail-pike", in: app)
        for _ in 0..<3 { app.buttons["detail.simulateVisit"].tap() }
        expectProgress("8 of 8 stamps", in: app)
        app.buttons["detail.claim"].tap()
        app.alerts.buttons["Claim reward"].tap()
        XCTAssertTrue(app.staticTexts["coupon.title"].waitForExistence(timeout: uiTimeout))
        XCTAssertEqual(app.staticTexts["coupon.title"].label, "Espresso")
    }

    func testFavoritesIncludeUnfinishedCardsAndPersistAcrossRelaunch() {
        let app = launch()
        toggleFavorite("monorail-pike", in: app)
        app.buttons["home.collection"].tap()
        app.buttons["Favorites"].tap()
        XCTAssertTrue(app.buttons["card.monorail-pike"].exists)
        XCTAssertFalse(app.buttons["card.cloud-city"].exists)
        openCard("monorail-pike", in: app)
        expectProgress("5 of 8 stamps", in: app)
        app.terminate()
        app.launchArguments = ["-ui-testing", "-skip-welcome"]
        app.launch()
        XCTAssertTrue((app.buttons["card.monorail-pike"].value as? String)?.contains("Favorite") == true)
        app.buttons["home.collection"].tap()
        app.buttons["Favorites"].tap()
        toggleFavorite("monorail-pike", in: app)
        XCTAssertTrue(app.staticTexts["No favorites"].exists)
        XCTAssertFalse(app.staticTexts["Save a place with its star. Unfinished cards can be favorites too."].exists)
    }

    func testGroupsCanCollectUnfinishedAndFullCardsRenameAndDelete() {
        let app = launch()
        toggleFavorite("monorail-pike", in: app)
        manageGroups(in: app)
        app.buttons["group.create"].tap()
        app.textFields["group.name"].tap()
        app.textFields["group.name"].typeText("Weekends")
        for id in ["monorail-pike", "cloud-city"] {
            toggle("group.place.\(id)", in: app)
            XCTAssertEqual(app.buttons["group.place.\(id)"].value as? String, "Selected")
        }
        app.buttons["group.save"].tap()
        XCTAssertTrue(app.buttons["group.edit.Weekends"].waitForExistence(timeout: uiTimeout))
        app.buttons["Done"].tap()
        app.buttons["home.collection"].tap()
        app.buttons["All groups"].tap()
        let stack = app.descendants(matching: .any)["home.group.Weekends"].firstMatch
        reach(stack, in: app)
        let expand = app.buttons.matching(NSPredicate(
            format: "identifier BEGINSWITH 'group.stack.' AND identifier ENDSWITH '.expand'"
        )).firstMatch
        expand.tap()
        let groupedCard = app.buttons.matching(NSPredicate(
            format: "identifier BEGINSWITH 'group.card.' AND identifier ENDSWITH '.cloud-city'"
        )).firstMatch
        reach(groupedCard, in: app)
        groupedCard.tap()
        expectProgress("6 of 6 stamps", in: app)
        app.navigationBars.buttons["Back"].tap()
        for _ in 0..<6 where !app.buttons["home.collection"].isHittable { app.swipeDown() }
        XCTAssertTrue(app.buttons.matching(NSPredicate(
            format: "identifier BEGINSWITH 'group.card.' AND identifier ENDSWITH '.monorail-pike'"
        )).firstMatch.exists)
        XCTAssertTrue(groupedCard.exists)
        XCTAssertFalse(app.buttons["card.five-stones-kirkland"].exists)
        capture("Group - unfinished and completed cards", app: app)
        manageGroups(in: app)
        app.buttons["group.edit.Weekends"].tap()
        let name = app.textFields["group.name"]
        name.tap()
        name.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 8) + "Saturday")
        app.buttons["group.save"].tap()
        let group = app.buttons["group.edit.Saturday"]
        XCTAssertTrue(group.waitForExistence(timeout: uiTimeout))
        group.tap()
        app.buttons["group.delete"].tap()
        app.alerts.buttons["group.cancelDelete"].firstMatch.tap()
        XCTAssertEqual(app.textFields["group.name"].value as? String, "Saturday")
        app.buttons["group.delete"].tap()
        app.alerts.buttons["group.confirmDelete"].firstMatch.tap()
        XCTAssertFalse(app.buttons["group.edit.Saturday"].exists)
        app.buttons["Done"].tap()
        XCTAssertEqual(app.buttons["home.collection"].label, "Your places")
        XCTAssertTrue(app.buttons["card.monorail-pike"].exists)
        XCTAssertTrue(app.buttons["card.five-stones-kirkland"].exists)
        XCTAssertTrue((app.buttons["card.monorail-pike"].value as? String)?.contains("Favorite") == true)
        openCard("monorail-pike", in: app)
        expectProgress("5 of 8 stamps", in: app)
        app.tabBars.buttons["Redeemed"].tap()
        XCTAssertEqual(app.buttons.matching(NSPredicate(
            format: "identifier BEGINSWITH 'coupon.'"
        )).count, 3)
    }

    func testGroupCanBeDeletedFromItsEditor() {
        let app = launch()
        manageGroups(in: app)
        app.buttons["group.create"].tap()
        app.textFields["group.name"].tap()
        app.textFields["group.name"].typeText("Nearby")
        app.buttons["group.save"].tap()
        XCTAssertTrue(app.buttons["group.edit.Nearby"].waitForExistence(timeout: uiTimeout))
        app.buttons["group.edit.Nearby"].tap()
        app.buttons["group.delete"].tap()
        app.alerts.buttons["group.cancelDelete"].firstMatch.tap()
        XCTAssertEqual(app.textFields["group.name"].value as? String, "Nearby")
        app.buttons["group.delete"].tap()
        app.alerts.buttons["group.confirmDelete"].firstMatch.tap()
        XCTAssertTrue(app.staticTexts["No groups"].waitForExistence(timeout: uiTimeout))
        app.buttons["Done"].tap()
        XCTAssertTrue(app.buttons["card.monorail-pike"].exists)
    }

    func testGroupSearchPreservesHiddenSelectionCancellationAndRelaunch() {
        let app = launch(extra: ["-many-groups"])
        app.buttons["home.stack.select"].tap()
        app.buttons["card.monorail-pike"].tap()
        reach(app.buttons["home.stack.groups"], in: app)
        app.buttons["home.stack.groups"].tap()
        XCTAssertEqual(app.buttons.matching(NSPredicate(
            format: "identifier BEGINSWITH 'group.membership.'"
        )).count, 6)
        XCTAssertTrue(app.buttons["membership.next"].exists)
        search("064", field: "membership.query", in: app)
        XCTAssertFalse(app.buttons["group.membership.Collection 001"].exists)
        XCTAssertTrue(app.buttons["group.membership.Collection 064"].isHittable)
        toggle("group.membership.Collection 064", in: app)
        XCTAssertEqual(app.buttons["group.membership.Collection 064"].value as? String, "Selected")
        app.buttons["membership.query.clear"].tap()
        app.segmentedControls["membership.selectedOnly"].buttons["Added"].tap()
        XCTAssertTrue(app.buttons["group.membership.Collection 064"].exists)
        XCTAssertFalse(app.buttons["group.membership.Collection 001"].exists)
        capture("Group assignment - selected from 64 groups", app: app)
        app.buttons["Done"].tap()
        app.terminate()
        app.launchArguments = ["-ui-testing", "-skip-welcome"]
        app.launch()
        manageGroups(in: app)
        search("064", field: "groups.query", in: app)
        app.buttons["group.edit.Collection 064"].tap()
        search("Cloud", field: "group.query", in: app)
        toggle("group.place.cloud-city", in: app)
        search("Monorail", field: "group.query", in: app)
        XCTAssertEqual(app.buttons["group.place.monorail-pike"].value as? String, "Selected")
        app.buttons["group.query.clear"].tap()
        XCTAssertTrue(app.buttons["group.place.cloud-city"].exists)
        XCTAssertTrue(app.buttons["group.place.monorail-pike"].exists)
        XCTAssertEqual(app.buttons["group.place.five-stones-kirkland"].value as? String, "Not selected")
        capture("Group editor - review hidden selections", app: app)
        app.buttons["Cancel"].tap()
        app.buttons["group.edit.Collection 064"].tap()
        search("Cloud", field: "group.query", in: app)
        XCTAssertEqual(app.buttons["group.place.cloud-city"].value as? String, "Not selected")
        toggle("group.place.cloud-city", in: app)
        app.buttons["group.save"].tap()
        app.buttons["Done"].tap()
        app.terminate()
        app.launchArguments = ["-ui-testing", "-skip-welcome"]
        app.launch()
        app.buttons["home.collection"].tap()
        app.buttons["All groups"].tap()
        search("064", field: "home.query", in: app)
        XCTAssertTrue(app.staticTexts["home.group.Collection 064"].exists)
        XCTAssertFalse(app.staticTexts["home.group.Collection 001"].exists)
        let expand = app.buttons.matching(NSPredicate(
            format: "identifier BEGINSWITH 'group.stack.' AND identifier ENDSWITH '.expand'"
        )).firstMatch
        reach(expand, in: app)
        expand.tap()
        let card = app.buttons.matching(NSPredicate(
            format: "identifier BEGINSWITH 'group.card.' AND identifier ENDSWITH '.cloud-city'"
        )).firstMatch
        reach(card, in: app)
        expectCleanCard("cloud-city", card: card, in: app)
        XCTAssertGreaterThan(card.frame.height, 280)
        capture("Group - shared expanded stack", app: app)
        card.tap()
        expectProgress("6 of 6 stamps", in: app)
        app.navigationBars.buttons["Back"].tap()
        reach(app.buttons["home.collection"], in: app)
        app.buttons["home.collection"].tap()
        app.buttons["home.chooseGroup"].tap()
        search("064", field: "groups.query", in: app)
        app.buttons["group.choose.Collection 064"].tap()
        XCTAssertEqual(app.buttons["home.collection"].label, "Collection 064")
        XCTAssertTrue(app.buttons["card.cloud-city"].exists)
        XCTAssertTrue(app.buttons["card.monorail-pike"].exists)
        XCTAssertFalse(app.buttons["card.five-stones-kirkland"].exists)
    }

    func testCollectionSelectionAssignsSeveralCardsWithoutPerCardMenus() {
        let app = launch()
        app.buttons["home.stack.select"].tap()
        app.buttons["card.monorail-pike"].tap()
        app.buttons["card.cloud-city"].tap()
        reach(app.buttons["home.stack.groups"], in: app)
        XCTAssertEqual(app.staticTexts["home.stack.selectedCount"].label, "2 selected")
        capture("Home - shared selection actions", app: app)
        app.buttons["home.stack.groups"].tap()
        app.buttons["New group"].tap()
        for id in ["monorail-pike", "cloud-city"] {
            XCTAssertEqual(app.buttons["group.place.\(id)"].value as? String, "Selected")
        }
        app.textFields["group.name"].tap()
        app.textFields["group.name"].typeText("Coffee")
        app.buttons["group.save"].tap()
        XCTAssertEqual(app.buttons["group.membership.Coffee"].value as? String, "Selected")
        app.buttons["Done"].tap()
        XCTAssertTrue(app.buttons["home.stack.groups"].waitForNonExistence(timeout: 3))
        expectCleanCard("monorail-pike", card: app.buttons["card.monorail-pike"], in: app)
    }

    func testGroupSearchAndEditorRemainInsetAtLargestTextSize() throws {
        let app = launch(extra: [
            "-many-groups", "-UIPreferredContentSizeCategoryName",
            "UICTContentSizeCategoryAccessibilityXXXL"
        ])
        manageGroups(in: app)
        let query = app.textFields["groups.query"]
        XCTAssertGreaterThan(query.frame.minX, app.frame.minX + 16)
        XCTAssertLessThan(query.frame.maxX, app.frame.maxX - 16)
        search("064", field: "groups.query", in: app)
        try audit(app)
        capture("Group search - largest text", app: app)
        app.buttons["group.edit.Collection 064"].tap()
        let placeQuery = app.textFields["group.query"]
        XCTAssertGreaterThan(placeQuery.frame.minX, app.frame.minX + 16)
        XCTAssertLessThan(placeQuery.frame.maxX, app.frame.maxX - 16)
        try audit(app)
        capture("Group editor - largest text", app: app)
    }

    func testNamedGroupEditingKeepsRowsAndRenderedMembershipInSync() {
        let app = launch()
        manageGroups(in: app)
        app.buttons["group.create"].tap()
        app.textFields["group.name"].tap()
        app.textFields["group.name"].typeText("Coffee")
        for id in ["monorail-pike", "cloud-city"] {
            app.buttons["group.place.\(id)"].tap()
        }
        app.buttons["group.save"].tap()
        app.buttons["Done"].tap()
        app.buttons["home.collection"].tap()
        app.buttons["Coffee"].tap()
        XCTAssertEqual(app.buttons["home.collection"].label, "Coffee")
        XCTAssertTrue(app.buttons["card.monorail-pike"].exists)
        XCTAssertTrue(app.buttons["card.cloud-city"].exists)
        XCTAssertFalse(app.buttons["card.five-stones-kirkland"].exists)
        app.buttons["home.stack.edit"].tap()
        XCTAssertFalse(app.segmentedControls["group.scope"].exists)
        let cloud = app.buttons["group.place.cloud-city"]
        XCTAssertEqual(cloud.value as? String, "Selected")
        cloud.tap()
        XCTAssertTrue(cloud.exists)
        XCTAssertEqual(cloud.value as? String, "Not selected")
        app.buttons["group.place.five-stones-kirkland"].tap()
        app.buttons["Cancel"].tap()
        XCTAssertTrue(app.buttons["card.cloud-city"].exists)
        XCTAssertFalse(app.buttons["card.five-stones-kirkland"].exists)
        app.buttons["home.stack.edit"].tap()
        XCTAssertEqual(app.buttons["group.place.cloud-city"].value as? String, "Selected")
        app.buttons["group.place.cloud-city"].tap()
        app.buttons["group.place.five-stones-kirkland"].tap()
        let name = app.textFields["group.name"]
        name.tap()
        name.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 6) + "Daily")
        app.buttons["group.save"].tap()
        XCTAssertEqual(app.buttons["home.collection"].label, "Daily")
        XCTAssertFalse(app.buttons["card.cloud-city"].exists)
        XCTAssertTrue(app.buttons["card.five-stones-kirkland"].exists)
        app.buttons["home.stack.expand"].tap()
        let expanded = XCTNSPredicateExpectation(
            predicate: NSPredicate { element, _ in
                guard let card = element as? XCUIElement else { return false }
                return card.frame.height > 280
            }, object: app.buttons["card.monorail-pike"]
        )
        XCTAssertEqual(XCTWaiter.wait(for: [expanded], timeout: 3), .completed)
        capture("Named group - updated members and expanded stack", app: app)
        app.buttons["home.stack.select"].tap()
        app.buttons["card.monorail-pike"].tap()
        app.buttons["home.collection"].tap()
        app.buttons["All places"].tap()
        XCTAssertFalse(app.buttons["home.stack.groups"].exists)
        XCTAssertTrue(app.buttons["card.cloud-city"].exists)
        app.terminate()
        app.launchArguments = ["-ui-testing", "-skip-welcome"]
        app.launch()
        app.buttons["home.collection"].tap()
        app.buttons["Daily"].tap()
        XCTAssertEqual(app.buttons["home.collection"].label, "Daily")
        XCTAssertTrue(app.buttons["card.monorail-pike"].exists)
        XCTAssertTrue(app.buttons["card.five-stones-kirkland"].exists)
        XCTAssertFalse(app.buttons["card.cloud-city"].exists)
        app.buttons["home.stack.edit"].tap()
        app.buttons["group.delete"].tap()
        app.alerts.buttons["group.confirmDelete"].firstMatch.tap()
        XCTAssertEqual(app.buttons["home.collection"].label, "Your places")
        XCTAssertTrue(app.buttons["card.cloud-city"].exists)
    }

    func testBatchGroupAssignmentShowsAndCompletesPartialMembership() {
        let app = launch()
        manageGroups(in: app)
        app.buttons["group.create"].tap()
        app.textFields["group.name"].tap()
        app.textFields["group.name"].typeText("Coffee")
        app.buttons["group.place.monorail-pike"].tap()
        app.buttons["group.save"].tap()
        app.buttons["Done"].tap()
        app.buttons["home.stack.select"].tap()
        app.buttons["card.monorail-pike"].tap()
        app.buttons["card.cloud-city"].tap()
        reach(app.buttons["home.stack.groups"], in: app)
        app.buttons["home.stack.groups"].tap()
        let group = app.buttons["group.membership.Coffee"]
        XCTAssertEqual(group.value as? String, "Some selected")
        app.segmentedControls["membership.selectedOnly"].buttons["Added"].tap()
        XCTAssertTrue(group.exists)
        group.tap()
        XCTAssertEqual(group.value as? String, "Selected")
        app.buttons["Done"].tap()
        app.buttons["home.collection"].tap()
        app.buttons["Coffee"].tap()
        XCTAssertEqual(app.buttons["home.collection"].label, "Coffee")
        XCTAssertTrue(app.buttons["card.monorail-pike"].exists)
        XCTAssertTrue(app.buttons["card.cloud-city"].exists)
        XCTAssertFalse(app.buttons["card.five-stones-kirkland"].exists)
    }

    func testBrandingPreviewUsesPhotoPickerAndHandlesImageErrors() throws {
        let app = launch()
        openCard("monorail-pike", in: app)
        app.buttons["Card options"].tap()
        app.buttons["Preview branding"].tap()
        XCTAssertTrue(app.buttons["branding.choosePhoto"].exists)
        app.buttons["branding.choosePhoto"].tap()
        XCTAssertTrue(app.buttons["Cancel"].waitForExistence(timeout: 5))
        app.buttons["Cancel"].tap()
        let url = app.textFields["branding.coverURL"]
        url.tap()
        url.typeText("http://example.com/image.jpg")
        app.buttons["branding.applyURL"].tap()
        XCTAssertTrue(app.alerts["Couldn't update artwork"].waitForExistence(timeout: uiTimeout))
        XCTAssertTrue(app.staticTexts["Use an HTTPS image URL without embedded credentials."].exists)
        app.alerts.buttons["OK"].tap()
        url.tap()
        url.typeText(
            String(repeating: XCUIKeyboardKey.delete.rawValue, count: "http://example.com/image.jpg".count)
                + "https://images.example.invalid/cover.jpg"
        )
        app.buttons["branding.applyURL"].tap()
        app.buttons["Done"].tap()
        let retry = app.buttons["Retry image"]
        XCTAssertTrue(retry.waitForExistence(timeout: 25))
        capture("Unavailable artwork - retry", app: app)
        retry.tap()
        XCTAssertTrue(retry.waitForExistence(timeout: 25))
        try audit(app)
        expectProgress("5 of 8 stamps", in: app)
    }

    func testDetailCanCreateAGroupAndChangeItsMembership() {
        let app = launch()
        openCard("cloud-city", in: app)
        app.buttons["Card options"].tap()
        app.buttons["Groups"].tap()
        app.buttons["New group"].tap()
        XCTAssertEqual(app.buttons["group.place.cloud-city"].value as? String, "Selected")
        app.textFields["group.name"].tap()
        app.textFields["group.name"].typeText("Nearby")
        app.buttons["group.save"].tap()
        let toggle = app.buttons["group.membership.Nearby"]
        XCTAssertTrue(toggle.waitForExistence(timeout: uiTimeout))
        XCTAssertEqual(toggle.value as? String, "Selected")
        toggle.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)).tap()
        XCTAssertEqual(toggle.value as? String, "Not selected")
        app.buttons["Done"].tap()
        app.navigationBars.buttons["Back"].tap()
        app.buttons["home.collection"].tap()
        app.buttons["All groups"].tap()
        XCTAssertTrue(app.staticTexts["No active places in this group"].waitForExistence(timeout: uiTimeout))
    }

    private func audit(_ app: XCUIApplication) throws {
        settle()
        do {
            try performAudit(app)
        } catch {
            // Appearance changes cross-fade colors, and a busy runner can time out an audit (-56).
            // Both clear once the screen is idle; a real contrast or clipping issue fails again.
            settle(2)
            try performAudit(app)
        }
    }

    private func performAudit(_ app: XCUIApplication) throws {
        try app.performAccessibilityAudit(for: [.contrast, .textClipped]) { issue in
            guard let element = issue.element else { return false }
            if issue.auditType == .contrast {
                let underTabBar = app.tabBars.firstMatch.exists &&
                    element.frame.intersects(app.tabBars.firstMatch.frame)
                let underScrollEdge = app.images.matching(identifier: "AdditionalDimmingOverlay")
                    .allElementsBoundByIndex.contains { element.frame.intersects($0.frame) }
                // Native floating bars and scroll-edge overlays fade underlying content.
                if underTabBar || underScrollEdge { return true }
            }
            let attachment = XCTAttachment(string: "\(issue.detailedDescription)\n\(element.debugDescription)")
            attachment.name = issue.auditType == .contrast ? "App-owned contrast issue" : "App-owned clipping issue"
            attachment.lifetime = .keepAlways
            self.add(attachment)
            return false
        }
    }
}
