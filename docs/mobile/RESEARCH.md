# Mobile apps — research

Findings that the spec (`SPEC.md`) is built on. Each one says where it came
from and when, so a later reader can re-check it instead of trusting it.
Append; when a finding turns out wrong, add a correction under it.

---

## 1. Drive UI/UX — what to model the Drive app on        2026-10-04

**Question:** which open-source app gives the Drive app a slick,
Google-Drive-like experience, with real folders and files that open in the app
without a download step?

### Candidates checked

GitHub data from `gh api repos/<repo>` on 2026-10-04; App Store data from the
iTunes lookup API the same day.

| App | Stack | License | Status | Verdict |
|---|---|---|---|---|
| **Filen** (`FilenCloudDienste/filen-ts` → `packages/filen-mobile`) | Expo / React Native UI on a **Rust core** (`filen-rs`) | AGPL-3.0 | active | **Primary reference — design and architecture.** See below. |
| Proton Drive (`ProtonDriveApps/ios-drive`, `android-drive`) | Swift / Kotlin | GPL-3.0 | active | Design reference: clean list, sort + grid toggle, per-file `⋯` menu. 4.1★ (1,196). |
| Nextcloud iOS (`nextcloud/ios`) | Swift | GPL-3.0 | active | Design reference: "Recommended files" strip above the list, bottom tabs (Files, Favorites, Media, Activity, More). 4.7★ (10,378). Bound to the Nextcloud server. |
| Google Drive | closed | — | — | Information architecture to copy: Home/Recent, My Drive, Shared, Starred; `+ New` sheet (upload, scan, photo, folder); list ⇄ grid. 4.8★ (7.8M). |
| Documents by Readdle | closed | — | — | The operator's favourite. What to copy: **every file opens in the app** (PDF, video, music, images, text), swipe between files. 4.8★ (629k). |
| Nextcloud Neon (`nextcloud/neon`) | Flutter | AGPL-3.0 | active, "Android and Linux supported, others WIP" | Too early; bound to Nextcloud. |
| ArDrive (`ardriveapp/ardrive-web`) | Flutter (web + iOS + Android from one repo) | Apache-2.0 | active, 74★ | Flutter prior art for folders + client-side encrypted "private drives". Reference for Flutter code patterns, not for look. |
| Ente Locker (`ente/ente` → `mobile/apps/locker`) | Flutter + Rust | AGPL-3.0 | active | **Rejected as base.** Checked its code: files live in flat "collections" (`CollectionType { folder, favorites, uncategorized, album }`, no parent field → no folders inside folders), and opening a file downloads it whole, decrypts to a temp file and hands it to another app (`open_file` package, `file_downloader.dart`). No in-app preview. |
| Internxt (`internxt/drive-mobile`) | React Native | AGPL-3.0 | active | Not inspected further; Filen covers the same ground better. |
| Cryptomator, ownCloud, Seafile | Swift / ObjC | GPL-3.0 / Apache-2.0 | active | Vault-oriented or server-bound; nothing Filen/Proton don't show better. |
| Flutter file managers (NFile, FileX, flutter_file_manager) | Flutter | GPL-3.0 / Apache-2.0 | small | Local-disk managers; widget ideas at most. |
| Filen's old app (`filen-mobile`) | React Native | AGPL-3.0 | **archived** | Superseded by `filen-ts`. |

### Why Filen

1. **Its architecture is the one we chose, already shipped.** From the
   `filen-ts` README: "Everything below the UI — networking, encryption,
   authentication, transfer concurrency, retries — belongs to the Rust SDK
   (`filen-rs`), consumed as threaded wasm in the browser and as a native module
   on React Native." The mobile app also ships "an iOS File Provider extension
   and an Android Documents Provider that are built from Rust".
2. **The look is what was asked for.** App Store screenshots (2026-10-04): dark,
   native iOS navigation bar with round `⋯` and search buttons, grid of tinted
   folder tiles, list rows with date and size, coloured folders.
3. **License fits.** AGPL-3.0, same as the DaemonClient repo — we may read and
   reuse its code with attribution, not just look at it.

