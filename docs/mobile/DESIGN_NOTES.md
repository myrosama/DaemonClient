# Mobile apps — design notes

One entry per task: what the plan said, what happened, decisions made along
the way, security findings, and the gate evidence. After a context reset, the
*why* is reconstructed from here — read it, do not re-derive it.

Append, never rewrite. A note that turns out wrong gets a correction under it.

**Format:**

```
## <task> — <title>            <date>

**Planned:** what the phase plan said.
**Did:** what actually happened, and any deviation with its reason.
**Decisions:** anything chosen at implementation time that the plan left open.
**Security:** findings raised, fixed, or accepted-and-tracked.
**Gate evidence:** G1 test names · G2 transcript/screenshots described · G3 reviewers and findings · G4 commits.
```

---

## — Research, spec and plan            2026-10-04

**Planned:** nothing; this preceded the plan.

**Did:** researched Drive UI references and the existing storage formats
(`RESEARCH.md` §1–§6), wrote `SPEC.md` (approved by the operator the same day)
and `PLAN.md` with the detailed P0 plan.

**Decisions:**
- Order changed by the operator from core → Drive → Photos to
  core → **Photos** → Drive (D7).
- Cargo workspace root moved from `mobile/core/` (first draft) to `mobile/`
  so the flutter_rust_bridge crate can be a workspace member: one lockfile,
  one build folder (D13).
- Images are decoded by the platform, not by Rust — PhotoKit / ImageDecoder
  read HEIC, RAW and video frames with hardware acceleration. Rust's work in
  media is decryption, range-to-part mapping and prefetching (SPEC §5.1).
- HEIC on Android goes through a JPEG preview made by the uploading phone;
  storing it needs `clientUpload` to accept `telegramPreviewId` — an additive
  worker change for the Linux machine (SPEC §5.1).
- Background upload reuses the fork's `background_downloader` (URLSession on
  iOS) to send pre-encrypted parts straight to Telegram (SPEC §5.2).
- `RustLib.init()` goes first in `initApp()`, not in `main()`, because the
  existing integration tests call `initApp()` but not `main()`.

**Blockers found:** 19 GB free disk (≥45 GB needed, P0 Task 0.1); no JDK; no
iOS Simulator runtime yet.

**Gate evidence:** docs only — no gates apply.

> **Correction, same day (operator):** the apps upload **no preview** (D14).
> The preview was added on the web so browsers could show HEIC; iPhones and
> Android 9+ decode HEIC natively, so the apps show blur → thumbnail →
> original, and the planned `telegramPreviewId` worker change is dropped. One
> fewer Telegram message per photo also eases rate limits during backup.
> Added the same day: smart loading (D15, SPEC §4.9) — the operator wants
> visible thumbnails first and scrolled-away requests dropped. Immich already
> cancels off-screen image requests, so the core cancels the matching
> Telegram fetch when the local-server connection closes.

---

## 0.1 — Toolchain (partial)            2026-10-05

**Planned:** free ≥45 GB, then Rust, Flutter (mise), CocoaPods, Simulator
runtime, JDK 21, Android SDK, flutter_rust_bridge codegen.

**Did:** Rust only — `rustc 1.99.0 (b940084d7 2026-09-28)` via rustup
(`--profile minimal`, + rustfmt, clippy, and the six iOS/Android targets).
Pinned in `mobile/rust-toolchain.toml`. Everything else waits for disk: 22 GB
free on 2026-10-05; most of the disk is in two other macOS accounts on this
Mac, which this account cannot read. `mobile/mise.toml` is not created yet
(Step 3 needs Flutter).

**Gate evidence:** no code; `flutter doctor` pending.

> **Completed 2026-10-06.**
> - **Disk:** 19 GB → 44 GB free. Removed with the operator's approval: the
>   Claude desktop VM bundle (11 GB), the Microsoft Office apps + OneDrive
>   (~11 GB), Autodesk Fusion 360 data in the `macbookair` account (12 GB),
>   the empty leftover home folder of the already-deleted account
>   `abdirimovbunyodbek701` (484 KB — the account deletion had worked),
>   installers and caches. Admin steps ran under the operator's own approval
>   prompts; the password is stored nowhere.
> - **Installed at user level (this account is not an administrator):**
>   Flutter 3.41.7 via mise (`mobile/mise.toml`), CocoaPods 1.17.0
>   (Homebrew), Java Temurin 21.0.12 via `mise use -g` (the `temurin@21` cask
>   needs sudo), Android SDK (platform 36, build-tools 36.0.0, platform-tools,
>   `cmdline-tools;latest`), flutter_rust_bridge_codegen 2.13.0. The iOS 27.0
>   platform + Simulator runtime came from Xcode → Settings → Components (the
>   operator), which handles the admin prompt itself.
> - **Deviation:** no Android emulator image (7 GB) — Android Gate 2 uses the
>   Samsung over USB.
> - **`flutter doctor`:** Flutter ✓, Xcode 27.0 ✓, Chrome ✓, devices ✓,
>   network ✓. Android: SDK and Java found; **"license status unknown"** —
>   the 2026 cmdline-tools answer `--licenses` with "no longer needed", which
>   Flutter 3.41.7 cannot parse. License files are present in
>   `~/Library/Android/sdk/licenses`. Task 0.4's first Android build is the
>   real check.

---

## 0.3 — Cargo workspace and `dc-core` with `chunk_plan`            2026-10-05

