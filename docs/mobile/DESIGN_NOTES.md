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
