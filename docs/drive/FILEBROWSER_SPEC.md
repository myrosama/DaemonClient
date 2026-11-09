# Drive on the File Browser UI — design spec

Status: **approved by the owner on 2026-10-12**, with trash and thumbnails
added to v1. No code changes yet. It replaces the first draft (closed PR #1)
and records the owner's decisions of 2026-10-05, 2026-10-06 and 2026-10-12.
Citations name files and functions rather than line numbers, so they survive
edits.

## Decisions (owner, 2026-10-05, 2026-10-06 and 2026-10-12)

| Question | Decision |
|---|---|
| Architecture | **Option A** (§3): fork File Browser's Vue frontend; an adapter replaces its API layer. |
| Sign-in | **The accounts portal.** Drive's *Sign in* and *Create account* go to `accounts.daemonclient.uz`; Drive gets its session from the shared sign-in (§5). No new login page. |
| Mobile sign-in | The mobile apps keep their existing JSON sign-in. |
| Sharing | **Not in this update.** |
| Copy | **Not in v1** (§4 explains why). |
| Thumbnails | **In v1** (2026-10-12; §4 *Thumbnails*). |
| Trash | **In v1** (2026-10-12; §4 *Trash*). Items stay 30 days, then are deleted for good. |
| Quality bar | Thumbnails, opening files and video streaming must work flawlessly; a damaged or missing part is reported, never a silent stall (2026-10-12; §4 *Integrity*). |
| Frontend stack | Vue 3 + Pinia accepted. |
| Look | File Browser's layout with DaemonClient colours and logo. |
| Languages | Ship File Browser's 33 locales; add Uzbek later. |
| Self-hosted Drive | Deferred while self-host is paused. |
| After signing in from Drive | Back to the Drive page the user came from (2026-10-06). |
| Zip size cap | 2 GB on phones only; no cap on desktop (2026-10-06). |

## 0. Drive today

| Area | How it works |
|---|---|
| App | `drive/` is a standalone React + Vite app (`App.jsx`), not an Immich fork. Its sign-in form talks to the central API (`drive/src/api.js` `login`). |
| Bytes | Chunks go between the browser and Telegram through `/proxy` on the user's own worker, a streamed passthrough to Telegram's API. The `/api/drive/*` handlers store metadata only (`immich-api-shim/src/drive.ts`). This spec keeps that. |
| Encryption | Client-side AES-GCM in 19 MB chunks (`drive/src/crypto.js`, `CHUNK_SIZE` in `App.jsx`), in *auto* or *custom-password* mode; a custom password is verified on unlock (`drive/src/zke-unlock.js`). The WebDAV mount is for auto mode. |
| Reading files | The service worker serves `/stream/<id>`: it fetches chunks from Telegram, decrypts them and answers Range requests within a chunk (`drive/public/sw.js`). A video player asks for one range after another, so large videos play and seek well when every part is intact; a request with no Range gets the first chunk only. Files are streamable after a per-file `REGISTER_FILE` message. Response types follow the rules tested in `drive/src/sw-stream-headers.test.mjs`: PDF inline; video, audio and raster images inline under a bare `sandbox` policy; other types as sandboxed or plain text, or as a download; always `nosniff`. |
| Sharing | None in Drive. |
| File Browser | Apache-2.0, archived upstream; the last release is v2.63.23 at `e8a388f`. We own every future fix, including fixes in its frontend dependencies. |

## 1. Goal and non-goals

The owner's request, verbatim: *"The next big update you are going to do is to
fully update the core drive.daemonclient.uz app!
https://github.com/filebrowser/filebrowser You are going to replace the web UI
of daemonclient drive with this app's UI. You are going to move the drive login
page from client side to server side so u can add turnstile."* On 2026-10-05
the owner settled the second part: sign-in goes through the accounts portal,
which already uses Turnstile.

**Goals**
1. `drive.daemonclient.uz` gets File Browser's UI: list and grid, breadcrumbs,
   context menu, multi-select, drag and drop, previews (image, video, audio,
   PDF, text, CSV, EPUB), the text editor, search and settings.
2. Drive signs in through the accounts portal and the shared session, like
   Photos, instead of its own sign-in form.
3. A **Trash**: deleting is undoable for 30 days.
4. **Thumbnails** in grid view, loaded as fast as Photos loads its grid.
5. **Integrity**: every part is confirmed when it is uploaded (from the web
   app, and from WebDAV after W1) and checked when it is read; opening a file
   and playing a video never stall silently.

**Non-goals**
- No change to the chunk size, the encryption format, the encryption settings
  or the WebDAV protocol. The `files` table gains three columns, `trashedAt`,
  `purgingAt` and `thumb` (§4).
- File Browser's Go backend is not used. The worker never buffers file bytes or
  decrypts them for the web app.
- The paused self-host installer is unchanged. The mobile Drive plan
  (`docs/mobile/`) will adopt the same delete rule: move to Trash, then delete for
  good. Photos changes in two ways: it re-checks the shared sign-in on start
  and focus (§5), and it imports the shared media scheduler (§4).
- Sharing and copy (see Decisions).

## 2. License

- File Browser is Apache-2.0; this repo is AGPL-3.0. Apache-2.0 code may go into
  a GPLv3-family work. The Drive web app is conveyed under AGPL-3.0; imported
  files keep their Apache-2.0 notices.
- What Apache-2.0 §4 asks of us:
  - **License text:** `drive-web/LICENSE.filebrowser`, a copy of upstream's.
  - **Modified files:** a header such as `// Derived from
    filebrowser/filebrowser@e8a388f (Apache-2.0). Modified by DaemonClient
    contributors.` Upstream is imported **unmodified in its own commit**, so
    history records every change.
  - **Existing notices:** carry any per-file headers and any `NOTICE` upstream
    has at `e8a388f` (checked again at import).
  - **Our `NOTICE`:** a File Browser paragraph beside the Immich one.
- §6 grants no trademark rights: the "File Browser" name and `branding/` logos
  go; "Based on File Browser" in About is fine.
- Bundled dependencies (video.js, ace, epub.js, marked, DOMPurify,
  material-icons) keep their own licenses; the build emits a third-party
  licenses file.
- AGPL §13: Help/About links to this repo's source.

## 3. Architecture

File Browser's UI reaches its backend through `frontend/src/api/*`,
`utils/auth.ts` and `utils/constants.ts`, plus two direct `createURL` calls
(`views/files/Preview.vue` and `views/Share.vue`). Replacing that layer is what
makes a fork practical.

| | **A. Fork; adapter replaces `api/*` (chosen)** | B. File Browser's REST API inside the worker | C. Fork; the service worker plays the backend |
|---|---|---|---|
| Encryption stays in the browser | Yes | No — `/raw` and `/preview` would need the worker to decrypt | Yes |
| Bytes through the worker | Only the existing `/proxy` stream | Buffered per request, beyond free-plan limits | Only `/proxy` |
| Effort | M–L | XL | M |
| Main risk | We own an archived Vue codebase | Breaks the model above | Multi-GB uploads inside a service worker, which browsers stop when idle |

**What A builds:** a new `drive-web/` from `e8a388f`. `api/*`, `utils/auth.ts`
and `utils/constants.ts` are rewritten over `/api/drive/*`, the IndexedDB
manifest (`drive/src/idb-store.js`, `manifest-sync.js`) and the existing
upload, download and crypto code. Users, global settings, the command shell,
tus, sharing and copy are removed.

Two details A must get right:
- **Synchronous URL getters.** `getDownloadURL`, `getPreviewURL` and
  `getSubtitlesURL` feed `src` attributes and `window.open`, so they must return
  a usable URL at once. The new service worker therefore gets a **one-time
  handoff per session** instead of per-file registration:
  - the page sends the worker URL, the bot token and the key once;
  - the service worker keeps the bot token and the key **in memory only** (the
    key imported as non-extractable) and drops both when the app locks or
    signs out;
  - it looks files up by id in the shared manifest database (new work: today
    it keeps its own registrations store);
  - after a restart it asks an open page for the handoff again (the existing
    `NEED_REGISTER` pattern);
  - it accepts a handoff only from window clients inside its own scope, checks
    the worker URL against the expected host pattern, and never sends the
    token or the key back to any page.
- **Static build.** Upstream's `public/index.html` is a Go template and its Vite
  config emits template placeholders. Both become a static config module and a
  plain Vite `base`.

## 4. API mapping

"Client" means work done in the browser with no worker route.

| File Browser call | DaemonClient equivalent |
|---|---|
| `auth.login`, `auth.signup` | **Leave the SPA.** Links to the accounts portal (§5). |
| `auth.renew` | The shared-session exchange (§5). |
| `files.fetch` | Client: path → id and children from the IndexedDB manifest, refreshed by `GET /api/drive/files`. Text content: client download and decrypt. |
| `files.fetchAll` (conflict checks) | Client: the manifest subtree. |
| `files.post` (folder) | `POST /api/drive/files {type:'folder'}`. |
| `files.post` / `tus.upload` (file) | Client: the existing pipeline (19 MB chunks, AES-GCM, `sendDocument` through `/proxy`, resumable), then `POST /api/drive/files`. Progress via File Browser's `onupload({loaded})`. The upload gate (`drive/src/upload-gate.js`) still holds uploads while encryption settings load or the key is locked. A resumed upload keeps the encryption mode it began with. |
| `files.put` (editor save) | Client re-encrypts and uploads the new chunks, then `POST /api/drive/files` with the **same `id`**: the route rebuilds the whole row from the body and updates it in place (`saveFile` upserts on `id`). So the client sends every column — `id`, `fileName`, `parentId`, `type:'file'`, `fileSize`, `fileType`, the new `messages`, `encrypted` and `encryptionMode`, and the original `uploadedAt` — and then deletes the old chunks. No new route. |
| `files.move` (rename/move) | `PATCH /api/drive/files/:id {fileName, parentId}`. The adapter refuses moving a folder into itself or a descendant, and the route enforces the same check. |
| `files.copy` | **Not in v1.** A metadata copy would share Telegram messages, so deleting one copy would break the other. |
| `files.remove` | **Moves to Trash** (§4 *Trash*): `POST /api/drive/files/:id/trash`. Nothing leaves Telegram until the Trash is emptied. |
| `files.checksum` | Dropped (would need a full download and decrypt). |
| `files.getDownloadURL` / single download | Inline: the service-worker stream. Save: the existing `downloadFile`. |
| `files.download` (several) | Client zip with `@zip.js/zip.js`, **streamed** to disk (File System Access where available, otherwise a service-worker download stream). The in-memory fallback on a phone refuses selections above 2 GB and says why; desktop has no cap. Tar formats dropped. |
| `files.getPreviewURL` | `big`: the service-worker stream. `thumb`: the file's thumbnail (§4 *Thumbnails*; `EnableThumbs=true`). |
| `files.getSubtitlesURL` | The service-worker stream of a sibling `.vtt`/`.srt`. |
| `files.usage` | `GET /api/drive/usage`; used bytes only (`DisableUsedPercentage=true`). |
| `search` | Client: `searchManifest` in `idb-store.js`. |
| `share.*`, `pub.*` | Removed (no sharing in this update). |
| `users.*` | Dropped; each worker has one owner. Locale, view, sort and theme go to `localStorage`. Password changes link to the accounts portal. |
| `settings.*`, `commands` | Dropped. |

Drive features File Browser lacks become **Settings tabs**: encryption
(`/api/drive/zke`, with new-user auto-init and custom-password unlock), the
Telegram bot, and *Connect as a drive* (`ConnectDriveModal.jsx`). The
resume-upload banner and the onboarding gate carry over.

**Paths vs ids.** File Browser addresses files by path; our table allows equal
names in one folder. The adapter shows duplicates as `name (2)` and keeps names
unique on create, rename and move.

**Streaming.** The new service worker keeps today's ranged playback and its
read-ahead (the next part is fetched when a read starts near a part boundary),
and adds two things: a request with no Range returns every chunk in order, and
a Range that crosses a chunk boundary returns bytes from both chunks (today's
stream answers within one chunk; tested in Gate 1). Opening a file takes
priority over thumbnails, with the same scheduler rules as Photos
(`immich/web/src/service-worker/media-scheduler.ts`): the opened file first,
then thumbnails on screen, newest first; thumbnails scrolled away are dropped
before they cost a request. Phase 3 moves the scheduler into a small module
both service workers import, before the new service worker uses it (owner,
2026-11-09: it has no second user until then).

**Integrity.**
- *Upload:* after each part is sent, Telegram's reply is checked: the stored
  size must equal the bytes sent, and a reply without a size counts as
  unconfirmed. An unconfirmed part is deleted and sent again, at most three
  times, waiting as long as a rate-limit reply asks. Every message id sent is
  recorded in the upload journal, so stray copies are cleaned up. The file's
  row is saved only when every part is confirmed.
- *Read:* an altered encrypted part fails AES-GCM decryption, each part is
  matched to the message id recorded at upload, and every part's decrypted
  length is checked against its expected length. A missing or damaged part
  stops with a clear message — which file, which part — instead of a stalled
  player or a silently short download. *Upload again* accepts a file of the same
  size, checks it against the parts that survive (decrypted and compared in the
  browser; no hash is stored) and keeps the original encryption mode.
- *Check file:* an action that confirms every part of a file still exists on
  Telegram (one `getFile` per part, nothing downloaded) and lists any missing
  ones.

**Trash.**
- *Delete* moves the item to Trash: its row gets `trashedAt`, set by the
  worker's clock; a trashed folder hides its contents. Nothing is deleted from
  Telegram yet, so it can be undone.
- The Trash view lists trashed items; *Restore* puts an item back in its
  folder, or at the top level if that folder is gone.
- *Delete forever* (one item) and *Empty Trash* do the real delete. The worker
  first marks the item and everything inside it as being deleted (`purgingAt`;
  a marked item can't be restored), then the app deletes its Telegram messages — the file's parts and its
  thumbnail — and then its row, deepest first, with a cycle guard and a depth
  limit. A local journal resumes an interrupted delete; any client also
  finishes items the worker has marked, so one device's interrupted delete is
  completed by the next.
- Items in Trash for more than 30 days by the worker's clock are deleted for
  good the next time Drive opens; the worker decides which items have expired.
- Listings, search and WebDAV path lookups leave out trashed items and the
  contents of trashed folders; a WebDAV delete moves the item to Trash too. The
  new app keeps trashed items and its journals in a separate local database
  (`daemonclient-drive`). Usage counts Trash until it is emptied.
- Routes: `GET /api/drive/files?trashed=1` (trashed items, the contents of
  trashed folders and marked items, so a delete can find their messages), `POST /api/drive/files/:id/trash`,
  `POST /api/drive/files/:id/restore`, `POST /api/drive/files/:id/purge` (the
  mark), and `DELETE /api/drive/files/:id`. For a marked item the route
  refuses a folder that still has children. During the beta, `DELETE` still
  accepts unmarked items, because the classic app deletes that way (a folder's
  row alone, its contents left behind); once `/classic/` is retired, release W2
  accepts only marked items.
- Before any write, the new app checks that the worker has W1, and it never
  falls back to deleting an item outright.

**Thumbnails.**
- Made in the browser, in a background worker with `createImageBitmap`, within
  size, pixel and time limits: images (scaled to 256 px on the longest side,
  WebP) and videos (a frame at one second, from the first part only). SVG and
  other types show a type icon. The server never makes thumbnails.
- Encrypted with the same mode and key as the file itself — a custom-password
  file's thumbnail uses the custom key — and stored as one small Telegram
  message. The row's `thumb` column holds only that message's reference: no
  hash, colour or size of the image.
- Files uploaded before this, or through WebDAV or the mobile apps, get a
  thumbnail when first shown in grid view, made in the background and saved
  the same way, so it happens once per file; at most a few at a time, and
  never on a connection the browser reports as metered.
- When a file's contents change (editor save, WebDAV overwrite), its old
  thumbnail message is deleted and the worker clears `thumb`, unless the save
  supplies a new one; the next view then makes a fresh one.
- Only the encrypted thumbnail bytes are cached on the device, keyed by user
  id; the cache is cleared on sign-out and on a user switch. Decrypted images
  exist only as in-memory blob URLs, revoked when the app locks.

## 5. Sign-in through the accounts portal

**Signing in.** Drive's *Sign in* and *Create account* go to
`https://accounts.daemonclient.uz/login` and `/signup` with
`return_url=<the Drive page>`. The portal runs its existing sign-in, with
Turnstile; the auth hub's `/create-session` sets the shared session; the portal
sends the user back through `safeReturnUrl`
(`accounts-portal/src/utils/safeReturnUrl.js`), which accepts only our own
pages. With no `return_url`, the portal's dashboard is the landing page, as
today. **Portal change (phase 2):** sign-up today ends on worker setup and does
not read `return_url`; it will carry `return_url` through setup and return the
user there when setup is done.

**How the session reaches Drive** — the flow Photos uses
(`immich/web/src/lib/utils/sso.ts`):
1. On boot, `GET https://auth.daemonclient.uz/session-token` with
   `credentials: 'include'`. Same-site, so the `SameSite=Lax` cookie is sent even
   where third-party cookies are blocked.
2. `POST https://api.daemonclient.uz/api/auth/exchange`, without credentials. It
   returns `workerUrl` and a token signed for that one worker. Drive's exchange
   call sets no cookies.

Drive's web session is scoped to the user's worker and renewed through the
shared sign-in. The token is held **in memory only** and sent as
`Authorization: Bearer`, never in a cookie or `localStorage`. On a 401, one
renewal runs at a time, with a bounded number of retries; if renewal fails,
Drive sends the user to the portal's sign-in with `return_url`.

**If the user's worker can't be reached** (the request fails: network error or
CORS refusal), Drive shows the existing unreachable screen
(`drive/src/worker-unreachable.js`) with *Try again*, never an empty folder. A
5xx from the worker leads to the same screen (new).

**Signing out ends the session everywhere.**
- Logout goes through the auth hub's origin-checked logout, which clears the
  shared session; Drive then clears its in-memory token, its local data (below)
  and the service worker's handoff.
- A `BroadcastChannel` signs out every other Drive tab at once.
- Drive and Photos both re-check the shared sign-in when they start and when
  their tab regains focus, and sign out when it is gone.
- The worker keeps a per-user session epoch: signing out raises it, and tokens
  issued before it are refused.
- Sign-out and a user switch clear the local databases (manifest, Trash store,
  delete and upload journals, resumable-upload records), the cached thumbnails
  and any read-ahead buffers, so the next account in the same browser never
  sees the previous one's data. Locking the app drops the read-ahead buffers
  too.

**Content Security Policy** for the app:
- `default-src 'none'`; then only what the app needs: `script-src 'self'`
  with Trusted Types (named policies for Vue and DOMPurify, tested with
  video.js and ace); `style-src` and `font-src` from `'self'`; `media-src
  'self' blob:`. No inline script. Every `v-html` in
  the imported tree is audited and either removed or fed only sanitized HTML,
  since file names come from users (and from WebDAV clients).
- `object-src 'none'`, `base-uri 'none'`, `form-action 'self'`,
  `frame-ancestors 'none'`.
- `frame-src`, `worker-src` and `img-src` limited to what the app needs (`'self'`,
  `blob:` for previews and the editor's workers); Markdown images therefore
  can't load remote URLs.
- `connect-src`: our API, the auth hub and per-user worker hosts. That list is
  not a barrier against sending data out (every account's workers share the
  same host suffix); the script rules above are the defence.

**Previews never run file content as our page:** images, video, audio and PDF
through the stream rules above; Markdown rendered through DOMPurify; CSV and
text as text; SVG only through `<img>`; EPUB in a sandboxed frame that never
combines `allow-scripts` with `allow-same-origin`. Stream responses carry
`frame-ancestors 'self'` and `Cross-Origin-Resource-Policy: same-origin`.

Other requirements:
- File Browser's own token storage is removed (`parseToken` writes to
  `localStorage` and a cookie).
- On first load the new app signs the classic app out on this device by
  removing only its stored session; cached manifests and resumable uploads stay.
- The mobile apps are unaffected.

## 6. Migration, rollout, rollback

- **Data.** Rows, Telegram chunks, encryption settings and the WebDAV token are
  unchanged. Files written by either UI or by WebDAV stay readable by the
  others.
- **Worker release W1** (one release to every per-user worker, through
  sign-in auto-update and the scheduled fleet update): the worker-side parts of
  §4 — the `trashedAt`, `purgingAt` and `thumb` columns (an additive migration),
  the trash, restore and purge routes, the listing and search filter, WebDAV
  path lookups that skip trashed items and WebDAV deletes that move to Trash,
  the same part confirmation for WebDAV uploads, `thumb` accepted on create and
  update, the move check (no folder into itself or a descendant) and the check
  on marked folders. A save that leaves `trashedAt` out keeps it, and one that
  leaves `thumb` out keeps it unless `messages` changed, so the classic app and
  WebDAV can neither un-trash an item nor drop a current thumbnail. The classic
  app keeps working against W1. The beta opens to everyone only once W1 has
  reached the fleet; until a user's worker has it, the new app says their Drive
  is being updated.
- **Worker release W2** (after `/classic/` is retired): `DELETE` accepts only
  marked items, and never a folder with children.
- **Local state.** The new app reuses the `daemonclient` IndexedDB database at
  its current version, so cached manifests and **in-progress resumable uploads**
  survive the switch; it adopts a cached manifest only if its stored user id
  matches the signed-in user, and clears it otherwise. Its new stores live in a
  separate database, because a version bump would lock the classic app out.
- **Sessions.** Anyone with a shared sign-in from the accounts portal is signed
  in silently; everyone else signs in once.
- **Hosting today:** the drive target's catch-all serves the landing page
  (`index.html`); the classic app is `app.html` at `/login` and `/dashboard`.
- **Beta on the same origin.** Per-user workers accept only exact origins, so a
  preview-channel URL would be refused. The beta ships at
  `drive.daemonclient.uz/next/`:
  - Vite `base: '/next/'`, built into `drive/dist/next/`;
  - `firebase.json`: `/next/**` → `/next/index.html`, before the catch-all;
    `Cache-Control: no-cache` on `/next/sw.js` and `/next/index.html`;
  - its own service worker at `/next/sw.js` with scope `/next/` (stream URLs
    `/next/stream/<id>`); the classic `/sw.js` is untouched.
  - Same origin means no security boundary between the two apps (storage is
    shared), so the beta gets the full CSP and Gate 3 from its first release.
- **Cutover** (`firebase.json`; each step is a rebuild with its own `base`):
  `/files/**` and `/settings/**` serve the new app; `/login` and `/dashboard`
  go to the new app's sign-in check and `/files/`; the new service worker moves
  to `/sw.js` with `/stream/<id>`; the `/next/` service worker is unregistered
  and the classic app's registrations store is cleared. The classic app stays
  at `/classic/` for two weeks.
- **Rollback.** Roll back the Firebase Hosting release and revert
  `firebase.json`. Backend changes are additive.

## 7. Tests, gates and phases

Every phase passes all four gates in `docs/plan/GATES.md`.

- **Gate 1 (tests first, vitest).**
  - Path ↔ id resolution: duplicates, unicode, trailing slash.
  - Chunk boundaries at 0 B, 1 B, 19 MB and 19 MB + 1, for upload **and** for the
    stream (whole file with no Range; a Range across a chunk boundary).
  - A resumed upload keeps the encryption mode it began with.
  - Moves: a folder can't move into itself or a descendant.
  - Trash: delete moves to Trash; restore (to the folder, or the top level if
    it is gone); listings, search and WebDAV leave trashed items out; delete
    forever and Empty Trash mark first (a marked item can't be restored), then
    go deepest first, delete the thumbnail too, guard cycles and resume from
    the journal; marking a folder marks everything inside it, and the Trash
    listing returns all of it; the route refuses a marked folder with children;
    the classic app's delete, a folder's included, still works under W1, and W2
    accepts only marked items; a second client finishes marked items; contents
    of trashed folders stay hidden; expiry uses the worker's clock; a save
    without `trashedAt` keeps it, one without `thumb` keeps it unless `messages`
    changed, and a supplied `thumb` wins.
  - Integrity: a part whose stored size doesn't match, or comes back without
    one, is deleted and resent (three times at most, honouring rate limits);
    the row is saved only after every part is confirmed; a damaged encrypted
    part, a part with the wrong message id and a short part are reported with
    the file and part number; *Upload again* refuses a different file.
  - Thumbnails: made for images and videos at upload, with the file's own
    mode and key; size, pixel and time limits; SVG gets an icon; made once for
    older files when shown; the cache holds only encrypted bytes and is
    cleared on sign-out.
  - Zip: the 2 GB cap applies on phones only.
  - Editor save sends every column and keeps `id`, `parentId`, encryption and
    `uploadedAt`.
  - Session: in-memory only; one renewal at a time; redirect with a valid
    `return_url`; sign-out across tabs; the classic app signed out on first load with
    its uploads kept; another account's cached manifest cleared, never shown.
  - Service worker: a handoff accepted only from its own scope; dropped on lock
    and on sign-out; never sent back to a page.
- **Gate 2 (throwaway account; real portal, worker and Telegram).** Upload 0 B,
  19 MB + 1, 200 MB and 2 GB with auto and custom encryption. Kill the tab mid-
  upload, then resume. Video seek across a chunk boundary, PDF, text edit and
  save (the old chunks are deleted), folder zip. Video plays across part
  boundaries without pausing; a deliberately removed part is reported, not a
  stall. A grid of 1,000 files fills its visible thumbnails first. Delete a
  folder, restore it, then empty the Trash and confirm its Telegram messages are
  gone. WebDAV and the classic UI read the new UI's files
  and the reverse. Create an account from Drive and land back in Drive; sign in
  from Drive and land back in Drive; one sign-out ends Drive and Photos, in every
  tab. Worker unreachable → the unreachable screen. iOS Safari and Android
  Chrome.
- **Gate 3.** Separate agents for *security* (session handling, CSP, previews,
  redirects, the service-worker handoff) and *spec conformance* (this
  document).
- **Gate 4.** Docs and code in separate commits.

**Phases**
1. Import `e8a388f` unmodified. Then: license and `NOTICE`, rebrand, strip,
   static config, the `/next/` build and hosting, the CSP and the `v-html`
   audit (the beta shares the origin, so these come first).
2. Worker release W1 (§6), rolled out to the fleet.
3. First the shared scheduler module (Photos imports it too; Photos gets its
   own Gate 2). Then the read-only adapter (browse, search, preview, download,
   zip) with the new stream and integrity checks; thumbnails shown in grid view; sign-in through
   the portal (including the sign-up `return_url` change); sign-out
   everywhere; the unreachable screen.
4. Writes (upload with part confirmation and thumbnails, the one-time
   background thumbnails for older files, folder, rename/move, Trash, editor
   save) and the Settings tabs.
5. Cutover and a rollback drill; remove `/classic/` after two weeks.
6. Worker release W2 once `/classic/` is gone, then the Uzbek locale.

## 8. Open questions for the owner

None at the moment; the answers are in the Decisions table.
