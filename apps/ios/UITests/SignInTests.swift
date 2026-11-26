import XCTest

/// I4 Gate 2: sign-in, restore and sign-out go through the core, on the real form, against the Phosphor service
/// with a test account that has photos. The password is only ever pasted, never typed or logged. The Simulator takes
/// it from the Mac's clipboard (`simctl pbcopy` did not reach the app), so empty that right after the run, pass or
/// fail. From apps/ios, after `../../core/dc-ffi/build-ios.sh` and `xcodegen generate`:
///   security find-generic-password -s <Keychain item> -w | tr -d '\n' | pbcopy
///   TEST_RUNNER_DC_TEST_EMAIL=<the account's email> xcodebuild test -project DCPhotos.xcodeproj -scheme DCPhotos \
///     -destination 'platform=iOS Simulator,name=<a booted iPhone>' -only-testing:DCPhotosUITests
///   printf x | pbcopy; pbcopy < /dev/null
/// (xcodebuild hands TEST_RUNNER_* variables to the test without the prefix.) Each test empties the Simulator's
/// pasteboard when it ends, passed or failed. The reinstall check: run `testSignInAndStay` alone with
/// TEST_RUNNER_DC_TEST_STAY=1, then `xcrun simctl uninstall` + `install` the app — it must open on this form.
final class SignInTests: XCTestCase {
    func testSignInRestoreSignOut() throws {
        defer { UIPasteboard.general.items = [] }
        let env = ProcessInfo.processInfo.environment
        let email = try XCTUnwrap(env["DC_TEST_EMAIL"])
        let app = XCUIApplication()
        // No server given: the form's default, the Phosphor service (D8).
        app.launchEnvironment = ["FOTOS_LOGIN_EMAIL": email, "FOTOS_BACKUP_OFF": "1"]
        app.launchArguments = ["-AppleLanguages", "(en)"]
        app.launch()
        signOutIfSignedIn(app)

        // A wrong password: the core's own words, not a type name.
        let password = app.secureTextFields.firstMatch
        XCTAssert(password.waitForExistence(timeout: 10))
        focus(password, in: app); password.typeText("not-the-password")
        app.buttons["Sign In"].tap()
        XCTAssert(app.staticTexts["Wrong email or password."].waitForExistence(timeout: 30), app.debugDescription)

        // The real password, pasted.
        focus(password, in: app); password.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 20))
        pastePasswordAndSignIn(app)

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

    /// Leaves the app signed in, for the reinstall check (see the header); skipped otherwise.
    func testSignInAndStay() throws {
        let env = ProcessInfo.processInfo.environment
        // Before the defer: a skipped run must not empty the pasteboard the other test pastes from.
        try XCTSkipUnless(env["DC_TEST_STAY"] != nil, "only for the reinstall check")
        defer { UIPasteboard.general.items = [] }
        let app = XCUIApplication()
        app.launchEnvironment = ["FOTOS_LOGIN_EMAIL": try XCTUnwrap(env["DC_TEST_EMAIL"]), "FOTOS_BACKUP_OFF": "1"]
        app.launchArguments = ["-AppleLanguages", "(en)"]
        app.launch()
        signOutIfSignedIn(app)
        pastePasswordAndSignIn(app)
    }

    private func pastePasswordAndSignIn(_ app: XCUIApplication) {
        let password = app.secureTextFields.firstMatch
        XCTAssert(password.waitForExistence(timeout: 10))
        focus(password, in: app)
        password.press(forDuration: 1.2)
        let paste = app.menuItems["Paste"].exists ? app.menuItems["Paste"] : app.buttons["Paste"]
        XCTAssert(paste.waitForExistence(timeout: 5), app.debugDescription)
        paste.tap()
        app.buttons["Sign In"].tap()
        XCTAssert(app.staticTexts["Library"].waitForExistence(timeout: 60), app.debugDescription)
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
