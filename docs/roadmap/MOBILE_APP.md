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
