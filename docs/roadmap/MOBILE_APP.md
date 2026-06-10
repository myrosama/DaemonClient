# DaemonClient Mobile App — fork plan (living doc)

Decision date: 2026-06-10. Owner: contact@boboxon.uz.

## What we're building

Fork of `immich/mobile` (Flutter — ONE codebase, iOS + Android) rebranded as
**DaemonClient** (working bundle ids: `uz.daemonclient.app`), with Photos and
Drive in a single app behind a mode switcher; onboarding asks which mode is
the default. Drive-as-iOS-Files-source comes much later (Phase 4).

## Hard constraints (researched, don't re-litigate)

- **Telegram Bot API**: getFile download cap **20 MB**, upload cap 50 MB.
  19 MB chunking is mandatory forever; never merge chunks into one file.
- **Cloudflare free plan**: request body cap **100 MB** → big uploads must be
  client-side chunked (the app slices, the worker assembles).
- **iOS distribution**: via the dev friend's paid Apple Developer account
  ($99/yr covers unlimited apps — costs them nothing extra). Listing shows
  THEIR seller name; they should invite us as App Store Connect **Admin** so
  we upload builds ourselves. If we ever split: Apple **App Transfer** moves
  the app to our own account free, keeping users/reviews.
- **Builds without a Mac**: Android on Linux/GitHub Actions; iOS on GitHub
  Actions macOS runners (free for public repos) or Codemagic free tier
  (500 macOS min/month, Flutter-native).
- **License**: Immich is AGPL → fork stays open-source (repo already public).
- **Apple policy**: in-app account creation is fine (Firebase email/password →
  no Sign-in-with-Apple obligation), but then in-app account **deletion** is
  required too.

## Phases

### Phase 1 — rebrand + build pipeline (foundation)
- Rename app, icon, splash, server defaults (`api.daemonclient.uz` baked in,
  per-user worker discovery after login unchanged).
- Bundle ids + Firebase app registrations (Android `google-services.json`,
  iOS `GoogleService-Info.plist`).
- CI: GitHub Actions workflow → signed Android APK/AAB artifact on tag;
  Codemagic (or Actions macOS) → iOS IPA → TestFlight via friend's account.
- Exit criteria: TestFlight build on the iPhone, APK on the Samsung,
  login → existing library loads.

## What the fork ELIMINATES (researched 2026-06-10, grounded in this repo)

The phone has hardware codecs and the original file in hand — so every job the
Worker struggles with moves client-side. For app uploads the worker becomes a
metadata + read server:

| Constraint today | After fork |
|---|---|
| HEIC thumbnails need browser Fix-tool / Render pillow-heif backend | DEAD — `entity.thumbnailDataWithSize(256,256)` (photo_manager) returns a JPEG for HEIC/RAW/video poster frames; the fork's background path ALREADY posts `thumbData_base64` to `/assets/:id/thumbnail` (background_upload.service.dart:282-295). Make it universal (foreground too, attach at upload). Render backend retires. |
| >19MB videos get no thumbnail (Telegram auto-thumb limit) | DEAD — same poster-frame path. |
| >100MB uploads impossible (CF 100MB body cap) | DEAD — app slices ≤19MB parts (Phase 2). Stretch: direct-to-Telegram via proxy like web's file-uploader.ts + finalize-client-upload → worker never touches media bytes → upload OOM/503/concurrency-cap class disappears + true client-side encryption. |
| Worker computes SHA-1 (DigestStream) | Redundant for app uploads — the app already hashes locally for bulk-upload-check. |
| Worker parses EXIF (exifr) | App sends metadata from PhotoKit/MediaStore at upload (worker parse stays for web/legacy). |
| Users type ugly workers.dev URL at login | DEAD — `api.daemonclient.uz` baked in; users see only email+password. Kills the "prettier worker URLs" backlog item. |

What does NOT go away: Telegram bot 20MB download cap (19MB chunks + range
streaming stay forever — read path unchanged); iOS background-time limits
(full-library backup still wants the app foregrounded sometimes; Android can
run a real foreground service); workers.dev carrier-blocking for per-user
worker traffic (separate fix: central relay, someday).

## Testing & money timeline (nothing for us to buy, ever)

- Android: CI APK installs on any Android device from Phase 1 day one. $0.
- iPhone: friend's account enters at FIRST DEVICE TEST (not at publish):
  they create the app record (bundle id) + invite our Apple ID to App Store
  Connect → **internal TestFlight**: builds land on the phone ~15-30 min
  after CI upload, NO review. External tester link (friends) needs one short
  Beta App Review for the first build only. Publishing later = same account.
- Free-Apple-ID sideloading from Linux (SideStore/AltServer-Linux) exists as
  a fallback but expires every 7 days — TestFlight is strictly better.

## Design & onboarding (we own all of it; onboarding is make-or-break)

Brand: match the landing aesthetic (dark, gradient accents). Reskin Immich's
internal screens (colors/icon/typography); fully custom: welcome, auth,
onboarding, mode switcher.

Onboarding flow v1:
1. Welcome carousel (Free. Unlimited. Encrypted. Yours.)
2. Create account / Sign in — email+password only, no URLs anywhere.
3. Guided private-cloud setup (the hard UX): step-by-step Cloudflare account
   + API token + Telegram bot/channel with in-app instructions and live
   validation, then "Building your private cloud…" progress (reuses
   deployment-service provisioning: account → database → worker).
4. Default mode question: Photos or Drive.
5. (Photos) backup album selection → done.

### Phase 2 — chunked upload (>100 MB videos) ← the feature that forced the fork
Worker (immich-api-shim):
- `POST /api/assets/chunked/begin` → uploadId (D1 upload_sessions reuse)
- `PUT  /api/assets/chunked/:uploadId/part/:n` (≤19 MB body) → worker forwards
  the part straight to Telegram (sendDocument), records {index, message_id,
  file_id} on the session. SHA-1 via DigestStream per part optional; full-file
  checksum comes from the app at finalize (it knows the bytes).
- `POST /api/assets/chunked/:uploadId/finalize` {metadata, checksum,
  livePhotoVideoId?} → assembles ONE photos row with telegramChunks exactly
  like today's multi-chunk assets → existing playback path just works.
- Resumable: `GET .../status` lists received parts.
App (Dart, foreground_upload.service.dart):
- if fileSize > 95 MB → chunked path; else legacy single POST (zero behavior
  change for photos/small videos).
- Encryption: server-ZKE happens worker-side per part (same as today's loop).

### Phase 3 — product features
- In-app signup (Firebase) + required in-app account deletion.
- Onboarding: guided per-user Cloudflare setup (the genuinely hard UX).
- Drive mode: Flutter screens over the existing `/api/drive` worker routes
  (list/upload/download/rename/delete), mode switcher in settings +
  onboarding default question.

### Phase 4 — "like iCloud Drive" (native, expensive, later)
- iOS File Provider extension + Android DocumentsProvider so DaemonClient
  Drive appears in the system Files apps. Native Swift/Kotlin, needs paid
  account entitlements. Do not start before Phases 1-3 are stable.

## Open questions
- Final app display name ("DaemonClient" vs "DaemonClient Photos").
- Play Store ($25 one-time) vs website-APK first for Android.
