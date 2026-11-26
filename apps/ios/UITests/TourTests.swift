import XCTest

/// I2/I3 Gate 2: walks the screens v1 keeps and keeps a screenshot of each in the test results (git-ignored; they
/// show the test account's photos — never commit or share them). Needs a signed-in app (`testSignInAndStay`) and
/// TEST_RUNNER_DC_TEST_TOUR=1; TEST_RUNNER_DC_TEST_LANG picks the language (en or ru). Skipped otherwise.
final class TourTests: XCTestCase {
    func testTour() throws {
        let env = ProcessInfo.processInfo.environment
        try XCTSkipUnless(env["DC_TEST_TOUR"] != nil, "only for the Gate 2 tour")
        let lang = env["DC_TEST_LANG"] ?? "en"
        let app = XCUIApplication()
        app.launchEnvironment = ["FOTOS_BACKUP_OFF": "1"]
        app.launchArguments = ["-AppleLanguages", "(\(lang))"]
        app.launch()
        let grid = app.collectionViews.cells.firstMatch
        XCTAssert(grid.waitForExistence(timeout: 30), app.debugDescription)
        let notNow = app.buttons[lang == "ru" ? "Не сейчас" : "Not Now"]
        if notNow.waitForExistence(timeout: 5) { notNow.tap() }
        sleep(12); shot(app, "1-library")

        // the lowest photo tile on screen (the top rows sit under the large title)
        // a tile well below the large title (the top rows sit under it)
        let tile = app.collectionViews.cells.allElementsBoundByIndex.first { $0.isHittable && $0.frame.minY > 200 }
        tile?.tap(); sleep(4); shot(app, "2-viewer")
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Info' OR label BEGINSWITH 'Инфо'")).firstMatch.tap()
        sleep(3); shot(app, "3-info")
        app.terminate(); app.launch()
        XCTAssert(grid.waitForExistence(timeout: 30), app.debugDescription)

        app.buttons[lang == "ru" ? "Медиатека" : "Library"].firstMatch.tap(); sleep(1)
        app.buttons[lang == "ru" ? "Коллекции" : "Collections"].firstMatch.tap()
        sleep(4); shot(app, "4-collections")
        app.swipeUp(); sleep(2); shot(app, "5-collections-more")

        app.buttons["Backup"].firstMatch.tap(); sleep(3); shot(app, "6-account-menu")
    }

    private func shot(_ app: XCUIApplication, _ name: String) {
        let a = XCTAttachment(screenshot: app.screenshot())
        a.name = name; a.lifetime = .keepAlways
        add(a)
    }
}
