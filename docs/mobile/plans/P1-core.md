# P1 — The Rust core

**Status: Part 1 (design) APPROVED by the operator, 2026-10-29** — all of
C1–C11 as recommended ("I approve all of your recommendations, and the
spec. GO for it!"). Part 2 holds the step-by-step plan: each task's steps,
with failing tests and code, are written and committed **before** that task's
code, so the plan always runs ahead of the work.

Read first: `SPEC.md` §3–§4 (the approved core spec), `RESEARCH.md` §2
(storage format), §6 (the web's client path), §9/§9b (Nuke), §10 (Immich's
loaders), §11 (worker routes), §12 (Telegram limits).

---

# Part 1 — Design

## 1. What the core is for

Today the Photos app sends whole files through the user's worker, which hits
Cloudflare's limits. The core moves that work onto the phone, the way the
website already does it: the phone encrypts, sends to Telegram, fetches from
Telegram, decrypts and streams; the worker only stores and returns small
metadata. One Rust library, compiled into both apps (Photos now, Drive in P3),
on iPhone and Android.

**P1 ends (SPEC §9) when:** the crypto matches the production JavaScript in
both directions; a command-line tool (`dc-cli`) built on the core signs in to
the test account, uploads a photo and a video over 100 MB that then open on
photos.daemonclient.uz, downloads and decrypts a file the website uploaded,
and the core's local media server streams a video with seeking.

## 2. Already proven (2026-10-27, scratch crate — not in the repo yet)

| What | Result |
|---|---|
| Key derivation | Rust derives the same AES key as `drive/src/crypto.js` for three passwords, including an empty one and one with Cyrillic, Chinese and emoji. |
| JS → Rust | Rust decrypts parts that the production `encryptChunk` made (0 B to 4 KB). |
| Rust → JS | The production `decryptChunk` decrypts parts Rust made, from 0 bytes to a full 19 MiB part. |
| Byte-identical | With the same IV, Rust's 19 MiB part is identical to WebCrypto's (SHA-256 compared). |
| Hostile input | Wrong key, a flipped byte, a damaged tag, truncated parts (0, 1, 27 bytes) all fail cleanly; nothing unauthenticated is returned. |
| Drive key check | The `check` value the worker release adds to `/api/drive/zke` verifies the right key and rejects a wrong one. |
| Networking | The TLS stack (below) builds for iPhone, the iOS Simulator and three Android CPU types, with no CMake; from the Mac it reached `api.telegram.org`, `api.daemonclient.uz` and a per-user worker over HTTP/2. |

The vectors come from a Node script that imports `drive/src/crypto.js`
itself, so the Rust is checked against the real code, not a copy. The spike
lives outside the repo on the MacBook (`~/dc-work/p1-spike`, re-run
2026-10-29: 8 tests, no lint findings, all five Rust parts decrypted by the
JavaScript); tasks 1.0 and 1.1 move it into `mobile/core`.

## 3. Decisions for the operator

Each has a recommendation. The ones marked **spec change** alter a line of
the approved SPEC and are recorded in its change log once approved.

| # | Question | Recommendation | Why |
|---|---|---|---|
| C1 | Which certificates does the phone trust? | **Mozilla's list, built into the core** (rustls + ring + webpki-roots). | No CMake, no Android-specific set-up, same on both platforms. Cost: a certificate the *user* installed on the phone (a company proxy, a self-hoster's private certificate) is not trusted. Telegram, workers.dev and daemonclient.uz all use public certificates, and self-hosting runs on Cloudflare too. |
| C2 | Rate limiter | **Port Nuke's 25-line token bucket** instead of the `governor` crate. **Spec change** (§4.9 names `governor`). | Same behaviour, tests run on a fake clock and never sleep, and it matches D19 ("port Nuke") exactly. |
| C3 | What names do encrypted parts get in the Telegram channel? | **Random 16 hex characters + `.partNNN`** for encrypted uploads, as Drive does. Unencrypted libraries keep the real file name. | The web's Photos uploader sends the real file name, which tells anyone who sees the channel what each photo is. Reading never uses the name, so the website is unaffected. |
| C4 | Does the opened photo wait for the rate limiter? | **No — it skips the token bucket** (it still counts against the connection limit and has a reserved slot). | D17: the opened item goes first. It is one request at a time; Telegram's 429 still pauses it if needed. |
| C5 | How long are asset manifests cached? | **10 minutes, in memory.** Decrypted thumbnails: **on disk, kept** (bounded, oldest dropped first). | A manifest can gain a preview (HEIC fix) or an H.264 rendition later; the web caches manifests forever and misses those. A Telegram `file_id` never changes, so its decrypted bytes can be kept. |
| C6 | Video start time | **Each 19 MiB part is downloaded and checked in full before any of its bytes are played**, and the next part is fetched while one plays. | AES-GCM can only prove a part is genuine at its end. Playing unchecked bytes would let a damaged or tampered part reach the player. Cost: the first frame waits for one part — about 1–3 s on Wi-Fi or good 4G. |
| C7 | Disk use during upload | **Encrypt a few parts ahead, not the whole file** (2 in the foreground; the background window is set in P2). Sent parts are deleted at once. | A 2 GB video would otherwise need 2 GB of free space before it starts. |
| C8 | Test-account password for `dc-cli` | **Read from the macOS Keychain** (an item the operator adds once with `security add-generic-password`). | Never in a file, the repo, an environment variable or the chat. |
| C9 | Logs | The core installs **its own logger**: Warn level in release builds, Info in debug; tokens, keys, passwords and Telegram URLs are never formatted into a log line or an error message. | SPEC §4.8; the bridge's default logger was removed in 0.4 for this reason. |
| C10 | Opened photos and video on Android | **A second port on the local server** for opened media. | Android's network stack allows 6 connections per host *and port*; without it an opened photo can queue behind 6 thumbnails (RESEARCH §10). |
| C11 | Networks where Telegram is blocked | **No fallback in P1.** The Telegram address is a setting, so a fallback through the user's own worker can be added later. | Such a fallback would send file bytes through the worker, which D4 rules out; that is the operator's call when it is needed. |

## 4. Shape of the code

One crate, `mobile/core/dc-core`, pure Rust with no bridge code (SPEC §3),
split into modules with one job each:

```
mobile/core/dc-core/src/
  lib.rs            module list; version()
  chunk_plan.rs     byte range → parts (exists, P0)
  crypto.rs         PBKDF2 key, encrypt/decrypt one part, Drive key check
  secret.rs         Secret<T>: never printed, wiped from memory on drop
  error.rs          CoreError — what went wrong, in words a user can act on
  logging.rs        the core's logger and its redaction rules
  http.rs           the one HTTP client: TLS (C1), timeouts, no redirects
  worker/           the user's worker
    session.rs        sign-in, hosted vs self-hosted, worker URL rules
    photos.rs         zke-config, telegram-config, dc-manifest,
                      bulk-upload-check, create asset, thumbnail+preview
    drive.rs          Drive routes, typed now, used in P3
    types.rs          request/response shapes, tolerant of new fields
  telegram/         the user's own bot
    client.rs         sendDocument, sendPhoto, getFile, download, deleteMessage
    errors.rs         429 / fatal / transient, retry_after
    file_paths.rs     getFile results kept 55 minutes
  sched/            smart loading — the Nuke port
    bucket.rs         token bucket (C2)
    queue.rs          priorities, limits, reserved slot, suspension
    state.rs          coalescing, subscribers, cancellation — pure, no I/O
    shell.rs          the async side: runs jobs, timers, 429 pauses
  read/             what to fetch for an asset, and fetching it
    manifest.rs       validate a manifest; pick file ids per request
    cache.rs          manifests in memory, thumbnails on disk
    reader.rs         thumbnail / preview / original / byte ranges
  media_server/     127.0.0.1, two ports, Range, streaming
  upload/
    journal.rs        what has been sent, on disk, for resuming
    prepare.rs        checksum, encrypt parts to disk
    engine.rs         dedupe → parts → thumbnail → create asset → preview
  core.rs           Core: owns the runtime and everything above
mobile/core/dc-cli/          command-line front end (Gate 2)
mobile/core/compat/          the Node scripts that check against crypto.js
```

The bridge crate (`mobile/packages/dc_core_flutter/rust`) stays thin: it
exposes `Core`'s methods to Dart. Most of that wiring belongs to P2.

## 5. The parts in detail

### 5.1 Foundations (task 1.0)

- **`Core`** owns a small tokio runtime of its own (2–4 threads), so the
  apps' Dart side never blocks and the core does not depend on the bridge's
  executor. Calls from Dart run on the core's runtime and return when done.
- **Secrets** live in `Secret<T>` values: printing one shows `[redacted]`,
  dropping one zeroes it. The session token is the only secret the app
  stores — in the Keychain / Android Keystore, by the app (SPEC §4.1). The
  bot token and the Photos key are fetched from the worker at each start and
  kept in memory only.