**Planned:** workspace at `mobile/`; `dc-core` with `part_count` and
`parts_for_range(...) -> Option<Vec<PartSlice>>`; 12 tests.

**Did:** as planned, then changed at Gate 3. The eager `Vec` became a lazy
plan: `plan_range(...) -> RangePlan { Partial(PartSlices) | Unsatisfiable |
Ignore }`, plus `plan_suffix(...)` for `bytes=-N`. 19 tests.

**Decisions:**
- **Serve the whole requested range, across parts.** The web's
  `planVideoRange` answers one part per request; its own comment says native
  players (AVPlayer, ExoPlayer) treat a short `206` as end-of-file, and the
  worker's `handleOriginal` serves the full range. The phone feeds native
  players, so it follows the worker.
- **Lazy, not a list.** A corrupt manifest size (e.g. `u64::MAX`) with a
  player's `bytes=0-` would have meant ~9.3e11 entries (~22 TB) and an abort.
  `PartSlices` holds five numbers whatever the size. Never `collect()` it from
  an untrusted size — **P1 1.5 must validate the manifest** (part list length
  == `part_count(file_size)`, except one stored part for a 0-byte upload —
  `assets.ts:1788,1858`).
- **Invalid range (start after end) → `Ignore` → `200` whole file** (RFC 9110
  §14.2 "MAY ignore"). Differs from the web/worker (one byte, or `416` past the
  end); players never send it. `Ignore` takes precedence over
  `Unsatisfiable`, since satisfiability is only defined for valid ranges —
  pinned by a test.
- **Suffix ranges:** `-0` → `416`; longer than the file → whole file; any
  non-zero suffix on an empty file → `Ignore` (§14.1.1). iPhone video opens
  with a suffix request to find its index, so this is load-bearing.
- **Strict lints** for the core: `unsafe_code` forbidden;
  `cast_possible_truncation`, `indexing_slicing`, `unwrap_used`, `expect_used`
  denied outside tests (`mobile/clippy.toml` allows them in tests). Verified
  they fire by injecting each into non-test code.
- Carry into P1: indexes into a part list must use `usize::try_from`, never
  `as usize` — armv7 Android has a 32-bit `usize`, and a wrapped index would
  fetch the wrong part, which decrypts fine and shows wrong bytes silently.
  The lint above enforces it.

**Security:** round 1 — security reviewer: 0 HIGH, 1 MEDIUM (unbounded
allocation from `file_size`), 3 LOW (one result for three cases; armv7
`usize`; lints); spec reviewer: 0 HIGH, 1 MEDIUM (same allocation), 5 LOW
(start>end wording vs test name; RFC section; suffix ranges undocumented;
"every remaining part" undocumented; records: toolchain pin, moved line
reference, 0-byte part count). All fixed. Round 2, a fresh reviewer: MEDIUM
resolved (3M random cases, no allocation, no overflow); 4 new LOW — wrong RFC
section, suffix on an empty file, untested precedence, "never collect" and a
stale plan document — all fixed.

**Gate evidence:**
- **G1:** tests written first and shown failing (`not implemented`, 11/12,
  then 16/17, then 1/19 for the empty-file suffix); now 19/19 pass; clippy
  `-D warnings` and `fmt --check` clean. Test names include
  `a_hostile_file_size_is_streamed_part_by_part_never_allocated_at_once`,
  `the_iphone_moov_probe_gets_the_last_bytes_of_the_file`,
  `an_invalid_range_is_ignored_even_when_it_also_starts_past_the_end`.
- **G2:** the production web planner (`telegram-media.ts` `planVideoRange`,
  run unmodified under Node 26) and `plan_range` on the same 2,754 ranges
  (9 file sizes up to 4 GiB, part boundaries, starts past the end, 2,700
  seeded random ranges): **0 mismatches** on part index, in-part offsets,
  `byte_range`, total coverage and 416 cases. A real device/network run is
  not applicable to pure arithmetic; it happens in P1 1.6 (media server).
- **G3:** above. **G4:** this commit pair.

---

## — Replan: HEIC previews and the scheduler's source            2026-10-05

**Planned:** D14 said the apps upload no preview.

**Did:** the operator asked what happens when an app-uploaded HEIC is opened
on the website. Checked the code (RESEARCH §8): the web viewer asks for a
preview and, with none, gets the HEIC original, which Chrome and Firefox cannot
draw. So **D18** brings the preview back for HEIC/HEIF/RAW only, through the
existing `POST /api/assets/:id/thumbnail` route the web's HEIC Fix tool already
uses — no worker change. The operator also asked to copy an existing
smart-loading algorithm rather than invent one: no Rust image scheduler exists,
so **D19** ports Nuke's (MIT) design onto Rust building blocks
(`governor`, `tokio-util`), keeping the operator's opened-first and
newest-first rules (RESEARCH §9, SPEC §4.9).

**Decisions:** the preview passes through the worker (a few hundred KB of
derived JPEG, the same as the web Fix tool) — a small, recorded exception to
"no file bytes through the worker". A later additive change could let
`clientUpload` take `telegramPreviewId` directly; not needed now.

**Gate evidence:** docs only.

---

## 0.2a — Make the Photos fork build on Xcode 27            2026-10-06

**Planned:** nothing — Task 0.2 said "if the build fails, record the error and
stop; the fix becomes its own task in P2". **Deviation:** SPEC §9's P0 exit
needs the app running on the Simulator for Task 0.4, so the spec wins; added
as Task 0.2a (`PLAN.md`), with an amendment note under Task 0.2.

