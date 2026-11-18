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
| D8 | Sign-in: server address field for self-hosters; "Sign in with a DaemonClient account" for the hosted service; "Create account" opens the sign-up page in an in-app browser sheet. *Changed 2026-11-17 (operator): no shortcut button — the sign-in screen asks for exactly the **server address** (always shown, filled in with the hosted address), **email** and **password**, plus **"Create account"**; self-hosted servers will be supported, so the address stays visible (§5 item 2).* | 2026-10-04 | operator |
| D9 | Names and ids: **DaemonClient Photos** `uz.daemonclient.photos`, **DaemonClient Drive** `uz.daemonclient.drive`. (Home-screen name narrowed by D20.) | 2026-10-04 | operator (accepted default) |
| D10 | Testing uses the test account only, never the operator's library. | 2026-10-04 | operator (accepted default) |
| D11 | **Top priorities for Photos:** automatic upload that just works (also in the background); excellent thumbnails; HEIC on **both** iPhone and Android; videos that open instantly and seek smoothly. | 2026-10-04 | operator |
| D12 | Remove what DaemonClient does not use — from a written list the operator approves first (§5.7). | 2026-10-04 | operator |
| D13 | One Cargo workspace at `mobile/`; both apps import the same core through one Flutter plugin package. | 2026-10-04 | plan |
| D14 | **No preview upload from the apps.** Viewer order: blur (thumbhash, from D1) → thumbnail → original. An existing preview (`telegramPreviewId`, e.g. from the web's HEIC fix) is used when present. Supersedes the preview in §5.1's first version and the worker change it needed. | 2026-10-04 | operator |
| D15 | **Smart loading:** what is on screen loads first; requests for what scrolled away are dropped; concurrency and Telegram's limits are respected (§4.9). | 2026-10-04 | operator |
| D17 | **What the user opened always goes first.** While the opened photo/video part loads, nothing else starts — no thumbnails, no prefetch, no new upload part; everything resumes once it has loaded or the viewer closes (§4.9). | 2026-10-04 | operator |
| D18 | **HEIC/HEIF and RAW uploads also get a ~1440 px JPEG preview**, so the website (Chrome, Firefox) can open them. Stored through the existing `POST /api/assets/:id/thumbnail` route (`preview` field) that the web's HEIC Fix tool already uses — **no worker change**. Formats every browser draws (JPEG, PNG, WebP) get no preview. Narrows D14. (R§8) | 2026-10-05 | operator |
| D19 | The fetch scheduler is a Rust port of **Nuke's** pipeline design (MIT): coalescing, priority queue with reserved slots and suspension, cancellation, token-bucket rate limit where cancelled work spends no token. (R§9, §4.9) | 2026-10-05 | operator |
| D16 | One shared engine with two thin adapters — Photos (`/api/assets`, Photos key, thumbnails, checksum) and Drive (`/api/drive/files`, Drive key, ordered `messages`). | 2026-10-04 | plan, confirmed by operator |
| D20 | The Photos app's **home-screen name is "Photos"** (Android debug builds "Photos-Debug"); its app icon, launch/splash screens and in-app logos are the DaemonClient logo (`drive/public/logo.png` on white); the Immich logo no longer spins on the sign-in screen. Done in P0 task 0.4, ahead of P2 task 2.1. The store name stays "DaemonClient Photos" (D9) unless the operator decides otherwise before P4 (§10). | 2026-10-12 | operator |
| D21 | **Store framing and release decisions** (from `APP_STORE.md`): the apps are presented as a **self-hosted storage tool**; sign-up and storage setup happen on the website, and the apps never ask for anything Telegram-related. The name shown is **"DaemonClient Photos"** (replaces D20's home-screen "Photos"; changed at release). The operator publishes from **their own Apple Developer account**. **Delete account** is offered in the app. Immich's remaining brand, links and purchase screens are removed before release. **In code:** storage credentials (bot token, channel) are fetched by the core from the user's worker and stay in the core's memory — they never cross the bridge to Dart, never appear on screen, and user-facing messages say "storage", not "Telegram". The privacy policy still names every third party (Apple 5.1.1/5.1.2). | 2026-10-31 | operator |
| D22 | **Automatic background backup, like iCloud Photos / Google Photos** (operator, 2026-11-16): photos are backed up while the app is suspended. The phone's own background uploader (URLSession on iOS, WorkManager on Android) sends each encrypted part **straight to Telegram**. The core prepares each part as a complete request body in the app's private storage and hands the uploader that file and the Telegram address — which holds the bot token: **the one exception to D21**, needed because only the operating system can upload while the app is suspended. The address goes only to the platform uploader, never to the screen, logs or analytics; the core still records every answer. The upload sends the **original file byte for byte** (no conversion) and dedupes on SHA-1 — base64 as the worker and the Immich app store it; *the website stores hex (found in P1 1.8), so the core asks about both*. | 2026-11-16 | operator |
| D23 | **The phone does the heavy work; the worker keeps the books** (operator, 2026-11-16 — "the goal of writing our own app is to avoid expensive worker work and do heavy CPU work on the phone in Rust"): encryption, decryption, uploads and downloads run in the core; the worker only answers small metadata requests and never handles photo or video bytes. Therefore: **previews** for HEIC/HEIF/RAW are made by the phone's image engine at upload, encrypted and sent to Telegram by the core, and the worker records only their ids (replaces D18's route through the worker); **EXIF and video metadata** are read by the phone's native engine (ImageIO; `ExifInterface`/`MediaMetadataRetriever`) and sent as one `exif` field in the worker's `PhotoExif` shape — the worker never downloads an original to read it; the **viewer** shows the preview at once and, while the photo stays on screen, quietly downloads the original, keeps it and shows it at full quality (videos play the original); the app and the website must read each other's uploads. The worker's old byte paths (server-side upload, serving decrypted thumbnails/originals/video, the D18 route sending to Telegram, EXIF backfill from originals) are to be deleted once nothing uses them (Linux machine). | 2026-11-16 | operator |
| D24 | **Backup sending — APPROVED by the operator 2026-11-17** (P1 1.9 measurements, RESEARCH §14). **Already in the core since 1.9** (not part of what is asked): one send at a time (the scheduler's single send slot); the pace 1 request every 3.5 s, bursts of 2 (≤ 19 in any minute, below the group's 20), not respent after a restart within a minute of a send; `retry_after` honoured; albums (`send_media_group`) and batch delete (`delete_messages`) as capabilities, unused by the upload engine. **Proposed, for P2's backup queue:** (1) **batch by token** — when the pacer allows a send, every small item waiting (≤ 5 MB each) goes in **one album** (≤ 10 documents, ≤ 45 MB); a lone item goes alone; a 19 MiB part always goes alone; albums one at a time (albums started together are refused); (2) every album item a random name, thumbnails and previews too, and replies matched by name and size, never by order; (3) unencrypted thumbnails sent as documents (an album cannot mix them with photos) — to check that the website still shows them; (4) duplicates checked 100 checksums a request (both spellings), encryption settings read once a batch, assets created one request per album once the worker has a bulk route; (5) background (D22): one connection per host, at most 15 requests queued per wake, and the restart mark both ways — a wake within a minute of foreground sends starts without a burst, and the platform uploader's answers count as sends; (6) the free plan's daily limits (worker Error 1027, D1 "daily limit exceeded") stop the queue until 00:00 UTC instead of retrying. **Amends:** D22 and §5.2 (prepared bodies become album bodies as well as single parts), §4.4 (random names for every album item, unencrypted libraries included; `deleteMessages`), §5.1 (unencrypted thumbnails as documents). **Result:** ~1,900 HEIC / ~2,200–2,800 JPEG photos an hour instead of ~340 / ~510 (photos ~3 MB, ~2 MB/s up), up to ~14,000–16,000 new photos a day on the free plan (D1 writes); videos unchanged (bandwidth). | proposed 2026-11-17 | **operator, 2026-11-17 (approved)** |
| D25 | **One engine for every client — APPROVED by the operator 2026-11-18** (operator's direction 2026-11-18; plan `docs/plan/ENGINE.md`): the rules — storage format, ranges, the scheduler, pacing, albums, the backup journal, dedupe, the worker's fields — live in one pure Rust crate (`dc-engine`, no I/O), used natively by the apps (`dc-core` keeps the I/O) and compiled to WebAssembly for the Photos website and Drive; the worker stays TypeScript and keeps the books (D23). | 2026-11-18 | operator (approved 2026-11-18; the websites move onto it after the mobile apps are finished, built with the Linux machine) |

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
  `.partNNN` so Telegram never sees real names — in Photos too, where the
  website still sends the real name; unencrypted libraries keep the real
  name), `getFile`, file download, `deleteMessage`.
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

- An HTTP server on `127.0.0.1`: two listeners on random ports, one for the
  grid and one for opened media (C10), opened on first use and reopened when
  the phone has closed them (`Core::media_server()`, called on resume).
- Every request must carry its listener's **random secret** — a new one each
  time a listener opens, so an app that takes over a closed port learns
  nothing that opens the next; anything without it gets `403` and loses its
  connection. Other apps on the device can reach loopback ports, so this is
  required, not optional; at most 32 connections per listener, so they cannot
  use up the app's file descriptors either.
- Answers the paths the Immich app already requests —
  `/api/assets/:id/thumbnail`, `/original`, `/video/playback` — by fetching the
  manifest, then the Telegram chunks, then decrypting. `Range` requests map to
  the chunks that cover them, so seeking in a 2 GB video fetches two chunks.
- Drive's viewers use the same server.

### 4.7 Cache

- Thumbnails are cached decrypted in the app's sandboxed cache directory, as
  every photo app does; size-bounded, evicted least-recently-used.
- Originals and video are fetched on demand through a small bounded cache,
  not kept: the last three parts read (57 MiB), in memory, per account — a
  player that probes the start, reads the index at the end and goes back to
  the start downloads each part once.
- Asset manifests are kept in memory for 10 minutes — a manifest can gain a
  preview or an H.264 rendition later. Decrypted thumbnails and previews are
  kept on disk (500 MB by default, nothing over 4 MiB), keyed by the account,
  how the file is read and its `file_id` (which never changes). The cache is
  emptied on sign-out and when another account signs in on the phone; an app
  restart keeps it.
- "Save to phone" is the only thing that writes a full file where the user
  can see it.

### 4.8 Errors and logs

- Errors reaching the UI say what the user can do ("Telegram rejected the
  bot token — check Settings"), not stack traces.
- Logs never contain tokens, keys, passwords, or Telegram URLs (which embed the
  bot token).

### 4.9 Fetch scheduler — smart loading (D15, D17, D19)

A Rust port of Nuke's image-pipeline design (R§9) — the most widely used iOS
image loader, MIT-licensed — plus what Telegram and the operator's rules need.
Every Telegram read goes through it.

- **Coalescing:** requests for the same `file_id` share one download.
- **Priority classes (D17), highest first:**
  1. **Opened** — the photo the user tapped, or the video part at the
     playhead.
  2. **Next** — the next video part ahead of the playhead; the photos either
     side of the opened one, so a swipe is instant.
  3. **Visible** — thumbnails on screen, **newest request first** (Nuke is
     first-in-first-out here; the operator wants the rows scrolled *to* first).
  4. **Background** — upload parts, off-screen prefetch, cache warming.
- **Opened pre-empts everything.** While an opened request is loading, every
  class below it is *suspended* (Nuke's `isSuspended`): queued work waits;
  thumbnails already in flight are tiny and finish; in-flight prefetch is
  cancelled and re-queued; an upload part already in flight finishes (aborting
  it would throw away up to 19 MB already sent). One concurrency slot is
  **reserved** for opened/next work (Nuke's reserved slots), so the opened item
  never waits for a free one. Lower classes resume, in order, the moment it has
  loaded or the viewer closes. Uploads never starve: they run whenever nothing
  above them is waiting.
- **Cancellation:** a request nobody is waiting for any more is dropped.
  Immich's image loader already cancels a thumbnail that scrolls off screen
  (`RemoteImagesImpl.swift:15-17`, `image_request.dart:29`); the local server
  sees the connection close and the scheduler cancels that fetch unless another
  request still wants the same file.
- **Rate limit:** a token bucket ported from Nuke's (MIT). A token is taken
  only when a job actually starts, so **cancelled work never spends one** — a
  fast fling through thousands of thumbnails costs only what gets loaded. The
  opened item skips the bucket (it still uses its reserved slot). **Measured in
  P1 1.8** (`dc-cli bench reads`, 1,600 requests): the storage served 122 file
  paths and 126 thumbnails a second with no rate limit; **P1 1.9** set
  the core to **24 downloads at once** (1 reserved for the opened item, at
  most 2 Next), **60 requests/s, burst 24**: a fling of 2,000 thumbnails runs
  at ~44 a second with no rate limit (11 with the starting values 6/20/10, 22
  with 1.8's 12/40/12; 32/80 was no faster). Each thumbnail first needs its
  asset's manifest from the worker: at most **16 such requests in flight**
  (grid and background), and the opened item's and the viewer's next item's
  skip the queue (a photo tapped mid-fling opens in
  ~2 s, not 5–13). A `429` pauses **all** reads for `retry_after`; a job
  gives up after three, and the screen asks again when it scrolls back.
  *The website uses its own measured values* (Linux machine, 2026-10-12): 12
  jobs at once, 2 reserved for the opened photo, at most 3 Next, burst 12, rate
  20/s — over HTTP/2 a cold thumbnail is 3 sequential requests, and 6 slots
  filled the grid slower than the old loader. The phone app's HTTP client must
  allow at least 24 connections to the grid listener (P2), or the core's slots
  go unused. Once the worker gives thumbnail file ids in bulk (the timeline's
  columns), P2 reads them from there and a scroll costs no manifest requests
  (the free plan's 100,000 worker requests a day — RESEARCH §14).
- **Fewer round-trips:** each `getFile` result is cached for its validity
  window, so a thumbnail usually costs one request, not two; decrypted
  thumbnails go to the disk cache (§4.7) because a `file_id` never changes.

---

## 5. DaemonClient Photos (Phase 2)

What changes in `immich/mobile`; everything else stays Immich's:

1. **Identity on iOS** — bundle ids are still Immich's (R§5). Becomes
   `uz.daemonclient.photos` (+ `.ShareExtension`, `.Widget`). Store name
   "DaemonClient Photos" (D9); the home-screen name "Photos" and the
   DaemonClient logo arrived early, in P0 task 0.4 (D20). Android is already
   `uz.daemonclient.photos`.
2. **Sign-in (D8, changed 2026-11-17)**
   - The form asks for exactly three things: **server address** (always
     shown, filled in with the hosted address; self-hosted servers will be
     supported), **email**, **password**. No shortcut button.
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
  web's size) and its thumbhash.
- **A preview only where the website needs one (D18):** HEIC/HEIF and RAW
  originals also get a ~1440 px JPEG preview, because Chrome and Firefox cannot
  draw HEIC. It goes through the existing `POST /api/assets/:id/thumbnail`
  route (`preview` field). JPEG/PNG/WebP originals get none.
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
  the next part before the player asks. **Which file (P2-9, operator
  2026-11-18):** the original plays wherever the device can decode it — every iPhone the
  app supports (HEVC in hardware, with HDR), Android phones whose decoder takes
  that profile, Safari; elsewhere a **720p H.264 copy** (8-bit SDR, AAC) made by
  the **uploading phone's own hardware encoder** (AVFoundation; Android media3
  Transformer, HDR tone-mapped) — Immich's default rule (`server/src/config.ts`,
  `services/media.service.ts`: any video not H.264 8-bit 4:2:0 gets one), run
  on the phone instead of a server, never on the worker. iCloud.com works the
  same way (a 720p "compatible" copy plays; downloads offer the original). The
  copy is uploaded after the original (originals first) and recorded as
  `telegramPlaybackChunks`; players choose by capability; downloads are always
  the original. Estimated cost ~19 MB a minute (2.5 Mbps): about +30% data for
  the iPhone's default 1080p30 HEVC (~60 MB a minute), +11% for 4K30 (~170 MB)
  — from Apple's published sizes, measured in P2 2.7.

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
| Telegram rate limits on whole-library backups | Upload speed | **Measured in P1 1.8–1.9:** the storage chat (a supergroup) takes about **20 requests a minute** — Telegram's documented group limit (RESEARCH §14); the core sends **1 every 3.5 s, bursts of 2 (≤ 19 in any minute; 10 minutes without a refusal)** (the 21st in a burst waited 40 s; at 1 per 3 s, one 3 s refusal after 40 sends). Every part, thumbnail and preview is a request when sent alone, so a first backup runs at about **510 JPEGs or 340 HEICs an hour**; videos are bound by bandwidth. **Albums (`sendMediaGroup`, up to 10 documents) count as one request** (P1 1.9: 300 files in 3.2 minutes, one album at a time; albums started together are refused) — batching small files into albums (~2–5×) is **proposed as D24** |
| Checksums in two spellings (website hex, app base64) | The website uploads again what the app already stored | Found in P1 1.8; the core asks about both; the worker to normalise (Linux, W2) |
| Does the accounts portal have account deletion? | App Store requirement (§5.3) | P2 — ask the Linux machine |
| Fields the Immich app sends that the web does not (deviceAssetId, live photos, EXIF) | Backup screen, dedupe, map | P2 — may need an additive worker change |
| Taking Immich updates later | Every change to the fork makes merges harder | Keep changes in few files; list them in `DESIGN_NOTES.md` |
| The operator's iPhone for device builds | Needs the operator's Apple ID in Xcode (free, 7-day builds) | P0 |
| Home-screen name "Photos" (D20) is also the name of Apple's Photos and Google Photos | Users may confuse the two apps; the iOS permission prompt reads "“Photos” Would Like to Access Your Photos"; App Review may object to a name that copies a system app | P4 — the operator confirms the store and home-screen names before submission |

---

## 11. Changes to this spec

| Date | Change | Approved by |
|---|---|---|
| 2026-10-04 | First draft | operator, 2026-10-04 |
| 2026-10-04 | D11–D13: priorities, clean-up, workspace at `mobile/`; §5.1, §5.2, §5.7 | operator (priorities), plan (layout) |
| 2026-10-04 | D14–D16: no preview upload (§5.1 rewritten, worker change dropped), smart loading (§4.9), shared engine + two adapters | operator |
| 2026-10-04 | D17: the opened item pre-empts everything (§4.9 priority classes) | operator |
| 2026-10-05 | D18: previews for HEIC/HEIF/RAW so the website can open them (§5.1); D19: scheduler ported from Nuke (§4.9 rewritten) | operator |
| 2026-10-27 | D20: home-screen name "Photos" and the DaemonClient logo, done in P0 0.4 (§5 item 1, §10 risk); §4.9 notes the website's measured scheduler values | operator (D20, 2026-10-12); Linux machine (web values) |
| 2026-10-31 | D21: store framing (self-hosted storage tool), name "DaemonClient Photos", own developer account, delete account in the app, Immich brand removed at release; storage credentials never leave the core | operator |
| 2026-10-29 | The core's design (`plans/P1-core.md` part 1, decisions C1–C11) approved in full; from it: random part names in Photos too (§4.4), manifest and thumbnail caching (§4.7), the token bucket ported from Nuke instead of `governor` and the opened item skipping it (§4.9) | operator, 2026-10-29 |
| 2026-11-15 | §4.7: the picture cache is per account, emptied on sign-out and when another account signs in, and keeps nothing over 4 MiB (P1 Task 1.5, Gate 3) | operator (emptied on sign-out, 2026-11-15) |
| 2026-11-15 | §4.6: a new secret per listener (not per launch), two listeners opened on first use and reopened after the phone closes them, 32 connections per listener; §4.7: the in-memory part cache (3 parts); C6 measured: an iPhone video opens after **two** parts, not one (P1 Task 1.6, Gate 2 and Gate 3) | Gate 3 (security), Gate 2 (measured); C6 cost to be confirmed by the operator |
| 2026-11-16 | D22: automatic background backup through the platform uploader straight to Telegram (the one exception to D21); the original byte for byte; SHA-1 dedupe | operator |
| 2026-11-16 | D23: the phone does the heavy work, the worker keeps the books — previews and EXIF made on the phone, the worker records ids and metadata only (replaces D18's worker route); the viewer shows the preview, then the original; the worker's old byte paths to go | operator |
| 2026-11-17 | §4.9: the read limits from P1 1.8's measurement (12 at once, 40/s, burst 12); §10: the send limit measured (~20 messages a minute per channel; the core paces 1 per 3 s, burst 3) and what it means for a first backup | Gate 2 (measured); the backup-speed figure for the operator |
| 2026-11-17 | D22 / §10: the website stores **hex** SHA-1, the app and the worker base64; the core asks about both, the website will re-upload what the app stored until the worker normalises (Linux, W2). C6 (start a video's last part early): built in 1.8, no gain measured end to end, removed | Gate 2 (found and measured); C6's removal for the operator to confirm |
| 2026-11-17 | §4.9: 24 at once, 60/s, burst 24 and a manifest gate (16 in flight, the opened item first) from P1 1.9's flings; §10: sends at 1 per 3.5 s (17 a minute, 10 minutes clean), albums count as one request; the free plan's worker and D1 daily limits; D24 proposed | Gate 2 (measured); D24 for the operator |
| 2026-11-17 | D24 approved; D8: the sign-in screen is the server address (always shown, hosted address filled in), email, password and "Create account" — no shortcut button; the P2 design (`plans/P2-photos.md`) approved | operator, 2026-11-17 |
| 2026-11-18 | §5.1 video: the original plays where it can, a 720p H.264 copy made on the uploading phone elsewhere (P2-9); D25 (one engine) approved — the websites after the mobile apps | operator, 2026-11-18 |
