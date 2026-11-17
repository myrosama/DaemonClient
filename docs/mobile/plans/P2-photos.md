# P2 — Photos on the core

**Part 1: the design, for the operator to approve before any code.** Part 2
(each task's steps) is written task by task, before that task's code, as in
P1. Goal: SPEC §9 P2 — on the Simulator, an iPhone and Android with the test
account: sign-in (all three D8 paths), the library loads, thumbnails, photos
and video work, a backup including a >100 MB video finishes, and the app and
the website read each other's uploads (§7).

Written 2026-11-17 after P1 (the core, `dc-cli`, the measured limits) and a
read of the fork. Builds on SPEC D8, D14, D17, D21–D23, and **D24 (backup
sending — still awaiting the operator)**.

---

## 1. Where the fork is today (read from the code)

| What | Where | Today |
|---|---|---|
| Media URLs | `immich/mobile/lib/utils/image_url_builder.dart:6,15,20,24`; `presentation/widgets/asset_viewer/video_viewer.widget.dart:122-124` | `${serverEndpoint}/assets/$id/{thumbnail,original,video/playback}` — the worker |
| Image loaders | `ios/Runner/Images/RemoteImagesImpl.swift`, `android/.../RemoteImagesImpl.kt` (RESEARCH §10) | iOS URLSession, 64 connections a host; Android **Cronet, 6 a host** over HTTP/1.1, the rest queued FIFO where the core cannot see them |
| Sign-in | `services/api.service.dart:87` (`serverEndpoint`), `providers/auth.provider.dart:126` (`accessToken`), `widgets/forms/login/login_form.dart` | Immich's login against the address typed; the hosted address never learns the per-user `workerUrl` (RESEARCH §7 part 2) |
| Foreground upload | `services/foreground_upload.service.dart:239-420` `_uploadSingleAsset` | gets the original (iCloud too), builds the fields, live-photo video first, then `_uploadRepository.uploadFile` — the whole file to the worker |
| Background upload | `services/background_upload.service.dart:307-500` | a `background_downloader` `UploadTask`: the whole file as multipart `assetData` to `$serverEndpoint/assets`, plus a phone-made 256 px thumbnail (`thumbData_base64`, an earlier DaemonClient change for the worker path) |
| The bridge | `mobile/packages/dc_core_flutter/rust/src/api/core.rs` | `core_version`, `part_count`, `start_core`, `check_telegram` (P0) |

---

## 2. Decisions

**P2-1. The bridge stays thin; the core owns every secret.** A small FRB API
over `dc-core`: `start`, `sign_in` / `restore` / `sign_out`, `media_server`
(the listeners' addresses), `upload` (foreground), and the background
hand-off (`begin_upload`, `part`, `part_sent`, `finish`). Images are not
passed over the bridge — they go through the local server, where Immich's
native loaders already fetch by URL. Dart never sees the bot token, except
the one D22 exception: the address the OS uploader needs.

**P2-2. Sign-in through the core (D8).** The core signs in (hosted, or a
typed self-hosted address) and returns the session. The app then sets
Immich's own store — `serverEndpoint = workerUrl + "/api"`, `accessToken` —
so Immich's sync (`/api/sync/stream`), websocket and API keep working
untouched, and the hosted path finally reaches the per-user worker. The
session goes to the Keychain / Keystore (`flutter_secure_storage`) and back
to `restore` on the next launch. "Create account" opens the accounts portal
in an in-app browser sheet.

**P2-3. Media through the local server.** The four URL builders and the
video viewer use the core's listeners: thumbnails → the **grid** listener;
previews, originals, playback → the **viewer** listener (the opened item
never queues behind the grid, D17). Addresses are refreshed on every resume
(`media_server()`, P1 1.6). **Android:** Cronet's 6 connections a host would
cap the grid at 6 of the core's 24 slots (P1 1.9: 44 thumbnails a second
needs ~24) — so the grid gets **four listeners** (ports), each thumbnail sent
to one by a hash of its asset id. To be measured on the emulator in 2.3
before it is kept (one listener against four).

**P2-4. The viewer shows the preview, then the original (D23).** Immich
already loads `size=preview` first and the original after; the core serves
the preview where one exists (`previewId`), else the thumbnail, and the
original as it arrives. A photo tapped mid-scroll opens in ~2 s (P1 1.9).

**P2-5. What the phone makes for each upload (D23).** From the platform's
own image engine (PhotoKit / MediaStore, through `photo_manager`, which the
fork already uses): a **256 px JPEG thumbnail**; for HEIC/HEIF/RAW a
**~1440 px JPEG preview**; a **thumbhash** of the thumbnail (computed in
Dart from the decoded 256 px image — Rust does not decode images, SPEC
§5.1); **EXIF** (make, model, lens, aperture, focal length, ISO, exposure,
orientation, date, GPS) read by the platform (`CGImageSource` /
`ExifInterface`) over a small method channel. All of it goes to the core,
which sends the pictures to Telegram and the rest to the worker as metadata.

**P2-6. Foreground upload through the core.** `_uploadSingleAsset` keeps
everything it does (iCloud download, file names, live photos video-first,
progress and errors) and replaces `_uploadRepository.uploadFile` with
`core.upload(request)`. Duplicates: the core's both-spellings check (P1
1.8); Immich's own hash stays for "is this backed up?".

