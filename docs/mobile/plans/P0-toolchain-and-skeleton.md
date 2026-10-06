# P0 — Toolchain and skeleton

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a MacBook that builds both platforms, a record of what the existing
Photos fork does today, and the first Rust code running inside the Photos app
on the iOS Simulator and Android.

**Architecture:** One Cargo workspace at `mobile/`. `mobile/core/dc-core` is
pure Rust. `mobile/packages/dc_core_flutter` is a flutter_rust_bridge plugin
whose Rust crate depends on `dc-core`; `immich/mobile` depends on the plugin by
path.

**Tech stack:** Rust stable (pinned), flutter_rust_bridge 2.13.0, Flutter
3.41.7 via mise, Xcode 27, CocoaPods, JDK 21, Android SDK + NDK.

**Spec:** `docs/mobile/SPEC.md` §3, §8, §9 (P0). Index: `docs/mobile/PLAN.md`.

## Global constraints

Everything in `PLAN.md` → "Global constraints" applies. For P0 in particular:

- Part size is exactly `19 * 1024 * 1024` = 19,922,944 bytes.
- Flutter **3.41.7** (pinned by `immich/mobile/mise.toml`); flutter_rust_bridge
  **2.13.0** (crate and Dart package must match).
- Sign in to the **test account** only. Its credentials are in the private
  memory, never in this repo.
- No push without the operator's review. No AI attribution in commits.

## Review focus

1. A byte range that starts in one part and ends in the next must return the
   tail of the first and the head of the second — Task 0.3,
   `a_range_across_a_boundary…`.
2. `bytes=N-` arrives as an end of `u64::MAX` and must clamp, not overflow —
   Task 0.3, `an_open_ended_range…` and `a_hostile_file_size…`.
3. File sizes above 2^53 must cross the Dart bridge exactly (Dart `double`
   would round them) — Task 0.4, integration test.
4. If the Rust library fails to load, the app must show its bootstrap error
   screen, not crash silently — Task 0.4: `RustLib.init()` is the first line
   of `initApp()`, which `main()` calls inside its `try`, and which the
   existing integration tests also call
   (`integration_test/test_utils/general_helper.dart:33`).
5. Adding Rust to the Photos app must not break the existing CI builds —
   Task 0.5.

---

### Task 0.1: Disk space and toolchain

No code. Gate 1 and Gate 3 do not apply; the evidence is `flutter doctor`.

**Files:**
- Create: `mobile/mise.toml`

- [ ] **Step 1: Free disk space (operator)**

The Mac has 19 GB free (2026-10-04). Roughly needed: iOS Simulator runtime
~8 GB, Flutter + CocoaPods + pub cache ~4 GB, Rust + targets ~2 GB, Rust build
output ~5 GB, Xcode build data ~5 GB, Android SDK + NDK ~6 GB, Android emulator
image ~7 GB (optional — the Samsung can be used over USB instead).
**Target: at least 45 GB free.** The operator decides what to delete; nothing
of theirs is deleted by an agent.

Run: `df -h ~ | tail -1`
Expected: `Avail` ≥ 45Gi.

- [ ] **Step 2: Rust**

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
source "$HOME/.cargo/env"
rustup component add rustfmt clippy
rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios \
  aarch64-linux-android armv7-linux-androideabi x86_64-linux-android
