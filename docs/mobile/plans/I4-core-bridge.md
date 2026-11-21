# I4 — the core in the iPhone app: sign-in, restore, sign-out

**Task I4 of `docs/plan/ENGINE.md` §9.** Decisions it follows: D26 (native
apps over one Rust core), D21 (storage credentials stay in the core), the I0b
requirements (the session only in the app's own Keychain).

**Order.** The operator, 2026-11-22: "add the swift code to the core and run
the tests already" — so I4 came straight after I1, before I2/I3. This plan was
written alongside the code, not before it; it records what was built.

## What

1. **`core/dc-ffi`** — the bridge, made with UniFFI 0.32.2, deliberately thin
   (the logic stays in `dc-core`): `Core(dataDir, cacheDir)`, `signIn` (async),
   `restore`, `signOut`, `mediaServer`, `coreVersion`, `setLogSink` (a
   callback). Errors reach Swift as `CoreError.Failed(message)` carrying the
   core's own words. **`core/uniffi-bindgen`** generates the bindings (a build
   tool, never shipped).
2. **`core/dc-ffi/build-ios.sh`** — release static libraries for
   `aarch64-apple-ios` and `aarch64-apple-ios-sim` (built for iOS 26, the
   app's minimum), the Swift bindings, `DCCore.xcframework`, all into
   `core/dc-ffi/build/` (git-ignored). `project.yml` links the XCFramework and
   compiles the generated `dc_ffi.swift` from there — never copied, so it
   cannot drift from the Rust. The Simulator build is arm64 only.
3. **`App/Core/CoreBridge.swift`** — one `Core` per process, started on first
   use; its log lines go to the system log. Sign-in goes through the core
   (the hosted address `api.daemonclient.uz`, however typed, or a self-hosted
   server — D8); the whole session (worker address, token, user id, email,
   name) is one Keychain item; at launch it is restored into the core. A
   session from an earlier install is dropped (the Keychain outlives a deleted
   app; a UserDefaults marker does not). Sign-out empties the core and the
   item. HomeRoll's client gets the worker address and token from the core
   until I5–I8 move the rest.

**Not in I4:** HomeRoll's SSO sign-in (removed in I2); the Debug-only token
from the launch environment (`sim-run.sh`), which skips the core; the media
server in use (I5); an x86_64 Simulator.

**Spike S1, in part.** Proven: an async call (Swift `async throws`), a
callback (the log sink), errors, packaging. Not yet: a stream (`AsyncStream`
over a callback) and cancelling a call — they come with I5/I9.

## Tests

- `dc-ffi`: 4 unit tests (the version, error words, a bad stored address
  refused, the media server answers); the whole workspace, 202 tests, fmt and
  clippy `-D warnings`.
- `UITests/SignInTests.swift` on the Simulator, on the real form, against the
  test account through the hosted address: a wrong password shows "wrong email
  or password"; the real password (pasted from the clipboard, never typed or
  logged) opens the library; a relaunch is signed in and the grid fills (the
  worker accepts the core's session); sign-out shows the form, and a relaunch
  stays signed out.

## Gate 3

Two separate reviews: security (the session in the Keychain, the install
marker, what the bridge exposes, logs) and spec (this plan, D21, D26, I0b).