**P2-7. Background upload (D22; D24 if approved).** The `background_downloader`
tasks change from "the whole file to the worker" to "**the core's prepared
request bodies to Telegram**": each task a binary upload of a body file the
core wrote (`part()`, or an album under D24), with the core's content type
and address; each finished task's answer goes back to `part_sent`; when a
file's parts are all recorded, `finish` sends the thumbnail and preview and
creates the asset (a few seconds, in the app's wake window, or at the next
one). The background budget (D24): one connection a host, at most 15
requests queued a wake, the restart mark both ways. **Verified on a real
iPhone before it is relied on** (SPEC §5.2) — iOS decides when background
sessions run.

**P2-8. The website and the app read each other** — a Gate 2 check in every
upload task: a phone upload opens on photos.daemonclient.uz in Chrome, a
website upload opens in the app. HEIC from the phone opens in Chrome only
after the worker's W2 (preview id) — a dependency on the Linux machine.

**P2-9. iPhone video on Android (2.7).** HEVC plays where the phone has a
decoder (most Android phones from ~2018). No H.264 copy is ever made today;
where HEVC cannot play, the viewer says so and offers the download. Making an
H.264 copy at upload is an operator decision (tutorial item 10), not P2.

**P2-10. Identity, account deletion, clean-up** as PLAN 2.1, 2.9, 2.10 —
account deletion needs the accounts portal's flow (Linux; asked since 10-31).

---

## 3. Tasks (PLAN.md, revised for D23/D24)

| Task | Delivers | Gate 2 |
|---|---|---|
| 2.1 | Identity: bundle ids `uz.daemonclient.photos*`, the remaining Immich names | builds and runs on the Simulator and Android |
| 2.2 | Sign-in through the core (P2-2) | all three D8 paths on the Simulator; sync loads the test account's library |
| 2.3 | Media through the local server (P2-3, P2-4); the Android listener count measured | scroll the whole library; open photos and videos; thumbnails a second on iOS and Android |
| 2.4 | Thumbnail, preview, thumbhash, EXIF made at upload (P2-5) | the pictures and EXIF of a JPEG, a HEIC and a video match the platform's own |
| 2.5 | Foreground upload through the core (P2-6) | JPEG, HEIC, a live photo and a >100 MB video, each read back byte-identical and open on the website |
| 2.6 | Background upload (P2-7) | a backup of the test set finishes with the app in the background, on a real iPhone and on Android |
| 2.7 | HEIC and video on Android (P2-9) | HEIC opens on Android 9+; HEVC plays or says it cannot |
| 2.8 | Live photos, EXIF/GPS, dedupe checks | a live photo plays; the map shows the photo; a re-backup sends nothing |
| 2.9 | Account deletion entry (Apple 5.1.1(v)) | leads to the portal's deletion |
| 2.10 | Remove unused Immich features (approved list) | the app still builds and passes 2.11 |
| 2.11 | The P2 exit run | SPEC §9 P2 on the Simulator, an iPhone and Android |

**Testing:** the Simulator and the Android emulator with the test account —
**the operator signs in on each once by hand** (the password is never typed
by me; the session then persists); background upload on the operator's
iPhone (a free 7-day build with their Apple ID, P0).

---

## 4. For the operator

1. Approve this design (P2-1 … P2-10), or change it.
2. Approve **SPEC D24** (backups in albums) — P2-7 is written for it; without
   it the background tasks are one part each (~5× slower for small photos).
3. P2-9: HEVC on phones that cannot play it — "say so and offer the
   download" (the default here), or an H.264 copy made at upload.
