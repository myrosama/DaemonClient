# Drive on the File Browser UI — design spec

Status: **draft for owner review**. No code changes. File:line citations are as
of commit `9dc8433`.

## 0. What the code does today (corrections to the brief)

| Assumed | Actual |
|---|---|
| Bytes never pass through the worker | Drive's chunk upload, download and delete requests are relayed through `/proxy` on the user's own worker, as a streamed passthrough (`immich-api-shim/src/index.ts:185-227`; `drive/src/App.jsx:54,170,277,296,391`). The `/api/drive/*` handlers never buffer, decrypt or store bytes. That is the constraint this spec keeps. |
| Encryption is client-side only | True for the web app (`drive/src/crypto.js`). WebDAV decrypts **on the worker**, with the auto-mode password stored in `drive_zke` (`webdav.ts:1-10,383-388`; `drive.ts:97-101`). Files encrypted with a custom password return 423 there. |
| Drive has sharing | It does not. `drive/README.md:28` claims it, but `App.jsx` has no share code, and Photos album sharing is a stub (`albums.ts:16-23`). Sharing is **new** work. |
| Turnstile must be added to login | `/api/auth/login` already verifies Turnstile and fails closed, but only when `TURNSTILE_SECRET` is bound (`auth.ts:83-90`). |
| Drive logs in via `api.daemonclient.uz` | It logs in via `immich-api.sadrikov49.workers.dev` (`drive/src/api.js:21`). Drive also ignores the shared sign-in and keeps its own session in localStorage (`api.js:23,38-41`). |
| File Browser is a live upstream | **Archived 2026-09-01.** No further releases or security fixes (its README). The last release is v2.63.23 at `e8a388f`. We would own every future fix, including fixes in its frontend dependencies. |

## 1. Goal and non-goals

The owner's request, verbatim: *"The next big update you are going to do is to fully update the core
drive.daemonclient.uz app! https://github.com/filebrowser/filebrowser You are
going to replace the web UI of daemonclient drive with this app's UI. You are
going to move the drive login page from client side to server side so u can add
turnstile."*

**Goals**
1. `drive.daemonclient.uz` gets File Browser's UI: list/grid, breadcrumbs, context menu, multi-select, drag-and-drop, previews (image, video, audio, PDF, text, CSV, EPUB), editor, search, settings.
2. Login becomes a server-rendered page whose POST is verified server-side, Turnstile before password.

**Non-goals**
- No change to chunking (19 MB, `App.jsx:28`), the AES-GCM format, the `files` table (`drive.ts:18-24`), `drive_zke` or WebDAV.
- File Browser's Go backend is not used. No server-side encryption; no bytes buffered by the worker.
- Photos, the mobile apps and the paused self-host installer are unchanged.

## 2. License

- File Browser is Apache-2.0; this repo is AGPL-3.0. Apache-2.0 code may go into a GPLv3-family work (not the reverse). The Drive web app is conveyed under AGPL-3.0; imported files keep their Apache-2.0 notices.
- What Apache-2.0 §4 requires of us:
  - **License text:** `drive-web/LICENSE.filebrowser`, a copy of upstream's ("Copyright 2018 File Browser Contributors").
  - **Modified files:** a header such as `// Derived from filebrowser/filebrowser@e8a388f (Apache-2.0). Modified by DaemonClient contributors.` Import upstream **unmodified in its own commit** so history records every change.
  - **Existing notices:** upstream has no per-file headers and no `NOTICE` (checked at `e8a388f` and HEAD); nothing to carry.
  - **Our `NOTICE`:** add a File Browser paragraph beside the Immich one (`NOTICE:11-18`).
- §6 grants **no trademark** rights: remove the "File Browser" name and `branding/` logos; "Based on File Browser" is fine.
- Bundled dependencies (video.js, ace, epub.js, marked, DOMPurify, material-icons) carry their own licenses; the build emits a third-party licenses file.
- AGPL §13: the Help/About link points at this repo's source.

## 3. Architecture options