What we **cannot** reuse from Filen: its UI code (React Native, our apps are
Flutter) and its protocol (Filen's own servers). `filen-rs` is a reference for
*how* to structure a Rust core with mobile bindings (`uniffi-bindgen`,
`uniffi-bindgen-swift`, `filen-mobile-native-cache`), not a dependency.

### Design direction (proposal — needs the operator's approval)

- **Look:** Filen — dark, native-feeling, tinted folder tiles, list ⇄ grid.
- **Structure:** Google Drive — Home (recent + suggested), Files (folder tree),
  Shared, Starred; one `+` button opening a sheet: upload file, upload
  photo/video, scan, new folder.
- **Opening files:** Documents — tap opens in the app, swipe between files in a
  folder, nothing saved to the phone unless the user asks.

---

## 2. One storage format for both apps        2026-10-04

Read from the code, not from memory:
`drive/src/crypto.js`, `drive/src/App.jsx:28-384`,
`immich-api-shim/src/assets.ts:17-202`, `docs/ARCHITECTURE.md` §"The storage
primitive" and §"Encryption".

Photos and Drive store bytes **the same way**:

| Property | Value | Source |
|---|---|---|
| Chunk size | **19 MiB of plaintext** (`19 * 1024 * 1024`), never merged — Telegram bots cannot download >20 MB | `App.jsx:28`, `assets.ts:22`, `contracts.ts DEFAULT_CHUNK_SIZE` |
| Cipher | AES-256-GCM, fresh random 12-byte IV per chunk | `crypto.js`, `assets.ts:188` |
| Chunk on the wire | `[IV 12 bytes][ciphertext][GCM tag 16 bytes]` — each chunk decrypts on its own | same |
| Key | PBKDF2-HMAC-SHA256, **100,000** iterations, salt base64 in config | `crypto.js:9`, `assets.ts:21` |
| Key scope | one key per user per app — **different** password/salt for Photos (`zke_*` D1 config) and Drive (`drive_zke` D1 config) | `drive.ts:82-107`, `d1-adapter.ts:339` |

Because each chunk carries its own IV and tag, any chunk can be fetched and
decrypted alone.

> **Corrections, 2026-10-05 (Gate 3 of P0 Task 0.3):**
> - The Drive constant is now at `drive/src/App.jsx:81` (and `:296`), not `:28`
>   — the 2026-10-04 bug-1 commits moved it.
> - The worker stores **one** part for a 0-byte upload
>   (`assets.ts:1788,1858`: `Math.max(1, Math.ceil(size / CHUNK_SIZE))`), where
>   `Math.ceil` alone gives 0. Readers trust the manifest's part list, never a
>   count computed from the size.
> - Native players treat a short `206` as end-of-file, and iPhone video opens
>   with a suffix range `bytes=-N` to find its index — both stated in the
>   comments of `immich/web/src/service-worker/telegram-media.ts`
>   (`planVideoRange`). The phone's media server must serve the full range and
>   handle suffix ranges. That is what makes video seeking and "open without
downloading" possible: a byte range maps to the chunks that cover it.

### Drive specifics

- File record (`/api/drive/files`): `id, parentId ('root' or a folder id),
  type ('file'|'folder'), fileName, fileSize, fileType, messages
  [{message_id, file_id}] in part order, encrypted, encryptionMode
  ('client'|'off'), uploadedAt, updatedAt`. Folders inside folders already work
  (`parentId`).
- Upload: slice → encrypt → `sendDocument` (multipart, document name = 16 random
  hex chars + `.partNNN` when encrypted, so Telegram never sees the real name)
  → collect `{message_id, file_id}` → `POST /api/drive/files`. Resumable per
  part; a resumed upload must keep the encryption mode it started with.
- Download: `getFile(file_id)` → `file/bot…/<file_path>` → decrypt → write at
  `index * 19 MiB`.
- Delete: the **client** deletes the Telegram messages (`deleteMessage`), the
  worker drops only the row.
- Key: `GET /api/drive/zke` → `{enabled, mode: 'auto'|'custom', password, salt}`.
  In `custom` mode the password is never stored — the app must ask the user.
- File names and folder structure are **not** encrypted; they sit in the user's
  own D1.
- No thumbnails exist for Drive files today, and no "starred" field.

### Photos specifics

- Each asset: `thumbhash` (D1), `telegramThumbId`, `telegramPreviewId`,
  `telegramChunks` `[{index, message_id, file_id}]`, optional
  `telegramPlaybackChunks` (H.264 rendition).
- `GET /api/assets/:id/dc-manifest` already returns everything a client needs to
  read an asset straight from Telegram (`asset-manifest.ts`).
- `GET /api/server/zke-config` returns the Photos key material to the signed-in
  owner (`server.ts:66-97`).
- The **web** already uploads client-side: it encrypts and sends chunks to
  Telegram itself, then `POST /api/assets` with `clientUpload: 'true'` and the
  `file_id` list (`assets.ts:1146`, ARCHITECTURE.md "The write path"). Only the
  current **mobile** app posts whole files to the worker — the path that
  hits Cloudflare's limits.
- `checksum = base64(SHA-1(plaintext))` is load-bearing: without it
  `bulk-upload-check` never matches and the app re-uploads the whole library.

**Consequence:** the mobile core is a port of what the web already does —
the Drive uploader/downloader and the Photos service worker — into Rust. The
worker API it needs mostly exists. Any worker change goes through the Linux
machine first (rule in `project_ios_app` memory).

---

## 3. Where the Immich fork touches media        2026-10-04

- Every media URL is built in **one file**: `immich/mobile/lib/utils/image_url_builder.dart`
  (`/assets/:id/thumbnail`, `/assets/:id/video/playback`, `/people/:id/thumbnail`);
  `video_viewer.widget.dart:124` picks `original` vs `video/playback`.
- Remote images are loaded natively through Pigeon APIs
  (`lib/platform/remote_image_api.g.dart`, Swift side in `ios/Runner/Images`).
- Image requests are **cancellable** end to end: Dart `ImageRequest.cancel()`
  (`lib/infrastructure/loaders/image_request.dart:29`) → native
  `cancel()` → `URLSessionDataTask.cancel()`
  (`ios/Runner/Images/RemoteImagesImpl.swift:15-17`). Scrolling a thumbnail off
  screen closes its HTTP request.
- Uploads: `lib/services/background_upload.service.dart` plus the foreground
  upload service; iOS background work in `ios/Runner/Background`.
- Metadata sync stays on `/api/sync/stream` — see the strict-parse traps in the
  `project_int64_mobile_trap` memory before touching anything it emits.
- Size: ~79k lines of Dart in `lib/` (excluding generated), ~5.5k Swift,
  ~5.8k Kotlin.

**Idea to validate in the spec:** run a small HTTP server inside the Rust core
on `127.0.0.1` that answers the same `/assets/:id/thumbnail|original|video/playback`
paths by fetching from Telegram and decrypting — an on-device version of the
web's service worker. The Immich screens keep requesting the same URLs; only the
base address changes. The same server streams Drive files to the video player
and to previews.

---

## 4. Rust core — technology        2026-10-04

Versions from crates.io / pub.dev on 2026-10-04.

| Need | Choice | Version | Why |
|---|---|---|---|
| Flutter ⇄ Rust | `flutter_rust_bridge` | 2.13.0 (crate + pub) | Generates the Dart bindings; used by Ente in production. |
| Swift/Kotlin ⇄ Rust (later: iOS File Provider extension, which cannot run Flutter) | `uniffi` | 0.32.2 | Mozilla's binding generator; Filen builds its File Provider from Rust this way. |
| AES-256-GCM | `aes-gcm` (RustCrypto) | 0.11.1 | Pure Rust, hardware AES on ARM; byte-compatible with WebCrypto's AES-GCM. |
| PBKDF2-SHA256 | `pbkdf2` + `sha2` | 0.13.0 | Matches WebCrypto `deriveKey`. |
| HTTP client (Telegram, worker) | `reqwest` (rustls) | 0.13.5 | Streaming bodies, multipart. |
| Local media server | `axum` on `tokio` | 0.8.9 / 1.53.2 | Range requests for video. |

**Precedents:** Filen (`filen-rs`, AGPL-3.0) — a Rust SDK for an encrypted
drive with uniffi mobile bindings and a native cache crate; Ente — Flutter apps
on a Rust core via flutter_rust_bridge.

---

## 5. Toolchain on the MacBook        2026-10-04

- Xcode **27.0** (27A266a) installed, `xcode-select -p` →
  `/Applications/Xcode.app/Contents/Developer`.
- **Not installed yet:** `rustc`/`cargo` (rustup), Flutter **3.41.7** (pinned by
  `immich/mobile/pubspec.yaml`), CocoaPods. iOS Simulator runtime: unchecked.
- The fork's iOS bundle ids are still Immich's (`app.alextran.immich`,
  `app.futo.immich.*`); only Android was renamed (`uz.daemonclient.photos`).

---

## 1b. Drive UI — second pass, after operator feedback        2026-10-04

**Operator:** liked Filen's look, but Filen mixes Photos and Drive in one app;
wants a better UI reference. Constraint added: **a pure file app** — Photos
lives in its own app.

Looked at in-app screens (App Store screenshots, iTunes lookup API,
2026-10-04). These are design references only — closed source, nothing copied.

| App | Rating | What is worth taking |
|---|---|---|
| **Apple Files** (iOS 26) | 2.9★ (7.5k — complaints are about sync, not UI) | The most native look possible: floating glass tab bar (Recents · Shared · Browse), large titles, round `⋯` button, search field, coloured folders with tag dots, big file thumbnails with date + size. Users already know it. |
| **Microsoft OneDrive** (2025 redesign) | 4.7★ (488k) | Clean structure for a pure drive: Home · My Files · Shared · Vault · Offline; sort control ("Modified"); grid with thumbnails and per-item `⋯`; a floating search bar and a `+` button at the bottom. Its Photos/Files toggle we would drop. "Vault" maps naturally onto our encryption. |
| **Dropbox** | 4.8★ (912k) | The best upload sheet: per-file thumbnail, progress bar, cancel, "Upload photos / Upload files / Cancel all". |
| **Google Drive** | 4.8★ (7.8M) | `+ New` bottom sheet (upload, scan, photo, folder); list ⇄ grid. |
| **Documents by Readdle** | 4.8★ (629k) | Built-in viewers for everything; swipe between files. |
| Box | 4.8★ (191k) | Now AI-centred; floating tab bar only. |
| pCloud, MEGA | 4.7★ / 4.6★ | Older look (pCloud) or media-first (MEGA); not references. |

**Leading candidate (needs the operator's choice):** Apple Files' look and
feel, OneDrive's tab structure, Dropbox's upload sheet, Documents' viewers.

---

## 6. Photos — the client-side path the mobile app will use        2026-10-04

Read from `immich/web/src/lib/utils/file-uploader.ts:300-448`,
`immich/web/src/lib/utils/daemonclient-drive.ts:295-367`,
`immich-api-shim/src/auth.ts:15,110-160`, `helpers.ts:65-150`.

### Login and the per-user worker

- `POST https://immich-api.sadrikov49.workers.dev/api/auth/login` (central,
  no D1) `{email, password}` → `{accessToken, userId, userEmail, name,
  workerUrl, …}`. Every later call goes **straight to `workerUrl`** with
  `Authorization: Bearer <accessToken>` — this is what the web Drive does
  (`drive/src/api.js`).
- Session tokens live **~10 years** (`SESSION_TTL_SECONDS`, `auth.ts:15`); the
  worker refreshes the Firebase token inside the session itself
  (`helpers.ts:139`). The app stores one token in the Keychain; no client-side
  refresh flow is needed.
- The current fork pre-fills `https://api.daemonclient.uz` as the server and
  does **not** read `workerUrl` anywhere in `lib/` (grep, 2026-10-04). The
  central worker does not forward API calls to per-user workers (no forwarding
  code in `immich-api-shim/src/index.ts`). **Unverified:** what the fork
  actually does after login today. Phase 0 runs it in the Simulator to find out
  before anything is designed around it.

### Upload, as the web does it today

1. Key: `GET {workerUrl}/api/server/zke-config` → `{enabled, password, salt,
   mode}` → PBKDF2 → AES key (the **Photos** key, not Drive's). Bot token and
   channel: `GET {workerUrl}/api/server/telegram-config` (`server.ts:65`; the
   web's `daemonclient-drive.ts getConfig`).
2. Checksum: `base64(SHA-1(plaintext))`; dedupe first with
   `POST /api/assets/bulk-upload-check`.
3. Thumbnail generated on the client; `thumbhash` derived from it.
4. Original sliced at 19 MiB → each slice encrypted → `sendDocument` →
   `telegramChunks: [{index, message_id, file_id}]`.
5. Thumbnail encrypted the same way → `sendDocument` as `thumb.bin` →
   `telegramThumbId`. (Unencrypted installs use `sendPhoto` instead.)
6. `POST {workerUrl}/api/assets` multipart, **no bytes**: `clientUpload=true`,
   `telegramChunks` (JSON), `telegramOriginalId` (the file_id when there is one
   chunk), `telegramThumbId`, `encryptionMode='server'` (= "encrypted with the
   zke_* key"), `fileCreatedAt`, `fileModifiedAt`, `isFavorite`, `width`,
   `height`, `fileName`, `fileSize`, `mimeType`, `thumbhash`, `checksum`,
   optional `visibility`.

The worker already accepts this (`assets.ts:1146`, `clientUpload`). No
preview is uploaded on this path; the detail view uses the original.

### Read

`GET {workerUrl}/api/assets/:id/dc-manifest` → Telegram `getFile` → download →
decrypt with the Photos key. Thumbnails: `thumbId`; originals: `chunks`
(range-mapped for video); `playbackChunks` when an H.264 rendition exists.

### Open items for the Photos phase (verify, don't assume)

- What the Immich mobile app sends that the web does not (`deviceAssetId`,
  `deviceId`, live-photo pairing `livePhotoVideoId`) and whether the
  `clientUpload` handler stores it — the backup screen and dedupe depend on it.
- EXIF: client uploads skip worker-side EXIF parsing (`assets.ts:1686`). The
  app can read EXIF from PhotoKit/MediaStore and send it — needs a field the
  worker accepts, or a worker change (→ Linux first).
- HEIC: the phone can produce a JPEG thumbnail natively, so no HEIC processor
  is needed for app uploads.
- iOS background upload limits: what the core can do while the app is
  suspended.
