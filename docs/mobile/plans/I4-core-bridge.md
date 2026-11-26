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

**Not in I4:** the Debug-only token from the launch environment
(`sim-run.sh`), which skips the core; the media server in use (I5); an x86_64
Simulator; a CI job that builds the app (add a macOS build-only job before
TestFlight); the hosted sign-in without the central login (I4b).

**Spike S1, in part.** Proven: a Swift `async throws` call, errors by kind,
the XCFramework packaging on iOS. The log callback is proven in Rust
(`tests/log_sink.rs`); in the app it is linked but no line was seen — a
release core logs warnings only and the sign-in path logs none. Not yet: a
stream (`AsyncStream` over a callback), cancelling a call, Android (cargo-ndk,
an AAR, coroutine cancel), binary size, a Swift Package — with I5/I9 and A0.

## As built (Gate 3 fixes, 2026-11-26)

- **Errors by kind** (`WrongCredentials`, `NotProvisioned`, `BadAddress`,
  `Network`, `SignedOut`, `Failed` with the core's words): the app says them
  in English or Russian; a panic UniFFI catches shows a fixed message.
- **HomeRoll's Immich sign-in is gone** (the server probe, SSO, `login`,
  `findServer`): SSO signed in past the core.
- **A 401 signs out fully** (the Keychain item and the core), so the next
  launch does not restore a refused session.
- **The install marker** is checked after the Keychain item is read: before
  the first unlock both read empty and nothing is wiped.
- **The sign-in screen (I4c)** came with it, at the operator's request: our
  logo, labelled fields in Immich's form style, the Phosphor service by
  default and "Use your own server" second (D8), **Create account** opening
  the accounts site's sign-up in an in-app Safari view. Not yet: **Delete
  account** in Settings (App Store 5.1.1(v); its page on the accounts site
  is Linux's).
- **Audit:** `core/deny.toml` ignores RUSTSEC-2026-0374 (basic-toml,
  build-time only inside UniFFI's generator); `url` 2.5.9 fixes
  RUSTSEC-2026-0592 (the core had the affected 2.5.8 before I4 too).
- **The UI test's password** reaches the Simulator through the Mac's
  clipboard, emptied after each run: `simctl pbcopy` did not reach the app.

## Tests

- `dc-ffi`: 4 unit tests (the version, error kinds and words, a bad stored
  address refused, the media server answers), `tests/sign_in.rs` (sign-in,
  restore, sign-out against a stand-in server; a wrong password and an
  unreachable server by kind), `tests/log_sink.rs`; the whole workspace, 206
  tests, fmt, clippy `-D warnings`, `cargo deny check advisories`.
- `UITests/SignInTests.swift` on the Simulator, on the real form, against the
  test account through the hosted address: a wrong password shows "wrong email
  or password"; the real password (pasted from the clipboard, never typed or
  logged) opens the library; a relaunch is signed in and the grid fills (the
  worker accepts the core's session); sign-out shows the form, and a relaunch
  stays signed out. `testSignInAndStay`, then an uninstall and reinstall:
  the app opens on the sign-in form (the install marker).

## Gate 3

Two separate reviews: security (the session in the Keychain, the install
marker, what the bridge exposes, logs) and spec (this plan, D21, D26, I0b).
