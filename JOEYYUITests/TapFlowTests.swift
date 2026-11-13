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
        XCTAssertTrue(app.staticTexts["Real cafe visits"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["These verified cards are separate from your local demo cards."].exists)
        XCTAssertTrue(app.staticTexts["Hardware test only — factory zero-key tags are not secure for production rewards."].exists)
        if app.textFields["Username"].exists {
            XCTAssertTrue(app.textFields["Username"].isHittable)
            XCTAssertTrue(app.secureTextFields["Password (12+ characters)"].isHittable)
        } else {
            XCTAssertTrue(app.buttons["Scan cafe tag"].exists || app.buttons["Retry pending tap"].exists)
        }

        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "Native Tap - real account"
        screenshot.lifetime = .keepAlways
        add(screenshot)

        app.tabBars.buttons["Home"].tap()
        XCTAssertTrue(collection.waitForExistence(timeout: 10))
        XCTAssertEqual(collection.label, originalCollection)
    }
}
