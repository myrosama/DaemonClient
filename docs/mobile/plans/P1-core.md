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
  `bulk-upload-check` in 1.2; `POST /api/assets` with `clientUpload=true` and
  `POST /api/assets/:id/thumbnail` in 1.7; the Drive routes in P3 (moved at
  Task 1.2 — each is built where it is first used).

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
4. **Thumbnail and preview** — the 256 px JPEG, its thumbhash and (for
   HEIC/HEIF/RAW) a ~1440 px JPEG preview come from the phone's own image
   engine (made by the app, P2), encrypted and sent by the core like a part.
5. **Create the asset** — `POST /api/assets` with `clientUpload=true`, the part
   list, the thumbnail's and preview's ids, device identity (`deviceAssetId`,
   `deviceId`, so a retry finds the existing asset instead of making a second
   one), dates, size, type, dimensions, duration, location, favourite,
   live-photo pairing, thumbhash and EXIF — metadata only.
6. *(Changed by SPEC D23, 2026-11-16: the worker's D18 route, which sent the
   pictures to Telegram itself, is not used — the phone sends them in step 4.)*
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

## Task 1.2 — Sign-in and the worker client

**Delivers:** sign-in (hosted and self-hosted, §5.3), the address rules, and
the worker's read routes the core needs first — `telegram-config`,
`zke-config` (with the Photos key derived off the async threads),
`dc-manifest`, `bulk-upload-check`. **Moved out (ponytail: built when used):**
`POST /api/assets` and the thumbnail route → 1.7; the Drive routes → P3.

**Files:** create `mobile/core/dc-core/src/{session,worker}.rs`,
`examples/sign_in.rs`; modify `src/{error,core,lib}.rs`, `Cargo.toml`
(`reqwest` gains `json`; `serde` with `derive` and `serde_json` move to
`[dependencies]`).

**Interfaces:**
- `CoreError` gains `SignedOut`, `WrongCredentials`, `NotProvisioned`,
  `BadAddress`, `NotFound`, `Server(String)` (the server's own message,
  scrubbed, at most 200 characters). A response body that is not the
  expected JSON is `Server("unexpected reply…")`.
- `session::{HOSTED_API = "https://api.daemonclient.uz", Deployment::{Hosted,
  SelfHosted}, Session { worker_url, token: Secret<String>, user_id, email,
  name }, normalize_server(&str) -> Result<String, CoreError>,
  sign_in(&reqwest::Client, server, Deployment, email, password) -> Result<Session, CoreError>}`.
- `worker::{Worker::new(reqwest::Client, Session), Worker::telegram_config()
  -> TelegramConfig { bot_token: Secret<String>, channel_id: String },
  Worker::zke_config() -> ZkeConfig { enabled, password: Option<Secret<String>>,
  salt: Option<String>, mode: Option<String> }, Worker::photos_key() ->
  Option<crypto::Key>, Worker::manifest(asset_id) -> AssetManifest,
  Worker::bulk_upload_check(&[(id, checksum)]) -> Vec<UploadCheck>}`.
- `Core::{sign_in(server, Deployment, email, password) -> Session,
  restore(Session), sign_out(), worker() -> Result<Arc<Worker>, CoreError>}`.

**Rules the tests pin:**
- `normalize_server`: trims; adds `https://` when no scheme is given; drops
  trailing `/` and a trailing `/api`; refuses credentials, a query or a
  fragment in the address; **`https` only — `http` only to a loopback or
  private-network address** (self-hosters at home; Task 1.0's carried-forward
  LOW). It is applied to the address the user types **and** to the
  `workerUrl` the server returns, before the token is ever sent there.
- `sign_in`: `POST {base}/api/auth/login` `{email (trimmed), password}`.
  `401` → `WrongCredentials`; other failures → `Server(message)` (e.g. 429
  "Too many sign-in attempts…", 403 "Verification failed"). No `workerUrl`:
  hosted → `NotProvisioned`; self-hosted → the server itself.
- Worker calls send `Authorization: Bearer` (reqwest marks it sensitive);
  `401` → `SignedOut`, `404` → `NotFound`, others → `Server(message)`.
- `TelegramConfig` accepts `channelId` as a string **or** a number; its
  `Debug` never shows the token. `ZkeConfig`'s password is a `Secret`.
- `photos_key()` derives the key with `spawn_blocking` (PBKDF2 is slow on
  purpose) — `None` when encryption is off or incomplete.
- `manifest(asset_id)` refuses ids that are not `[0-9a-f-]{1,64}` before
  building a URL (`BadAddress`).

- [x] **Step 1:** dependencies; tests first in `session.rs` and `worker.rs`
  against `wiremock` (the fake server is `http://127.0.0.1`, which the rules
  allow): address cases (`"x.workers.dev"` → `"https://x.workers.dev"`,
  `"https://x.dev/api/"` → `"https://x.dev"`, `"http://192.168.1.5:2283"` ok,
  `"http://localhost:8080/api"` ok, `"http://example.com"`, `"ftp://x"`,
  `"https://u:p@x.dev"`, `"https://x.dev/?a=1"`, `""` → `BadAddress`);
  hosted sign-in → `Session` with the normalised worker URL and the trimmed
  email sent; hosted without `workerUrl` → `NotProvisioned`; self-hosted
  without → the server; a returned `http://` public worker URL →
  `BadAddress`; `401` → `WrongCredentials`; `429` → `Server` with the
  message; worker GET carries the Bearer token; `401` → `SignedOut`; numeric
  `channelId`; the token absent from `Debug`; zke on/off → key / `None`; a
  manifest with every field; the asset-id guard; bulk check request and reply.
  Run → fail.
- [x] **Step 2:** `error.rs`, `session.rs`, `worker.rs`, `Core` methods. Run
  → pass; clippy, fmt, `cargo deny check advisories`.