- **Errors** are one enum, `CoreError`: signed out, not provisioned yet,
  wrong password, Telegram rejected the bot (bot removed / bad token, with
  Telegram's own words), rate limited, network, corrupt data, not found,
  disk full. Each says what the user can do. No URL is ever part of an
  error: the HTTP client's errors are stripped of URLs before they are kept.
- **HTTP**: one `reqwest` client (C1), HTTP/2, connect timeout 10 s, read
  timeout 30 s, **redirects off** (an API call that redirects could carry
  the bot token somewhere else).
- **Gate 2 for 1.0** is on devices: a bridge test that makes a real HTTPS
  call to Telegram from the iOS Simulator and the Android emulator. This is
  the one thing the spike could not prove from the Mac.

### 5.2 Crypto (task 1.1)

Exactly what section 2 proved, moved into the repo: `derive_key(password,
salt_b64)`, `encrypt_part`, `decrypt_part` (decrypts in place — no second
19 MiB copy — and returns nothing unless the tag checks out),
`verify_drive_key`. Salts are decoded the way the browser's `atob` does
(spaces ignored, padding optional). Key derivation takes ~0.1 s on a phone
and runs off the async threads. CI runs both vector directions with Node
(`mobile/core/compat/`).

### 5.3 Sign-in and the worker (task 1.2)

- `sign_in(server, email, password)` → `POST {server}/api/auth/login`. The
  answer's `workerUrl` is where every later call goes.
- **Hosted** (the "Sign in with a DaemonClient account" button): a missing
  `workerUrl` means the account is not set up yet → "Finish setting up your
  account at accounts.daemonclient.uz", never a silent fallback.
  **Self-hosted** (an address typed by the user): a missing `workerUrl` means
  that server is the worker (as `drive/src/api.js` does).
- Addresses: `https://` required, except `http://` to a local-network or
  loopback address for self-hosters testing at home. Trailing `/` and `/api`
  are trimmed.
- Every call sends `Authorization: Bearer <token>`. `401` → `SignedOut`.
- Response types accept fields they do not know (the server may add fields)
  and reject wrong types loudly in tests rather than guessing.
- Routes (RESEARCH §11): `zke-config`, `telegram-config`, `dc-manifest`,
  `bulk-upload-check`, `POST /api/assets` with `clientUpload=true`,
  `POST /api/assets/:id/thumbnail`; Drive routes typed for P3.

### 5.4 Telegram (task 1.3)

- Talks to `https://api.telegram.org` directly (the address is a setting,
  C11). The bot token is only ever placed into a URL at the moment of the
  request.
- Calls: `sendDocument` (parts, encrypted thumbnails), `sendPhoto`
  (thumbnails of unencrypted libraries), `getFile`, file download,
  `deleteMessage`.
- **Every answer is classified:** `429`/`420` → rate limited, with Telegram's
  `retry_after` honoured in full (the worker caps it at 6 s only because it
  cannot wait; the phone can); `400/401/403/404` → fatal, stop and show
  Telegram's message (bot removed from the channel, bad token); network and
  `5xx` → transient, retried with growing waits.
- `getFile` answers (`file_path`) are kept 55 minutes; an expired path is
  fetched again once.
- Downloads are capped at 20 MiB (Telegram's bot limit; an encrypted part is
  19 MiB + 28 bytes), so a wrong or hostile answer cannot fill memory.
- **Sends are paced per bot** — 1 per 1.5 s, bursts of 8 (RESEARCH §12).
  Downloads are not paced by that bucket.

### 5.5 Smart loading — the Nuke port (task 1.4)

Every Telegram read and every upload part goes through one scheduler. It is
built in two layers:

- **A pure state machine** (`sched/state.rs`, `queue.rs`, `bucket.rs`): it
  receives "someone wants file X at priority P", "that request went away",
  "job finished / failed / was told 429", "time is now T", and answers with
  "start job", "cancel job", "deliver result". No I/O, no real clock — so
  Nuke's own test cases port directly and run instantly.
- **A thin async shell** (`sched/shell.rs`) that carries those instructions
  out: runs the downloads, wakes up on timers, hands results to everyone
  waiting.

**Rules** (SPEC §4.9, D15, D17, D19):

| Rule | Behaviour |
|---|---|
| Coalescing | Requests for the same `file_id` share one download. |
| Priority of a shared download | The highest priority among the requests waiting for it; recomputed when one joins, changes or leaves. |
| Cancellation | When the last request for a download goes away (the thumbnail scrolled off screen and its HTTP connection closed), a queued download is dropped and a running one is stopped. |
| Classes, highest first | **Opened** (the tapped photo, the video part at the playhead) → **Next** (the next video part; the photos either side of the opened one) → **Visible** (on-screen thumbnails) → **Background** (upload parts, prefetch). |
| Order inside a class | Visible: **newest request first** (the rows you scrolled *to*); the rest first-come first-served. |
| The opened item pre-empts | While an Opened download is queued or running, **nothing below it starts**. Thumbnails already running finish (they are small); Background reads already running are cancelled and re-queued; an upload part already sending finishes (stopping it would waste up to 19 MB already sent). Everything resumes, in order, when it finishes or the viewer closes. |
| Slots | 6 at once; 1 kept free for Opened/Next; at most 2 Next, at most 2 Background, at most 1 upload part sending. (The website uses 12 over HTTP/2; the phone's local server is HTTP/1.1 — SPEC §4.9.) |
| Rate limit (reads) | Token bucket, 20 per second, bursts of 10. A token is taken only when a job really starts — **cancelled work never spends one**, so flinging through 10,000 thumbnails costs only what gets loaded. Opened skips the bucket (C4). |
| Telegram says 429 | **All reads pause** until `retry_after` has passed; the job goes back to the front of its class. Sends have their own pause. |

These numbers are starting points; task 1.8 measures them against the real
Telegram with `dc-cli` and records the result.

**Tests ported from Nuke** (RESEARCH §9b lists them by name): concurrency
limits, priority order, priority changes of queued and running work,
reserved slots, suspension and resume, cancelled work never running, the
token bucket's burst, refill and "cancelled work spends no token", and the
sharing rules (one download for many requests; cancelled only when the last
leaves; a late joiner gets the same result; an error reaches everyone). Our
own rules get their own tests: newest-first, Opened pre-empting, the 429
pause, Background reads re-queued.

Nuke is MIT-licensed; its copyright notice goes into `NOTICE` and the module
headers.

### 5.6 Reading an asset (task 1.5)

- **Manifest** (`GET /api/assets/:id/dc-manifest`) is checked before use: part
  indexes must be exactly 0…n−1 with no gaps or repeats; a part's decrypted
  length must be exactly 19 MiB except the last, which must match
  `fileSize`; a 0-byte file has one part. A manifest that fails is reported
  as corrupt — never served at the wrong offsets.
- **Which Telegram file answers which request** — the website's
  `selectFileIds` ported exactly, plus its `playbackChunks` rule:

| Request | Answer, in order of preference |
|---|---|
| Grid thumbnail | thumbnail → preview → (single-part assets only) the original |
| Preview / full size | preview → (single-part) the original → the thumbnail |
| Original | all parts in order; single-part assets use `originalId` |
| Video playback | the H.264 rendition's parts when one exists, else the original's |

- **Every asset shape works:** encrypted by the worker (`server`), by a
  client (`client`), unencrypted (`off`); one part (`originalId`, older
  uploads) or many; with or without thumbnail, preview, rendition.
- **Caches** (C5): manifests 10 minutes in memory; decrypted thumbnails and
  previews on disk, keyed by `file_id`, 500 MB by default, least recently
  used dropped first, written atomically so a crash never leaves half a file.
  Originals are not kept (SPEC §4.7).

### 5.7 The local media server (task 1.6)

The phone's version of the website's service worker: Immich's own image
loaders and the platform video players keep requesting URLs; only the
address changes.

- Listens on **127.0.0.1 only**, random ports, **two listeners** — one for
  the grid, one for opened media (C10).
- Every URL starts with a **per-launch random secret**
  (`http://127.0.0.1:PORT/<64 hex chars>/api/…`); without it → `403`. Other
  apps on the phone can reach loopback ports, so this is required. The
  secret is compared in constant time.
- Answers what the app asks for today (`lib/utils/image_url_builder.dart`):
  `/api/assets/{id}/thumbnail?size=thumbnail|preview|fullsize`,
  `/api/assets/{id}/original`, `/api/assets/{id}/video/playback`; `edited`
  is ignored. Anything else → `404`.
- **Range requests**, with the edge cases already settled in P0's
  `chunk_plan`: the **whole requested range** is served across part
  boundaries (players treat a short answer as end of file); `bytes=-N`
  (iPhone's first look for the video index) gives the last N bytes; a start
  past the end → `416`; an end past the end is trimmed, not refused. `HEAD`
  answers the size without downloading anything.
- **Streaming:** parts are sent as they are checked (C6), the next part is
  fetched while one is being sent, so memory stays at about two parts per
  video however big it is.
- **Hang-ups cancel work:** when the player or image loader closes the
  connection, the requests behind it go away and the scheduler drops what
  nobody waits for.
- **Phone life cycle:** iOS can close a suspended app's listening sockets.
  `ensure_running()` (called by the app when it returns to the foreground)
  checks the listeners and reopens them, returning the — possibly new —
  addresses.

### 5.8 Uploading (task 1.7)

The same order as the website (RESEARCH §6), with the phone's improvements:

1. **Checksum** — `base64(SHA-1)` of the original, streamed (load-bearing:
   without it dedupe never matches and the whole library uploads again).
2. **Dedupe first** — `bulk-upload-check`; already stored → done, nothing
   sent (saves Telegram's scarce send budget, RESEARCH §12).
3. **Parts** — 19 MiB slices, each encrypted with its own random IV, written
   to the app's private storage a few at a time (C7), sent with
   `sendDocument` under a random name (C3). Each sent part's
   `{index, message_id, file_id}` is written to the job's **journal** at
   once.
4. **Thumbnail** — the 256 px JPEG and its thumbhash come from the phone's
   own image engine (made by the app, P2), encrypted and sent like a part.
5. **Create the asset** — `POST /api/assets` with `clientUpload=true`, the part
   list, device identity (`deviceAssetId`, `deviceId`, so a retry finds the
   existing asset instead of making a second one), dates, size, type,
   dimensions, duration, GPS, favourite, live-photo pairing, thumbhash.
6. **HEIC/HEIF/RAW only** (D18): the thumbnail and a ~1440 px JPEG preview go
   to `POST /api/assets/:id/thumbnail` together, and step 4 is skipped for
   these files — that route requires the thumbnail and sends it itself, so
   sending it in step 4 too would waste a Telegram message.
7. Delete the temporary files and the journal.

**Resuming:** the journal (one small file per upload, no secrets, written
atomically) records the encryption mode and a fingerprint of the key it
started with, the parts already sent, and the step reached. After a crash or
a lost connection the upload continues from there: sent parts are never sent
again, and a failed step 5 is retried with the same part list. If the key has
changed meanwhile, the upload starts over. One unavoidable case: if the app
dies after Telegram accepted a part but before the journal recorded it, that
part is sent again and the first copy stays in the channel unused.

**Failures:** `429` waits and retries the same part; "bot removed" or "bad
token" stops all uploads with that message; network trouble retries with
growing waits and then pauses the upload until the next attempt.

**For background upload (P2):** the core can hand out "part N is ready at
this file path, send it to this Telegram address" and accept "here is what
Telegram answered" — so the platform's background uploader (URLSession on
iOS, WorkManager on Android) can send parts while the app is suspended, with
the core keeping the books (SPEC §5.2). Built and tested in P1; used in P2.

### 5.9 What the apps will call

Sketch of the Dart-facing surface (final names in Part 2; wiring in P2):

```
Core.start(dataDir, cacheDir)                      → Core
core.signIn(server?, email, password)              → SignedIn {sessionToken, workerUrl, userId, email, name}
core.restore(sessionToken)                         // at app start, token from secure storage
core.signOut()
core.mediaServer()                                 → {gridBase, viewerBase}   // ensure_running
core.upload(UploadRequest)                         → stream of progress / done / failed
core.cancelUpload(id)
core.logs()                                        → stream of log lines (for Immich's log screen)
```

Sizes cross the bridge as `BigInt` (exact above 2^53 — proven in P0).

### 5.10 `dc-cli` and the P1 exit (task 1.8)

A small command-line program on the core, for testing against the real
worker and Telegram without an app: `login`, `whoami`, `upload <file>`,
`download <asset> <out>`, `serve` (start the media server and print its
URLs), `bench thumbs` (measure the read limits). Gate 2 for the whole core:

- sign in to the **test account** (C8);
- upload a photo and a >100 MB video → both open on photos.daemonclient.uz;
- download a file the website uploaded → byte-identical to the original;
- `serve` a video and play it in QuickTime/VLC, seeking across part
  boundaries; check the ranges with `curl`;
- measure thumbnails per second and how often Telegram answers 429; set the
  scheduler's numbers from the measurement and record them.

## 6. Tasks

| Task | Delivers | Gate 2 (real conditions) |
|---|---|---|
| 1.0 | Foundations: `Core`, runtime, `Secret`, `CoreError`, logging, HTTP client | HTTPS to Telegram from the iOS Simulator and the Android emulator |
| 1.1 | Crypto + the Node checks in CI | both vector directions with the production JS |
| 1.2 | Sign-in, worker client, response types | sign in to the test account; read its zke and Telegram config |
| 1.3 | Telegram client, error classes, send pacing, file-path cache | send, fetch and delete one message in the test channel |
| 1.4 | The scheduler (Nuke port + our rules) | ported tests + a load test on a fake Telegram |
| 1.5 | Manifests, file selection, caches, reader | read every asset shape the test account has |
| 1.6 | Local media server | video seeks in QuickTime/VLC; `curl` range checks |
| 1.7 | Upload engine, journal, background hand-off API | kill an upload mid-way, resume, no duplicates; opens on the website |
| 1.8 | `dc-cli`, measurements, P1 exit | SPEC §9 P1 exit, recorded in DESIGN_NOTES |

Every task goes through the four gates (`docs/plan/GATES.md`): failing tests
first; real conditions; two review agents (security, spec); code and docs
committed separately, nothing pushed without the operator.

## 7. How it is tested

- **Unit tests** in every module; the scheduler's are fast and exact because
  its core takes time as an input.
- **Property tests** (`proptest`) for range planning, manifest checks and
  `Range` header parsing — random inputs must never panic or serve wrong
  offsets.
- **A fake worker and a fake Telegram** (`wiremock`) for the clients, the
  reader, the media server and the upload engine — including 429 floods,
  expired file paths, bots removed mid-upload and connections dropped
  mid-part.
- **The production JavaScript** for crypto, in both directions, in CI.
- **Real conditions** per task as in section 6, and the full P1 exit at 1.8.
- Lints as in P0: no `unsafe`, no `unwrap`/`expect`/indexing outside tests.

## 8. Risks

| Risk | What happens | Mitigation |
|---|---|---|
| Telegram limits on reads are unknown | Fast scrolling may draw 429s | Starting values + global pause; measured in 1.8 before P2 |
| Send budget (~20 messages / 30 s per bot) | A first backup of a large library takes hours | Dedupe before sending; no wasted messages (C3, step 6); stated in the product's expectations |
| The website and the phone upload with the same bot at once | Their pacers do not know about each other | Both honour `retry_after`; nothing is lost |
| iOS closes the media server's sockets in the background | Images fail after resume | `ensure_running()` on resume (5.7) |
| First frame of a video waits for one part | ~1–3 s on a good network | C6; prefetch; the thumbnail shows meanwhile |
| A user's own certificate (company proxy) | Sign-in fails on that network | C1 trade-off; revisit if a user hits it |
| Upstream `flutter_rust_bridge` / cargokit changes | Build breaks | Versions pinned; CI builds both platforms (0.5) |

## 9. Spec changes this design asks for

- §4.9: "a token bucket (`governor`, MIT)" → "a token bucket ported from
  Nuke's" (C2).
- §4.4: part names — random hex for encrypted uploads also in Photos (C3).
- §4.9: the opened item skips the token bucket (C4).
- §4.7: manifests cached 10 minutes in memory (C5).

---

# Part 2 — Tasks, step by step

Each task below is written before its code. Order: 1.0 → 1.8 (section 6).

## Task 1.0 — Foundations

**Delivers:** `Core` (owns the core's tokio runtime and the HTTP client),
`Secret<T>`, `CoreError`, the core's logger with token scrubbing, and the
HTTP client of decision C1 — plus a device check: one HTTPS request to
Telegram from the iOS Simulator and the Android emulator through the bridge.

**Files:**
- Modify: `mobile/core/dc-core/Cargo.toml`, `mobile/core/dc-core/src/lib.rs`
- Create: `mobile/core/dc-core/src/{secret,logging,error,http,core}.rs`
- Modify: `mobile/packages/dc_core_flutter/rust/Cargo.toml`,
  `rust/src/api/core.rs`; regenerate the bindings
- Modify: `mobile/packages/dc_core_flutter/example/integration_test/core_test.dart`

**Interfaces (later tasks rely on these names):**
- `dc_core::Secret<T: Zeroize>` — `new(T)`, `expose(&self) -> &T`; prints `[redacted]`.
- `dc_core::CoreError` — `Network(String)`, `Internal(String)`; later tasks add variants.
  `From<reqwest::Error>` strips the URL and scrubs the text.
- `dc_core::logging::{scrub(&str) -> String, install(Option<Sink>) -> bool, recent_logs() -> Vec<String>, default_level()}`.
- `dc_core::http::client() -> Result<reqwest::Client, CoreError>` (crate-internal).
- `dc_core::{Core, CoreConfig}` — `CoreConfig::new(data_dir, cache_dir)` (field
  `telegram_api`, default `https://api.telegram.org`), `Core::start(config)`,
  `core.config()`, `core.run(future).await`, `core.check_telegram().await -> Result<u16, CoreError>`.
- Bridge: `start_core(data_dir, cache_dir)`, `check_telegram() -> u16` (Dart:
  `startCore(dataDir:, cacheDir:)`, `checkTelegram()`).

- [x] **Step 1: Dependencies** — `mobile/core/dc-core/Cargo.toml`
  `[dependencies]` and `[dev-dependencies]` (exact versions, as in the spike,
  except tokio: 1.53.2 carries RUSTSEC-2026-0386, "unsound", fixed in 1.53.3 —
  `cargo update -p tokio --precise 1.53.3`; found by 0.5's Gate 3. Task 1.0's
  own Gate 3 then moved webpki-roots 1.0.9 → 1.0.11 (RUSTSEC-2026-0381:
  distrusted emSign roots) and rustls 0.23.45 → 0.23.46 (RUSTSEC-2026-0346
  to -0349). From now on Gate 1 includes `cargo deny check advisories`):

```toml
[dependencies]
log = "=0.4.34"
reqwest = { version = "=0.13.5", default-features = false, features = ["rustls-no-provider", "http2"] }
rustls = { version = "=0.23.46", default-features = false, features = ["ring", "std", "tls12", "logging"] }
thiserror = "=2.0.21"
tokio = { version = "=1.53.3", features = ["rt-multi-thread", "macros"] }
webpki-roots = "=1.0.11"
zeroize = "=1.9.1"

[dev-dependencies]
tempfile = "=3.27.0"
wiremock = "=0.6.5"
```

- [x] **Step 2: `Secret` — tests first** (`src/secret.rs`, module `tests`):

```rust
#[test]
fn never_prints_the_value() {
    let token = Secret::new(String::from("123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw"));
    assert_eq!(format!("{token:?}"), "Secret([redacted])");
    assert_eq!(format!("{token}"), "[redacted]");
}

#[test]
fn exposes_the_value_on_purpose_and_clones() {
    let token = Secret::new(String::from("abc"));
    let copy = token.clone();
    assert_eq!(token.expose(), "abc");
    assert_eq!(copy.expose(), "abc");
}
```

Run `cargo test -p dc-core secret` → fails (no `Secret`). Then:

```rust
//! Values that must never be printed, logged or left behind in memory: the
//! session token, the bot token, passwords (SPEC §4.1, §4.8). `Debug` and
//! `Display` print `[redacted]`; the value is zeroed when dropped.

use std::fmt;
use zeroize::{Zeroize, Zeroizing};

pub struct Secret<T: Zeroize>(Zeroizing<T>);

impl<T: Zeroize> Secret<T> {
    pub fn new(value: T) -> Self {
        Self(Zeroizing::new(value))
    }

    /// The value itself. Use it where it is needed (a header, the URL of a
    /// request being sent) and never keep or format the result.
    pub fn expose(&self) -> &T {
        &self.0
    }
}

impl<T: Zeroize + Clone> Clone for Secret<T> {
    fn clone(&self) -> Self {
        Self::new((*self.0).clone())
    }
}

impl<T: Zeroize> fmt::Debug for Secret<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Secret([redacted])")
    }
}

impl<T: Zeroize> fmt::Display for Secret<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("[redacted]")
    }
}
```

Run again → passes.

- [x] **Step 3: `scrub` and the logger — tests first** (`src/logging.rs`):

```rust
const TOKEN: &str = "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw";

#[test]
fn scrubs_bot_tokens_wherever_they_appear() {
    let url = format!("GET https://api.telegram.org/bot{TOKEN}/getFile?file_id=x");
    assert_eq!(scrub(&url), "GET https://api.telegram.org/bot[redacted]/getFile?file_id=x");
    assert_eq!(scrub(TOKEN), "[redacted]");
    assert_eq!(scrub(&format!("{TOKEN} and {TOKEN}")), "[redacted] and [redacted]");
    assert_eq!(scrub(&format!("ошибка {TOKEN} конец")), "ошибка [redacted] конец");
}

#[test]
fn leaves_ordinary_colons_alone() {
    for line in ["12:30:45", "http://localhost:8080/x", "error 404: not found", "123456789:short", ""] {
        assert_eq!(scrub(line), line);
    }
}

fn record_into(logger: &CoreLogger, level: log::Level, text: &str) {
    log::Log::log(logger, &log::Record::builder().level(level).target("t").args(format_args!("{text}")).build());
}

#[test]
fn keeps_recent_lines_scrubbed_and_drops_the_oldest() {
    let logger = CoreLogger::new(log::LevelFilter::Info, 2, None);
    record_into(&logger, log::Level::Info, "one");
    record_into(&logger, log::Level::Info, &format!("two {TOKEN}"));
    record_into(&logger, log::Level::Warn, "three");
    assert_eq!(logger.recent(), vec!["INFO t: two [redacted]".to_owned(), "WARN t: three".to_owned()]);
}

#[test]
fn ignores_levels_below_its_own() {
    let logger = CoreLogger::new(log::LevelFilter::Warn, 10, None);
    record_into(&logger, log::Level::Info, "quiet");
    assert!(logger.recent().is_empty());
}

#[test]
fn hands_each_line_to_the_sink() {
    let seen = std::sync::Arc::new(Mutex::new(Vec::new()));
    let into = std::sync::Arc::clone(&seen);
    let logger = CoreLogger::new(log::LevelFilter::Info, 10, Some(Box::new(move |line: &str| {
        into.lock().unwrap().push(line.to_owned());
    })));
    record_into(&logger, log::Level::Info, TOKEN);
    assert_eq!(*seen.lock().unwrap(), vec!["INFO t: [redacted]".to_owned()]);
}

#[test]
fn installs_once_at_the_build_level() {
    let _ = install(None);
    assert!(!install(None));
    assert_eq!(log::max_level(), default_level());
}
```

Run → fails. Then the module:

```rust
//! The core's logger (SPEC §4.8, P1 decision C9). Warn in release builds,
//! Info in debug builds. Every line goes through `scrub`, is kept in a small
//! ring buffer the app can show (P2), and goes to an optional sink (`dc-cli`
//! prints it). It never writes to the device log by itself.

use std::collections::VecDeque;
use std::sync::{Mutex, OnceLock};

pub type Sink = Box<dyn Fn(&str) + Send + Sync>;

const RECENT_LINES: usize = 500;

pub fn default_level() -> log::LevelFilter {
    if cfg!(debug_assertions) { log::LevelFilter::Info } else { log::LevelFilter::Warn }
}

/// Replaces anything shaped like a Telegram bot token (`<6+ digits>:<30+ of
/// A-Z a-z 0-9 _ ->`) with `[redacted]`. A second line of defence — code
/// must not put a token into a message in the first place.
pub fn scrub(line: &str) -> String {
    let bytes = line.as_bytes();
    let is_token_char = |b: &u8| b.is_ascii_alphanumeric() || *b == b'_' || *b == b'-';
    let mut out = String::with_capacity(line.len());
    let mut copied = 0;
    let mut i = 0;
    while i < bytes.len() {
        if bytes.get(i) == Some(&b':') {
            let digits = bytes.get(..i).unwrap_or_default().iter().rev().take_while(|b| b.is_ascii_digit()).count();
            let tail = bytes.get(i + 1..).unwrap_or_default().iter().take_while(|b| is_token_char(b)).count();
            if digits >= 6 && tail >= 30 {
                // Every index here sits next to an ASCII byte, so on a char boundary.
                out.push_str(line.get(copied..i - digits).unwrap_or_default());
                out.push_str("[redacted]");
                i += 1 + tail;
                copied = i;
                continue;
            }
        }
        i += 1;
    }
    out.push_str(line.get(copied..).unwrap_or_default());
    out
}

pub struct CoreLogger {
    level: log::LevelFilter,
    capacity: usize,
    recent: Mutex<VecDeque<String>>,
    sink: Option<Sink>,
}

impl CoreLogger {
    pub fn new(level: log::LevelFilter, capacity: usize, sink: Option<Sink>) -> Self {
        Self { level, capacity, recent: Mutex::new(VecDeque::with_capacity(capacity)), sink }
    }

    pub fn recent(&self) -> Vec<String> {
        self.recent.lock().map(|r| r.iter().cloned().collect()).unwrap_or_default()
    }
}

impl log::Log for CoreLogger {
    fn enabled(&self, metadata: &log::Metadata<'_>) -> bool {
        metadata.level() <= self.level
    }

    fn log(&self, record: &log::Record<'_>) {
        if !self.enabled(record.metadata()) {
            return;
        }
        let line = scrub(&format!("{} {}: {}", record.level(), record.target(), record.args()));
        if let Some(sink) = &self.sink {
            sink(&line);
        }
        if self.capacity == 0 {
            return;
        }
        if let Ok(mut recent) = self.recent.lock() {
            if recent.len() >= self.capacity {
                recent.pop_front();
            }
            recent.push_back(line);
        }
    }

    fn flush(&self) {}
}

static LOGGER: OnceLock<&'static CoreLogger> = OnceLock::new();

/// Installs the core's logger for the whole process, once. Returns `false`
/// when it was already installed, or when another logger got there first.
pub fn install(sink: Option<Sink>) -> bool {
    let mut installed = false;
    LOGGER.get_or_init(|| {
        let logger: &'static CoreLogger =
            Box::leak(Box::new(CoreLogger::new(default_level(), RECENT_LINES, sink)));
        if log::set_logger(logger).is_ok() {
            log::set_max_level(default_level());
            installed = true;
        }
        logger
    });
    installed
}

/// The most recent log lines, oldest first (for the app's log screen).
pub fn recent_logs() -> Vec<String> {
    LOGGER.get().map(|l| l.recent()).unwrap_or_default()
}
```

Run → passes.

- [x] **Step 4: `CoreError` — test first** (`src/error.rs`):

```rust
#[tokio::test]
async fn network_errors_never_carry_the_url_or_the_token() {
    // A port that was free a moment ago: the connection is refused.
    let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let url = format!("http://127.0.0.1:{port}/bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw/getMe");
    let err: CoreError = crate::http::client().unwrap().get(&url).send().await.unwrap_err().into();
    let text = err.to_string();
    assert!(text.starts_with("network problem"), "{text}");
    assert!(!text.contains("AAHdq") && !text.contains("/bot") && !text.contains(&port.to_string()), "{text}");
}
```

Run → fails. Then:

```rust
//! What can go wrong, in words a user can act on (SPEC §4.8). An error never
//! holds a URL, a token or a key: errors end up in logs and on screen.
//! Later tasks add variants as they need them.

#[derive(Debug, thiserror::Error)]
pub enum CoreError {
    /// The network failed or a server could not be reached.
    #[error("network problem: {0}")]
    Network(String),
    /// A bug or an impossible state.
    #[error("internal error: {0}")]
    Internal(String),
}

impl From<reqwest::Error> for CoreError {
    fn from(err: reqwest::Error) -> Self {
        // `without_url` drops the request URL — for Telegram it contains the
        // bot token. The cause chain is kept for diagnosis and scrubbed.
        let err = err.without_url();
        let mut text = err.to_string();
        let mut source = std::error::Error::source(&err);
        while let Some(cause) = source {
            text.push_str(": ");
            text.push_str(&cause.to_string());
            source = cause.source();
        }
        CoreError::Network(crate::logging::scrub(&text))
    }
}
```

Run → passes (after Step 5 provides `http::client`; write Step 5 before
running this test).

- [x] **Step 5: the HTTP client (C1) — tests first** (`src/http.rs`):

```rust
#[test]
fn offers_http2_then_http1() {
    assert_eq!(tls_config().unwrap().alpn_protocols, vec![b"h2".to_vec(), b"http/1.1".to_vec()]);
}
```

(Redirects being refused is tested through `Core::check_telegram` in Step 6.)
Then the module — the spike's, with errors mapped to `CoreError`:

```rust
//! The one HTTP client for the worker and Telegram (P1 decision C1): rustls
//! with the `ring` provider and Mozilla's roots compiled in (`webpki-roots`).
//! No platform verifier, so no CMake and no Android-specific set-up; the
//! cost is that certificates a user installed on the phone are not trusted.

use std::sync::Arc;
use std::time::Duration;

use crate::CoreError;

pub(crate) fn tls_config() -> Result<rustls::ClientConfig, rustls::Error> {
    let mut roots = rustls::RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let mut config =
        rustls::ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_safe_default_protocol_versions()?
            .with_root_certificates(roots)
            .with_no_client_auth();
    // reqwest uses a preconfigured TLS config as it is, so offer HTTP/2 here.
    config.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];
    Ok(config)
}

pub(crate) fn client() -> Result<reqwest::Client, CoreError> {
    let tls = tls_config().map_err(|e| CoreError::Internal(format!("TLS set-up failed: {e}")))?;
    reqwest::Client::builder()
        .tls_backend_preconfigured(tls)
        .connect_timeout(Duration::from_secs(10))
        .read_timeout(Duration::from_secs(30))
        .user_agent(concat!("DaemonClient-core/", env!("CARGO_PKG_VERSION")))
        // The worker and Telegram never redirect API calls; following one
        // could carry the bot token to another host.
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| CoreError::Internal(format!("HTTP client set-up failed: {e}")))
}
```

- [x] **Step 6: `Core` — tests first** (`src/core.rs`):

```rust
fn config_in(dir: &tempfile::TempDir) -> CoreConfig {
    CoreConfig::new(dir.path().join("data"), dir.path().join("cache"))
}

#[tokio::test]
async fn starts_makes_its_folders_runs_work_and_drops_inside_async_code() {
    let dir = tempfile::tempdir().unwrap();
    let core = Core::start(config_in(&dir)).unwrap();
    assert!(dir.path().join("data").is_dir() && dir.path().join("cache").is_dir());
    assert_eq!(core.run(async { 2 + 2 }).await.unwrap(), 4);
    drop(core); // inside an async test: must not panic
}

#[tokio::test]
async fn checks_telegram_without_following_redirects() {
    let server = wiremock::MockServer::start().await;
    wiremock::Mock::given(wiremock::matchers::path("/"))
        .respond_with(wiremock::ResponseTemplate::new(302).insert_header("location", "https://core.telegram.org/bots"))
        .expect(1)
        .mount(&server)
        .await;
    let dir = tempfile::tempdir().unwrap();
    let mut config = config_in(&dir);
    config.telegram_api = server.uri();
    let core = Core::start(config).unwrap();
    assert_eq!(core.check_telegram().await.unwrap(), 302);
}
```

Run → fails. Then:

```rust
//! `Core`: one per app process. It owns a small tokio runtime of its own
//! (the app's Dart side never blocks, and the core does not depend on the
//! bridge's executor) and the shared HTTP client.

use std::future::Future;
use std::path::PathBuf;

use crate::CoreError;

pub const TELEGRAM_API: &str = "https://api.telegram.org";

#[derive(Debug, Clone)]
pub struct CoreConfig {
    /// Private storage that persists (upload journals).
    pub data_dir: PathBuf,
    /// Private storage the OS may clear (thumbnails).
    pub cache_dir: PathBuf,
    /// Telegram's address: a setting, so tests can use a fake and a fallback
    /// can be added later (P1 decision C11).
    pub telegram_api: String,
}

impl CoreConfig {
    pub fn new(data_dir: PathBuf, cache_dir: PathBuf) -> Self {
        Self { data_dir, cache_dir, telegram_api: TELEGRAM_API.to_owned() }
    }
}

pub struct Core {
    runtime: Option<tokio::runtime::Runtime>,
    handle: tokio::runtime::Handle,
    http: reqwest::Client,
    config: CoreConfig,
}

impl Core {
    pub fn start(config: CoreConfig) -> Result<Self, CoreError> {
        crate::logging::install(None);
        for dir in [&config.data_dir, &config.cache_dir] {
            std::fs::create_dir_all(dir)
                .map_err(|e| CoreError::Internal(format!("cannot create the core's folders: {e}")))?;
        }
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .thread_name("dc-core")
            .enable_all()
            .build()
            .map_err(|e| CoreError::Internal(format!("cannot start the core's runtime: {e}")))?;
        let handle = runtime.handle().clone();
        let http = crate::http::client()?;
        log::info!("core {} started", crate::version());
        Ok(Self { runtime: Some(runtime), handle, http, config })
    }

    pub fn config(&self) -> &CoreConfig {
        &self.config
    }

    /// Runs `future` on the core's runtime and waits for it.
    pub async fn run<F>(&self, future: F) -> Result<F::Output, CoreError>
    where
        F: Future + Send + 'static,
        F::Output: Send + 'static,
    {
        self.handle
            .spawn(future)
            .await
            .map_err(|e| CoreError::Internal(format!("a core task stopped: {e}")))
    }

    /// One HTTPS request to Telegram; its HTTP status. The device check of
    /// task 1.0, later a diagnostics screen.
    pub async fn check_telegram(&self) -> Result<u16, CoreError> {
        let http = self.http.clone();
        let url = format!("{}/", self.config.telegram_api.trim_end_matches('/'));
        self.run(async move { Ok(http.get(url).send().await?.status().as_u16()) }).await?
    }
}

impl Drop for Core {
    fn drop(&mut self) {
        // A plain drop of a runtime panics inside async code (Dart's bridge
        // may drop us there); shutting down in the background does not.
        if let Some(runtime) = self.runtime.take() {
            runtime.shutdown_background();
        }
    }
}
```

`src/lib.rs`:

```rust
pub mod chunk_plan;
mod core;
mod error;
pub(crate) mod http;
pub mod logging;
mod secret;

pub use crate::core::{Core, CoreConfig, TELEGRAM_API};
pub use crate::error::CoreError;
pub use crate::secret::Secret;
```

Run `cargo test -p dc-core` → all pass; `cargo clippy --workspace --all-targets -- -D warnings`; `cargo fmt --all --check`.

- [x] **Step 7: the bridge and the device check.** `rust/Cargo.toml` gains
  `anyhow = "=1.0.104"`. In `rust/src/api/core.rs`:

```rust
use std::sync::OnceLock;

static CORE: OnceLock<dc_core::Core> = OnceLock::new();

/// Starts the core once per app process; later calls do nothing.
pub fn start_core(data_dir: String, cache_dir: String) -> anyhow::Result<()> {
    if CORE.get().is_none() {
        let core = dc_core::Core::start(dc_core::CoreConfig::new(data_dir.into(), cache_dir.into()))?;
        // If another call won the race, its core stays and this one is dropped.
        let _ = CORE.set(core);
    }
    Ok(())
}

/// One HTTPS request from the device to Telegram; the HTTP status.
pub async fn check_telegram() -> anyhow::Result<u16> {
    let core = CORE.get().ok_or_else(|| anyhow::anyhow!("the core is not started"))?;
    Ok(core.check_telegram().await?)
}
```

Regenerate (`flutter_rust_bridge_codegen generate` in the plugin), then add to
`example/integration_test/core_test.dart` (`import 'dart:io';`):

```dart
test('the core reaches Telegram over HTTPS from this device', () async {
  final base = Directory.systemTemp.createTempSync('dc-core-test').path;
  await startCore(dataDir: '$base/data', cacheDir: '$base/cache');
  expect(await checkTelegram(), inInclusiveRange(200, 399));
});
```

- [x] **Step 8: Gate 2** — `flutter test integration_test/core_test.dart -d
  <device>` from `example/` on the iOS Simulator and on the Android emulator:
  3/3 each. Paste the output into DESIGN_NOTES.

- [x] **Step 9: Gate 3** (two review agents), then commit code
  (`feat(core): foundations — Core, Secret, CoreError, logging, TLS client`)
  and docs (tick 1.0, DESIGN_NOTES entry, EXECUTION_STATUS, NOW.md).

**Carried forward from Task 1.0's Gate 3** (accepted LOWs, each owned by a
later task):
- **1.2:** the worker URL must be `https://` (or `http://` only to a loopback
  or local-network address, §5.3) — checked when the URL is accepted, before
  the session token is ever sent to it. The HTTP client itself allows
  `http://` because self-hosters on a home network need it.
- **1.8 and P2:** the logger's sink is fixed when the logger is installed
  (once per process). `dc-cli` installs its sink before `Core::start`; the
  app's log stream (§5.9) reads `recent_logs()` or gets a replaceable sink
  then.
- **P2:** the bridge's process-wide `Core` lives until the app ends, so
  per-account state (session, bot token, keys) must sit in a resettable part
  of `Core` for sign-out; errors reach Dart as text through `anyhow` until a
  typed error is needed (`SignedOut`, task 1.2).


## Task 1.1 — Crypto

**Delivers:** the spike's crypto (proven 2026-10-27/29 against
`drive/src/crypto.js`, both directions, up to a full 19 MiB part) moved into
`dc-core`, with the production-JavaScript checks in CI.

