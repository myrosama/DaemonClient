# Mobile apps — spec

**Status:** **approved by the operator, 2026-10-04.** Implementation follows
`PLAN.md`.
Changes to this file need the operator's approval; record each one in the
decisions log (§11).

Findings this spec rests on are in `RESEARCH.md`, cited as R§n.

---

## 1. Goal

Two phone apps — **DaemonClient Photos** and **DaemonClient Drive** — for
iPhone and Android, that work the way the website already works: **the phone
does the heavy work** (encrypting, decrypting, sending to and fetching from
Telegram, streaming video) and the user's worker keeps only small metadata.
The current mobile app sends whole files through the worker and is unreliable
because of it (Cloudflare body and CPU limits).

### Success looks like

- Photos: sign in, the existing library appears, thumbnails and full photos
  load fast, any video plays and seeks, and a phone backup — including videos
  over 100 MB — finishes. Everything the app uploads appears on
  photos.daemonclient.uz, and the reverse.
- Drive: browse folders, open any common file in the app without a separate
  download step, upload anything. Same two-way compatibility with
  drive.daemonclient.uz.
- Both on iPhone and Android, distributed through TestFlight / the App Store
  and an Android build.

---

## 2. Decisions

| # | Decision | Date | By |
|---|---|---|---|
| D1 | Two separate apps, not one app with a switcher. Supersedes the 2026-06-10 plan in `daemonclient-ops/.../MOBILE_APP.md`. | 2026-10-04 | operator |
| D2 | Both apps' UI in **Flutter**; Android comes from the same code. | 2026-10-04 | operator (option A) |
| D3 | One shared core in **Rust** under both apps — usable later from Swift/Kotlin (e.g. the iOS Files extension) and from the web as WebAssembly. | 2026-10-04 | operator |
| D4 | Client-heavy architecture: the phone encrypts, decrypts and talks to Telegram **directly**; the worker serves metadata only. | 2026-10-04 | operator |
| D5 | Photos keeps Immich's UI and replaces only what talks to the server and moves bytes. | 2026-10-04 | operator |
| D6 | Drive gets **its own UI**, inspired by Apple Files, Google Drive and Documents (R§1, R§1b). No fork. | 2026-10-04 | operator |
| D7 | Order: core → **Photos** → Drive. | 2026-10-04 | operator |
| D8 | Sign-in: server address field for self-hosters; "Sign in with a DaemonClient account" for the hosted service; "Create account" opens the sign-up page in an in-app browser sheet. | 2026-10-04 | operator |
| D9 | Names and ids: **DaemonClient Photos** `uz.daemonclient.photos`, **DaemonClient Drive** `uz.daemonclient.drive`. | 2026-10-04 | operator (accepted default) |
| D10 | Testing uses the test account only, never the operator's library. | 2026-10-04 | operator (accepted default) |
| D11 | **Top priorities for Photos:** automatic upload that just works (also in the background); excellent thumbnails; HEIC on **both** iPhone and Android; videos that open instantly and seek smoothly. | 2026-10-04 | operator |
| D12 | Remove what DaemonClient does not use — from a written list the operator approves first (§5.7). | 2026-10-04 | operator |
| D13 | One Cargo workspace at `mobile/`; both apps import the same core through one Flutter plugin package. | 2026-10-04 | plan |
| D14 | **No preview upload from the apps.** Viewer order: blur (thumbhash, from D1) → thumbnail → original. An existing preview (`telegramPreviewId`, e.g. from the web's HEIC fix) is used when present. Supersedes the preview in §5.1's first version and the worker change it needed. | 2026-10-04 | operator |
| D15 | **Smart loading:** what is on screen loads first; requests for what scrolled away are dropped; concurrency and Telegram's limits are respected (§4.9). | 2026-10-04 | operator |
| D16 | One shared engine with two thin adapters — Photos (`/api/assets`, Photos key, thumbnails, checksum) and Drive (`/api/drive/files`, Drive key, ordered `messages`). | 2026-10-04 | plan, confirmed by operator |

---

## 3. Architecture

```
┌────────────── phone ──────────────┐
│  Photos UI (Immich fork, Flutter) │      Drive UI (Flutter, later)
│            │                      │            │
│            ▼                      │            ▼
│   dc_core_flutter (Flutter plugin, generated bindings)
│            │
│            ▼
│   dc-core (Rust)
│    ├─ session      login, the worker URL, token
│    ├─ crypto       PBKDF2 + AES-256-GCM, the existing chunk format
│    ├─ worker       metadata calls to the user's worker
│    ├─ telegram     sendDocument / getFile / download / deleteMessage
│    ├─ transfer     upload + download queues, resume, retries
│    ├─ media        local server on 127.0.0.1 for images and video
│    └─ cache        bounded on-disk cache
└───────────┬───────────────┬───────┘
            │ metadata      │ encrypted chunks
            ▼               ▼
   user's worker (D1)    api.telegram.org (the user's own bot + channel)
```

No byte of a photo or file passes through the worker. The phone needs no
`/proxy` relay either: that exists only because browsers block cross-site
calls, and an app is not a browser.

### Where the code lives

| Path | What |
|---|---|
| `mobile/Cargo.toml` | the Cargo workspace (one lockfile, one build folder) |
| `mobile/core/dc-core/` | the core library — pure Rust, no FFI, fully unit-tested |
| `mobile/core/dc-cli/` | a command-line front end to the core, for testing against real Telegram and a real worker without an app (Gate 2) |
| `mobile/core/compat/` | test vectors produced by the **production** JavaScript crypto (`drive/src/crypto.js`), so Rust is checked against the real thing |
| `mobile/packages/dc_core_flutter/` | Flutter plugin: a thin binding crate over `dc-core` (flutter_rust_bridge 2.x) plus the generated Dart API |
| `immich/mobile/` | the Photos app — stays where it is; moving it would make taking Immich updates harder |
| `mobile/drive/` | the Drive app (Phase 3) |

Keeping `dc-core` free of any binding code means a Swift binding (uniffi) can
sit beside the Flutter one later without touching the core.

**One core, two apps:** both apps list `dc_core_flutter` as a path dependency.
There is one copy of the source; each app compiles it into its own bundle
(iOS apps cannot share a library at run time, and do not need to).

---

## 4. The core (`dc-core`)

### 4.1 Session

- `login(baseUrl, email, password)` → `POST {baseUrl}/api/auth/login` →
  `{accessToken, workerUrl, userId, userEmail, name}`.
- **Hosted:** `baseUrl` is the central API; every later call goes to
  `workerUrl`. **Self-hosted:** the user's server is both; when `workerUrl` is
  absent, use `baseUrl` (as `drive/src/api.js` does).
- The token lives ~10 years and the worker refreshes it internally (R§6), so
  there is no client refresh flow. A `401` signs the user out.
- Secrets — the session token, the Telegram bot token, the key material — are
  stored at rest **only** in platform secure storage (iOS Keychain, Android
  Keystore-backed storage), handed to the core at start-up, and held in memory.
  The core never writes them to disk or logs.

### 4.2 Crypto — byte-compatible with what is stored today (R§2)

- PBKDF2-HMAC-SHA256, 100,000 iterations, base64 salt → AES-256 key.
- Chunk = `[12-byte random IV][ciphertext][16-byte GCM tag]`, 19 MiB of
  plaintext per chunk, each decryptable alone.
- Two keys per user: **Photos** (`/api/server/zke-config`) and **Drive**
  (`/api/drive/zke`; in `custom` mode the app asks for the password and never
  stores it on the server).
- Proven by vectors from the production JavaScript in both directions: Rust
  decrypts what `crypto.js` encrypted, and `crypto.js` decrypts what Rust
  encrypted.

### 4.3 Worker client

Only routes that exist today (R§2, R§6):

- Photos: `GET /api/server/zke-config`, `GET /api/server/telegram-config`
  (bot token + channel — the same bot Drive uses),
  `GET /api/assets/:id/dc-manifest`, `POST /api/assets/bulk-upload-check`,
  `POST /api/assets` with `clientUpload=true`.
- Drive (Phase 3): `/api/drive/config`, `/api/drive/zke`, `/api/drive/files`,
  `/api/drive/files/:id`, `/api/drive/usage`.
- The Immich app keeps its own generated API client for everything else
  (sync stream, albums, people…) — pointed at `workerUrl`.

**Any change to the worker** goes to the Linux machine first (rule in
`README.md`). The parity rule holds: the server may add fields, never remove
or repurpose them, and every value must survive the app's strict parser
(booleans are booleans, numbers fit in int64).

### 4.4 Telegram client

- `sendDocument` (multipart; encrypted parts are named with random hex +
  `.partNNN` so Telegram never sees real names), `getFile`, file download,
  `deleteMessage`.
- `429` → wait `retry_after` and retry. `400/401/403/404` → stop and surface
  Telegram's own message (bad token, bot removed from the channel). Other
  failures → bounded retries with backoff.
- Concurrency is limited and paced so a whole-library backup does not trip
  Telegram's limits.

### 4.5 Transfers

- **Upload** — the same sequence as the web (R§6): checksum → dedupe check →
  thumbnail + thumbhash (made by the app, which has native image APIs) →
  slice, encrypt, send each part → encrypted thumbnail → metadata `POST`.
- **Resumable:** finished parts are recorded on disk (message ids only, no
  secrets) so a killed app resumes rather than re-sending. A resumed upload
  keeps the encryption mode it started with.
- **Download** — fetch the chunks that cover a byte range, decrypt each, in
  order.

### 4.6 Local media server — the phone's version of the web service worker

- An HTTP server on `127.0.0.1`, random port, started with the core.
- Every request must carry a **per-launch random secret**; anything without
  it gets `403`. Other apps on the device can reach loopback ports, so this is
  required, not optional.
- Answers the paths the Immich app already requests —
  `/api/assets/:id/thumbnail`, `/original`, `/video/playback` — by fetching the
  manifest, then the Telegram chunks, then decrypting. `Range` requests map to
  the chunks that cover them, so seeking in a 2 GB video fetches two chunks.
- Drive's viewers use the same server.

### 4.7 Cache

- Thumbnails are cached decrypted in the app's sandboxed cache directory, as
  every photo app does; size-bounded, evicted least-recently-used.
- Originals and video are fetched on demand through a small bounded cache,
  not kept.
- "Save to phone" is the only thing that writes a full file where the user
  can see it.

### 4.8 Errors and logs

- Errors reaching the UI say what the user can do ("Telegram rejected the
  bot token — check Settings"), not stack traces.
- Logs never contain tokens, keys, passwords, or Telegram URLs (which embed the
  bot token).

### 4.9 Fetch scheduler — smart loading (D15)

Every Telegram read goes through one scheduler in the core:

- **Visible first, newest first.** Thumbnail requests are served
  last-in-first-out, so after a fast scroll the rows now on screen load before
  the ones the user flew past.
- **Dropped when nobody waits.** Immich's image loader already cancels a
  request when its thumbnail scrolls off screen (`RemoteImagesImpl.swift:15-17`,
  `image_request.dart:29`); the local server sees the connection close and the
  scheduler cancels that fetch unless another request is waiting for the same
  file.
- **One fetch per file.** Concurrent requests for the same `file_id` share one
  download.
- **Bounded.** A fixed number of concurrent Telegram downloads; `getFile`
  results are cached for their validity window so each thumbnail costs one
  round-trip, not two; a `429` pauses all reads for `retry_after`.
- **Classes:** thumbnails, then the photo/video being viewed, then prefetch.
  Uploads have their own queue and never starve the screen.

---

## 5. DaemonClient Photos (Phase 2)

What changes in `immich/mobile`; everything else stays Immich's:

1. **Identity on iOS** — bundle ids are still Immich's (R§5). Becomes
   `uz.daemonclient.photos` (+ `.ShareExtension`, `.Widget`), display name
   "DaemonClient Photos". Android is already `uz.daemonclient.photos`.
2. **Sign-in (D8)**
   - Main form: server address, email, password — the fields Immich already
     has, for self-hosters.
   - Bottom: **"Sign in with a DaemonClient account"** — fills in the hosted
     address and hides the field.
   - **"Create account"** opens `accounts.daemonclient.uz` sign-up in an in-app
     browser sheet (`SFSafariViewController` on iOS, Custom Tabs on Android).
     After sign-up and setup there, the user returns and signs in.
   - After sign-in, the app's server address becomes `workerUrl`.
3. **Account deletion** — required by Apple once the app offers account
   creation. A "Delete account" entry in Settings that leads to deletion.
   Whether the accounts portal already has a deletion flow is an open question
   (§10).
4. **Reading media** — the URLs built in `lib/utils/image_url_builder.dart` and
   `video_viewer.widget.dart` point at the core's local server instead of the
   worker (R§3). Immich's native image loader keeps working because it only
   sees a URL.
5. **Uploading** — the foreground and background upload services hand files
   to the core, which uses the client-side path. No file is posted to the
   worker.
6. **Sync** — unchanged: `/api/sync/stream` on `workerUrl`.

### 5.1 Thumbnails, HEIC and video (D11, D14)

- **Thumbnails are made on the phone by the OS's own image engine** (PhotoKit
  on iOS, MediaStore/ImageDecoder on Android): it reads HEIC, RAW and video
  frames, applies rotation, and is hardware-accelerated. Rust does not decode
  images; the platform does it better. Per upload: a 256 px JPEG thumbnail (the
  web's size) and its thumbhash. **No preview** (D14).
- **What the viewer shows, in order:** the blur (thumbhash, already in D1 and
  synced) → the thumbnail → the original. Where an asset already has a preview
  (`telegramPreviewId`, from the web's HEIC fix), it is used before the
  original. Assets with no thumbnail at all (some old web uploads) get one made
  on the phone from the original and cached locally — never uploaded.
- **HEIC:** iPhones and Android 9+ (`ImageDecoder`) decode HEIC natively, so
  originals open directly. The app supports Android 8 (`minSdk 26`), which
  cannot; there, a HEIC photo shows at thumbnail quality.
- **Video** plays in the platform players (AVPlayer, ExoPlayer) from the
  core's local server. Rust's job: decrypt fast, map seeks to parts, and fetch
  the next part before the player asks. iPhone HEVC video plays on Android
  phones with an HEVC decoder; where one is missing, the existing H.264
  rendition (`playbackChunks`) is the fallback.

### 5.2 Automatic upload (D11)

Keep Immich's backup engine — it watches the library, decides what to upload,
tracks state, and schedules background work. Replace only how bytes travel:
the core encrypts the parts **to files on disk**, and the existing background
uploader (`background_downloader`, which uses `URLSession` on iOS) sends each
part straight to Telegram's `sendDocument`. That keeps uploads running while
the app is in the background, within iOS limits. The core then posts the
metadata. Verified in P2 before it is relied on.

### 5.7 Clean-up (D12)

`immich/` holds the whole upstream Immich monorepo; `FORK.md` says `server/`,
`machine-learning/`, `docker/`, `e2e/` and `cli/` are not used. The website's
build (production, deployed from Linux) runs through the same pnpm workspace,
so removals are proposed as a list, approved by the operator, and checked
against the web build on the Linux machine before they land. Unused Immich
features inside the app (demo logins, OAuth, Immich support and licence
screens) are listed and removed in P2.

Open items to settle **during** Phase 2, by reading code and testing — not
assumed here: R§6 "Open items" (deviceAssetId, live photos, EXIF, iOS
background limits).

---

## 6. DaemonClient Drive (Phase 3)

Before any screen is built, Phase 3 starts with its own **design spec and
mockups** for the operator to approve (D6). Starting scope, to be confirmed
then:

- Sign-in as in §5.2.
- Home (recent files), Files (folders inside folders, list ⇄ grid, sort),
  a `+` sheet (upload files, upload photos/videos, new folder), a `⋯` menu per
  item (rename, move, delete, save to phone, share), a transfer sheet with
  per-file progress.
- **Opening without a download step:** images in an in-app viewer; video and
  audio streamed through the local server; PDF, Office and text via the
  platform's preview (Quick Look on iOS). Swipe between files in a folder.
- Settings: account, encryption password (custom mode), storage used, sign out,
  delete account.
- Not in the first version: starred, sharing between users, the iOS Files
  extension, document scanning, thumbnails shared across devices (they are
  made and cached on each phone; sharing them needs a worker field — Linux
  first).

---

## 7. Compatibility rules

- Anything the app uploads must open on the website, and anything the website
  uploaded must open in the app. Gate 2 checks both directions.
- Formats are frozen to what is stored today (§4.2). A format change is a new
  decision in §2, not an implementation detail.
- Existing photos encrypted by the worker (`encryptionMode='server'`) use the
  same Photos key and decrypt the same way.

---

## 8. Quality — how every task is accepted

The four gates of `docs/plan/GATES.md`, applied as follows:

- **The whole core is full treatment** — it is the chunk / encrypt / manifest
  path.
- **Gate 1:** tests first. Crypto is checked against vectors from the
  production JavaScript. Hostile input (truncated chunks, wrong key, bad
  manifest, Telegram errors) must fail cleanly, never crash.
- **Gate 2:** real conditions — `dc-cli` against the test account's real worker
  and Telegram; the apps on the iOS Simulator, the operator's iPhone and an
  Android emulator or the Samsung; plus the two-way website check (§7).
- **Gate 3:** two separate review agents, security and spec, neither the
  author. HIGH and MEDIUM fixed before shipping; LOW accepted in writing.
- **Gate 4:** code and docs in separate commits; records updated in the same
  sitting; nothing pushed without the operator's review.

---

## 9. Phases

Each phase ends with its exit criteria met and shown. `PLAN.md` breaks them
into tasks.

| Phase | What | Exit criteria |
|---|---|---|
| **P0** | Toolchain and skeleton | Rust, Flutter 3.41.7 and CocoaPods installed; the **existing** Photos fork run in the Simulator and its current behaviour recorded; `dc-core` + `dc_core_flutter` exist; the Photos app calls a Rust function on the iOS Simulator and Android; CI runs the core's tests. |
| **P1** | The core | Crypto vectors pass both ways; `dc-cli` signs in to the test account, uploads a photo and a >100 MB video that then open on photos.daemonclient.uz, and downloads and decrypts a file the website uploaded; the local server streams a video with seeking. |
| **P2** | Photos on the core | On Simulator, iPhone and Android with the test account: sign-in (all three paths of D8), library loads, thumbnails / photos / video work, a backup including a >100 MB video finishes, and both directions of §7 hold. |
| **P3** | Drive | Design approved first; then §6 scope working on all three targets, both directions of §7. |
| **P4** | Release | TestFlight builds of both apps through the friend's App Store Connect account; Android builds; store listings. |
| Later | — | iOS Files extension and Android DocumentsProvider (Swift/Kotlin over the core), starred, sharing, cross-device Drive thumbnails. |

---

## 10. Risks and open questions

| Item | Why it matters | Settled in |
|---|---|---|
| What the current fork does after sign-in (it never reads `workerUrl`) | Decides how much of Immich's login flow changes | P0 — run it and see |
| flutter_rust_bridge with Flutter 3.41.7 and Xcode 27 | Build risk | P0 |
| iOS background limits for uploads | Big backups while the app is closed | P2 — may need encrypted parts written to disk and handed to a background `URLSession` |
| Telegram rate limits on whole-library backups | Upload speed | P1 — measured with `dc-cli` |
| Does the accounts portal have account deletion? | App Store requirement (§5.3) | P2 — ask the Linux machine |
| Fields the Immich app sends that the web does not (deviceAssetId, live photos, EXIF) | Backup screen, dedupe, map | P2 — may need an additive worker change |
| Taking Immich updates later | Every change to the fork makes merges harder | Keep changes in few files; list them in `DESIGN_NOTES.md` |
| The operator's iPhone for device builds | Needs the operator's Apple ID in Xcode (free, 7-day builds) | P0 |

---

## 11. Changes to this spec

| Date | Change | Approved by |
|---|---|---|
| 2026-10-04 | First draft | operator, 2026-10-04 |
| 2026-10-04 | D11–D13: priorities, clean-up, workspace at `mobile/`; §5.1, §5.2, §5.7 | operator (priorities), plan (layout) |
| 2026-10-04 | D14–D16: no preview upload (§5.1 rewritten, worker change dropped), smart loading (§4.9), shared engine + two adapters | operator |