- [x] **Step 3: Gate 2** — `examples/sign_in.rs` signs in to the **test
  account** with the password from the macOS Keychain (decision C8: the
  operator runs `security add-generic-password -s daemonclient-test -a
  <email> -w` once; the example reads it with `security find-generic-password
  -s daemonclient-test -w`), then reads the Telegram and zke config and
  derives the Photos key. It prints only the worker's host, whether a bot
  token and a channel are present, the encryption mode and how long the key
  took — **never** a token, password or key.
- [x] **Step 4:** Gate 3; commit code, then docs.

**Carried forward from Task 1.2's Gate 3** (accepted LOWs and notes, each owned):
- **1.3:** a missing Telegram config (no `botToken`) → `NotProvisioned`, not a
  raw decode error; cache the Telegram config per session, clear on sign-out.
- **1.5:** cache the Photos key per session; treat any `encryptionMode` other
  than `server`/`client` as plain (the manifest defaults to `""`, the worker's
  default is `off`); `From<CryptoError> for CoreError`; cap reply sizes.
- **1.7:** zke `enabled` with empty settings must **refuse to upload** —
  `photos_key()` returns `None` for both "off" and "incomplete", so 1.7 checks
  `enabled` itself (the D1 adapter calls a plaintext upload here a fail-open).