rustc --version
```

Expected: a `rustc 1.x.y` line. Write that exact version down — Task 0.3 pins it.

- [ ] **Step 3: Flutter 3.41.7 through mise**

```bash
brew install mise
echo 'eval "$(mise activate zsh)"' >> ~/.zshrc
eval "$(mise activate zsh)"
cd ~/Desktop/DaemonClient/immich/mobile && mise trust && mise install
flutter --version
```

Expected: `Flutter 3.41.7`.

Create `mobile/mise.toml` so the plugin and the future Drive app get the same
Flutter:

```toml
[tools]
flutter = "3.41.7"
```

```bash
cd ~/Desktop/DaemonClient/mobile && mise trust && flutter --version
```

Expected: `Flutter 3.41.7`.

- [ ] **Step 4: CocoaPods and the iOS Simulator**

```bash
brew install cocoapods
sudo xcodebuild -runFirstLaunch
xcodebuild -downloadPlatform iOS
xcrun simctl list runtimes
```

Expected: an `iOS 27.x` runtime listed (it was empty on 2026-10-04).

- [ ] **Step 5: Java and Android**

CI uses Temurin 21 (`.github/workflows/mobile-build.yml`); match it.

```bash
brew install --cask temurin@21 android-commandlinetools
export ANDROID_HOME="$HOME/Library/Android/sdk"
yes | sdkmanager --sdk_root="$ANDROID_HOME" --licenses
sdkmanager --sdk_root="$ANDROID_HOME" "platform-tools" "platforms;android-36" "build-tools;36.0.0"
flutter config --android-sdk "$ANDROID_HOME"
```

The NDK version comes from Flutter (`ndkVersion = flutter.ndkVersion` in
`immich/mobile/android/app/build.gradle:18`); Gradle downloads it on the first
Android build. Emulator (only if disk allows, otherwise use the Samsung):

```bash
sdkmanager --sdk_root="$ANDROID_HOME" "emulator" "system-images;android-36;google_apis;arm64-v8a"
avdmanager create avd -n dc-test -k "system-images;android-36;google_apis;arm64-v8a"
```

- [ ] **Step 6: flutter_rust_bridge codegen**

```bash
cargo install flutter_rust_bridge_codegen@2.13.0 --locked
flutter_rust_bridge_codegen --version
```

Expected: `2.13.0`.

- [ ] **Step 7: Verify everything**

Run: `flutter doctor -v`
Expected: Flutter, Android toolchain, Xcode and CocoaPods all `[✓]`. Paste the
summary block into `DESIGN_NOTES.md` under "0.1".

- [ ] **Step 8: Commit** (only `mobile/mise.toml` is new)

```bash
git add mobile/mise.toml
git commit -m "chore(mobile): pin Flutter 3.41.7 for the mobile workspace"
```

---

### Task 0.2: What the existing Photos fork does today

No code. Investigation; the record is the deliverable.

**Files:**
- Modify: `docs/mobile/RESEARCH.md` (append §7)
- Modify: `docs/mobile/DESIGN_NOTES.md` (entry "0.2")

- [ ] **Step 1: Build prerequisites** (the CI steps, run locally)

```bash
cd ~/Desktop/DaemonClient/immich/mobile
flutter pub get
dart run easy_localization:generate -S ../i18n
dart run bin/generate_keys.dart
(cd ios && pod install)
```

Expected: no errors. Record any that appear.

- [ ] **Step 2: Boot a Simulator and run**

```bash
xcrun simctl list devices available | grep -i iphone | head -3
open -a Simulator
flutter run -d "<the iPhone name printed above>"
```

Expected: the DaemonClient sign-in screen. If the build fails, record the
error and stop — the fix becomes its own task in P2, not a detour here.

> **Amended 2026-10-06:** the build failed, and the "stop — fix in P2" rule
> above was overridden by SPEC §9 (the P0 exit needs the app running on the
> Simulator for Task 0.4). The fix is **Task 0.2a** in `PLAN.md`; details in
> RESEARCH §7 and `DESIGN_NOTES.md` 0.2a. Steps 3–5 continue after it.

- [ ] **Step 3: Sign in with the test account** at `https://api.daemonclient.uz`
and record, with the `flutter run` log:

1. Does sign-in succeed? What does the login response contain?
2. Which host does the app call **after** sign-in — the central API or the
   worker in `workerUrl`? (The fork never reads `workerUrl`; R§6.)
3. Does the timeline load? Do thumbnails appear? Does a video play?
4. What does the backup screen show?

- [ ] **Step 4: Screenshot** each finding:

```bash
xcrun simctl io booted screenshot ~/Desktop/p0-2-<n>.png
```

Screenshots stay out of the repo (they show the test account); describe them
in the notes.

- [ ] **Step 5: Write it down** — `RESEARCH.md` §7 "What the fork does today"
(facts, dated) and the `DESIGN_NOTES.md` entry. Then commit docs:

```bash
git add docs/mobile/RESEARCH.md docs/mobile/DESIGN_NOTES.md
git commit -m "docs(mobile): record what the current Photos fork does at sign-in"
```

---

### Task 0.3: Cargo workspace and `dc-core` with `chunk_plan`

