# One engine for every client — plan

**For the operator and the Linux machine.** Direction from the operator
(2026-11-18): "rewrite the core for Photos too, then potentially Drive too,
with this Rust logic where it's not worker heavy." **Approved by the
operator 2026-11-18 (SPEC D25), with the order changed:** "focus on your work,
finalize the mobile apps; we optimize and rebuild the websites after these
works are finished — you two will be building that together." Nothing here is
built yet. Written on the MacBook from the code as it is on `main`
(`2aff3f6`) and the Linux machine's NOW.md of 2026-11-17.

---

## 1. Two separate problems

**A. The website is heavy on the worker.** Every byte it reads or uploads goes
through the worker's `/proxy` (three worker requests per thumbnail); the worker
backfills EXIF by downloading originals; uploads go unpaced. **None of that
needs Rust to fix** — it is the worker contract and calling Telegram directly
(`docs/web/photos-website-fixes.md`, items 1–5, 9, 10). Those go ahead now, in
TypeScript, and do not wait for anything below.

**B. Each client has its own copy of the rules, and they drift.** Found in P1
alone:

- the website stores hex SHA-1 where the app stores base64 (re-uploads);
- the website and worker pace sends at twice Telegram's group limit (40 s stalls);
- the website's video re-downloads each 19 MiB part for every range request;
- the website converts HEIC (the original and its EXIF lost);
- the scheduler's numbers differ per client;
- album batching (D24) would have to be written three times.

**The engine fixes B:** one implementation of the rules, tested once,
measured once (`dc-cli`), used by the phone apps, the Photos website and
Drive.

---

## 2. Architecture: a sans-I/O engine

**`dc-engine`** (new crate, carved out of `dc-core`): pure Rust — **no async
runtime, no network, no files; time is passed in.** It decides; the platform
does the I/O. Contents:

| Module | Today in `dc-core` | Change |
|---|---|---|
| Storage format: AES-GCM parts, PBKDF2 keys | `crypto.rs` (337 lines, pure) | moves as is |
| Parts and byte ranges | `chunk_plan.rs` (327, pure) | moves as is |
| Manifests: types, which files make a rendition, checks | `reader.rs` (select, Layout, Stored, job keys) + `worker.rs` types | split out of the I/O |
| Scheduler (the Nuke port: classes, slots, coalescing, D17) | `sched/state.rs`, `bucket.rs`, `mod.rs` (~1,030, pure but for tokio's `Instant`) | time becomes milliseconds passed in |
| Send pacer (1 per 3.5 s, burst 2, restart rule) | inside `telegram.rs` | becomes a pure bucket like the read one |
| Backup queue (D24: batch by token, albums ≤ 10 files ≤ 45 MB, parts alone, journal and resume rules, both-spellings dedupe, the worker's fields) | inside `upload.rs` (1,422, mixed with files) | **written pure**: the journal is data the platform stores |
| Telegram answers, multipart bodies for parts and albums, name cleaning | inside `telegram.rs` | split out of the I/O |
| Checksum (streamed SHA-1 → base64 and hex) | inside `upload.rs` | moves |

**The shells — I/O only:**

- **`dc-core` (native, the two apps):** stays the crate the apps call. It
  keeps tokio, reqwest, the hyper local media server, the disk caches, files
  and the background hand-off, and calls `dc-engine` for every decision.
  Behaviour does not change: all of today's tests stay green through the
  split.
- **`dc-engine-wasm` (the websites):** `dc-engine` compiled to WebAssembly
  (`wasm-bindgen`), with a small TypeScript wrapper. The browser does
  `fetch`, the Cache API and IndexedDB, service-worker responses and `File`
  slicing. The engine tells it what to fetch next, how to place bytes, what to
  send in which album, and what to tell the worker.

**What is not in the engine anywhere:**
- picture and video making — thumbnails, previews and the H.264 copy:
  - phones: PhotoKit/AVFoundation, MediaCodec;
  - browsers: canvas, `heic2any`, WebCodecs;
- the UI.

**The worker stays TypeScript, and thin.** After D23 it keeps the books:
metadata and D1, no bytes. Rewriting it in Rust (Cloudflare's `workers-rs`) is
not proposed: it would gain nothing, it is live production, and it is the
Linux machine's.

---

## 3. What runs where, when this is done

| | Phone apps | Photos website | Drive website | Drive app (P3) |
|---|---|---|---|---|
| Rules (format, ranges, scheduler, pacing, albums, journal, dedupe) | `dc-engine` (native) | `dc-engine` (wasm) | `dc-engine` (wasm) | `dc-engine` (native) |
| Network, storage, media serving | `dc-core` (Rust) | service worker + page (TS) | `sw.js` + page | `dc-core` |
| Pictures / video copies | PhotoKit, AVFoundation, MediaCodec | canvas, heic2any, WebCodecs | same | platform |
| Worker | metadata only | metadata only | metadata only | metadata only |

---

## 4. Measured before it is chosen (E2)

- **Crypto in the browser:** the AES-GCM crate in wasm runs in software;
  WebCrypto uses the CPU's AES instructions.
  - Time a 19 MiB part both ways in Chrome, Safari and Firefox.
  - If WebCrypto wins clearly, the web shell does the AES and the engine does
    everything around it.
  - The format is pinned by the CI vectors either way.
- **WebAssembly in a service worker:**
  - loading it at install (the SvelteKit service-worker build in
    `immich/web`; Drive's plain `public/sw.js`);
  - **CSP:** compiling wasm needs `'wasm-unsafe-eval'` in `script-src`. That
    matters for Drive's strict CSP and Trusted Types;
  - Safari's service-worker limits.
- **Size:** target under 400 KB gzipped.
- **Randomness:** `getrandom`'s browser backend (`crypto.getRandomValues`).

---

## 5. Steps and owners

| Step | Who | What | Waits for |
|---|---|---|---|
| **L0** | Linux | Release **R2** (approved by the operator 2026-11-18). Tutorial items 2 (call Telegram directly), 3 (thumbnail ids in bulk), 4 (one checksum spelling), 5 (complete deletes), 7's pacing constants only, 9 (the free plan's day). Accept `telegramPlaybackChunks` (+ size) on `clientUpload` for the phone's H.264 copy (P2-9). | nothing |
| **E1** | Mac | Carve `dc-engine` out of `dc-core`, no behaviour change (every test stays green); scheduler and buckets on passed-in time. | nothing |
| **E2** | Mac | `dc-engine-wasm`: the build, the TypeScript API, the measurements in §4, a test page. Its API is the contract with Linux, agreed in a doc before code. | E1 |
| **E3** | Mac | D24's backup queue, written in the engine (pure, tested); used by the app's P2 2.5 / 2.6. | E1 |
| **WE** | Linux | The Photos website on the engine (scheduler, reads, video ranges with a part cache, uploads with pacing, albums, journal, originals with their own previews). It replaces tutorial items 6, 7 (albums) and 8. A/B against today. | E2, E3 |
| **DE** | Linux | Drive phase 3's "shared scheduler module" **is** the engine's scheduler (wasm), not a new TypeScript module. Drive phase 4's writes go on the engine's upload queue. | E2 (E3 for writes) |
| **P3** | Mac | The Drive app, native on `dc-core`. | P2 |

**Order (operator, 2026-11-18):**
1. **The mobile apps first.** On the Mac:
   - P2 2.1–2.4: identity, sign-in, media through the local server, the
     phone-made pictures;
   - then **E1** (the split) and **E3** (D24's queue in the engine), because
     the apps' uploads are built on them;
   - then P2 2.5 onwards, and P3 (the Drive app).

   On Linux, only what the apps need from the worker: R2 (approved), and
   `telegramPlaybackChunks` on `clientUpload`. The rest of L0 waits, unless
   the operator says otherwise.
2. **Then the websites, together:**
   - **E2** (the wasm build);
   - **WE** (the Photos website on the engine) and **DE** (Drive on the
     engine);
   - the remaining tutorial items, rebuilt and optimised with the Linux
     machine.

---

## 6. Questions for the Linux machine (answer in NOW.md)

1. **Drive phase 3** was to start with a TypeScript shared scheduler. Can it
   take the engine's scheduler (wasm) instead? It already exists in Rust, with
   Nuke's tests and the measured numbers. E2 gives you its API first.
2. **Builds:**
   - Can the `immich/web` service worker (SvelteKit) and Drive's `sw.js` load
     a wasm module at install?
   - Is `'wasm-unsafe-eval'` acceptable in both CSPs?
   - Should the built `.wasm` be committed or built in CI?
   - Should the Rust workspace move from `mobile/` to a root `engine/` folder
     now that the web uses it?
3. **L0:** which items you take now, in what order, and when R2 goes out.
4. **One contract release:**
   - `telegramPlaybackChunks` (+ size) on `clientUpload`;
   - thumbnail and preview message ids;
   - a bulk create;
   - thumbnail ids in bulk (timeline columns).

   Agree the shapes in a doc first, so the engine builds the fields once.

## 7. For the operator

- Approve the direction as planned: the engine split, wasm for the websites,
  the worker staying TypeScript.
- Approve the order: Linux's L0 now; on the Mac P2 2.1–2.4, then E1–E3, then
  P2's uploads.
- Approve that the browser's crypto (wasm or WebCrypto) is chosen by the E2
  measurement.

---

# Part 2 — The rebuild (SPEC D26): native apps on one core

**Decided by the operator 2026-11-19:** the Immich Flutter mobile fork is
dropped; Photos (and later Drive) become native apps — **SwiftUI on iOS
(iPhone first), Kotlin + Jetpack Compose on Android** — thin over the Rust
core. *"First … a big research and a plan … the core beyond perfect and
bulletproof … the drive and photos will be rewritten for that … build it all
together with central planning"* (with the Linux machine). **The Photos
website stays an Immich fork, cleaned up.** This Part is that plan; nothing in
it is built yet. Status: **research in progress** (§12).

## 8. The layers

| Layer | What it is | Who |
|---|---|---|
| `dc-engine` | the rules, pure Rust, no I/O (Part 1 §2): format, ranges, scheduler, pacing, albums (D24), journal, dedupe, the worker's fields | Mac |
| `dc-core` | the I/O on a phone: worker + Telegram clients, **the library index and sync** (new — Immich's app did this), the upload queue's execution, the local media server, caches, logs | Mac |
| `dc-ffi` (new) | the bridge: UniFFI → a Swift package (XCFramework) and a Kotlin library (AAR); one API for both apps | Mac |
| iOS app (new) | SwiftUI screens + platform work: PhotoKit (library, changes, resources), ImageIO/AVFoundation (thumbnails, previews, EXIF, the H.264 copy), the background URLSession uploader, AVKit playback | Mac |
| Android app (new) | Compose screens + MediaStore, ImageDecoder/MediaMetadataRetriever, Media3 (Transformer, ExoPlayer), WorkManager | Mac |
| Worker | keeps the books (D23); a v2 contract designed with the apps (§12 Q9) | Linux |
| Websites | the Photos website (Immich fork, cleaned) and Drive, later on the engine as wasm (Part 1 WE, DE) | Linux + Mac |

The look: system components, so iOS 26 gives Liquid Glass and Android
Material 3 by themselves; behaviour modelled on Apple Photos and Immich (the
grid, the scrubber, the viewer's gestures) — never Apple's branding.

## 9. Order

1. **R0 — Research** (§12), Mac and Linux; the operator approves the plan.
2. **R1 — Repo cleanup** (§11), once Linux confirms the website's build
   closure and has pushed its own work.
3. **R2 — Spikes** that settle the unknowns by measurement, not prose:
   S1 the bridge (UniFFI: async calls, a callback, a stream) on the Simulator
   and the emulator; S2 the library index fed by the worker's sync; S3 a
   10k–100k-item timeline on synthetic data (UICollectionView vs LazyVGrid;
   Compose LazyGrid); S4 iOS background upload (background URLSession +
   BGTask + the core's hand-off); S5 Android WorkManager upload; S6 the media
   made on the phone (thumbnail, preview, thumbhash, EXIF, width, height,
   duration, the H.264 copy).
4. **C — the core, bulletproof**, each task through the four gates:
   C1 the engine split (Part 1 E1); C2 the worker contract v2, with Linux;
   C3 the library index + sync; C4 the upload engine (E3: D24's queue, the
   platform's pictures and metadata, background hand-off); C5 reads (the
   media server, already built — its 2.3 fixes come back here from
   `archive/p2-flutter-2.3`); C6 albums, favorites, archive, trash; C7 **the
   differential harnesses** (§10); C8 `dc-cli` exercising every function.
5. **I — the iOS app**: sign-in and settings → timeline → viewer (photo, live
   photo, zoom, swipe) → video → backup (foreground, then background) →
   albums / favorites / archive / trash → save, share, delete → the exit run
   on the Simulator, then a release build on the operator's iPhone.
6. **A — the Android app**, the same list.
7. **W — the websites on the engine** (Part 1 E2, WE, DE), with Linux.
8. **P3 — the Drive apps**, native, on the same core.

## 10. How the core is proven

**Differential harnesses** (the method of "Horizon", the Rust rewrite of
Minecraft checked against the real game): for every behaviour, the core and
what exists today get the same input and must agree —
- every asset the core reads matches, byte for byte, what the website's
  service worker and the worker's manifest give;
- every upload the core makes opens on the website, with the same thumbnail,
  EXIF and dimensions the website would make;
- the core's library index equals the worker's sync stream, after every
  change;
- pacing and rate limits measured against Telegram, as in P1 1.9.

Plus the gates as before (TDD, Gate 2 on the Simulator and emulator, two
Gate 3 reviews), and the audit harness idea from 2.3 (timings, thumbnails
loaded, frames, every screen) rebuilt for the native apps.

**Requirements already learned on the fork** (2026-11-18/19):
- an upload carries width, height and duration (a 0×0 asset crashed the viewer);
- iPhone HDR video (Dolby Vision HEVC) needs the H.264 copy where it cannot decode;
- the old uploads lack durations and split live photos — a one-time repair;
- the worker stubs most Immich features (people, tags, search, partners,
  shared links, sessions, API keys, libraries, memories, duplicates, stacks,
  jobs, workflows); auth is login / logout / status / exchange — build only
  what it serves: sync, the viewer, albums, favorites, archive, trash, map
  markers, download, upload;
- the local server's replies are `no-store`; its secret never reaches a log;
  the opened item first (D17), neighbours at Next, saves at the grid's class;
- a free personal Apple team cannot sign App Groups, Wi-Fi info or push —
  iOS v1 ships none (no widget, no share extension yet).

## 11. Repo cleanup — proposal, pending Linux

Nothing is deleted until the Linux machine confirms the website's build and
has pushed its own commits (asked 2026-11-19).

| Path | Live / needed | Owner | Proposal |
|---|---|---|---|
| `immich/web`, `immich/i18n`, `immich/open-api/typescript-sdk`, the workspace root files | the Photos website's build (as read 2026-11-19) | Linux | **keep**, cleaned; `pnpm-workspace.yaml` trimmed to what is kept |
| `immich/mobile` | the Flutter fork (D26 drops it) | Mac | delete — with `.github/workflows/mobile-build.yml`, `mobile/tools/check-identity.sh`, `mobile/packages/dc_core_flutter` |
| `immich/server`, `machine-learning`, `cli`, `e2e`, `e2e-auth-server`, `docs`, `fastlane`, `design`, `docker`, `deployment`, `misc`, `plugins`, `readme_i18n`, `immich/.github`, its Makefile and installers | nothing deployed from them (to confirm) | — | delete once confirmed |
| `immich-api-shim`, `deployment-service`, `accounts-portal`, `auth-worker`, `drive`, `daemonclient-site` | live | Linux | keep |
| `daemonclient-proxy`, `processor`, `hosting`, `docs-site`, `schema`, `selfhost`, `install.sh`, `scripts` | unknown (`scripts/scan-secrets.mjs` is used) | Linux | Linux says which are live |

## 12. Research — questions to answer before C starts

| # | Question | Answer (filled in as found) |
|---|---|---|
| Q1 | The bridge: UniFFI's async (Swift async/await, Kotlin coroutines), callbacks and streams (logs, progress), errors; packaging (XCFramework, cargo-ndk + AAR), CI, binary size | **Found 2026-11-19:** UniFFI (0.32.x; Mozilla ships it in Firefox mobile and desktop) maps Rust `async` to Swift `async throws` and Kotlin `suspend`; it has **no stream type** — a log or progress stream is a Rust callback interface wrapped in Swift `AsyncStream` / Kotlin `callbackFlow`; callback interfaces are vtables and may be async; cancelling a Kotlin coroutine may not cancel the Rust future (to verify in S1). Packaging, as Ferrostar and `uniffi-starter` do it: iOS — build the device + simulator targets, `lipo` the simulators, `xcodebuild -create-xcframework`, a Swift Package; Android — `cargo-ndk` for arm64-v8a + x86_64 into an Android library, plus a host build so the Kotlin bindings test on the JVM in CI. A static archive is ~16 MiB before the linker strips it. **S1 settles it.** |
| Q2 | The library index in the core: SQLite (bundled) schema; the timeline's queries (months, days, counts, paging); how Immich's local database does it | |
| Q3 | Sync: the worker's `/api/sync/stream` wire format (`immich-api-shim/src/sync.ts`), acks, full vs delta; a v2? | **Read 2026-11-19:** JSON lines (`application/jsonlines+json`): `UserV1`, then one `AssetV1` per asset (id, checksum, type, dates, duration, width, height, favorite, live-photo link, name, thumbhash, visibility), `AssetDeleteV1` for trashed rows, `SyncCompleteV1`; `SyncResetV1` on a server-side epoch change. **Every sync is the whole library** — one `SELECT` of all the user's rows (no cursor; the acks are not used to skip). EXIF and albums are not in it (albums: `GET /api/albums`). A duplicate-checksum pre-pass and one background heal job (checksum / EXIF / HEIC thumbnail backfill) ride on each call. **For the core:** D1's free plan reads 5 M rows a day, so a 100k library could sync ~50 times a day — **a delta sync (changes since a cursor, with tombstones) is needed in v2 (Q9).** |
| Q4 | The timeline at 10k–100k items on each platform; how pictures reach the grid (local server URLs vs bytes over the bridge); thumbhash on the platform | **Found 2026-11-19 (to measure in S3):** SwiftUI's `LazyVGrid` is adequate to a few thousand items but drops frames past that and does not reuse cells; `UICollectionView` (cell reuse, prefetching) is the reference for full libraries — **plan: a `UICollectionView` grid inside SwiftUI** for the timeline, SwiftUI everywhere else. Android: Compose `LazyVerticalGrid`, measured in S3. |
| Q5 | The viewer: zoom, paging, live photos, video (AVPlayer / ExoPlayer from the local server), HDR | |
| Q6 | The backup source: PhotoKit (changes, resources, iCloud originals, limited access), MediaStore and Android's media permissions | |
| Q7 | Background upload: background URLSession from prepared files + BGTask (limits), WorkManager and Android 14/15 foreground-service rules | **Found 2026-11-19:** iOS — background `URLSession` moves the bytes but not the CPU work around them: prepare the encrypted bodies first, in Application Support (iOS may clear `tmp`), then hand them to the session (D22). **iOS 26's `BGContinuedProcessingTask`** keeps work the user started running in the background with a system Live Activity (progress, cancel), real devices only; `BGProcessingTask` for deferred work. Android 15+ (targeting API 35): `dataSync` foreground services share **6 hours per 24 h**, then stop; user-initiated data transfer jobs (Android 14+) are the documented path for user-started transfers — to verify on the official pages in S5. |
| Q8 | What the phone makes: thumbnail and preview sizes and formats, thumbhash, EXIF, dimensions, duration, the H.264 copy (AVAssetExportSession, Media3 Transformer), HEIC on Android | **Found 2026-11-19 (partly):** Android — Media3 Transformer tone-maps HDR to SDR (OpenGL from Android 10, MediaCodec on Android 12+/13+ devices that capture HDR) and takes Dolby Vision profile 8 through its HEVC base layer; an H.264 output cannot carry HDR, so the copy is SDR by design. iOS — `AVAssetExportSession` / AVFoundation, to research. Thumbnails, previews, thumbhash and EXIF: ImageIO (iOS), `ImageDecoder` + `ExifInterface` (Android) — sizes and formats to match what the website makes (S6). |
| Q9 | The worker contract v2 with Linux: bulk create, every field above, idempotency, the free plan's D1 write budget, sync v2 | **Read 2026-11-19:** the upload route already takes (R2) `clientUpload`, `deviceAssetId`, `deviceId`, `checksum`, dates, `filename`, `fileSize`, `mimeType`, **`width`, `height`, `duration`**, `isFavorite`, `latitude`/`longitude`, `exif`, `thumbhash`, `livePhotoVideoId`, `encryptionMode`, `thumbEncrypted`, `telegramChunks` / `telegramOriginalId` / `telegramThumbId` / `telegramPreviewId` / `telegramPlaybackChunks` + `playbackSize`, `uploadSessionId`. So 2.4's 0×0 crash was the core not *sending* width / height / duration — no worker change. **v2 asks:** delta sync (Q3); bulk create (D24: one request per album); albums in the sync. |
| Q10 | The look and behaviour: Apple Photos' grid (zoom levels, Years / Months / All), scrubber, selection, viewer gestures; iOS 26 Liquid Glass APIs; Material 3 | **Found 2026-11-19:** `NavigationStack`, `TabView` and toolbars take Liquid Glass by recompiling with the iOS 26 SDK; `.glassEffect()` for custom floating controls, grouped in a `GlassEffectContainer`; `tabBarMinimizeBehavior(.onScrollDown)` hides the tab bar while scrolling. **Glass only on a few fixed floating surfaces (toolbar, tab bar, a control group), never on grid cells** — per-cell glass costs heavy compositing while scrolling. Apple Photos' behaviour list (zoom levels, Years / Months / All, scrubber, selection, gestures) — to write down. |
| Q11 | Distribution: the free team's limits (no App Group in v1), the paid account for TestFlight / App Store, Android signing | |
| Q12 | The differential harnesses: what each compares, fixtures, where they run | |
| Q13 | Test data: a fresh test account with synthetic fixtures — **the operator decides** (the current one holds real ID documents) | |

**Open for the operator (from the research):**
- **Minimum versions.** iOS 26 gives the real Liquid Glass and
  `BGContinuedProcessingTask` (background backup the user started, with a
  system progress bar); iOS 26 shipped in September 2025. Android: 10 (tone
  mapping for the H.264 copy) or later. Proposal: **iOS 26+, Android 10+.**
- **The test account** (Q13).

**Sources (2026-11-19):** [UniFFI](https://github.com/mozilla/uniffi-rs) ·
[UniFFI changelog](https://github.com/mozilla/uniffi-rs/blob/main/CHANGELOG.md) ·
[KMP/iOS and UniFFI](https://andrei-calazans.com/posts/2026-09-19-the-kmp-ios-scaling-problem-rust-uniffi-fixes/) ·
[Ferrostar: XCFramework + Swift Package](https://stadiamaps.com/blog/ferrostar-building-a-cross-platform-navigation-sdk-in-rust-part-2/) ·
[uniffi-starter](https://github.com/ianthetechie/uniffi-starter) ·
[WWDC25: Build a SwiftUI app with the new design](https://developer.apple.com/videos/play/wwdc2025/323/) ·
[Liquid Glass pitfalls](https://juniperphoton.substack.com/p/adopting-liquid-glass-experiences) ·
[WWDC25: Finish tasks in the background](https://developer.apple.com/videos/play/wwdc2025/227/) ·
[BGContinuedProcessingTask + background URLSession](https://www.theswift.dev/posts/bgcontinuedprocessingtask-background-urlsession/) ·
[Android foreground service timeouts](https://developer.android.com/develop/background-work/services/fgs/timeout) ·
[Android 15 behaviour changes](https://developer.android.com/about/versions/15/behavior-changes-15) ·
[Media3 Transformer formats](https://developer.android.com/media/media3/transformer/supported-formats) ·
[SwiftUI collection performance](https://defagos.github.io/swiftui_collection_part1/) ·
[Unsplash LazyCollectionView](https://unsplash.com/blog/lazycollectionview)
