# Phosphor Photos for iPhone

The iPhone app (SwiftUI + UIKit, iOS 26). It is built from
[HomeRoll](https://github.com/silentprovider423/HomeRoll) (GPL-3.0, imported
at `bd90811` with `git subtree --squash`; see `LICENSE` and the repository's
`NOTICE`), with HomeRoll's Immich server layer being replaced step by step by
the Rust core in [`../../core`](../../core) — the plan is
[`docs/plan/ENGINE.md`](../../docs/plan/ENGINE.md) Part 2, tasks I1–I11.

Many code comments and string keys are still German (HomeRoll's); the app
ships in English and Russian.

## Build and run on the Simulator

Needs Xcode 26+, [XcodeGen](https://github.com/yonaskolb/XcodeGen)
(`mise use xcodegen`) and the Rust toolchain (`rustup`; `core/rust-toolchain.toml`
adds the iOS targets). The core is built first — `DCCore.xcframework` and its
Swift bindings land in `core/dc-ffi/build/` (git-ignored); the project file is
generated, not committed:

```sh
../../core/dc-ffi/build-ios.sh
xcodegen generate
FOTOS_SERVER=<worker URL> FOTOS_TOKEN_FILE=<file holding a session token> ./sim-run.sh
```

`sim-run.sh` signs in by token on Debug builds only, so no password is typed —
that path skips the core. Sign-in through the core, on the real form, is the UI
test `UITests/SignInTests.swift` (how to run it is at its top).

## Checks

`tools/check-identity.sh` (and its self-test) keeps the app's identity ours:
bundle id `uz.daemonclient.photos`, name "Phosphor Photos", no App Group or
extensions, English and Russian only.
