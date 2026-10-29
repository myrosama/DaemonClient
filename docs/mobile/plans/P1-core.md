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