File Browser's UI reaches its backend only through `frontend/src/api/*` (files, share, pub, search, users, settings, commands, tus) and `utils/auth.ts`. That single seam is what makes options A and C feasible.

| | **A. Fork the Vue frontend; adapter in place of `api/*`** | **B. File Browser's REST API inside the worker** | **C. Fork; the service worker plays the backend** |
|---|---|---|---|
| Changes | New `drive-web/` from `e8a388f`, building into `drive/dist/` (Firebase target unchanged). `api/*`, `utils/auth.ts`, `utils/constants.ts` rewritten over `/api/drive/*`, the IndexedDB manifest and the existing upload/download/crypto code. Users, global settings, shell, tus deleted. | Shim gains `/api/resources`, `/raw`, `/preview`, `/tus`, `/search`, `/login`, `/renew`, `/shares`. UI nearly untouched. | UI nearly untouched; the service worker answers `/api/resources/*` and `/api/raw/*` from IndexedDB and Telegram. |
| Encryption stays client-side | Yes | **No.** `/raw` and `/preview` need the worker to decrypt; custom-password files become unreadable, as in WebDAV (`webdav.ts:388`). | Yes |
| Bytes through the worker | Only the existing streamed `/proxy` | **Buffered**, with a 19 MB AES operation per request: beyond free-tier CPU and subrequest limits. WebDAV already caps PUT at 90 MB (`webdav.ts:250,437`). | Only `/proxy` |
| WebDAV | Untouched | Untouched | Untouched |
| Effort | M–L (adapter ≈1.5k lines + porting the pipeline) | XL | M |
| Risk | We own an archived Vue codebase; a third frontend framework in the repo. | Breaks the security model. | Multi-GB uploads inside a service worker, which browsers kill when idle (`drive/public/sw.js:6-11`); abort, progress and debugging get harder. |

**I recommend A.** It is the only option that keeps every hard constraint. It borrows C's one good idea for reads: download, preview and subtitle URLs become same-origin service-worker URLs, so `<img>`, `<video>` and `<object>` work unmodified. Upstream is archived, so keeping the fork untouched (C's main appeal) buys nothing.

Two details A must get right:
- **URL getters are synchronous.** `getDownloadURL`, `getPreviewURL` and `getSubtitlesURL` feed `src` attributes and `window.open`. Today the service worker serves a file only after a per-file `REGISTER_FILE` message (`sw.js:170`, `App.jsx:1745-1785`), so those URLs would race. Replace that with a one-time handoff per session:
  - The page sends the bot token, the worker URL and the key once.
  - The key stays in service-worker memory only, as today (`sw.js:9-11`).
  - The service worker looks up `messages` by id in the shared manifest DB (`idb-store.js:13`).
  - After a restart it asks an open page for the key again (the existing `NEED_REGISTER` pattern).
- **Build.** Upstream's `public/index.html` is a Go template (`window.FileBrowser = [{[ .Json ]}]`), and `renderBuiltUrl` in `vite.config.ts` emits `[{[ .StaticURL ]}]`. Both are replaced with a static config module and a plain Vite `base`.

## 4. API mapping

"Client" means work done in the browser with no worker route.

