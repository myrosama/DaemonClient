import XCTest

/// I4 Gate 2: sign-in, restore and sign-out go through the core, on the real form.
/// The password is only ever pasted, never typed or logged: put it on the Mac's clipboard (the Simulator syncs it in)
///   security find-generic-password -s <item> -w | tr -d '\n' | pbcopy; pbpaste | xcrun simctl pbcopy booted
/// and clear both right after the run. The address and email come from TEST_RUNNER_DC_TEST_SERVER / _EMAIL.
final class SignInTests: XCTestCase {
    func testSignInRestoreSignOut() throws {
        let env = ProcessInfo.processInfo.environment
        let server = try XCTUnwrap(env["DC_TEST_SERVER"]), email = try XCTUnwrap(env["DC_TEST_EMAIL"])
        let app = XCUIApplication()
        app.launchEnvironment = ["FOTOS_LOGIN_SERVER": server, "FOTOS_LOGIN_EMAIL": email, "FOTOS_BACKUP_OFF": "1"]
        app.launchArguments = ["-AppleLanguages", "(en)"]
        app.launch()
        signOutIfSignedIn(app)

        // A wrong password: the core's own words, not a type name.
        let password = app.secureTextFields.firstMatch
        XCTAssert(password.waitForExistence(timeout: 10))
        focus(password, in: app); password.typeText("not-the-password")
        app.buttons["Sign In"].tap()
        XCTAssert(app.staticTexts["wrong email or password"].waitForExistence(timeout: 30), app.debugDescription)

        // The real password, pasted.
        focus(password, in: app); password.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 20))
        password.press(forDuration: 1.2)
        let paste = app.menuItems["Paste"].exists ? app.menuItems["Paste"] : app.buttons["Paste"]
        XCTAssert(paste.waitForExistence(timeout: 5), app.debugDescription)
        paste.tap()
        app.buttons["Sign In"].tap()
        XCTAssert(app.staticTexts["Library"].waitForExistence(timeout: 60), app.debugDescription)

        // Restore: a new launch is signed in without the form.
        app.terminate()
        app.launchEnvironment = ["FOTOS_BACKUP_OFF": "1"]
        app.launch()
        XCTAssert(app.staticTexts["Library"].waitForExistence(timeout: 30), app.debugDescription)
        // The worker accepts the core's session: the grid fills.
        XCTAssert(app.collectionViews.cells.firstMatch.waitForExistence(timeout: 30), app.debugDescription)

        // Sign out: the form again, and a new launch stays signed out.
        signOutIfSignedIn(app)
        XCTAssert(app.buttons["Sign In"].waitForExistence(timeout: 10))
        app.terminate(); app.launch()
        XCTAssert(app.buttons["Sign In"].waitForExistence(timeout: 10))
    }

    /// A tap does not always give the field the keyboard on the first try.
    private func focus(_ field: XCUIElement, in app: XCUIApplication) {
        for _ in 0..<3 where !((field.value(forKey: "hasKeyboardFocus") as? Bool) ?? false) {
            field.tap()
            _ = app.keyboards.firstMatch.waitForExistence(timeout: 3)
        }
    }

    private func signOutIfSignedIn(_ app: XCUIApplication) {
        guard app.staticTexts["Library"].waitForExistence(timeout: 8) else { return }
        app.buttons["More"].firstMatch.tap()
        app.buttons["Sign Out"].firstMatch.tap()
        app.sheets.buttons["Sign Out"].firstMatch.tap()
    }
}
