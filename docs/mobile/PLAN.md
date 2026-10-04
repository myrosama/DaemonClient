# Mobile apps — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** DaemonClient Photos and DaemonClient Drive for iPhone and Android,
on one Rust core that does encryption, Telegram transfers and media streaming
on the phone.

**Architecture:** One Cargo workspace at `mobile/`. `dc-core` is pure Rust;
`dc_core_flutter` is a Flutter plugin (flutter_rust_bridge) that both apps
import. Photos is the Immich fork in `immich/mobile`, with its server and byte
paths moved onto the core; Drive is a new Flutter app in `mobile/drive`.

**Tech stack:** Rust (stable, pinned in `mobile/rust-toolchain.toml`),
flutter_rust_bridge 2.13.0, Flutter 3.41.7, Xcode 27, Android SDK + NDK,
`aes-gcm`, `pbkdf2`, `reqwest`, `axum`, `tokio`.

**Spec:** `docs/mobile/SPEC.md` (approved 2026-10-04). Findings it rests on:
`docs/mobile/RESEARCH.md`.

---

## How this plan is organised

This file is the **index**: every task in every phase, one line each, ticked
as it ships. Each phase has a **detailed plan** in `docs/mobile/plans/` with
bite-sized steps and code. A phase's detailed plan is written when the phase
before it ends, because it depends on what that phase finds — and each one is
reviewed by the operator before work starts.

| Phase | Detailed plan | State |
|---|---|---|
| P0 Toolchain and skeleton | `plans/P0-toolchain-and-skeleton.md` | **approved 2026-10-04 — in progress** |
| P1 The core | `plans/P1-core.md` | written as task 0.6 |
| P2 Photos on the core | `plans/P2-photos.md` | written at the end of P1 |
| P3 Drive | `plans/P3-drive.md` | written at the end of P2, after Drive's design is approved |
| P4 Release | `plans/P4-release.md` | written at the end of P3 |

## Every task, every time

1. Read `docs/mobile/README.md` → the status section → this file → the task's
   detailed plan → the spec sections it cites.
2. **Gate 1** — failing test first; whole suite green.
3. **Gate 2** — real conditions, evidence pasted into `DESIGN_NOTES.md`.
4. **Gate 3** — two separate review agents (security, spec). Fix HIGH/MEDIUM;
   accept LOW in writing.
5. **Gate 4** — inspect the index; code commit, then docs commit (tick the
   box here, add the `DESIGN_NOTES.md` entry, update the status section and
   `NOW.md`). No push without the operator's review.

Proportional rigor (`GATES.md`): tasks with no code (installs,
investigations) record their evidence and skip Gate 3. Everything in the core
gets the full treatment.

**Execution (operator, 2026-10-04):** tasks are implemented in the main
session; Gate 3 for every code task is two separate review agents (security,
spec), as `GATES.md` requires.

## Global constraints

- Part size **19 MiB of plaintext** (`19 * 1024 * 1024`); parts are never merged.
- AES-256-GCM; each part = `[12-byte IV][ciphertext][16-byte tag]`.
- PBKDF2-HMAC-SHA256, **100,000** iterations, base64 salt.
- Formats are frozen to what is stored today (SPEC §7).
- No file bytes pass through the worker.
- Secrets (session token, bot token, key material) at rest only in platform
  secure storage; never on disk otherwise; never in logs.
- Flutter **3.41.7**; flutter_rust_bridge **2.13.0**.
- The server may add fields, never remove or repurpose them; booleans are
  booleans and numbers fit in int64 (strict Dart parser).
- Test account only. Worker changes go to the Linux machine first.
- No push without the operator's review. No AI attribution in commits.
- The repo is public: no secrets or security findings in any file.

## Review focus

Failure modes the spec implies that are most likely to hurt a real user. Each
is pinned by a test in the task named.

1. **Interrupted upload** (app killed or network lost mid-file) → resumes
   without duplicates; no asset record until every part is sent. → 1.7
2. **Mixed library** — worker-encrypted (`server`), unencrypted (`off`),
   single-part (`telegramOriginalId`) and multi-part assets all display. → 1.5
3. **Seeking a huge video** — ranges at part boundaries, past the end, on a
   2 GB file → correct `206`/`416`, memory bounded. → 0.3 (arithmetic), 1.6
4. **Missing or wrong key** — no zke config, wrong password, truncated part →
   a clear error, never plaintext written, never a crash. → 1.1, 1.5
