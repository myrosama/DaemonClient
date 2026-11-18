# P2 — Photos on the core

**Part 1: the design — approved by the operator 2026-11-17 (with SPEC D24
approved and D8 changed: see P2-2).** Part 2
(each task's steps) is written task by task, before that task's code, as in
P1. Goal: SPEC §9 P2 — on the Simulator, an iPhone and Android with the test
account: sign-in (all three D8 paths), the library loads, thumbnails, photos
and video work, a backup including a >100 MB video finishes, and the app and
the website read each other's uploads (§7).

Written 2026-11-17 after P1 (the core, `dc-cli`, the measured limits) and a
read of the fork. Builds on SPEC D8, D14, D17, D21–D23 and **D24 (backup
sending in albums — approved 2026-11-17)**.

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
to `restore` on the next launch. **The screen (operator, 2026-11-17):
exactly the server address (always shown, filled in with the hosted
address — self-hosted servers will be supported), email and password, and
"Create account"** (the hosted portal's sign-up in an in-app browser sheet;
for a self-hosted address, that server's own sign-up once self-hosting
ships). No shortcut button.

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

**P2-9. Video everywhere (2.7) — decided by the operator 2026-11-18:**
the original plays wherever the device can decode it — every iPhone the
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
In the app: the video viewer (`video_viewer.widget.dart:122`, which already
chooses `original` or `video/playback`) picks the original when the device's
decoder takes it (iOS: always; Android: `MediaCodecList` for the codec,
profile and size), else `video/playback`, which the core serves from the
copy. The copy is made in Swift/Kotlin over a method channel; the core
uploads it as a second set of parts. Needs the worker to accept
`telegramPlaybackChunks` on `clientUpload` (Linux).

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
| 2.7 | HEIC on Android (the original on Android 9+, which decodes HEIC; the preview on Android 8, which never downloads the HEIC original it cannot draw); the H.264 copy and the playback choice (P2-9) | HEIC opens on Android 9+; an iPhone HDR video plays as the original on iPhone and Safari, as the copy on an Android without HEVC and in Chrome without it |
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

1. ~~Approve this design~~ — approved 2026-11-17, with the sign-in screen
   changed (P2-2).
2. ~~Approve SPEC D24~~ — approved 2026-11-17.
3. ~~P2-9~~ — decided 2026-11-18: the original where it plays, a 720p
   H.264 copy made on the uploading phone elsewhere.
4. **R2 contract (Linux, 2026-11-17):** the core must **always** send `exif`
   (`{}` when the engine found nothing) — the worker uses its presence to
   skip its own EXIF download. Done in 2.4.

---

# Part 2 — the tasks, each written before its code

## Task 2.1 — Identity

**Delivers:** the app is DaemonClient Photos to the system on both platforms:
no Immich bundle id, app group, background-task id, signing team, verified
web domain or user-visible name is left. Read from the fork 2026-11-18:

| What | Where | Today | Becomes |
|---|---|---|---|
| iOS bundle ids (Release / Debug / Profile × app, ShareExtension, Widget — 9) | `ios/Runner.xcodeproj/project.pbxproj` | `app.alextran.immich*`, `app.futo.immich.{debug,profile}*` | `uz.daemonclient.photos`, `.debug`, `.profile`, each `+ .ShareExtension` / `.Widget` (Android's id is already `uz.daemonclient.photos`) |
| App group (app ↔ extensions) | pbxproj `CUSTOM_GROUP_ID` (×6, *found by the check*), 4 entitlements files, `Runner/Core/URLSessionManager.swift:7`, `WidgetExtension/ImmichAPI.swift:5`, `lib/constants/constants.dart:33` | `group.app.immich.share` | `group.uz.daemonclient.photos` — all seven together |
| Background task ids | `Runner/Info.plist:9-10`, `Runner/Background/BackgroundWorkerApiImpl.swift:25-26` (+ comments in `BackgroundWorker.swift`) | `app.alextran.immich.background.*` | `uz.daemonclient.photos.background.*` |
| `CFBundleName` | `Runner/Info.plist:77` | `immich_mobile` | `Photos` |
| Extension names (the share sheet shows the first) | pbxproj `INFOPLIST_KEY_CFBundleDisplayName` (3 + 3) | `ShareExtension`, `Widget` | `Photos` |
| Verified web links to Immich's domain | `Runner.entitlements`, `RunnerProfile.entitlements` (`applinks:my.immich.app`); Android `AndroidManifest.xml:100-122` (`autoVerify` for `my.immich.app`) | claimed | removed (our domain's links come with P4) |
| Signing team | pbxproj `DEVELOPMENT_TEAM = 2W7AC6T8T5` (×9 — Immich's team) | Immich's | removed; device builds use the operator's team, chosen in Xcode at the device step |
| Widget text | `WidgetExtension/widgets/MemoryWidget.swift:168`, `ImmichAPI.swift:25,28` | "…from Immich", "Login to Immich", "…your Immich instance" | "See your memories.", "Sign in to Photos", "Unable to connect to your server" |
| Android notification icon | `res/drawable-*/notification_icon.png` | Immich's | the approved icon's monochrome silhouette (`ic_launcher_monochrome`), 24 dp at each density |
| Client certificate's keychain label *(found by the check)* | `URLSessionManager.swift:4` | `app.alextran.immich.client_identity` | `uz.daemonclient.photos.client_identity` |
| Android names on system surfaces *(found by Gate 3)* | `BackgroundWorker.kt:72` (the notification channel's name), `lib/main.dart:241` (the task label in Recents / TalkBack), widget text (`strings.xml`, `PhotoWidget.kt`, `RandomConfigure.kt`) | "immich::background_worker::notif", "Immich", "…Immich…" | "Backup", "Photos", "Sign in to Photos" |

**Not in 2.1, recorded:** the Kotlin package `app.alextran.immich` (internal,
not seen by users; renaming it is a large diff against upstream — the Dart
widget receiver names in `constants.dart:42-43` follow it), the `immich://` and `app.immich`
URL schemes and the Dart links to immich.app (OAuth and Immich links go with
2.10's approved removal list), and **the widgets**: they fetch pictures from
the worker's byte routes, which D23 retires — keep them (the app would put a
few thumbnails in the app group for them) or remove them is a 2.10 question
for the operator.

**Device signing — carried to Task 2.6** (decided at Gate 3: 2.1's Gate 2
is the Simulator and Android, and 2.6 cannot pass without a real iPhone):
with a free Apple ID (P0), on the operator's iPhone, at their next session at
the Mac and no later than the start of 2.6. A free personal team may refuse
the App Groups capability; then the device build needs the group removed from
`Runner.entitlements` too (not only the extensions left out) until the paid
account (D21).

- [x] **Step 1:** a check that fails first — `mobile/tools/check-identity.sh`
  (run in `mobile-build` CI): none of the old ids, group, team or domain in
  the iOS and Android projects; the app group the same in the four
  entitlements, the two Swift files and the Dart constant.
- [x] **Step 2:** the changes above; the check passes; `flutter analyze` on
  the touched Dart.
- [x] **Step 3: Gate 2** — `flutter build ios --simulator` and
  `flutter build apk --debug`: the built app's bundle ids, app-group
  entitlement and names read back from the products (`plutil`,
  `codesign -d --entitlements`, `aapt2 dump badging`); the app installs and
  starts on the iOS Simulator and the Android emulator.
- [x] **Step 4:** Gate 3 (one reviewer at a time); commit code, then docs.

**As built (Task 2.1):**
- The check found two rows the first table lacked (`CUSTOM_GROUP_ID`, the
  keychain label) and Gate 3 two Android names (the notification channel,
  the Recents title); all are in the table now. The Dart widget receiver names
  (`constants.dart:42-43`) follow the Kotlin package and stay.
- Android widget text also changed (Gate 3): "See your memories.", "Sign in
  to Photos", "Sign in to Photos to set up this widget."
- Gate 3 security: 0 HIGH, 2 MEDIUM (the check passed silently when a listed
  file was missing; it did not check `CUSTOM_GROUP_ID`'s value — both fixed
  and shown to fail on a copy with a missing file and with one typo), 5 LOW
  (Android widget text — fixed; fixed-string matching and `bash` in CI —
  fixed; `Podfile.lock`: the bridge's version 0.0.1 → 0.1.0, stale since
  1.x, committed; the rest below).
- **For 2.10's removal list (operator):** Immich's fastlane folders
  (`ios/fastlane`, `android/fastlane`: Immich's bundle id, team and Apple ID —
  running them would put Immich's identity back); the `immich://` scheme
  (now that both apps can be installed side by side, iOS may open either);
  the OAuth `app.immich` callback; the Dart links to immich.app; the widgets
  (their data path).
- A local Android build after the 10-27 disk clean-up had no `libsqlite3.so`
  (the app stops at start: "library libsqlite3.so not found"): `build/` was
  deleted but `.dart_tool`'s hook cache kept, so Flutter never rewrote
  `build/native_assets/android`. CI's APK of `main` has it for all three
  ABIs. Fix: `flutter clean` before building after deleting `build/` by hand.
- Gate 3 spec: 0 HIGH, 3 MEDIUM (the two Android names above — fixed; the
  check did not confirm the Android application id or all nine iOS bundle
  ids, and banned `app.alextran.immich` in the manifest whose class names
  keep that package — now it checks both ids positively and bans only the
  domain there; device signing could be lost — carried to 2.6 above), LOW
  fixed (table layout, stale PLAN rows, the 2.7 wording).
- **For P4's rename (D21: "DaemonClient Photos" in the store):** 2.1 put
  "Photos" in the pbxproj display names (×6), `ImmichAPI.swift:25`,
  `PhotoWidget.kt:102`, `RandomConfigure.kt:147`, `main.dart:241` and the
  Android channel name. The Android share label is "Upload to DaemonClient"
  (`AndroidManifest.xml`) and the iOS share sheet shows "Photos" — the
  operator settles the naming at P4.

---

## Task 2.2 — Sign-in through the core (D8)

**Delivers** (SPEC D8 as changed 2026-11-17, P2-2): **one form for
everyone** — server address (always shown, the hosted address filled in),
email, password, a **Sign in** button and **Create account**. The core signs
in; Immich's own machinery is then handed the result, so its sync, websocket
and API keep working unchanged and finally reach the per-user worker.

**Read from the fork (2026-11-18):**
- Today's screen is two steps (address → **Next** → email/password), with
  `/.well-known/immich` discovery (`api.service.dart:98-152`) — the central
  address answers `{}` there, which is why the hosted path never found the
  worker (RESEARCH §7 part 2).
- Immich authenticates its native HTTP with the **`immich_access_token`
  cookie**: `NetworkRepository.setHeaders(…, token:)` →
  `setRequestHeaders` (iOS `NetworkApiImpl.swift:64`, Android
  `HttpClientManager.kt:255`) writes it for the server's host; the worker
  accepts that cookie (`relay-policy.ts:50`) and `Authorization: Bearer`.
- `auth.provider.dart:81 login` → `saveAuthInfo(accessToken)` stores the
  token in Immich's `Store`, writes the widget's credentials, fetches the
  user (`/api/users/me`) and marks the app signed in.

**Flow:**
1. The core picks the deployment from the address: the hosted address
   (`api.daemonclient.uz`, however typed) → hosted (the reply names the
   per-user worker); anything else → self-hosted (that server is the worker).
   A new `session::deployment_of(address)`, tested.
2. Bridge (`dc_core_flutter`, FRB): `sign_in(address, email, password) →
   {workerUrl, token, userId, email, name}`, `restore(…)`, `sign_out()`; the
   core's error text is shown as is (wrong email or password, no server at
   that address, account not set up yet, can't reach the server).
3. Dart, after a sign-in: `serverEndpoint = workerUrl + "/api"` (no
   `.well-known` lookup), the API client pointed there,
   `NetworkRepository.setHeaders(…, [workerUrl], token: token)` (the
   cookie), then Immich's own `saveAuthInfo(accessToken: token)`.
4. The session (worker URL, token, user id, email, name) goes to secure
   storage (`flutter_secure_storage`: Keychain / Keystore — the fork already
   uses it for the PIN); at app start the core is `restore`d from it. Sign-out
   deletes it and signs the core out (which also clears its caches and
   uploads, P1).
5. **Create account** opens `https://accounts.daemonclient.uz/signup` in an
   in-app browser sheet (`url_launcher` `inAppBrowserView`:
   SFSafariViewController / Custom Tabs — no new dependency). After sign-up
   and setup there the user comes back and signs in (D8). For a self-hosted
   address: the same link until self-hosting has its own sign-up.

**Not in 2.2:** OAuth and demo login disappear from this screen (the form
no longer asks the server for its features first); their code goes with
2.10's list. **Known, recorded:** Immich's `Store` keeps its own copy of the
token in the app's private database, as upstream does (its API client and
background isolates read it there); the core's copy is in secure storage.
Moving Immich's reads to secure storage is a later hardening, not 2.2.

- [x] **Step 1:** tests first, failing: `deployment_of` (the hosted address
  with and without scheme, `/api`, trailing slash, capitals → hosted; other
  hosts, a private-network `http://` → self-hosted; junk → refused); a
  widget test of the form (the three fields, the hosted address filled in,
  Sign in disabled until all three are filled, Create account opens the
  sign-up URL); the session's round trip through secure storage (a fake
  storage).
- [x] **Step 2:** implement; regenerate the bridge (`flutter_rust_bridge_codegen
  generate`); Rust and Dart tests, clippy, `flutter analyze`.
- [x] **Step 3: Gate 2** — the **operator** signs in by hand on the iOS
  Simulator and the Android emulator with the test account (the password is
  never typed by me): the library loads from the worker; a wrong password
  and a wrong address show their messages; quitting and reopening stays
  signed in (restored from secure storage); signing out returns to the form
  and empties the stored session. Create account opens the sign-up page in
  the sheet.
- [x] **Step 4:** Gate 3 (one reviewer at a time); commit code, then docs.

**As built (Task 2.2):**
- **Sign-in replies (found on the emulator):** `example.com` answered 405 and
  the form showed "The server said: 405". Now: 401 → wrong email or
  password; 404 → not a usable server address; 5xx → a network problem
  (try again); another refusal → the server's own JSON `message`, cleaned
  (no tokens or bidi characters, 200 at most), else not a usable server
  address; a success that is not a sign-in answer → not a usable server
  address. An https server cannot hand the token to a plain-http worker.
- **The order (Gate 3 spec, HIGH):** the first version invalidated Immich's
  API providers *before* pointing them at the worker, so the user fetch
  after a first sign-in would have gone to an empty address. Now
  `signInWithCore` (core sign-in, endpoint, `Store` keys, the cookie) →
  the form invalidates the providers → `saveAuthInfo`; if that fails,
  `undoCoreSignIn` (core, secure storage, `Store` token, widget). A secure
  storage write that fails undoes the core's sign-in too.
- Immich resumes at start only when the core restored its session
  (`CoreSessionService.restoredAtStart`); a session the core refuses is
  dropped from secure storage. Every sign-out path — the menu and a token
  the server refuses (the auth guard) — goes through
  `AuthService.clearLocalData`, which now signs the core out.
- The form validates on submit (Immich's `ImmichForm`), not by disabling
  Login: address, email, and a password (now required) — the plan's
  "disabled until filled" differs. **Settings stays** on the form (custom
  headers and certificates, for self-hosters).
- Gate 3 security: 0 HIGH, 2 MEDIUM (the refusal text was shown raw — now
  cleaned, a regression against `read_json`; older code logged the token
  on the splash screen — removed), 4 LOW (fixed: half sign-ins undone,
  refused sessions dropped, no https→http worker; recorded: look-alike
  addresses — showing a self-hosted address's punycode under the field is
  a later polish). Gate 3 spec: 1 HIGH (the order above), 1 MEDIUM (resume
  only with the core), 7 LOW (fixed: the forced sign-out, the 404 rule, the
  undo of a failed write, the required password, the key's sort order, a
  stale comment; recorded: the widget's own copy of the token, as upstream).
- **Known, recorded:** Immich keeps copies of the token where upstream does —
  its `Store` (the app's private database) and the home-screen widget's
  storage; the core's copy is in secure storage. Untested in code (needs
  the app): `signInWithCore`/`undoCoreSignIn` end to end — Gate 2 covers it.
- **Decided by the operator 2026-11-18:** the hosted address stays filled in
  (users need only email and password); typing one's own worker address
  (`https://dc-….workers.dev`) also works — the core treats it as a
  self-hosted server and signs in to the worker directly (checked: a
  per-user worker answers `/api/auth/login` itself). The accounts portal's
  dashboard is to show "Your server address" for those who want it (Linux).
- **Gate 2 (2026-11-18, test account; the operator typed the password —
  pasted from the Keychain on the Mac's clipboard, cleared after):** iOS
  Simulator and Android emulator both signed in; the timeline loaded; the
  profile shows **Server URL `https://dc-ozkv3fuz.sadrikov49.workers.dev`**
  (the per-user worker, found through `api.daemonclient.uz`); force-closed
  and reopened → straight to the timeline on both (restored from secure
  storage); signed out on Android → the form, the address kept, and a
  reopen does not resume. Wrong password, a non-DaemonClient address, an
  empty email and Create account were checked earlier on the emulator.
- **Found by Gate 2:** on Android the first tries failed after the core had
  signed in: Immich's `refreshMyUser` gives up after **7 s** ("TimeoutException
  after 0:00:07"), and with no saved user that undid the sign-in. A first
  sign-in now waits up to 30 s; resuming keeps 7 s. (Made after the Gate 2
  run — a constant only; checked by the analyzer and the 677 Dart tests.)
- Thumbnails, photos and videos still come through the worker's old byte
  routes — exactly what 2.3 replaces (the core's local server).