**Files:**
- Create: `mobile/core/compat/{gen-vectors.mjs,verify-rust-output.mjs,vectors.json}`
  (copied from `~/dc-work/p1-spike/compat/`; `vectors.json` regenerated here)
- Create: `mobile/core/dc-core/src/crypto.rs`, `mobile/core/dc-core/examples/emit_vectors.rs`
- Modify: `mobile/core/dc-core/{Cargo.toml,src/lib.rs}`, `.github/workflows/mobile-core.yml`

**Interfaces (later tasks rely on these):** `dc_core::crypto::{Key,
CryptoError, derive_key(password, salt_b64) -> Result<Key, CryptoError>,
encrypt_part(&Key, &[u8]) -> Result<Vec<u8>, CryptoError>,
decrypt_part(&Key, Vec<u8>) -> Result<Bytes, CryptoError>,
verify_drive_key(&Key, check_b64) -> bool, forgiving_base64, IV_LEN, TAG_LEN,
PBKDF2_ITERATIONS, DRIVE_KEY_CHECK_PLAINTEXT}`. `CryptoError` = `BadSalt |
Truncated(usize) | Authentication | Random | PartTooLarge`.

- [x] **Step 1: Dependencies** — `[dependencies]` gains `aes-gcm = "=0.11.1"`,
  `base64 = "=0.23.1"`, `bytes = "=1.12.1"`, `getrandom = "=0.4.3"`,
  `pbkdf2 = { version = "=0.13.0", default-features = false, features = ["hmac"] }`,
  `sha2 = "=0.11.1"`, `subtle = "=2.6.1"`; `[dev-dependencies]` gains
  `hex = "=0.4.3"`, `serde = { version = "=1.0.229", features = ["derive"] }`,
  `serde_json = "=1.0.154"` (the example uses them too).