> **Changed at Gate 3, 2026-10-05** (see `DESIGN_NOTES.md` 0.3): the eager
> `parts_for_range(...) -> Option<Vec<PartSlice>>` below became
> `plan_range(...) -> RangePlan` (`Partial(PartSlices)` — a lazy iterator —
> `| Unsatisfiable | Ignore`) plus `plan_suffix(...)`, because a corrupt file
> size could make the Vec enormous. The steps below are kept as written; the
> code in `mobile/core/dc-core/src/chunk_plan.rs` is the current contract.

Full treatment (it is the chunk path).

**Files:**
- Create: `mobile/Cargo.toml`, `mobile/rust-toolchain.toml`, `mobile/.gitignore`,
  `mobile/clippy.toml` (added at Gate 3)
- Create: `mobile/core/dc-core/Cargo.toml`, `mobile/core/dc-core/src/lib.rs`,
  `mobile/core/dc-core/src/chunk_plan.rs`

**Interfaces** (as shipped after Gate 3):
- Produces: `dc_core::version() -> &'static str`;
  `dc_core::chunk_plan::{PART_SIZE: u64, ENCRYPTION_OVERHEAD: u64,
  part_count(file_size: u64) -> u64, PartSlice { index: u64, start: u64,
  end_inclusive: u64 }, RangePlan { Partial(PartSlices), Unsatisfiable, Ignore },
  PartSlices (lazy Iterator<Item = PartSlice>; remaining() -> u64,
  byte_range() -> (u64, u64)), plan_range(file_size: u64, start: u64,
  end_inclusive: u64) -> RangePlan, plan_suffix(file_size: u64, suffix_len: u64)
  -> RangePlan}`.
  Task 0.4 calls `version()` and `part_count()`; P1's read path and media
  server call `plan_range()` / `plan_suffix()` — after validating the manifest
  (its part list must match `part_count`, allowing one part for 0 bytes).

- [ ] **Step 1: Workspace files**

`mobile/Cargo.toml`:

```toml
[workspace]
resolver = "3"
members = ["core/dc-core"]

[workspace.package]
version = "0.1.0"
edition = "2024"
publish = false

[workspace.lints.rust]
unsafe_code = "forbid"

[workspace.lints.clippy]
all = { level = "deny", priority = -1 }
```

`mobile/rust-toolchain.toml` — use the exact version Task 0.1 Step 2 printed:

```toml
[toolchain]
channel = "<rustc version from 0.1, e.g. 1.95.0>"
components = ["rustfmt", "clippy"]
targets = [
  "aarch64-apple-ios", "aarch64-apple-ios-sim", "x86_64-apple-ios",
  "aarch64-linux-android", "armv7-linux-androideabi", "x86_64-linux-android",
]
```

`mobile/.gitignore`:

```
/target/
```

`mobile/core/dc-core/Cargo.toml`:

```toml
[package]
name = "dc-core"
version.workspace = true
edition.workspace = true
publish.workspace = true

[lints]
workspace = true

[dependencies]
```

- [ ] **Step 2: Write the failing tests**

`mobile/core/dc-core/src/lib.rs`:

```rust
//! DaemonClient's mobile core: everything below the UI of the Photos and
//! Drive apps. See docs/mobile/SPEC.md §4.

pub mod chunk_plan;

/// This crate's version, shown in the apps so a build can be traced to a commit.
pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}
```

`mobile/core/dc-core/src/chunk_plan.rs` — tests and empty stubs:

```rust
//! How a file maps onto Telegram parts (docs/mobile/RESEARCH.md §2).

/// Plaintext bytes per Telegram part. Frozen: bots cannot download files over
/// 20 MB, and every file already stored was split at this size.
pub const PART_SIZE: u64 = 19 * 1024 * 1024;

/// Bytes AES-GCM adds to each encrypted part: a 12-byte IV and a 16-byte tag.
pub const ENCRYPTION_OVERHEAD: u64 = 12 + 16;

/// The bytes of one part needed to serve a range, as offsets inside that part.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PartSlice {
    pub index: u64,
    pub start: u64,
    pub end_inclusive: u64,
}

/// Number of parts a file of `file_size` bytes is split into.
pub fn part_count(file_size: u64) -> u64 {
    let _ = file_size;
    unimplemented!()
}

/// Which parts, and which bytes inside each, hold plaintext bytes
/// `start..=end_inclusive` of a file of `file_size` bytes. An end past the
/// file is clamped, as HTTP `Range` requires (`bytes=N-` arrives as
/// `u64::MAX`). `None` means unsatisfiable — the caller answers `416`.
pub fn parts_for_range(file_size: u64, start: u64, end_inclusive: u64) -> Option<Vec<PartSlice>> {
    let _ = (file_size, start, end_inclusive);
    unimplemented!()
}

#[cfg(test)]
mod tests {
    use super::*;

    const P: u64 = PART_SIZE;
    const TWO_GIB: u64 = 2 * 1024 * 1024 * 1024;

    #[test]
    fn the_part_size_is_the_one_the_web_and_the_worker_use() {
        assert_eq!(PART_SIZE, 19_922_944);
    }

    #[test]
    fn an_empty_file_has_no_parts() {
        assert_eq!(part_count(0), 0);
    }

    #[test]
    fn a_file_of_exactly_one_part_is_not_split() {
        assert_eq!(part_count(1), 1);
        assert_eq!(part_count(P), 1);
    }

    #[test]
    fn one_byte_over_a_part_needs_a_second_part() {
        assert_eq!(part_count(P + 1), 2);
    }

    #[test]
    fn a_2_gib_video_has_108_parts() {
        assert_eq!(part_count(TWO_GIB), 108);
    }

    #[test]
    fn a_range_inside_one_part_touches_only_that_part() {
        assert_eq!(
            parts_for_range(3 * P, 10, 20),
            Some(vec![PartSlice { index: 0, start: 10, end_inclusive: 20 }])
        );
    }

    #[test]
    fn a_range_across_a_boundary_takes_the_tail_of_one_part_and_the_head_of_the_next() {
        assert_eq!(
            parts_for_range(3 * P, P - 1, P),
            Some(vec![
                PartSlice { index: 0, start: P - 1, end_inclusive: P - 1 },
                PartSlice { index: 1, start: 0, end_inclusive: 0 },
            ])
        );
    }

    #[test]
    fn seeking_near_the_end_of_a_2_gib_video_fetches_one_part_not_all() {
        let slices = parts_for_range(TWO_GIB, TWO_GIB - 1000, TWO_GIB - 1).unwrap();
        assert_eq!(slices.len(), 1);
        assert_eq!(slices[0].index, part_count(TWO_GIB) - 1);
    }

    #[test]
    fn an_open_ended_range_is_clamped_to_the_last_byte() {
        let slices = parts_for_range(P + 10, 5, u64::MAX).unwrap();
        assert_eq!(slices.len(), 2);
        assert_eq!(slices[1], PartSlice { index: 1, start: 0, end_inclusive: 9 });
    }

    #[test]
    fn unsatisfiable_ranges_are_refused_so_the_server_can_answer_416() {
        assert_eq!(parts_for_range(0, 0, 0), None);
        assert_eq!(parts_for_range(100, 100, 200), None);
        assert_eq!(parts_for_range(100, 50, 40), None);
    }

    #[test]
    fn the_slices_cover_exactly_the_requested_bytes_in_order() {
        let size = 5 * P + 123;
        for (start, end) in [(0, size - 1), (P - 5, 3 * P + 7), (4 * P, u64::MAX), (17, 17)] {
            let slices = parts_for_range(size, start, end).unwrap();
            let covered: u64 = slices.iter().map(|s| s.end_inclusive - s.start + 1).sum();
            assert_eq!(covered, end.min(size - 1) - start + 1);
            for pair in slices.windows(2) {
                assert_eq!(pair[1].index, pair[0].index + 1);
                assert_eq!(pair[0].end_inclusive, P - 1);
                assert_eq!(pair[1].start, 0);
            }
        }
    }

    #[test]
    fn a_hostile_file_size_does_not_overflow() {
        let slices = parts_for_range(u64::MAX, u64::MAX - 10, u64::MAX).unwrap();
        assert!(!slices.is_empty());
        assert_eq!(part_count(u64::MAX), u64::MAX / P + 1);
    }
}
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd ~/Desktop/DaemonClient/mobile && cargo test -p dc-core`
Expected: the `chunk_plan` tests FAIL with `not implemented`.

- [ ] **Step 4: Implement**

Replace the two stubs in `chunk_plan.rs`:

