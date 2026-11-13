import XCTest

@MainActor
final class TapFlowTests: XCTestCase {
    func testTapScreenIsSeparateFromDemoAndVisuallyUsable() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["-ui-testing", "-reset-demo", "-skip-welcome", "-reduce-motion"]
        app.launch()

        let collection = app.buttons["home.collection"]
        XCTAssertTrue(collection.waitForExistence(timeout: 10))
        let originalCollection = collection.label
        app.tabBars.buttons["Tap"].tap()
        XCTAssertTrue(app.staticTexts["tap.heading"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.descendants(matching: .any)["tap.testMode"].exists)
        if app.textFields["tap.username"].exists {
            XCTAssertTrue(app.textFields["tap.username"].isHittable)
            XCTAssertTrue(app.secureTextFields["tap.password"].isHittable)
            XCTAssertFalse(app.buttons["tap.authenticate"].isEnabled)
        } else {
            XCTAssertTrue(app.buttons["Scan cafe tag"].exists || app.buttons["Retry pending tap"].exists)
        }
        revealTestInformation(in: app)
        XCTAssertTrue(app.staticTexts["These verified cards are separate from your local demo cards."].exists)
        XCTAssertTrue(app.staticTexts["Hardware test only. Factory zero-key tags are not secure for production rewards."].exists)

        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "Native Tap - real account"
        screenshot.lifetime = .keepAlways
        add(screenshot)

        app.tabBars.buttons["Home"].tap()
        XCTAssertTrue(collection.waitForExistence(timeout: 10))
        XCTAssertEqual(collection.label, originalCollection)
    }

    func testPolishedTapFormSupportsBothAppearances() throws {
        let app = launch()
        for mode in ["Light", "Dark"] {
            app.tabBars.buttons["You"].tap()
            app.buttons["settings.appearance"].tap()
            app.buttons[mode].tap()
            app.tabBars.buttons["Tap"].tap()
            XCTAssertTrue(app.staticTexts["tap.heading"].waitForExistence(timeout: 5))
            if app.textFields["tap.username"].exists {
                XCTAssertTrue(app.secureTextFields["tap.password"].isHittable)
                XCTAssertFalse(app.buttons["tap.authenticate"].isEnabled)
            }
            capture("Tap - \(mode)", app: app)
            try auditVisibleContent(in: app)
        }
    }

    func testTapCanShowItsSafetyInformationAtLargestTextSize() throws {
        let app = launch(extra: [
            "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"
        ])
        app.tabBars.buttons["Tap"].tap()
        XCTAssertTrue(app.staticTexts["tap.heading"].waitForExistence(timeout: 5))
        capture("Tap - largest text", app: app)
        revealTestInformation(in: app)
        let warning = app.staticTexts["Hardware test only. Factory zero-key tags are not secure for production rewards."]
        reach(warning, in: app)
        capture("Tap - accessible test information", app: app)
        try auditVisibleContent(in: app, types: [.textClipped])
    }

    private func revealTestInformation(in app: XCUIApplication) {
        let information = app.buttons["How this test works"]
        reach(information, in: app)
        information.tap()
    }

    private func reach(_ element: XCUIElement, in app: XCUIApplication) {
        let bottom = app.tabBars.firstMatch.frame.minY
        for _ in 0..<10 where !element.isHittable || element.frame.maxY > bottom {
            if element.frame.minY < app.frame.minY + 62 { app.swipeDown() }
            else { app.swipeUp() }
        }
        XCTAssertTrue(element.isHittable)
        XCTAssertLessThanOrEqual(element.frame.maxY, bottom)
    }

    private func launch(extra: [String] = []) -> XCUIApplication {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["-ui-testing", "-reset-demo", "-skip-welcome", "-reduce-motion"] + extra
        app.launch()
        XCTAssertTrue(app.buttons["home.collection"].waitForExistence(timeout: 10))
        return app
    }

    private func capture(_ name: String, app: XCUIApplication) {
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = name
        screenshot.lifetime = .keepAlways
        add(screenshot)
    }
}