| File Browser call | DaemonClient equivalent |
|---|---|
| `auth.login` (`POST /api/login`, reCAPTCHA) | **Leaves the SPA.** The server-rendered form posts to the auth hub (§5). |
| `auth.renew` (`POST /api/renew`) | Existing: `auth.daemonclient.uz/session-token` (`auth-worker/src/index.ts:251-293`), then `POST /api/auth/exchange` (`auth.ts:194-245`). |
| `auth.signup` | Dropped. A link to `accounts.daemonclient.uz/signup` replaces it, as today (`App.jsx:712`). |
| `files.fetch` (`GET /api/resources/{path}`) | Client: path→id and children from the IndexedDB manifest, refreshed via existing `GET /api/drive/files` (`drive.ts:112-116`). Text content: client download + decrypt. |
| `files.fetchAll` (recursive, used for conflict checks) | Client: the manifest subtree. |
| `files.post` (directory) | Existing `POST /api/drive/files {type:'folder'}` (`drive.ts:120-143`). |
| `files.post` / `tus.upload` (file) | Client: the existing pipeline, ported (19 MB chunks, AES-GCM, `sendDocument` via `/proxy`, resumable; `App.jsx:49-235`), then existing `POST /api/drive/files`. Progress via File Browser's `onupload({loaded})`. |
| `files.put` (editor save) | Client re-encrypts and uploads; then a **new** `PATCH /api/drive/files/:id` that accepts `messages`, `fileSize` and `fileType` (today: name and parent only, `drive.ts:153-159`); then the old messages are deleted. |
| `files.move` (`action=rename`) | Existing `PATCH /api/drive/files/:id {fileName,parentId}` (`drive.ts:153-160`). |
| `files.copy` | **None.** A metadata copy shares Telegram messages, so deleting one copy breaks the other. Drop in v1, or ref-count on delete (Q5). |
| `files.remove` | Client: `deleteMessage` via `/proxy` (`App.jsx:387-398`), then existing `DELETE /api/drive/files/:id` (`drive.ts:162-167`). Folders **must recurse**; today children are orphaned (`App.jsx:1254`). Optional **new** batch-delete route. |
| `files.checksum` | Dropped. It would require a full download and decrypt. |
| `files.getDownloadURL` / single `download` | Inline: service-worker `/stream/<id>` (`sw.js:5`). Save: existing `downloadFile` (`App.jsx:238-384`). |
| `files.download` (several, `algo=`) | Client zip via `@zip.js/zip.js` (already a dependency). Tar formats dropped. |
| `files.getPreviewURL` (`big` / `thumb`) | `big`: service-worker stream. `thumb`: off in v1 (`EnableThumbs=false`); client-made, IndexedDB-cached thumbnails later. |
| `files.getSubtitlesURL` | Service-worker stream of a sibling `.vtt`/`.srt`. |
| `files.usage` | Existing `GET /api/drive/usage` (`drive.ts:77-80`); used bytes only, so `DisableUsedPercentage=true`. |
| `search` (streamed NDJSON) | Client: the existing `searchManifest` (`idb-store.js:285-291`). |
| `share.*`, `pub.*` | **New feature, later phase** (Q4): new `/api/drive/shares` routes and table. The key travels only in the URL fragment. Recipients fetch *ciphertext* one chunk per request from a new public route (within the subrequest limit) and never see the bot token. |
| `users.getAll/get/create/remove` | Dropped. Each worker has exactly one user (the owner gate). |
| `users.update` (locale, view, sort, theme) | localStorage, or a **new** `GET/PUT /api/drive/prefs` for cross-device prefs. Password change links to the accounts portal. |
| `settings.*` (global admin settings) | Dropped. |
| `commands` (WebSocket shell) | Dropped. Upstream itself calls it unsafe. |

Drive features File Browser lacks become **Settings tabs**: encryption (`/api/drive/zke`, with new-user auto-init, `App.jsx:1044-1085`), the Telegram bot (`drive.ts:66-74`) and *Connect as a drive* (`ConnectDriveModal.jsx`). The resume-upload banner and the onboarding gate (`App.jsx:2223-2239`) carry over.

**Paths vs ids.** File Browser addresses by path; our table allows duplicate names in a folder (no unique index, `drive.ts:18-24`). The adapter shows duplicates as `name (2)` and enforces unique names on create, rename and move.

## 5. Server-side login with Turnstile

**Where it runs.** `daemonclient-auth` (`auth-worker/`, `auth.daemonclient.uz`) serves `GET /login` as plain HTML and handles `POST /login`. It already holds `TURNSTILE_SECRET`, `FIREBASE_API_KEY` and `SESSION_SECRET` (`auth-worker/src/index.ts:1-7`) and owns the shared `__session` cookie (`:199`). `drive.daemonclient.uz/login` becomes a Firebase Hosting 302 to it, as Photos does for `/signup` (`firebase.json:132-134`). A form on the drive origin itself would mean moving Drive hosting to Cloudflare (Q1).