```rust
pub fn part_count(file_size: u64) -> u64 {
    file_size.div_ceil(PART_SIZE)
}

pub fn parts_for_range(file_size: u64, start: u64, end_inclusive: u64) -> Option<Vec<PartSlice>> {
    if file_size == 0 || start >= file_size || start > end_inclusive {
        return None;
    }
    let end = end_inclusive.min(file_size - 1);
    let first = start / PART_SIZE;
    let last = end / PART_SIZE;
    Some(
        (first..=last)
            .map(|index| {
                let part_start = index * PART_SIZE;
                let part_end = part_start.saturating_add(PART_SIZE - 1);
                PartSlice {
                    index,
                    start: start.max(part_start) - part_start,
                    end_inclusive: end.min(part_end) - part_start,
                }
            })
            .collect(),
    )
}
```

- [ ] **Step 5: Run everything**

```bash
cargo test -p dc-core
cargo clippy -p dc-core --all-targets -- -D warnings
cargo fmt --all --check
```

Expected: all tests PASS, no clippy warnings, no format diff.

- [ ] **Step 6: Gate 3** — two review agents on the unstaged diff: security
(overflow, hostile sizes) and spec (matches RESEARCH §2 and the web's
`Math.ceil(size / CHUNK_SIZE)`). Fix HIGH/MEDIUM; re-run Step 5.

- [ ] **Step 7: Commit code, then docs**

```bash
git add mobile/Cargo.toml mobile/Cargo.lock mobile/rust-toolchain.toml mobile/.gitignore mobile/core/dc-core
git commit -m "feat(mobile-core): dc-core workspace with part and byte-range arithmetic"
```

Then tick 0.3 in `PLAN.md`, add the `DESIGN_NOTES.md` entry, commit docs.

---

### Task 0.4: `dc_core_flutter` and the first Rust call from the Photos app

**Files:**
- Create: `mobile/packages/dc_core_flutter/` (generated by flutter_rust_bridge, then edited)
- Create: `mobile/packages/dc_core_flutter/rust/src/api/core.rs`
- Create: `mobile/packages/dc_core_flutter/lib/dc_core_flutter.dart`
- Create: `mobile/packages/dc_core_flutter/example/integration_test/core_test.dart`
- Modify: `mobile/Cargo.toml` (add the plugin crate to `members`)
- Modify: `immich/mobile/pubspec.yaml` (path dependency)
- Modify: `immich/mobile/lib/main.dart:64-65` (`RustLib.init()` first in `initApp()`)
- Modify: `immich/mobile/lib/pages/login/login.page.dart:40` (show the core version)

**Interfaces:**
- Consumes: `dc_core::version()`, `dc_core::chunk_plan::part_count()` (Task 0.3).
- Produces (Dart, `package:dc_core_flutter/dc_core_flutter.dart`):
  `RustLib.init()`, `String coreVersion()`, `partCount({required fileSize})`
  — the exact Dart type of `fileSize` is whatever the generator emits for
  Rust `u64` (expected `BigInt`); Step 5 records it.

- [ ] **Step 1: Generate the plugin**

```bash
cd ~/Desktop/DaemonClient/mobile/packages
flutter_rust_bridge_codegen create --help | grep -A3 -i template
flutter_rust_bridge_codegen create dc_core_flutter --template plugin
```

Expected: the help lists a `plugin` template, and a `dc_core_flutter/` folder
appears with `rust/`, `rust_builder/`, `lib/`, `example/`. If it fails with
"current package believes it's in a workspace when it's not", do Step 2's
`members` edit first and re-run. If the help shows no
plugin template, stop and record it — fall back to `flutter create
--template=plugin dc_core_flutter` followed by `flutter_rust_bridge_codegen
integrate`, and note the deviation in `DESIGN_NOTES.md`.

- [ ] **Step 2: Join the workspace and depend on `dc-core`**

In `mobile/Cargo.toml`, set:

```toml
members = ["core/dc-core", "packages/dc_core_flutter/rust"]
```

In `mobile/packages/dc_core_flutter/rust/Cargo.toml`, under `[dependencies]`, add:

```toml
dc-core = { path = "../../../core/dc-core" }
```

Delete the template's demo (`rust/src/api/simple.rs` and its `mod` line in
`rust/src/api/mod.rs`).

- [ ] **Step 3: The API**

`mobile/packages/dc_core_flutter/rust/src/api/core.rs`:

```rust
//! What the apps can call. Deliberately thin: the logic lives in dc-core.

#[flutter_rust_bridge::frb(sync)]
pub fn core_version() -> String {
    dc_core::version().to_owned()
}

#[flutter_rust_bridge::frb(sync)]
pub fn part_count(file_size: u64) -> u64 {
    dc_core::chunk_plan::part_count(file_size)
}

#[flutter_rust_bridge::frb(init)]
pub fn init_app() {
    flutter_rust_bridge::setup_default_user_utils();
}
```

Add `pub mod core;` to `rust/src/api/mod.rs`, then:

```bash
cd ~/Desktop/DaemonClient/mobile/packages/dc_core_flutter
flutter_rust_bridge_codegen generate
```

`mobile/packages/dc_core_flutter/lib/dc_core_flutter.dart`:

```dart
/// DaemonClient's Rust core, for the Photos and Drive apps.
library;

export 'src/rust/api/core.dart';
export 'src/rust/frb_generated.dart' show RustLib;
```

- [ ] **Step 4: Write the failing integration test**

`mobile/packages/dc_core_flutter/example/integration_test/core_test.dart`:

```dart
import 'package:dc_core_flutter/dc_core_flutter.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(() async => RustLib.init());

  test('the app reaches the Rust core and reads its version', () {
    expect(coreVersion(), matches(RegExp(r'^\d+\.\d+\.\d+$')));
  });

  test('file sizes above 2^53 cross the bridge exactly', () {
    expect(partCount(fileSize: BigInt.from(2147483648)), BigInt.from(108));
    expect(partCount(fileSize: BigInt.parse('18014398509481984')), BigInt.parse('904203642'));
  });
}
```

(18014398509481984 = 2^54, beyond what a Dart `double` holds exactly;
⌈2^54 / 19,922,944⌉ = 904,203,642.)

- [ ] **Step 5: Run it on the Simulator**

```bash
cd ~/Desktop/DaemonClient/mobile/packages/dc_core_flutter/example
flutter test integration_test -d "<iPhone simulator name>"
```

Expected: both tests PASS. If `partCount` turned out to take `int` rather than
`BigInt`, the 2^54 case is the bug this test exists for: change the Rust
signature until the generated Dart uses `BigInt`, and record what was
generated.

To prove the test can fail, temporarily change `part_count` in `core.rs` to
`dc_core::chunk_plan::part_count(file_size) + 1`, regenerate, re-run (Expected:
FAIL), then revert.

- [ ] **Step 6: Wire it into the Photos app**

`immich/mobile/pubspec.yaml`, under `dependencies:`:

```yaml
  dc_core_flutter:
    path: ../../mobile/packages/dc_core_flutter
```

`immich/mobile/lib/main.dart` — first line of `initApp()`. `main()` calls
`initApp()` inside its `try`, so a missing native library shows the bootstrap
error screen instead of crashing; the existing integration tests call
`initApp()` too, so the sign-in screen they render can reach the core:

```dart
Future<void> initApp() async {
  await RustLib.init();
  await initializeDateFormatting();
```

with `import 'package:dc_core_flutter/dc_core_flutter.dart';` added.

`immich/mobile/lib/pages/login/login.page.dart` line 40, the version label:

```dart
                  'v${appVersion.value} · core ${coreVersion()}',
```

with the same import added.

- [ ] **Step 7: Gate 2 — real devices**

```bash
cd ~/Desktop/DaemonClient/immich/mobile
flutter pub get && (cd ios && pod install)
flutter run -d "<iPhone simulator name>"
xcrun simctl io booted screenshot ~/Desktop/p0-4-ios.png
flutter run -d <android emulator or the Samsung>
adb exec-out screencap -p > ~/Desktop/p0-4-android.png
```

Expected: the sign-in screen reads `v2.7.5 · core 0.1.0` on both. Describe the
screenshots in `DESIGN_NOTES.md`.

- [ ] **Step 8: Gate 3** — security (no new permissions, nothing logged) and
spec (SPEC §3 layout, D13) reviews on the unstaged diff.

- [ ] **Step 9: Commit code, then docs**