**Did:** three causes, each already fixed upstream by Immich, found one after
another by following the evidence (RESEARCH §7): iOS minimum 13/14 → 15.0;
Flutter's simulator `-sdk` flag builds Swift macro programs for the Simulator
(upstream's mise `postinstall` patch, ported); `swift-sharing` 2.7.4 cannot link
against the iOS 27 SDK (pins moved to upstream's).

**Decisions:**
- **Follow upstream exactly** wherever it already solved the problem —
  Podfile and project deployment targets, package pins and commits, the patch
  script — so future Immich merges stay clean.
- **Patch script, DaemonClient changes** (from Gate 3): mise's install path is
  read first, then `FLUTTER_ROOT` (CI), then `mise where flutter`; fails loudly
  if `mac.dart` is missing or the line is still there afterwards (e.g. a
  read-only SDK); the mise hook quotes `{{config_root}}`.
- **The project-level `Package.resolved`** (not used by Flutter's workspace
  build) carries the same pins as the workspace one, plus GRDB 7.9.0; upstream's
  copy of that file is stale.
- **Minimum iOS 15.0** drops no iPhone that iOS 14 supported; the app is not
  distributed yet.

**Fork files changed by this task** (SPEC §10 asks for this list):
`immich/mobile/ios/Podfile`, `ios/Podfile.lock` (CocoaPods 1.16.2 → 1.17.0 and
the Podfile checksum only), `ios/Runner.xcodeproj/project.pbxproj` (six
deployment-target lines), both `Package.resolved` files, `immich/mobile/mise.toml`,
new `ios/scripts/xcode_flutter_patch.sh`.

**Security:** security reviewer — 0 HIGH, 0 MEDIUM, 3 LOW (`FLUTTER_ROOT`
precedence over mise's path; silent success on a read-only SDK; unquoted
`{{config_root}}`) — all fixed; confirmed the three pins are upstream's commits
and their tags' commits, and that nothing touches signing, entitlements or ATS.
Spec reviewer — 0 HIGH, 3 MEDIUM (deviation not recorded; "issue open two
years" false — flutter#146122 was closed 2024-04-04; CI step and existing
installs not covered), 6 LOW (CI history detail, "two causes" vs three,
`-sdk` only for simulator builds, the project-level resolved file, script
precedence, user-impact wording) — all fixed in code or these records.

**Gate evidence:**
- **G1:** the build is the test — it failed with each cause in turn
  (`/tmp/dc-p02/run-*.log`, `xcodebuild*.log`, not kept) and now succeeds
  (`Xcode build done. 108.5s`). Patch script, five cases on fake SDK trees:
  mise path wins over `FLUTTER_ROOT` (other SDK untouched); second run is a
  no-op; read-only SDK exits 1 ("patch not applied"); `FLUTTER_ROOT` alone (CI)
  works; a hook path with a space works; a missing `mac.dart` exits 1.
- **G2:** `flutter run` on the iPhone 18 Pro Simulator (iOS 27): the app
  launched for the first time on iOS — sign-in screen, "immich" logo (iOS is
  not rebranded yet), server prefilled `https://api.daemonclient.uz`, v2.7.5.
  The central API answers the discovery calls behind "Next" (`/.well-known/immich`
  `{}`, `/api/server/ping` pong, version 2.7.5, features, config — all 200).
- **Pending:** proof that the mise hook fires on a real install — run
  `mise install --force flutter` in `immich/mobile` before the 0.4 rebuild and
  paste its output here. (On this Mac the patch was applied by running the
  script by hand, since Flutter was already installed.)
- **G3:** above. **G4:** code and docs commits below.

> **Hook proof, 2026-10-12 (closes "Pending" above):** `mise install --force
> flutter` in `immich/mobile` reinstalled Flutter 3.41.7 — the 2.15 GB download
> needed resumable retries through DNS failures, and the zip's SHA-256
> (`2e3e6af44d1adccf695deff52e5e4c8beb10e5625066b27ad082b38b83ef805e`) was
> checked — and the `postinstall` hook removed the line: the patched
> `buildCommands.addAll(...IPhoneSimulator...)` line occurs 0 times in the
> installed `mac.dart` (still 0 on 2026-10-29; the file's date is the
> reinstall's). 0.2a is done.

---

## 0.2 — What the existing Photos fork does at sign-in            2026-10-12

**Planned:** run the fork in the Simulator and record what it does at sign-in.
**Did:** recorded in RESEARCH §7 part 2 (2026-10-06): the hosted address signs
in but the sync has no host; the per-user worker address signs in and syncs,
with an empty timeline on that account. On 2026-10-12 the operator signed in
with their own account and saw their photos — through the old path that sends
whole files through the worker, which P1 and P2 replace. (Asked the Linux
machine whether the first account has photos at all.)
**Decisions:** none. No code — evidence only, so no Gate 3 (`GATES.md`
proportional rigor).
**Gate evidence:** RESEARCH §7 part 2 and its 2026-10-12 update.

---

## 0.4 — `dc_core_flutter` and the first Rust call from the Photos app            2026-10-29

**Planned:** a Flutter plugin over `dc-core` (flutter_rust_bridge 2.13.0);
the Photos app shows the core version on its sign-in screen, on the iOS
Simulator and on Android.

**Did:**
- `mobile/packages/dc_core_flutter/`, generated with `flutter_rust_bridge_codegen
  create … --template plugin --platforms ios,android`; the desktop platforms and
  the template's `simple.*` demo removed. Dart API: `coreVersion()` and
  `partCount({required BigInt fileSize})` — Rust `u64` arrives in Dart as
  `BigInt`, which keeps sizes above 2^53 exact (P1's API should keep that).
  The example app is a one-screen check; `example/integration_test/core_test.dart`
  holds the bridge tests. The binding crate is a workspace member.
- Photos app: path dependency in `pubspec.yaml`; `await RustLib.init()` is the
  first line of `initApp()` in `lib/main.dart` (the file uses CRLF line
  endings — kept; the diff is two lines); the sign-in page shows
  `v<app> · core <version>`.
- **Branding (operator, 2026-10-12, SPEC D20):** home-screen name "Photos"
  (`CFBundleDisplayName`; Android `android:label`, debug build "Photos-Debug"),
  app icon, launch/splash images and in-app logos drawn from
  `drive/public/logo.png` on white; the Immich logo no longer spins on the
  sign-in screen. The drawing scripts are `mobile/tools/brand/` — they
  reproduce all 58 committed images byte for byte. The icon/splash generator
  sources (`assets/immich-logo-android-adaptive-icon.png`,
  `immich-logo-w-bg.png`, `immich-splash*.png`) now hold our images, so
  re-running `flutter_launcher_icons` / `flutter_native_splash` no longer
  brings the Immich logo back.
- **Deviations from the P0 plan:** the template ships `cargokit/`, not
  `rust_builder/`; Android Gate 2 ran on an emulator (Pixel 8 image, API 36,
  AVD `dc-test`) instead of the Samsung over USB that the 0.1 entry planned;
  Android shows `v2.7.5-DEBUG` (Immich's debug suffix) where the plan expected
  `v2.7.5`.

**Upstream breakages met on the way (each checked, not guessed):**
- The plugin template targets iOS 13; Xcode 27 needs 15 → podspec, example
  Podfile and example project raised to 15.0.
- `libc` 0.2.190 restricted `_dyld_image_count` / `_dyld_get_image_name` to
  macOS, so `backtrace` 0.3.76 (via flutter_rust_bridge) failed to compile for
  iOS. Pinned to 0.2.189 on 2026-10-12; on 2026-10-29 0.2.190 still fails
  and **0.2.191 builds** for `aarch64-apple-ios` and `-sim`, so the lock now
  holds 0.2.191 and nothing is pinned. The iOS build in CI (0.5) guards it.
- Android: `home_widget` 0.8.1 declares `androidx.work:work-runtime-ktx:2.+`,
  which now resolves to WorkManager 2.12.0 — compiled for JVM 11
  (`OneTimeWorkRequestKt.class` major 55), so its inline
  `OneTimeWorkRequestBuilder` cannot be inlined into home_widget's JVM 1.8
  code ("Cannot inline bytecode built with JVM target 11"). Forced 2.11.2 in
  `android/build.gradle`, next to the June glance pin: still JVM 1.8 (major
  52), the newest 2.11 fix release; background_downloader asks for 2.11.0.
  This also lifts the app's catalog pin (`work = "2.9.1"`) — P2 2.6 relies
  on WorkManager. Remove the force once home_widget pins its own version.
- The root `.gitignore` rule `lib/` silently ignored the plugin's whole Dart
  API and cargokit's build tool — a fresh clone could not have built the
  core (the same trap as `b1a466d`). Fixed with `!mobile/**/lib/`.
- Two Android build failures went away on a rerun with no change: a Gradle
  build-cache store error ("Could not get file mode for …/merged.dir/values-in")
  and a CMake failure in the `jni` package right after Gradle installed CMake
  3.22.1. A third failure on 2026-10-27 was a full disk (881 MB free); freeing
  build folders fixed it.

**Decisions:**
- **Logging off at start.** FRB's template calls `setup_default_user_utils()`,
  which turns on Trace-level Rust logging to logcat and os_log (`%{public}s`,
  no redaction) and sets `RUST_BACKTRACE=1`. `init_app` is now empty; the
  core sets up its own redacting logger in P1 (SPEC §4.8).
- **Binding crate settings.** It takes the workspace's version, edition 2024
  and `publish = false` (it builds and tests on 2024 — checked). It does not
  take the workspace lints, because the generated `frb_generated.rs` needs
  `unsafe` and unwraps; `src/api/mod.rs` — the hand-written part — forbids
  `unsafe` and denies unwrap/expect/indexing itself.
- **cargokit:** `rust/cargokit.yaml` passes `--locked` (app builds use exactly
  `mobile/Cargo.lock`) and has no `precompiled_binaries` section, so cargokit
  always builds from source and never downloads a binary. Local patch:
  `cargokit/build_pod.sh` no longer runs `env`, which printed every
  environment variable into the Xcode build log.
- **cargokit ignores `mobile/rust-toolchain.toml`:** it runs `rustup run stable
  cargo build` (`builder.dart`: `_toolchain ?? 'stable'`; only
  stable/beta/nightly accepted). Today stable is 1.99.0, the pin. Task 0.5
  adds a CI check that fails when they differ.
- **Plugin metadata:** licence pointer to the repo's AGPL-3.0, accurate README,
  pubspec and podspec text, Android namespace `uz.daemonclient.dc_core_flutter`;
  the template's unused `ffi`, `ffigen` and `plugin_platform_interface`
  dependencies removed.

**Fork files changed by this task** (SPEC §10 asks for this list), under
`immich/mobile/`: `pubspec.yaml`, `pubspec.lock`, `lib/main.dart`,
`lib/pages/login/login.page.dart`, `lib/widgets/forms/login/login_form.dart`,
`ios/Podfile.lock`, `ios/Runner/Info.plist`, the iOS `AppIcon` and
`LaunchImage` PNGs, `assets/immich-{logo,logo-w-bg,logo-android-adaptive-icon,
splash,splash-android12,text-light,text-dark}.png`,
`assets/immich-logo-inline-{light,dark}.{png,svg}`, `android/build.gradle`,
`android/app/src/main/AndroidManifest.xml`,
`android/app/src/debug/AndroidManifest.xml`,
`android/app/src/main/res/values/colors.xml`, and the Android `mipmap-*`
launcher and `drawable{,-night}-*` splash PNGs. Images keep Immich's file
names so code and generator configs need no change.

**Security:** reviewer (2026-10-27; a first run on 10-13 stopped at a usage
limit before reporting) — 0 HIGH, 2 MEDIUM, 2 LOW, 4 INFO.
- MEDIUM: FRB's default init turned on Trace logging to the device log, where
  an HTTP client's debug line would carry the bot token → `init_app` emptied;
  test `starting_the_app_turns_on_no_logging` failed first (`left: Trace`).
- MEDIUM: `!mobile/**/lib/**` re-included `.env` files and keys under any
  `lib/`, overriding the SECRETS rules (`git check-ignore` proved it) → the
  `lib/**` lines removed for `mobile/` **and** `immich/mobile/` (same flaw,
  older); 461 Dart files checked still trackable, secret paths ignored again.
  A similar rule outside the mobile folders belongs to the Linux machine and
  was passed to it, not edited here.
- LOW: cargokit's `env` line → removed. LOW: WorkManager 2.11.0 missed two fix
  releases → 2.11.2.
- INFO, taken: `--locked`; module-level lints in the binding; no
  `cargo-deny` yet → Task 0.5. INFO, confirmed fine: no precompiled-binary
  download; vendored cargokit identical to the FRB template; the new SVGs
  hold one embedded PNG and nothing active; PNG metadata has no GPS, author
  or paths.
- INFO, recorded for the operator: "Photos" is also the system app's name —
  the iOS permission prompt will read "“Photos” Would Like to Access Your
  Photos" (SPEC §10, before P4).

Spec reviewer (2026-10-27) — 0 HIGH, 2 MEDIUM, 6 LOW, 1 INFO.
- MEDIUM: the example app still called the deleted `greet()` and did not
  compile → rewritten; `flutter analyze` clean for plugin and example.
- MEDIUM: "Photos" contradicted SPEC D9/§5 → SPEC D20, §5 item 1, §10 risk,
  §11 line; PLAN 2.1 narrowed.
- LOW: libc pin unexplained → resolved upstream, see above. LOW: cargokit
  ignores the pin → recorded, PLAN tech stack and P0 0.5 amended. LOW: template
  leftovers → replaced. LOW: generator sources still Immich's → replaced, with
  `mobile/tools/brand/`. LOW: Dart-side Gate 1 evidence missing → run, below.
  LOW: commits must be split → done (G4). INFO: binding crate exceptions →
  recorded above.
- Records it asked for: 0.2a hook proof (above), 0.2 entry (above), RESEARCH
  §7 part 2 corrections, EXECUTION_STATUS, NOW.md (the names were sent to
  Linux on 10-13), and **push 0.4 together with 0.5** — the Photos CI build
  needs Rust from now on.

**Gate evidence:**
- **G1:** bridge tests written first (`core_test.dart`: version string; 2 GiB →
  108 parts; 2^54 → 904,203,642 parts) — 2/2, and a deliberately broken core
  made them fail. `starting_the_app_turns_on_no_logging` failed before the
  fix and passes after. Rust: `cargo fmt --check`, `cargo clippy --workspace
  --all-targets` with the workspace's deny lints, `cargo test --workspace` —
  21 tests. Dart: `flutter analyze` clean for the plugin and its example; in
  `immich/mobile`, `flutter analyze lib test` — no issues (a whole-folder
  `flutter analyze` reports 175 errors, all in upstream's
  `packages/ui/showcase`, whose packages were never fetched — not app code);
  `flutter test` — 668 passed, 1 skipped.
- **G2:**
  - iOS 27 Simulator (iPhone 18 Pro), 2026-10-12: sign-in screen shows
    "v2.7.5 · core 0.1.0", the DaemonClient logo and wordmark; home screen
    shows "Photos" with the cloud icon.
  - Android emulator (API 36), 2026-10-13: sign-in screen "v2.7.5-DEBUG · core
    0.1.0"; app list shows "Photos-Deb…" with the cloud icon inside the round
    mask (a first try at 56% touched the mask; 46% fits); Android 12 splash
    shows the whole logo; `aapt2 dump badging` → application-label
    'Photos-Debug'.
  - After the Gate 3 fixes: bridge tests 2/2 on the Android emulator
    (2026-10-27) and on the iOS Simulator under Xcode 27.1 (2026-10-29). The
    rebuilt Photos APK resolves `androidx.work:work-runtime-ktx` → 2.11.2
    (`gradlew :app:dependencies`), launches and gets past `RustLib.init()`,
    and logcat shows no Rust log lines. The emulator had meanwhile been signed
    in to a real account (not the test account), so the app opened on its
    library — the run was stopped there and the screenshot deleted (D10); the
    sign-in label was not re-photographed.
- **G3:** above. **G4:** code commits (core plugin, Photos wiring, Android
  build fix, branding, `.gitignore`) and docs commits below; not pushed —
  0.4 goes out with 0.5.

> **Correction to the 0.4 entry, 2026-10-29:** its G1 says `cargo fmt --check`
> passed. That was true before the binding crate moved to edition 2024; after
> the move, rustfmt orders the generated `frb_generated.rs` imports
> differently from flutter_rust_bridge_codegen, so the check failed at the
> 0.4 commits. Found while preparing 0.5 and fixed there (`rustfmt.toml`).

---

## 0.5 — CI            2026-10-29

**Planned:** the core's format, lint and tests on every change under
`mobile/`; the app builds install Rust and the iOS job applies the Flutter
patch; the 2026-10-27 amendments (cargokit's `stable` must equal the pinned
Rust; a dependency audit).
**Did:**
- `.github/workflows/mobile-core.yml` (new): `rustup show`, `cargo fmt --all
  --check`, `cargo clippy --workspace --all-targets --locked -D warnings`,
  `cargo test --workspace --locked`; a separate `audit` job (cargo-deny,
  advisories); also weekly (Monday 04:17 UTC).
- `.github/workflows/mobile-build.yml`: runs on `mobile/**` too; both jobs
  install Rust and stop with a message when `stable` is not the pinned
  version; the iOS job runs `ios/scripts/xcode_flutter_patch.sh` before
  building.
- **Not foreseen by the plan:** running the CI commands locally showed
  `cargo fmt --check` failing on the generated bindings (correction above).
  `mobile/packages/dc_core_flutter/rust/rustfmt.toml` sets `style_edition =
  "2021"` for that crate so `cargo fmt` and the code generator agree;
  regenerating twice leaves `fmt --check` clean. The crate still compiles as
  edition 2024.
**Decisions:**
- The audit is its own job (parallel), not a step of `core`.
- `rustup show` stays in the build jobs as the plan asked, although cargokit
  builds with `stable`; it costs about a minute.
- **The pin check will turn the build red on purpose** when Rust stable moves
  (1.100.0 is expected around 2026-11-12 on the six-week cycle, sooner with a
  1.99.x point release). Then: edit `mobile/rust-toolchain.toml`, re-run the
  core's tests, commit.
**Security:** reviewer — 0 HIGH, 0 MEDIUM, 3 LOW, all fixed (`e9eb128`):
third-party actions pinned to commits (resolved with `git ls-remote`,
matching the reviewer's); `permissions: contents: read` and
`persist-credentials: false` everywhere; the audit also runs weekly. INFO:
no workflow injection (no `${{ }}` in any `run:`); fork pull requests get a
read-only token and no secrets; cargokit's environment dump is gone; nothing
secret is compiled into the artefacts.
Spec reviewer — 0 HIGH, 0 MEDIUM, 2 LOW, INFO: the 0.4 record (corrected
above); tokio 1.53.2 carries RUSTSEC-2026-0386 ("unsound", `AsyncFd`) —
reached only through flutter_rust_bridge today, but P1 task 1.0 makes tokio a
direct dependency, which cargo-deny would fail → task 1.0 pins `=1.53.3`.
INFO: CI's Xcode (`latest-stable` on macos-15) is likely 26.x, not the Mac's
27.1; if the iOS job fails, check the version and consider `macos-26`.
**Gate evidence:**
- G1: locally, at the 0.5 commits — fmt check clean, clippy clean, 20 tests
  pass (`--locked`); the pin-check snippet prints `pinned 1.99.0, stable
  1.99.0`; both workflow files parse.
- G2: **pending the push** — the GitHub run URLs for `mobile-core` (core,
  audit) and `mobile-build` (android-apk, ios-simulator) go here. PLAN 0.5 is
  ticked only when all four are green (ios-simulator never has been).
- G3: above. G4: `2db0136`, `206ffc1`, `e9eb128`; not pushed.

---

## Icons — the approved Photos icon            2026-10-29

**Planned:** none — the operator approved app icons for both apps on
2026-10-29 (made on the Linux machine, `docs/mobile/icons/`, `8a695dc`).
**Did:** `mobile/tools/brand/install-photos-icon.sh` resizes the Photos set
("fanned gallery") into all 34 iOS AppIcon slots and the five Android
densities (legacy, adaptive foreground, and the Android 13 themed monochrome
icon, wired in `mipmap-anydpi-v26/ic_launcher.xml`) and refreshes the icon
generator's sources. Launch screens and in-app logos stay the DaemonClient
logo. The brand README marks the old icon outputs as superseded.
**Decisions:** assets only (plus one XML line and a resize script), so no
Gate 3 under GATES.md's proportional rigor.
**Gate evidence:** G2 — iOS: the built app's `AppIcon60x60@2x.png` is the new
icon, and the copy installed on the iPhone 18 Pro Simulator is byte-identical
(the home screen shows it on its second page; the first screenshot showed the
old icon from a stale build — see below). Android emulator: the home screen
shows the new icon. The iOS 1024 icon has no alpha. Commit `d52c269`.

---

## Finding — Xcode 27.1 breaks `flutter build ios --simulator`            2026-10-29

Xcode auto-updated to 27.1 on 2026-10-16. Its `lipo` rejects several
architectures after `-verify_arch` (`lipo: -verify_arch requires exactly one
input file`; each architecture alone passes). Flutter 3.41.7's
`debug_unpack_ios` checks `arm64 x86_64` in one call, so a two-architecture
Simulator build fails with "Binary … Flutter does not contain architectures
"arm64 x86_64"" although `lipo -info` lists both. `flutter run` and `flutter
test` build only the running architecture and are unaffected. Workaround for
local Simulator builds: `FLUTTER_XCODE_ARCHS=arm64 flutter build ios
--simulator --debug` (Flutter passes `FLUTTER_XCODE_*` to Xcode). CI still uses
an older Xcode. Also seen: a background build reported success because the
shell's last command (`echo`) succeeded — check Flutter's own "✓ Built" line,
not the job's exit code.

---

## 1.0 — Foundations            2026-10-29

**Planned:** `Core` with its own runtime, `Secret`, `CoreError`, the core's
logger, the HTTP client of decision C1, and an HTTPS request to Telegram from
both device types (P1-core.md Part 2, Task 1.0 — written before the code).
**Did:** as planned. Differences: rustfmt reflowed the plan's code (layout
only); versions moved for advisories — tokio 1.53.3 (RUSTSEC-2026-0386),
webpki-roots 1.0.11 (RUSTSEC-2026-0381), rustls 0.23.46 (RUSTSEC-2026-0346
to -0349); four tests and three small fixes added from Gate 3 (below).
Also in this sitting: Rust **1.99.1** (`b0dfe2a`) — the 0.4/0.5 push turned
mobile-build red exactly as the pin check intends (stable became 1.99.1 on
2026-10-13), and `cargo-deny` 0.20.2 installed on the Mac so advisories are
checked before a push.
**Decisions:** a malformed address is `Internal`, not `Network`; a panicking
task reports only "a core task panicked"; `scrub` also catches the token with
`%3A` as the separator. Accepted LOWs, each assigned (P1-core.md, end of Part
2): `https://`-only worker URLs → 1.2; the logger's sink fixed at install →
1.8 / P2; the process-wide `Core` and text errors over the bridge → P2.
**Security:** reviewer — **1 HIGH**, 0 MEDIUM, 4 LOW. HIGH: webpki-roots
1.0.9 still trusted a root with distrusted emSign intermediates whose keys
are public (RUSTSEC-2026-0381) — on hostile Wi-Fi a forged api.telegram.org
certificate would have exposed the bot token; fixed (1.0.11). LOW: rustls
advisories (not exploitable with this config) → 0.23.46; panic messages
reached Dart unscrubbed → fixed; percent-encoded tokens escaped `scrub` →
fixed; `http://` allowed → task 1.2. INFO: `scrub` fuzzed with 200k random
and 300k token-bearing lines — no panic, no leak, linear time; error texts for
refused/DNS/bad-scheme/unparsable carry no URL; `Secret` really zeroes;
only reqwest and rustls log through `log`, nothing with URLs at Info/Warn;
no certificate bypass anywhere; redirects off.
Spec reviewer — 0 HIGH, 2 MEDIUM (Gate 2 transcript missing; EXECUTION_STATUS
row stale — both fixed in this docs commit), 4 LOW (weak logger test →
strengthened; the redirect test needed the internet → now catches it on the
fake server; builder errors called "network" → fixed; sink fixed at install
→ assigned), INFO for P2 recorded above.
**Gate evidence:**
- G1: tests written first and failing (compile errors for the new modules;
  then the three Gate 3 tests failed before their fixes). `cargo test -p
  dc-core` — 33 passed; clippy (deny lints) and fmt clean;
  `cargo deny check advisories` — "advisories ok".
- G2 (after all fixes, 2026-10-29), `flutter test
  integration_test/core_test.dart` from the plugin's example:
  - iOS 27.0 Simulator, iPhone 18 Pro, Xcode 27.1: "the app reaches the Rust
    core…", "file sizes above 2^53…", "the core reaches Telegram over HTTPS
    from this device" → `00:01 +3: All tests passed!`
  - Android emulator, API 36 (`dc-test`): same three → `00:01 +3: All tests
    passed!` (A first run failed with "Connect: operation timed out": the
    emulator had lost its network — `ping` could not resolve any name — while
    the Mac reached Telegram in 0.12 s; restarting the emulator fixed it.)
- G3: above. G4: `b0dfe2a` (Rust 1.99.1), `9d9e929` (code), this docs commit.

> **0.5, G2 (2026-10-30):** after the push and the Rust 1.99.1 bump, all of
> CI is green on `3440a3c` — `mobile-core` (core + audit)
> https://github.com/myrosama/DaemonClient/actions/runs/40887140650 and
> `mobile-build` (android-apk **and ios-simulator — the first green iOS
> build ever**) https://github.com/myrosama/DaemonClient/actions/runs/40887140844.
> 0.5 is done, and with it P0 (SPEC §9 P0 exit).

---

## 1.1 — Crypto            2026-10-30

**Planned:** move the spike's crypto into `dc-core` with the production
JavaScript checks in CI (P1-core.md Part 2, Task 1.1).
**Did:** as planned — files, names, `CryptoError` variants and pins match the
plan; the spike's scripts are byte-identical; `sha1` dropped (not needed
until 1.7). From Gate 3: aes-gcm's `zeroize` feature (the expanded key is
wiped); the Rust→JS check refuses an empty part list; salts accept trailing
bits like `atob`; the Drive key-check vector is made by
`drive/src/zke-unlock.js`'s `makeKeyCheck`; a test pins the SHA-256 of both
JavaScript sources, so a change to either fails CI until `vectors.json` is
regenerated (`node mobile/core/compat/gen-vectors.mjs`). `vectors.json` changes
on every regeneration (random IVs in two sections); keys and fixed-IV answers
are reproducible.
**Decisions / carried forward:** SPEC §7 (worker-encrypted `server` assets) is
covered by inspection — the worker's `assets.ts` and the web service worker
use the same `atob` salt, PBKDF2 parameters and part layout as `crypto.js`;
the real check is reading such an asset in 1.5. `verify_drive_key` returns
`false` for a malformed check as for a wrong password → P3 (Drive unlock).
`From<CryptoError> for CoreError` → 1.5. `derive_key` is slow by design → 1.2
calls it through `spawn_blocking`.
**Security:** reviewer — 0 HIGH, 0 MEDIUM, 2 LOW (expanded key not zeroized →
fixed; malformed check reads as wrong password → P3), INFO (atob edge cases →
fixed; empty check list → fixed; stale vectors → fixed). Confirmed: no
unauthenticated plaintext leaves `decrypt_part` (aes-gcm checks the tag before
decrypting), no panic on hostile lengths, fresh random IV per part, PBKDF2
identical to the JS.
Spec reviewer — 0 HIGH, 0 MEDIUM, 3 LOW (atob trailing bits, frozen vectors,
key-check constant not from production code — all fixed).
**Gate evidence:**
- G1: the eight tests written first (compile failure), then the Gate 3 tests
  (trailing bits failed before its fix). `cargo test -p dc-core` 42 passed;
  clippy and fmt clean; `cargo deny check advisories` ok.
- G2 (the production code is the real condition): JS→Rust — the vectors were
  produced by `drive/src/crypto.js` (SHA-256 `aa2a05f2…`) and `zke-unlock.js`,
  and all crypto tests pass against them; Rust→JS — `emit_vectors | node
  mobile/core/compat/verify-rust-output.mjs` → `ok 0 / 1 / 16 / 1000 /
  19922944 bytes`, exit 0.
- G3: above. G4: `6361a35` and this docs commit.

---

## 1.2 — Sign-in and the worker client            2026-10-30

**Planned:** P1-core.md Part 2, Task 1.2 (written before the code).
**Did:** as planned, with these differences: `POST /api/assets` and the
thumbnail route moved to 1.7 and the Drive routes to P3 (built where first
used; PLAN and §5.3 amended); `restore` and `sign_out` return `Result` (the
session lock); `.local`, link-local and IPv6 unique-local addresses count as
local; from Gate 3 — hosted workers must be https even on a home network,
`restore` re-checks the stored worker address, a 404 at sign-in is
`BadAddress`, empty zke settings give no key, server messages are scrubbed
**before** being cut and lose control/bidi characters, an undecodable reply
quotes nothing. Closes Task 1.0's carried-forward LOW (http worker URLs).
**Decisions:** recorded at the end of P1-core.md Part 2 — each accepted LOW
with its owning task (1.3, 1.5, 1.7, P2), the accepted self-hosted LAN-http
risk, and the Turnstile risk on the central login.
**Security:** reviewer — 0 HIGH, 0 MEDIUM, 4 LOW, all fixed: a token cut at
the 200-character limit escaped `scrub`; hosted sign-in allowed http to local
addresses; `restore` skipped the address check; the example could print raw
Keychain bytes on a decode failure. INFO: password copies in the request body
are not wiped (accepted); sign-out does not stop in-flight work (→ P2); lock
poisoning now cannot keep the token; reply sizes uncapped (→ 1.5). Checked
fine: every `Secret` field redacted in `Debug`; the Bearer header is marked
sensitive; redirects off; the asset-id guard blocks traversal; address tricks
(`@`, userinfo, `127.0.0.1.nip.io`, IPv4 forms, IDN) normalise or are refused.
Spec reviewer — 0 HIGH, 1 MEDIUM (empty zke settings derived a key from "" —
fixed, test added), 4 LOW (404 untested / sign-in 404 → fixed; decode text
uncapped → fixed; missing Telegram config → 1.3; moved routes → recorded).
`HOSTED_API` (`https://api.daemonclient.uz`) confirmed: the fork's prefilled
address and the openapi spec's "login and worker discovery" server.
**Gate evidence:**
- G1: tests first, failing (missing types), then each Gate 3 test failed
  before its fix. `cargo test -p dc-core` 58 passed; clippy (deny lints) and
  fmt clean; `cargo deny check advisories` ok.
- G2 (2026-10-30, `cargo run -p dc-core --example sign_in`, the operator's
  approved test account, password from the Keychain item `daemonclient-test`):
  `signed in — worker: dc-…workers.dev` (host withheld here) ·
  `telegram — bot token: present, channel: present` ·
  `photos encryption — mode: server, key: derived (derived in 638 ms)` (debug
  build; includes one network round-trip). Re-run after every Gate 3 fix.
- G3: above. G4: this code commit and docs commit.