**`POST /login`, in order:**
1. Require `Origin: https://auth.daemonclient.uz`.
2. Turnstile siteverify, fail-closed, also checking `hostname` and `action`.
3. Firebase `signInWithPassword` over REST (as `auth.ts:96-108`).
4. Firestore `config/cloudflare` lookup, so an unprovisioned user goes to onboarding.
5. Set `__session` with `Domain=.daemonclient.uz; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=400d`.
6. `303` to `continue`.

At most four subrequests, counting the activity log `/create-session` already writes. Errors re-render the form with **one generic message**, so it never reveals which accounts exist. Headers: `no-store`, `frame-ancestors 'none'`, and a CSP allowing scripts and frames only from `challenges.cloudflare.com`. Turnstile's implicit render puts `cf-turnstile-response` into the form, so no app JavaScript is needed. One dashboard step: add `auth.daemonclient.uz` to the widget's hostnames (site key: `accounts-portal/src/components/Turnstile.jsx:6`).

**How the session reaches Drive.** This is the flow Photos already uses (`immich/web/src/lib/utils/sso.ts`):
1. On boot, `GET auth.daemonclient.uz/session-token` with `credentials:'include'`. It is same-site, so the Lax cookie is sent even where third-party cookies are blocked.
2. Then `POST api.daemonclient.uz/api/auth/exchange`, sent without credentials as `sso.ts` does. It returns `workerUrl` and a token signed for that one worker (`auth.ts:209-245`).

We use exchange rather than a raw Firebase ID token because only a worker-signed token may claim an unowned install (`owner-gate.ts:89-97`). The token is held **in memory only** and sent as `Authorization: Bearer`, never in a cookie, so the worker has no CSRF surface. On a 401 the SPA repeats the two steps; if that fails, it redirects to `/login?continue=<url>`.