```bash
git add mobile/Cargo.toml mobile/Cargo.lock mobile/packages/dc_core_flutter \
  immich/mobile/pubspec.yaml immich/mobile/pubspec.lock \
  immich/mobile/lib/main.dart immich/mobile/lib/pages/login/login.page.dart \
  immich/mobile/ios/Podfile.lock
git commit -m "feat(mobile): call the Rust core from the Photos app"
```

Inspect `git diff --cached --stat` before committing — generated build folders
must not be in it.

---

### Task 0.5: CI

**Files:**
- Create: `.github/workflows/mobile-core.yml`
- Modify: `.github/workflows/mobile-build.yml` (Rust for both jobs; trigger on `mobile/**`)

- [ ] **Step 1: Core workflow**

`.github/workflows/mobile-core.yml`:

```yaml
# The Rust core shared by the Photos and Drive apps (docs/mobile/SPEC.md §3).
name: mobile-core

on:
  workflow_dispatch:
  push:
    branches: [main]
    paths:
      - 'mobile/**'
      - '.github/workflows/mobile-core.yml'
  pull_request:
    paths:
      - 'mobile/**'
      - '.github/workflows/mobile-core.yml'

defaults:
  run:
    working-directory: mobile

jobs:
  core:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v4
      # rustup is preinstalled; it reads mobile/rust-toolchain.toml.
      - run: cargo fmt --all --check
      - run: cargo clippy -p dc-core --all-targets -- -D warnings
      - run: cargo test -p dc-core
```

- [ ] **Step 2: The mobile build now needs Rust (and the Flutter patch)**

In `.github/workflows/mobile-build.yml`, add `'mobile/**'` to `paths:`. In the
`android-apk` job, after `setup-java`:

```yaml
      - name: Rust for the core
        working-directory: mobile
        run: rustup show
```

In the `ios-simulator` job, after `setup-xcode`, the same step.

**Added 2026-10-06 (Task 0.2a):** in the `ios-simulator` job, after
`subosito/flutter-action`, patch Flutter the way mise does locally
(subosito sets `FLUTTER_ROOT`, which the script reads when mise is absent):

```yaml
      - name: Patch Flutter for Swift macros (upstream Immich, RESEARCH §7)
        run: bash ios/scripts/xcode_flutter_patch.sh
``` (`rustup show`
installs the toolchain and targets listed in `mobile/rust-toolchain.toml`.)

- [ ] **Step 3: Verify locally what CI will run**

```bash
cd ~/Desktop/DaemonClient/mobile
cargo fmt --all --check && cargo clippy -p dc-core --all-targets -- -D warnings && cargo test -p dc-core
```

Expected: PASS.

- [ ] **Step 4: Commit.** CI is confirmed green after the operator approves
the push — record the run URLs in `DESIGN_NOTES.md` then.

```bash
git add .github/workflows/mobile-core.yml .github/workflows/mobile-build.yml
git commit -m "ci(mobile): test the Rust core; install Rust for mobile builds"
```

---

### Task 0.6: Clean-up proposal and the P1 plan

**Files:**
- Create: `docs/mobile/plans/cleanup-proposal.md`
- Create: `docs/mobile/plans/P1-core.md`

- [ ] **Step 1: Inventory** every top-level entry in `immich/`: size
(`du -sh`), whether anything we build references it (grep the web build,
`pnpm-workspace.yaml`, `immich/mobile`, CI), and a recommendation (keep /
delete / ask Linux). `FORK.md` says `server/`, `machine-learning/`, `docker/`,
`e2e/`, `cli/` are unused; verify each claim with a grep.

- [ ] **Step 2: Write `cleanup-proposal.md`** as a table with that evidence,
plus what must change with each deletion (e.g. `pnpm-workspace.yaml`
`packages:`) and who verifies the web build (the Linux machine).

- [ ] **Step 3: Write `plans/P1-core.md`** with this file's structure: tasks
1.1–1.7 from `PLAN.md`, each with files, interfaces, failing tests, code and
gates. Inputs: SPEC §4, RESEARCH §2 and §6, the flutter_rust_bridge type
mappings observed in 0.4.

- [ ] **Step 4: Commit docs; stop for the operator's review of both.**

```bash
git add docs/mobile/plans/cleanup-proposal.md docs/mobile/plans/P1-core.md docs/mobile/PLAN.md docs/mobile/DESIGN_NOTES.md
git commit -m "docs(mobile): clean-up proposal and the detailed P1 plan"
```