5. **Telegram's limits under load** — a fast scroll through 10,000 photos,
   tapping a photo while 200 thumbnails and a backup are queued, or a `429`
   flood: the tapped photo's request goes out next, ahead of everything; what
   is on screen loads before what was scrolled past; reads pause for
   `retry_after`; a removed bot gives a clear message instead of endless
   retries. → 1.3, 1.4

---

## P0 — Toolchain and skeleton

Detailed: `plans/P0-toolchain-and-skeleton.md`.

- [ ] **0.1** Free disk space and install the toolchain (Rust, Flutter via
      mise, CocoaPods, iOS Simulator runtime, JDK 21, Android SDK + NDK,
      flutter_rust_bridge codegen).
- [ ] **0.2** Run the existing Photos fork in the Simulator; record what it
      does at sign-in.
- [ ] **0.3** Cargo workspace at `mobile/` and `dc-core` with `chunk_plan`
      (part count; byte range → parts, with the edge cases of Review focus 3).
- [ ] **0.4** `dc_core_flutter` plugin; the Photos app shows the core version
      on its sign-in screen, on the iOS Simulator and Android.
- [ ] **0.5** CI: the core's format, lint and tests on every push touching
      `mobile/`; the existing mobile build installs Rust and still passes.
- [ ] **0.6** Clean-up proposal (SPEC §5.7) and the detailed P1 plan, both
      for the operator's review.

**Exit:** SPEC §9 P0.

## P1 — The core

- [ ] **1.1** Crypto — PBKDF2 + AES-GCM parts; vectors from the production
      JavaScript, both directions.
- [ ] **1.2** Session + worker client — sign-in (hosted and self-hosted),
      `telegram-config`, `zke-config`, `dc-manifest`, `bulk-upload-check`,
      `POST /api/assets` (`clientUpload`); the Drive adapter's routes typed but
      exercised in P3.
- [ ] **1.3** Telegram client — `sendDocument`, `getFile` (with its result
      cached), download, `deleteMessage`; `429` and fatal errors.
- [ ] **1.4** Fetch scheduler (SPEC §4.9) — four priority classes with the
      opened item pre-empting everything (D17), newest-first thumbnails,
      cancellation when nobody waits, one fetch per file, bounded concurrency,
      global pause on `429`.
- [ ] **1.5** Read path — thumbnail, existing preview, original and byte
      ranges, for every asset shape.
- [ ] **1.6** Local media server — loopback only, per-launch secret, `Range`,
      next-part prefetch, client disconnect cancels through the scheduler.
- [ ] **1.7** Upload engine — prepare encrypted parts on disk, send, resume
      journal, metadata post.
- [ ] **1.8** `dc-cli` and Gate 2 for the whole core against the test
      account, both directions with photos.daemonclient.uz.

**Exit:** SPEC §9 P1.

## P2 — Photos on the core

- [ ] **2.1** Identity — iOS bundle ids `uz.daemonclient.photos*`, names;
      signing with the operator's Apple ID for device builds.
- [ ] **2.2** Sign-in (SPEC D8) — server address, "Sign in with a
      DaemonClient account", "Create account" in an in-app browser sheet;
      `workerUrl`; secrets to secure storage.
- [ ] **2.3** Media through the local server — thumbnails, photos, video, on
      iOS and Android.
- [ ] **2.4** Thumbnails at upload (SPEC §5.1, D14) — 256 px JPEG +
      thumbhash from the platform image engine; local thumbnails for assets
      that have none. No preview, no worker change.
- [ ] **2.5** Foreground automatic upload through the core.
- [ ] **2.6** Background upload — encrypted parts handed to the background
      uploader (SPEC §5.2); Android WorkManager.
- [ ] **2.7** HEIC and video on Android — native HEIC decode (Android 9+),
      thumbnail-quality on Android 8; HEVC playback with the H.264 rendition
      fallback.
- [ ] **2.8** Live photos, EXIF/GPS, `deviceAssetId` dedupe.
- [ ] **2.9** Account deletion entry (Apple requirement).
- [ ] **2.10** Remove unused Immich features (approved list).
- [ ] **2.11** P2 exit run on Simulator, iPhone and Android.

**Exit:** SPEC §9 P2.

## P3 — Drive

- [ ] **3.0** Drive design spec + mockups (Apple Files / Google Drive /
      Documents inspiration), approved by the operator.
- [ ] Tasks written into `plans/P3-drive.md` after 3.0.

## P4 — Release

- [ ] Tasks written into `plans/P4-release.md` at the end of P3.