**Requirements**
- `continue` is accepted only as an exactly allowlisted origin (drive, photos, accounts) plus a path. Anything else falls back to the Drive root: `//host`, backslashes, userinfo, look-alike suffixes, non-https.
- Logout is POST-only and checks Origin. It clears `__session` (ending every app's session), the in-memory token, the IndexedDB manifest and the service worker's key.
- Credentialed CORS uses an exact-origin set, as in `auth-worker/src/index.ts:115-125`.
- Remove File Browser's token persistence. `parseToken` writes the JWT to localStorage and to a non-HttpOnly cookie (`frontend/src/utils/auth.ts:13,15`).
- On first load, delete the legacy `dc_drive_session` (`api.js:23`).

**Threat model**
- *Credential stuffing.* Turnstile here only helps if the other doors are covered. The JSON `/api/auth/login` (used by mobile) is gated only when its secret is bound. Firebase's sign-in endpoint is callable directly with the public web key. Both need decisions (Q2–Q3). A Cloudflare rate-limit rule on both login paths is cheap defence in depth.
- *Token storage.* JavaScript can no longer read any long-lived credential; the refresh token lives only in the HttpOnly cookie. XSS on the drive origin would still act as the user while the page is open, and could read the bot token (`drive.ts:50-60`). So the CSP and the preview renderers (markdown, CSV, EPUB, SVG) are Gate 3 scope.
- *Token lifetime.* Exchange tokens get the ~10-year TTL (`auth.ts:15`). The web client can always re-exchange, so a backend task adds a short-lived variant for web (e.g. 12 h).
- *Mobile.* Not affected; the apps keep the JSON login.

## 6. Migration, rollout, rollback

- **Data.** Nothing to migrate. Rows, Telegram chunks, `drive_zke` and the WebDAV token are unchanged. Files written through either UI or through WebDAV stay readable by the others.
- **Local state.** The new app reuses the `daemonclient` IndexedDB database and its schema (`idb-store.js:13`), so cached manifests and **in-progress resumable uploads** survive the switch. The service worker keeps the `/sw.js` path and the `/stream/<id>` contract.
- **Sessions.** Anyone with a shared `__session` cookie (an accounts-portal sign-in within the last 400 days) is signed in silently; everyone else signs in once. The legacy tokens deleted from localStorage stay valid until per-worker secrets rotate. That is accepted, and recorded here.
- **Beta on the same origin.** Per-user workers get `ALLOWED_ORIGINS` at deploy time (`deployment-service/src/index.ts:113`), and fleet auto-update is unreliable. A preview-channel origin would therefore be CORS-blocked, so the beta ships at `drive.daemonclient.uz/next/` with its own service-worker scope.
- **Cutover.** In `firebase.json:213-233`:
  - `/files/**`, `/settings/**` and `/share/**` serve the new app
  - `/dashboard` redirects to `/files/`
  - `/login` redirects to the hub

  The classic app stays at `/classic/` for two weeks.
- **Rollback.** Roll back the Firebase Hosting release and revert `firebase.json`. Backend changes are additive, so they need no rollback.

## 7. Tests, gates and phases

Every phase passes all four gates in `docs/plan/GATES.md`.

- **Gate 1 (tests first, vitest).** Path↔id resolution (duplicates, unicode, trailing slash). Chunk boundaries at 0 B, 1 B, 19 MB and 19 MB+1. Resuming in the wrong encryption mode (`App.jsx:61-67`). Recursive delete and zip. For the login handler: every fail-closed Turnstile case (including wrong hostname or action), Origin rejection, an open-redirect corpus for `continue`, exact cookie attributes, and the single generic error.
- **Gate 2 (throwaway account; real Turnstile, Firebase, worker and Telegram).** Upload 0 B, 19 MB+1, 200 MB and 2 GB, with auto and custom encryption. Kill the tab mid-upload, then resume. Video seek, PDF, text edit and save, folder zip. Delete a folder and confirm its Telegram messages are gone. Check that WebDAV and the classic UI can read the new UI's files, and vice versa. SSO from the accounts portal, and a single logout ending every app. iOS Safari and Android Chrome.
- **Gate 3.** Separate agents for *security* (login, cookie, CORS, CSP, redirects, preview XSS) and *spec conformance* (this document).
- **Gate 4.** Docs and code in separate commits, with no AI trailers.

**Phases**
1. Auth hub: `GET/POST /login`, logout hardening, a short-lived web exchange token. Additive; classic Drive keeps working.
2. Import `e8a388f` unmodified. Then: license and NOTICE, rebrand, strip, static config. Then the read-only adapter (browse, search, preview, download, zip) at `/next/`.
3. Writes (upload, mkdir, rename/move, recursive delete, editor save) and the Settings tabs.
4. Cutover and a rollback drill. Remove `/classic/` after two weeks.
5. Optional: sharing (with its own spec and security review), thumbnails, an Uzbek locale.

## 8. Open questions for the owner

1. Is a login page at `auth.daemonclient.uz/login` acceptable, with Photos able to share it later? Or must it live on `drive.daemonclient.uz`, which means moving Drive hosting to Cloudflare?
2. Mobile JSON login: keep it without Turnstile and add a rate limit, or move the apps to an in-app web login that shows Turnstile?
3. Is `TURNSTILE_SECRET` bound on the central worker today? Do you want Firebase-side abuse protection? That is a separate decision.
4. Is sharing in scope for this update or a later one? Public links stream ciphertext through the worker to recipients.
5. Copy: drop it, or ref-count shared Telegram messages?
6. Is v1 without image thumbnails acceptable?
7. Do you accept Vue 3 + Pinia as a third frontend stack, in a fork of an archived project whose dependency fixes we will own?
8. Branding: File Browser's look with DaemonClient colours and logo, or its stock theme?
9. Locales: File Browser ships 33, with no Uzbek. Ship all of them, or a subset plus Uzbek?
10. While self-host is paused, may self-hosted Drive keep the JSON login as a documented divergence?