- **P2:** a worker `401` must clear the session (SPEC §4.1); a sign-in that
  finishes after sign-out signs back in (reset per-account state); P2 stores
  all five `Session` fields (§5.9's `restore(sessionToken)` is out of date).
- **Accepted (operator's design §5.3):** plain http to a private-network
  address stays allowed for **self-hosted** servers only. A phone that later
  joins a hostile network could send the session token to whatever answers
  there; hosted workers are always https.
- **Risk:** if the central login ever enforces Turnstile (`TURNSTILE_SECRET`),
  app sign-in gets 403 "Verification failed" — tell the Linux machine first.


## Task 1.3 — The Telegram client

**Delivers:** the user's bot, spoken to directly (design §5.4): `getFile`
with its answer cached, file download with a size cap, `sendDocument`,
`sendPhoto`, `deleteMessage`; every answer classified; sends paced per bot.
Also from 1.2's carried-forward list: a missing Telegram config is
`NotProvisioned`, and the config is cached per session.

**Files:** create `src/telegram.rs`, `src/sched/{mod,bucket}.rs` (the token
bucket ported from Nuke now, because sends need it first; 1.4 reuses it),
`examples/telegram_roundtrip.rs`; modify `src/{error,worker,core,lib}.rs`,
`Cargo.toml` (`reqwest` gains `multipart`; `tokio` gains `time`).

**Interfaces:**
- `CoreError` gains `RateLimited { retry_after: u64 }` ("Telegram asked to
  wait N s") and `TelegramRejected(String)` (Telegram's own description,
  e.g. "Bad Request: chat not found", with "check the bot in Settings").
- `sched::bucket::TokenBucket::{new(rate_per_sec, burst, now), try_take(now)
  -> bool, wait(now) -> Duration}` — a token is taken only when work starts.
- `telegram::Telegram::new(http, api_base, Secret<String> bot_token,
  channel_id)`; `get_file(file_id) -> String` (path; cached 55 minutes, at most
  4,096 entries); `download(file_id) -> Vec<u8>` (getFile, then the file;
  refuses more than 20 MiB; a `400`/`404` on a cached path drops it and asks
  once more); `send_document(name, bytes) -> Sent { message_id, file_id }`
  (paced); `send_photo(jpeg) -> Sent` (largest size's `file_id`; paced);
  `delete_message(message_id)`.
- `Worker::telegram_config()` → `NotProvisioned` when the bot token or channel
  is missing or empty; cached for the life of the `Worker` (a new session is a
  new `Worker`).
- `Core::telegram() -> Result<Arc<Telegram>, CoreError>` for the signed-in
  account (built from the cached config, kept until sign-out).

**Rules the tests pin:**
- Answers: `ok: true` → the result; `429` (or `error_code` 429/420) →
  `RateLimited` with `parameters.retry_after`; `400/401/403/404` →
  `TelegramRejected(description)`; `5xx` and network failures → `Network` /
  `Server`. The bot token never appears in an error (URLs are dropped, text
  scrubbed).
- Sends: one token per send from a bucket of 1 per 1.5 s, bursts of 8
  (RESEARCH §12); a `RateLimited` send pauses all sends until `retry_after`
  has passed. Downloads are not paced here (the scheduler, 1.4, owns reads).
- The bucket (Nuke's tests): a burst runs at once; then one token per
  1/rate; never more than the burst; time going backwards takes nothing.

- [x] **Step 1:** dependencies; tests first — `bucket.rs` (burst, refill,
  cap, wait time) and `telegram.rs` against `wiremock` with
  `api_base = server.uri()`: `getFile` + download round trip; the second
  `download` of the same id skips `getFile` (cache); a stale path (`404`)
  re-asks `getFile` once; an answer over 20 MiB (by `Content-Length` and by
  streamed bytes) is refused; `sendDocument` sends `chat_id` and the file
  under the given name and returns `message_id` + `file_id`; `sendPhoto`
  takes the last (largest) size; `429` with `retry_after: 7` →
  `RateLimited { retry_after: 7 }`; `403` "bot was kicked" →
  `TelegramRejected`; an error's text never contains the token; nine sends in
  a row: eight at once, the ninth waits ~1.5 s (paused tokio clock). Worker:
  missing `botToken` → `NotProvisioned`; a second `telegram_config()` makes
  no request. Run → fail.
- [x] **Step 2:** implement. Run → pass; clippy, fmt, `cargo deny`.
- [x] **Step 3: Gate 2** — `examples/telegram_roundtrip.rs`: sign in to the
  test account (Keychain), send a small random document named
  `<16 hex>.part001` to its channel, read it back through `download` and
  compare, then delete the message. Prints sizes and timings only.
- [x] **Step 4:** Gate 3; commit code, then docs.

**As built (Task 1.3), differences from the steps above:** the Telegram
config is cached as the `Telegram` client in `Core::telegram()` (one per
session, so one pacer and one path cache), not in `Worker::telegram_config()`,
which stays uncached; worker and bot share one lock and the bot is made once
even under concurrent calls (Gate 3). Pacing is tested on `SendPacer` with a
paused clock (wiremock's real sockets and a paused clock do not mix); dev
dependency `tokio` gains `test-util`, `net`, `io-util`. `retry_after` is capped
at a day; 5xx answers are `Network` (transient); user-facing text says
"storage" (SPEC D21).

**Carried forward from Task 1.3's Gate 3:**
- **1.4:** what is left of Nuke's `RateLimiter` — the pending queue (new work
  waits behind pending work), the drain that skips cancelled work without a
  token, re-arming the timer, and their tests; the scheduler holds abort
  handles (`Core::run` detaches tasks, so dropping a caller does not cancel);
  a `400` from `getFile` is about one file, not the bot — it must not stop all
  reads; downloads need an overall time limit (a slow trickle resets
  `read_timeout`).
- **1.5:** cap the size of JSON answers (`answer()` reads them whole).
- **1.7:** `RateLimited` / `Network` are the retryable errors; at most one
  upload part sending at a time (the pacer's waiters are not served in order).
- **1.8:** measure the burst right after a 429 (the bucket has refilled — the
  production worker behaves the same).
- **Noted, not changed:** the bot token is not shape-checked before it goes
  into a URL path; copies of it inside reqwest/hyper buffers are not zeroized
  (comes with reqwest).


## Task 1.4 — Smart loading: the scheduler (Nuke port)

**Delivers:** design §5.5. Every Telegram read and every upload part goes
through one scheduler: coalescing, four classes with the opened item first,
reserved slot, per-class caps, cancellation when nobody waits, a token bucket
that cancelled work never spends, a global pause on `429`.

**Files:** create `src/sched/{state,shell}.rs`; modify `src/sched/mod.rs`,
`src/error.rs` (`CoreError` derives `Clone` — one result goes to every waiter).

**Interfaces:**
- `sched::Class::{Background, Visible, Next, Opened}` (ordered, lowest first);
  `sched::Kind::{Read, Send}`.
- `sched::Limits { max_running: 6, reserved_high: 1, max_next: 2,
  max_background: 2, max_sending: 1, reads_per_sec: 20.0, read_burst: 10.0,
  job_timeout: 300 s }` (`Limits::default()`; measured in 1.8).
- `sched::state::State` — pure, no I/O, time passed in:
  `subscribe(key, kind, class, now) -> (SubId, Vec<Action>)`,
  `unsubscribe(sub, now) -> Vec<Action>`,
  `finished(job, Outcome::{Done, Failed, RateLimited(secs)}, now) -> Vec<Action>`,
  `tick(now) -> Vec<Action>`, `next_wakeup() -> Option<Instant>`;
  `Action::{Start { job, key, kind }, Cancel { job }, Finish { job, subs }}`.
- `sched::Scheduler::new(Limits, fetch: Arc<dyn Fn(String) -> BoxFuture<Result<Bytes, CoreError>>>)`
  (spawned on the core's runtime); `read(key, class) -> Ticket` (`Ticket::wait()
  -> Result<Bytes, CoreError>`; dropping it unsubscribes); `send_slot() ->
  Permit` future (a Background send slot; dropping the permit frees it).

**Rules the tests pin** (Nuke's — RESEARCH §9b — and ours, SPEC §4.9):
- Coalescing: one job per key; its class is the highest of its subscribers';
  it is cancelled only when the last subscriber leaves (a pending job then never
  runs and spends no token); every subscriber gets the same result or error; a
  new request after all left starts new work.
- Order: higher class first; FIFO within Opened/Next/Background, **newest
  first within Visible**; a pending job moves when its class changes; a running
  job's class change does not move it.
- Slots: at most `max_running`; the last `reserved_high` only for Opened/Next;
  at most 2 Next, 2 Background, 1 Send running.
- **Opened first (D17):** while an Opened job is pending or running, nothing
  below it starts; running Visible reads and Sends finish; running Background
  **reads** are cancelled and re-queued. Everything resumes when it finishes.
- Rate limit: a Read takes a token only when it starts; Opened skips the
  bucket; deferred reads start in order as tokens refill; never more than the
  burst.
- `429`: the job goes back to the front of its class and **all reads** pause
  for `retry_after`; sends are paced separately (Task 1.3).
- Shell: a job is a task with an abort handle — cancelling aborts it (closes
  the connection); each job is limited to `job_timeout` (a slow trickle, Task
  1.3's carry-forward); errors are per job (a `400` for one file stops nothing
  else).

**Not ported (YAGNI, recorded):** changing limits at run time; a running
job's priority raise freeing its low-priority slot.

- [x] **Step 1:** tests first on `State` with a fake clock — the rules above,
  one test each (max concurrency; class order; FIFO vs newest-first; a pending
  job moving up and down; reserved slot; per-class caps; cancelled pending work
  never runs and spends no token; Opened suspends, running continues, resume
  drains; Background read pre-empted and re-queued, Visible/Send not; burst,
  refill, order of deferred reads, cancelled deferred read spends no token;
  Opened skips the bucket; coalescing: one start for two subscribers, cancel
  only after the last leaves, joining mid-run gets the same finish, error
  reaches all, new work after all left, class follows the highest subscriber
  and drops when it leaves; 429 pauses reads, re-queues at the front, sends
  continue). Then the shell (paused tokio clock where no sockets are
  involved): two tickets for one key → one fetch; dropping the only ticket
  aborts the fetch; a send permit is exclusive and freed on drop; a job over
  `job_timeout` fails. Run → fail.
- [x] **Step 2:** implement `state.rs`, then `shell.rs`. Run → pass; clippy,
  fmt, `cargo deny`. Credit Nuke in the module headers (NOTICE done in 1.3).
- [x] **Step 3: Gate 2** — the scheduler against fakes is the real condition
  here (Telegram limits are measured in 1.8): a load run of 10,000 requests
  from a simulated fast scroll with cancellations — started jobs ≈ what was
  still wanted, the opened request starts first, and no more than the burst
  in any instant. Recorded in DESIGN_NOTES.
- [x] **Step 4:** Gate 3; commit code, then docs.

**As built (Task 1.4), differences from the steps above:**
- The reserved slot is for the **opened item only** — the rule above said
  "Opened/Next", which let Next work fill it; SPEC §4.9 ("never waits for a
  free one") and the web's port win (Gate 3).
- Slots are counted by the class a job **started** in, so raising or lowering
  a running job moves no slot (this is the "Not ported" line, now pinned).
- The opened item never waits for a token but **spends one when there is
  one** (fast swipes in the viewer are metered); a re-queued pre-empted
  prefetch spends a second token when it restarts.
- `429`: the pause is at least 1 s (a `retry_after: 0` spun at 1,000/s) and
  at most a day; after **3** rate limits the job fails with the rate-limit
  error. An opened item waiting out a pause does not hold up uploads. A 429
  from Telegram's file server is now a rate limit too (was a plain error).
- Interfaces: `Scheduler::start(Limits, Fetch)` spawns on the **current** tokio
  runtime (1.5 creates it inside the core's); `State::subscribe(sub, key,
  kind, class, now)` — the caller picks unique `sub` ids; `send_slot()` is
  `async → Result<Permit>`; `Fetch` returns `Bytes` (`Telegram::download`
  gives `Vec<u8>` — `Bytes::from` is free). Dropping the `Scheduler` stops it:
  running jobs aborted, waiting tickets get an error (sign-out). A panicking
  fetch becomes an `Internal` error instead of a waiter left hanging.
- Not wired into `Core` yet — that is 1.5.
- **Bug found in Task 1.3's code:** `TokenBucket::wait()` rounded to 0 ns when
  the tokens were a float hair under 1.0 while `try_take()` refused, so
  `SendPacer` let an occasional upload part through unpaced. Fixed in the
  bucket (wait is never zero without a token), with a test.

**Carried forward from Task 1.4's Gate 3:**
- **1.5:** create one `Scheduler` per signed-in account inside `Account` (its
  `Fetch` holds that account's bot) and drop it on sign-out; route every read
  through it (`Telegram::download` stays `pub` for the examples and dc-cli
  only); create it on the core's runtime.
- **1.8:** measure how many pending jobs the O(n) scan copes with on a phone
  (20k pending = 2.3 s on the Mac); add an ordered index if prefetch or
  upload queues get that long.
- **P2 (UI):** during a sustained fast fling every started fetch is cancelled
  (each tile is on screen less than one fetch) — bounded by the rate, but
  wasted. Check that Immich's thumbnails defer loading during fast scrolls
  (Flutter's scroll-aware image loading) so such requests never reach the core.
- **Before video work:** the web caps how long the opened item may suspend
  everything (`maxSuspendMs`) because playhead parts chain; the phone has no
  cap yet — decide then.


## Task 1.5 — The read path

**Delivers:** design §5.6 — every asset shape of the account read correctly:
the manifest fetched, checked and cached; the right Telegram file chosen for
each request; decrypted per the asset's mode; thumbnails and previews kept on
disk; originals read part by part and by byte range; every download through
the account's scheduler (Task 1.4).

**Files:** create `src/reader.rs` (selection, manifest check, range reader),
`src/disk_cache.rs`; modify `src/core.rs` (`Account` gains the scheduler,
the Photos key, the manifest cache), `src/error.rs`, `src/worker.rs` and
`src/telegram.rs` (reply size caps).

**Interfaces:**
- `reader::Rendition::{Thumbnail, Preview, Original, Playback}`.
- `reader::select(&AssetManifest, Rendition) -> Selection { file_ids, size,
  mime }` — pure. Thumbnail/Preview: the web's `selectFileIds` exactly
  (`immich/web/src/service-worker/telegram-media.ts`): grid thumbnail → thumb
  → preview → (single-part) original; preview/fullsize → preview →
  (single-part) original or thumb → (multi-part) thumb; thumb/preview are
  `image/jpeg`. Original: parts sorted by index, or `originalId` for one-part
  uploads. Playback: `playbackChunks` with `playbackSize` when present, else
  the original (`index.ts` `fetchVideoDirect`). Nothing to serve → `NotFound`.
- `reader::check(&Selection)` for Original/Playback — indexes exactly
  0…n−1, no gaps or repeats, and n = `part_count(size)` (one part for a
  0-byte file); a size of 0 with a non-empty single file is an older upload
  whose size was never stored — it is served at the length the file has.
  Fails → `CoreError::Corrupt`, never bytes at the wrong offsets.
- `Core::image(asset_id, Rendition::Thumbnail|Preview, Class) -> Bytes` —
  through the disk cache.
- `Core::layout(asset_id, Rendition::Original|Playback) -> Layout { size,
  parts, mime }` (what 1.6 answers `HEAD` with) and
  `Core::range(asset_id, rendition, start, end_inclusive, Class) -> RangeReader`
  with `async fn next() -> Option<Result<Bytes>>` — walks P0's `PartSlices`,
  one part at a time; each decrypted part must be exactly `PART_SIZE` except
  the last, `size − (n−1)·PART_SIZE`, else `Corrupt`.
- `CoreError::Corrupt(String)` ("this file is damaged …") and
  `From<CryptoError> for CoreError` (authentication failure → `Corrupt`).

**Rules** (design §5.6, and the carry-forwards from 1.2–1.4):
- Encrypted = `encryptionMode` `server` or `client`; anything else is plain.
  Encrypted with no Photos key → an error saying the encryption password is
  not set up (`NotProvisioned`), never the encrypted bytes.
- Per signed-in account, made on first use and dropped on sign-out with it:
  the Photos key (derived once), the scheduler (its fetch holds this
  account's bot), manifests (10 minutes, at most 4,096, all dropped when
  full).
- Disk cache: decrypted thumbnails and previews under `cache_dir/media`,
  file named by SHA-256 of the `file_id`, 500 MB, oldest-used dropped first
  (modified time touched on read), written to a temp file and renamed so a
  crash never leaves half a file. Originals are never kept.
- Reply caps: a worker or Bot API JSON reply over 4 MiB is refused.

- [x] **Step 1:** tests first, failing — `select` for every row of the table
  and every shape (one-part `originalId`, multi-part, no thumb, no preview,
  rendition, empty); `check` (gap, repeat, wrong count, 0-byte, size-0 older
  upload); the range reader across part boundaries, a short or long part →
  `Corrupt`, a wrong key → `Corrupt`, plain assets untouched; the disk cache
  (hit, atomic write leaves no partial file, eviction order, survives a
  restart); `Core::image` fetches a thumbnail once (second read from disk);
  sign-out drops key, scheduler and manifests; reply caps. Fakes: wiremock
  worker and Telegram, as in 1.2/1.3.
- [x] **Step 2:** implement. Run → pass; clippy, fmt, `cargo deny`.
- [x] **Step 3: Gate 2** — `examples/read_assets.rs` on the test account: list
  the account's assets through the worker's timeline (the web's calls), group
  them by shape (mode × parts × thumb/preview/rendition × image/video), and
  for one of each: read thumbnail and preview; read the original in full and
  three random ranges, and compare each with the same bytes from the worker's
  own `/api/assets/:id/original` (SHA-256 equal). Prints shapes, counts,
  sizes and timings only — never ids, names or tokens. Recorded in
  DESIGN_NOTES.
- [x] **Step 4:** Gate 3; commit code, then docs.

**As built (Task 1.5), differences from the steps above:**
- `check` is folded into `select`: a selection that does not add up is never
  produced. Stricter than the web in two places: one original file larger
  than a part is `Corrupt`; an empty `mimeType` stays empty (the worker
  always fills it).
- `range` takes `PartSlices` that the caller plans from `layout`'s size with
  P0's `chunk_plan` (1.6 answers 206/416/200 from that plan). `image` reads
  one stored file (thumbnails and previews; a multi-part original there is
  `Internal`). `layout` on a size-0 one-file asset downloads the file to
  measure it, and `range` downloads it again.
- **A shape the plan missed** (spec review): in an encrypted library, older
  uploads stored the thumbnail and preview as plain JPEGs. As the worker
  does, such a file is used as it is when decryption fails and its bytes are
  a JPEG or PNG — thumbnails and previews only, never parts.
- Encrypted with no Photos key → `NotProvisioned`, before downloading. A
  stopped scheduler (its account signed out) reports `SignedOut`.
- Picture cache (Gate 3, and the operator on 2026-11-15): named by SHA-256 of
  the account (user id, worker address), how the file is read and its
  `file_id`; emptied on sign-out and when another account signs in — not on
  the app's next launch; a write that began before a clear is dropped;
  only the manifest's thumbnail and preview files, ≤ 4 MiB, are kept;
  eviction to 90 %. SPEC §4.7 updated.
- Reply caps: manifests 1 MiB (~9,500 parts, about 180 GB), other JSON
  4 MiB, files 20 MiB — one capped reader for all three.
- `http` (the core's TLS client, for the examples) and `reader` are public.

**Carried forward from Task 1.5's Gate 3:**
- **1.6:** allow-list `Selection.mime` before it becomes a `Content-Type` (the
  worker supplies it); the per-launch secret (§5.7); which type a playback
  rendition is served as (the web sends the original's, the worker
  `video/mp4`); a video with only `originalId` has no preview — its
  "preview" is the video itself and must never reach an image decoder (P2
  too).
- **1.6 / P2:** `Telegram::download` (reachable through `Core::telegram()`)
  bypasses the scheduler — keep it off the bridge.
- **Linux (asked):** the worker treats a row with `encrypted: true` and no
  `encryptionMode` as server-encrypted, but its manifest reports `off`, so
  the web and the core would read it as plain.
- **1.8:** throughput — Gate 2 read ~1.5 MB/s in a debug build, one part at a
  time; next-part prefetch is 1.6.
- **Accepted:** the manifest's 10-minute life is not pinned by a test (no
  injectable clock); the media cache failing to open stops `Core::start`
  (only when its folder cannot be made, which start needs anyway); each call
  reads the account twice (fails closed — a `file_id` works only with its own
  bot, and the cache generation drops late writes); a grid thumbnail standing
  in for a one-file original is downloaded every time (§4.7).


## Task 1.6 — The local media server

**Delivers:** design §5.7 — Immich's own image loaders and the platform video
players fetch from `http://127.0.0.1:PORT/<secret>/api/…`, and the core
answers from the read path (Task 1.5), streaming, a part ahead.

**Files:** create `src/media_server.rs`, `examples/serve.rs`; modify
`src/reader.rs` (prefetch: starting a part's download is split from waiting
for it), `src/core.rs` (`Core::media_server()`), `src/lib.rs`, `Cargo.toml` +
`Cargo.lock` (`hyper` `server`/`http1`, `hyper-util` `tokio`,
`http-body-util` — all already in the tree through reqwest; HTTP/1.1 only).

**Interfaces:**
- `Core::media_server() -> MediaServer { grid_base, viewer_base }` — the
  design's `ensure_running`: binds both listeners on first call, returns the
  same addresses while they run, reopens one whose accept loop has ended
  (iOS closes a suspended app's sockets) and returns its new address. Works
  signed out (requests then get `401`); sign-out and another account leave
  the listeners alone. The secret is made once per `Core` (32 random bytes,
  hex).
- Routes, `GET` and `HEAD`: `/{secret}/api/assets/{id}/thumbnail?size=
  thumbnail|preview|fullsize`, `/{secret}/api/assets/{id}/original`,
  `/{secret}/api/assets/{id}/video/playback`; `edited` and other query
  parameters ignored.

**Rules:**
- **Secret:** a missing or wrong one → `403`, compared in constant time
  (`subtle`). Request paths are never logged (the secret is in them).
- **Classes (D17, decided here — the 1.4 carry-forward):** the grid listener
  reads at `Visible`, the viewer listener at `Opened`, but **only the first
  part of each request** — the parts prefetched behind it are `Next`, so a
  long video never holds the grid back for more than one part.
- **Thumbnail routes never answer with a video:** when the selected file is
  not an image (an `originalId`-only video has no preview, so "preview" is
  the video), the grid thumbnail is served instead (a JPEG). The worker
  sends the video; recorded as a difference.
- **Content-Type:** thumbnails and previews `image/jpeg`; an H.264 rendition
  `video/mp4` (the worker's choice; the web sends the original's type); an
  original its manifest type, only if it is `image/…` or `video/…` made of
  safe characters, else `application/octet-stream`.
- **Ranges** (RFC 9110 §14, P0's `chunk_plan`): `bytes=a-b`, `bytes=a-`,
  `bytes=-n` → `206` with `Content-Range`, the whole range served across
  parts; a start past the end → `416` with `Content-Range: bytes */size`; an
  end past the end trimmed; no `Range`, more than one range or one we cannot
  read → `200` with the whole file. `HEAD` answers sizes and types without
  downloading (except a size-0 older upload, which `layout` measures).
  `Accept-Ranges: bytes` always.
- **Streaming (C6):** each part is downloaded and checked in full, then sent;
  the next part's download starts as soon as the current one is in hand;
  the body holds at most one part — about two parts in memory per stream.
- **Hang-ups cancel:** a closed connection drops the response; the stream
  stops and its tickets go, so the scheduler drops what nobody waits for.
  hyper's `half_close` stays off (a read EOF ends the connection).
- **Errors:** `SignedOut` → `401`, `NotFound` / a bad id → `404`,
  `Corrupt` → `502`, network / rate limit / not provisioned → `503`; bodies
  carry no detail. Other methods `405`, other paths `404`.
- **Idle sockets:** any app on the phone can connect; headers must arrive
  within 30 s (`header_read_timeout`) or the connection closes.

- [x] **Step 1:** tests first, failing — secret (missing, wrong, right);
  every route and size; `405`/`404`; ranges across a part boundary with real
  19 MiB parts, suffix, past-the-end `416`, trimmed end, no/multiple/garbled
  `Range` → `200`; `HEAD` with no download (`.expect(0)`); the Content-Type
  allow-list (a manifest saying `text/html`); a video's "preview" served as
  its JPEG thumbnail; a rendition as `video/mp4`; the next part requested
  before the client reads the first; a stream's second part pending while a
  grid thumbnail still starts; a hang-up (raw `TcpStream`: write the
  request, drop the socket) cancels — a re-request downloads again; a
  signed-out request `401`; `media_server()` returns the same addresses
  twice and reopens a dead listener.
- [x] **Step 2:** implement. Run → pass; clippy, fmt, `cargo deny`.
- [x] **Step 3: Gate 2** — `examples/serve.rs --release` on the test account:
  starts the media server and a local counting relay in front of Telegram
  (`CoreConfig.telegram_api`), then through the media server only: a grid
  thumbnail is a JPEG; a full original is byte-identical to the worker's
  (SHA-256); three ranges match; **AVFoundation on this Mac** loads a
  multi-part video from the viewer address and draws a frame from its middle
  (as AVPlayer would), timed to the first frame. Prints Telegram downloads
  per part during that load: if any part is downloaded more than once
  (players read the index at the end, then the start), a small in-memory
  cache of the last parts (SPEC §4.7 "a small bounded cache") is added here.
- [x] **Step 4:** Gate 3 (one reviewer at a time); commit code, then docs.

**Carried into this task from 1.5:** a manifest refreshed between `layout()`
and `range()` can leave the slices planned for the old size — it fails
closed as `Corrupt`; `examples/read_assets.rs` signs out on the error path
too; DESIGN_NOTES 1.5 says whether a test-account thumbnail took the plain
fallback is not observable (the unit test is the evidence).
**For P2:** the app's server address becomes `http://127.0.0.1:PORT/<secret>`
— a base with a path; check that Immich's URL handling keeps the path.

**As built (Task 1.6), differences from the steps above:**
- **A new secret per listener**, not one per `Core` (security review, HIGH):
  a closed port can be taken by another app, which then receives the old
  secret with the app's next request. `ensure_running` challenges each port
  (a fresh nonce; only our listener can answer with the HMAC of its secret) —
  iOS can close a suspended app's socket while its accept loop never
  notices, and another app may then hold the port — and reopens it with a new
  secret; a listener's connections end with it. A busy port that cannot
  answer within the deadline is reopened too (safe; see DESIGN_NOTES 1.6). Accept errors pause 100 ms and, after 20 in a row, end the
  listener; at most 32 connections per listener (a semaphore before
  `accept`); a `403` closes its connection; SVG is not a picture.
- **A part cache** (Step 3's own criterion: AVFoundation's probe of the first
  2 bytes, then the whole file, then the end, downloaded every part twice):
  the last 3 parts read, 57 MiB, in memory, per account, used only by the
  range reader; dropped at sign-out (structurally — the account owns it).
- **C6 measured:** an iPhone `.mov` keeps its index at the end, so a video
  opens after **two** parts (the probe, then the end), not one — ~8 s at
  ~5 MB/s on this Mac. Recorded in SPEC §11 for the operator; a candidate for
  1.8: fetch the last part alongside the first.
- Interfaces: `Core::media_server(self: &Arc<Self>)` — the bridge holds an
  `Arc<Core>`; `MediaServer` has no `Debug` (it holds the secrets);
  `Core::image()` returns `Image { bytes, mime }` and is never a video (a
  video with no preview gets its JPEG thumbnail; a one-file original with an
  empty type is now `404`, where 1.5 served it); `Core::range()` takes the
  size it was planned on and refuses (`Corrupt`) if the manifest changed in
  between; a stream's first part read from memory leaves the next download
  at the listener's class.
- A one-file original standing in for a thumbnail keeps its own image type;
  `fullsize` is the preview; `HEAD` on a thumbnail route downloads the
  picture (only originals and videos answer `HEAD` from the manifest).
- The 1.4 carry-forward on suspension during video (the web's
  `maxSuspendMs`) is closed by the classes rule: only a request's first part
  runs at `Opened`. The 1.5 carry-ins are done (`read_assets` signs out on
  every path; DESIGN_NOTES 1.5 says the plain-picture fallback is shown by
  its unit test only).
- tokio `net`, `PartSlices::bounds()`, `disk_cache::hex` crate-visible.

**Carried forward from Task 1.6's Gate 3:**
- **P2:** the app's HTTP client must open at most 32 connections per host
  (Dart's `HttpClient` has no limit by default; a 33rd waits for an idle one
  to close); the base URLs carry a path (`/<secret>`) — check Immich keeps
  it; call `media_server()` on every resume, off the UI thread and off the
  core's threads (it can block ~2 s per listener), use the addresses it
  returns and reload what failed when they change;
  check on a device which error iOS gives a reclaimed socket and that the
  reopen works; `Telegram::download` stays off the bridge; the bridge holds
  `Arc<Core>`.
- **1.8:** fetch the last part alongside the first when a player probes the
  start (halves a video's opening); measure the part cache's size on a phone.
- **Accepted, untested:** `header_read_timeout`; a stream cut mid-way after
  its headers; a hang-up during streaming dropping the prefetched part; the
  part cache's drop at sign-out. A stream started before sign-out can still
  send the part it already holds and one prefetched part (the request was
  allowed when made).


## Task 1.7 — The upload engine

**Delivers:** design §5.8 steps 1–7, in the foreground: a file on the phone
becomes an asset of the account, its bytes sent to Telegram by the core
itself, the worker given only the metadata (`clientUpload`), exactly as the
website's uploader does it (`immich/web/src/lib/utils/file-uploader.ts`,
`daemonclient-drive.ts` `uploadMedia`) plus the phone's improvements
(C3 random part names, C7 a few parts on disk, the resume journal).

**The background hand-off is in this task** (operator, 2026-11-16, SPEC
D22): the platform's background uploader sends parts straight to Telegram,
so the core prepares each part as a **complete multipart request body on
disk** (`chat_id` + `document`) and hands out `{body file, address,
content type}`; when Telegram answers, the core is given the answer and
records it. The foreground path uses the same two halves — it sends the
prepared file itself — so every foreground upload tests what the background
one will use. The address carries the bot token (D22's exception to D21): it
goes only to the platform uploader, never to the screen or the logs.

**Files:** create `src/upload.rs`, `examples/upload.rs`; modify
`src/core.rs` (`Core::upload`), `src/worker.rs` (asset creation, the D18
thumbnail route), `Cargo.toml` (`sha1`, RustCrypto, the same family as
`sha2` — the checksum the worker dedupes on is base64 SHA-1).

**Interfaces:**
- `Core::upload(UploadRequest, on_progress) -> Result<Uploaded, CoreError>`;
  `UploadRequest { path, file_name, mime, created_at, modified_at,
  device_asset_id, device_id, width, height, duration, favorite,
  live_photo_video_id, thumbnail, preview, thumbhash, exif }` — the device
  ids required (a retried creation then finds the asset already made); the
  pictures, thumbhash and EXIF made by the app (P2, D23);
  `Uploaded { asset_id, duplicate }`. Dropping the future stops the
  upload; calling `upload` again with the same request resumes it.
- The hand-off (D22): `Core::next_part(&job) -> Option<PartToSend { index,
  body_path, url, content_type }>` (prepares at most 2 ahead) and
  `Core::part_sent(&job, index, telegram_answer_json)` (checks and records
  it); `upload` is built on these two.
- The journal: `data_dir/uploads/<SHA-256 of device id + device asset id>`,
  JSON, written atomically, no secrets: the encryption mode and a
  fingerprint of the key it started with, the checksum, the parts sent
  (`{index, message_id, file_id}`), the thumbnail's `file_id`, the step.

**Rules:**
- **The original, byte for byte** (operator, 2026-11-16): the file at `path`
  is what is stored — no conversion (the website turns HEIC into JPEG; the
  phone never does). P2 hands the core the photo library's original resource
  (HEIC/RAW/MOV as shot, Live Photo pairs together), not an edited or
  re-encoded copy. Gate 2 proves it: each upload reads back byte-identical.
- **Dedupe on SHA-1** (base64), as the worker and the website do: a
  different hash would match nothing already stored and upload the whole
  library again. Part integrity is AES-GCM's; per-file progress is the
  journal's; which photos are backed up is the app's own database (P2).
- **Order** (§5.8, D23): checksum (streamed) → `bulk-upload-check` (already
  stored → `Uploaded { duplicate }`, nothing sent) → parts → thumbnail and
  preview → `POST /api/assets` (metadata only) → remove the temporary files
  and the journal.
- **Encryption:** the Photos key when the library is encrypted (`server`,
  as the website); none when encryption is off; **refused** when encryption
  is on but its settings are incomplete (the 1.2 carry-forward — never a
  plaintext upload by accident).
- **Parts:** 19 MiB slices, each with its own random IV, at most 2 waiting on
  disk (C7), each deleted once sent; names: random 16 hex + `.partNNN` when
  encrypted (C3), the real name (as the website) when not; one part at a
  time through the scheduler's send slot, paced by the Telegram client.
- **Journal:** each sent part recorded at once; a resumed upload sends no
  recorded part again; a key that changed since the journal was written
  means starting over; the asset creation is retried with the same parts.
- **Thumbnail and preview (D23):** made by the app's image engine; the core
  sends both itself — encrypted as documents (`thumb.bin`, `preview.bin`), or
  the thumbnail as a plain `sendPhoto` when the library is not encrypted (as
  the website) — and the worker gets only their ids. The worker's D18 route
  (which sent pictures to Telegram itself) is not used. A preview is given for
  HEIC/HEIF/RAW (the website cannot show those) and may be for others.
- **EXIF (D23):** read by the app's native engine, given to the core, sent as
  one `exif` field in the worker's `PhotoExif` shape (`make`, `model`,
  `lensModel`, `fNumber`, `focalLength`, `iso`, `exposureTime`,
  `orientation`, `dateTimeOriginal`, `latitude`, `longitude`).
- **Fields** (`clientUpload=true`, the worker's names): `telegramChunks`,
  `telegramOriginalId` (the part's `file_id` when there is one part),
  `telegramThumbId`, `encryptionMode`, `thumbEncrypted`, `fileName`,
  `fileSize`, `mimeType`, `checksum`, `fileCreatedAt`, `fileModifiedAt`,
  `deviceAssetId`, `deviceId`, `width`, `height`, `duration`, `latitude`,
  `longitude`, `isFavorite`, `livePhotoVideoId`, `thumbhash`, and — new,
  for the worker to store (Linux, worker release W2) — `telegramPreviewId`
  and `exif`. Until W2 the worker ignores those two: phone uploads then show
  no preview on the website and no EXIF panel.
- **Failures:** a rate limit waits and retries the same part (the Telegram
  client pauses); "the storage refused" stops the upload with that message;
  network trouble retries with growing waits (1, 2, 4 s), then returns the
  error with the journal kept.

- [x] **Step 1:** tests first, failing (wiremock worker + Telegram, as in
  1.2–1.6): checksum against a known SHA-1; a duplicate stops before any
  send; part slicing, names and IVs; the prepared body is a complete
  `sendDocument` request; the journal written before a body is deleted, and
  a resume sends nothing twice; `part_sent` given the same answer twice is
  fine, a second copy of a part is deleted from the channel; a changed key
  or file starts over and deletes the old parts; incomplete encryption
  refused; every form field and its name; one part → `telegramOriginalId`;
  thumbnail and preview sent by the core, no worker picture route; a rate
  limit retried; a refusal stops; temp files and journal gone at the end; a
  creation retried after an unrecorded success gets the same asset.
- [x] **Step 2:** implement. Run → pass; clippy, fmt, `cargo deny`.
- [x] **Step 3: Gate 2** — `examples/upload.rs` on the test account (uploads
  and deletes there are approved): a new JPEG, a HEIC made with `sips`, and a
  video over 100 MB (`avconvert` of a test-account video, so its checksum is
  new), each with a thumbnail and preview made by `sips`; each read back
  through the core byte-identical to its source (EXIF included), seen in the
  timeline, its thumbnail a picture; one upload stopped after two
  parts and resumed — a counting relay shows no part sent twice; the same
  file again → a duplicate, nothing sent; then the test assets deleted
  (`DELETE /api/assets`, which removes their parts from the channel).
- [x] **Step 4:** Gate 3 (one reviewer at a time); commit code, then docs.

**As built (Task 1.7), differences from the steps above:**
- Interfaces: `begin_upload(request) -> Begun::{Duplicate(Uploaded), Job}`,
  `UploadJob::pending()`, `part(&job, index) -> PartToSend` (the plan's
  `next_part`: the platform layer picks the index), `part_sent(&job, index,
  answer)`, `finish_upload(job)`; `upload(request)` runs them all in the
  foreground. `PartToSend { index, body_path, content_type }` + `address()`
  (no `Debug`). No progress callback: P2 reports progress from `pending()`.
- The journal: `uploads/<account>/<file>/journal.json` + `<index>.body` —
  the checksum, the key's fingerprint (none = plain), the random name, the
  parts, thumbnail and preview, and a `creating` flag set before the asset is
  asked for: from then on nothing it lists is taken out of the channel (an
  asset may point at it — the spec review's HIGH: a lost answer to a
  successful creation followed by a "duplicate" deleted the asset's parts).
- From the security review: an upload belongs to the account that began it
  (its worker and bot kept, every step checks the signed-in account,
  per-account folders, all of `uploads/` wiped at sign-out and account
  switch); encryption settings read again for every file (the key derived
  again only when they change); an answer from the platform uploader is
  recorded only for its own part (index, name, size); the file's size and
  modified time checked before each part is read; one upload per file at a
  time; journal writes flushed to disk with unique temporary names; a
  duplicate takes what an earlier attempt sent out of the channel (unless
  `creating`); at most 2 prepared parts wait on disk (a refusal, not a
  prefetch — C7).
- From Gate 2: sends use their own HTTP client — reqwest's 30 s "read"
  limit runs from the start of a request until the answer begins, so a
  19 MiB part on a slow uplink always failed; sends get a time limit from
  their size (20 KB/s, a minute at least) and TCP keepalive instead.
- `latitude`/`longitude` are sent from the EXIF: until worker release W2
  reads `exif`, location comes only from them. Thumbnail and preview go
  through the send slot with the same retries as parts.

**Carried forward from Task 1.7:**
- **P2:** the platform uploaders (URLSession, WorkManager) on `part` /
  `part_sent`; cancel their tasks at sign-out or account switch (the core
  deletes the bodies and journals; a late answer then fails); the backup
  queue and the app's record of what is backed up; progress from
  `pending()`; abandoned uploads (a photo deleted mid-upload) cleaned up;
  never log `PartToSend::address()` in Dart.
- **Linux (W2):** the worker stores `telegramPreviewId` and `exif`.
- **Accepted:** parts sent before a wipe at sign-out stay in that channel
  unused; the encryption settings cost one small worker request per file.