- [x] **Step 2: Vectors** — copy the two scripts to `mobile/core/compat/`
  (their default repo root is `../../..` from there, which is the repo root)
  and run `node mobile/core/compat/gen-vectors.mjs > mobile/core/compat/vectors.json`.
- [x] **Step 3: Tests first** — `src/crypto.rs` with the spike's eight tests
  (`derives_the_same_key_as_production_javascript`,
  `decrypts_parts_production_javascript_encrypted`,
  `fixed_iv_output_is_byte_identical_to_webcrypto`,
  `round_trips_and_uses_a_fresh_iv_each_time`,
  `rejects_wrong_key_tampering_and_truncation`, `verifies_the_drive_key_check`,
  `salt_decoding_matches_atob`, `debug_output_never_shows_key_bytes`), reading
  `include_str!("../../compat/vectors.json")`. Run → fails (no module).
- [x] **Step 4: The module** — the spike's `crypto.rs` with one change: no
  `expect`. `encrypt_part_with_iv` returns `Result<Vec<u8>, CryptoError>` and
  maps AES-GCM's only failure (a plaintext over 64 GiB) to `PartTooLarge`:

```rust
pub(crate) fn encrypt_part_with_iv(key: &Key, iv: &[u8; IV_LEN], plaintext: &[u8]) -> Result<Vec<u8>, CryptoError> {
    let mut out = Vec::with_capacity(IV_LEN + plaintext.len() + TAG_LEN);
    out.extend_from_slice(iv);
    out.extend_from_slice(plaintext);
    let (_, body) = out.split_at_mut(IV_LEN);
    let tag = key
        .cipher()
        .encrypt_inout_detached(&Nonce::from(*iv), &[], body.into())
        .map_err(|_| CryptoError::PartTooLarge)?;
    out.extend_from_slice(&tag);
    Ok(out)
}
```

  (`encrypt_part` returns `encrypt_part_with_iv(key, &iv, plaintext)`; the
  fixed-IV test unwraps it.) Run → 8 pass; clippy, fmt.
- [x] **Step 5: Rust → JavaScript** — `examples/emit_vectors.rs` (the
  spike's, `spike::` → `dc_core::`), then
  `cargo run -q -p dc-core --example emit_vectors | node mobile/core/compat/verify-rust-output.mjs`
  → five `ok` lines, exit 0. In `mobile-core.yml`'s `core` job add
  `actions/setup-node` (Node 22) and that command as a step, and add
  `drive/src/crypto.js` to both `paths:` lists — a change to the production
  crypto must re-run the check.
- [x] **Step 6: Gate 2** — the vectors are the real-conditions check (the
  production code itself produced and verified them); paste both directions'
  output into DESIGN_NOTES. Gate 3; commit code, then docs.
