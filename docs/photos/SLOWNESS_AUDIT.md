# DaemonClient Photos: slowness and dead-logic audit

Scope: `immich/web` (SvelteKit, adapter-static) against `immich-api-shim/`. No code was changed. Build measured with `pnpm install` + `npm run build` in `immich/web` (needed `pnpm --filter @immich/sdk build` first). The measurements are static: there is no live trace, so the ms figures are estimates from request counts and sizes. Service-worker thumbnail scheduling is out of scope (being redesigned on `feat/photos-media-scheduler`).

## Summary

The earlier fixes already cover the worst of the websocket problem. `lib/stores/websocket.ts:46-76` never connects and `openWebsocketConnection` is a no-op. There is no version polling or telemetry. The remaining slowness is mostly:
1. a 4.8 MB font,
2. a serial boot chain of API calls, some of them stubs,
3. a full photo-table scan on every page load (`/api/users/me/storage`),
4. a third-party Google Cast script loaded on every boot,
5. about 1.3 MB of JS preloaded, mostly shared UI and icon code.

Maplibre, three, pdf and ffmpeg are all lazy. They are not in the initial load.

## Boot and timeline-page requests (in order)

| # | Request | Where | Shim | Verdict |
|---|---|---|---|---|
| 0 | SW register + wait for `controllerchange` (first visit only, up to 8 s cap) | `utils/sw-register.ts:20-55` | n/a | Needed. Only on first visit |
| 1 | `GET /api/server/config` | `server.ts:14`, `server-config-manager` | real (static JSON) | Needed for pre-login. One invocation |
| 2 | `GET /api/users/me` and `/api/users/me/preferences` (parallel) | `auth-manager.svelte.ts:63` | real | Needed |
| 3 | `GET /api/server/about` | `auth-manager.svelte.ts:68-72` | static JSON | **Wasted.** The shim always returns `license: null` (`user.ts:87`), so this runs on every boot. It serialises after step 2 |
| 4 | `GET /api/server/features` | `feature-flags-manager`, `utils/server.ts:19` | static JSON | Static. Serial after step 3. Could run in parallel or be inlined |
| 5 | `GET /api/server/media-types` | `upload-manager.svelte.ts:11,23` (on `AppInit`) | static JSON | Static list. Not needed to paint |
| 6 | `GET /api/memories` | `memory-manager.svelte.ts:29,133` (on `AuthUserLoaded`) | **stub `[]`** (`stubs.ts`) | **Wasted.** `preferences.memories.enabled:false` (`user.ts:125`), but the manager never checks it |
| 7 | `GET /api/timeline/buckets`, then `GET /api/timeline/bucket` per visible bucket | `timeline-manager.svelte.ts:242` | real (loads all photos per call) | Needed. `withPartners:true` (`photos/+page.svelte:44`) is meaningless: `/api/partners` is a stub |
| 8 | `GET /api/notifications` | `NavigationBar.svelte:50` | real D1 query | One call is needed, if notifications are kept |
| 9 | `GET /api/notifications` (again) | `photos/[[assetId=id]]/+page.svelte:55-63` | real D1 query | **Duplicate of 8**, only to find the `heic-fix` banner |
| 10 | `GET /api/assets/zke-status` | `NavigationBar.svelte:55` | real | Needed for the padlock |
| 11 | `GET /api/albums` | `RecentAlbums.svelte:13` (sidebar, if the dropdown is enabled) | real | Only if the sidebar shows recent albums |
| 12 | `GET /api/users/me/storage` | `StorageSpace.svelte:35` via `utils/auth.ts:33` | real, **full scan** | See finding 2 |
| 13 | `GET /api/server/about` and `/api/server/version-history` | `ServerStatus.svelte:26-35` | static JSON and stub `[]` | **Wasted.** Footer "Server Online v2.7.5" |
| 14 | `https://www.gstatic.com/cv/js/sender/v1/cast_sender.js` | `utils/cast/gcast-destination.svelte.ts:27-51` | third party | **Wasted.** See finding 4 |
| 15 | `GET /api/search/*`, `/api/people`, `/api/tags`, `/api/shared-links` etc. | only after the user navigates | stubs | Not on boot |

Estimates for a boot with a warm Worker: about 11 to 13 Worker invocations before the timeline settles. The serial chain is config → (me ‖ prefs) → about → features, so roughly 4 network round trips before the router can render the page (about 4 × 80–250 ms on mobile). The total Worker invocations are not the issue; the serial depth is.

## Ranked findings

### A. Safe, high impact

**1. 4.8 MB variable font blocks first text paint.**
- Evidence: `build/_app/immutable/assets/GoogleSans.DGRbB7N7.ttf` = 4,845,504 bytes. It is pulled by `app.css:88-90` with no `font-display`, so the default `auto` can hide text for up to 3 s while it downloads. `GoogleSansCode.ttf` is another 126 KB.
- Impact: on a 4G connection (about 1.5 MB/s) about 3 s of invisible text on a cold cache, 0 after caching. By far the largest single payload on first load.
- Risk: none for the API, the SW or login. Only the visual font changes.
- Minimal change: add `font-display: swap`, subset to Latin and convert to WOFF2 (typically 100–300 KB), or fall back to the system font stack. Do the subset if brand matters.

**2. `/api/users/me/storage` scans every photo on every page load.**
- Evidence: `immich-api-shim/src/user.ts:100-118` calls `queryPhotos({ownerId})`, loads all rows into the isolate and sums `fileSize` in JS. The web calls it on every cold boot (`StorageSpace.svelte:35`, `utils/auth.ts:31-35`), and the in-memory cache `userInteraction.serverInfo` is lost on reload. The reported `free`/`total` are `Number.MAX_SAFE_INTEGER` anyway.
- Impact: with 20k photos this is tens of thousands of D1 rows on the free-tier Worker (small CPU budget) to render a storage label. The cost is Worker CPU, not web CPU. It can also trip the CPU limit and delay the neighbouring boot calls.
- Risk: the mobile app shows storage from the same endpoint (confirm). Keep the contract; change only the implementation.
- Minimal change (shim): `SELECT COALESCE(SUM(fileSize),0), COUNT(*)` in SQL, or cache for 5 to 10 minutes. Or hide `StorageSpace` for unlimited storage.

**3. Memories fetch on every boot, though memories are disabled.**
- Evidence: `memory-manager.svelte.ts:28-33,131-143` always calls `searchMemories`. The shim sets `memories.enabled:false` (`user.ts:125`) and `/api/memories` is a stub `[]`.
- Impact: 1 Worker invocation, off the critical path but competing for the browser's 6-connection limit with the timeline calls.
- Risk: none; the timeline memory carousel at `photos/+page.svelte:107-114` simply stays empty.
- Minimal change: early-return in `MemoryManager.load()` when `!authManager.preferences.memories.enabled`.

**4. Google Cast SDK is injected on every boot.**
- Evidence: `gcast-destination.svelte.ts:28` reads `if (!authenticated || preferences.cast.gCastEnabled) return false;`. The shim ships `gCastEnabled:false` (`user.ts:122`), so the condition is false and the code appends `cast_sender.js` from gstatic.com on `AppInit` (`cast-manager.svelte.ts:63`). It also arms a 3 s timeout.
- Impact: one third-party script plus follow-up requests (about 100+ KB, one DNS and TLS handshake), on the main-thread critical path. The condition also looks inverted against upstream (`!gCastEnabled`), so Cast is never actually usable.
- Risk: none; Cast does not work without a media URL the SW can serve to a Chromecast anyway.
- Minimal change: delete `GCastDestination` from `castDestinations` (`cast-manager.svelte.ts:57`) or short-circuit `initialize()`.

**5. Duplicate and wasted boot calls.** Fold these into one small PR:
- Remove the second `/api/notifications` in `photos/+page.svelte:55-63`; read from `notificationManager.notifications` (row 9 above).
- Skip `getAboutInfo()` in `auth-manager.svelte.ts:68-72`. It exists only to set `isPurchased`; the shim never licenses.
- Run `featureFlagsManager.init()` in parallel with the config call (`utils/server.ts:18-23`), or inline the constants from `server.ts` `serverFeatures()`.
- Drop `ServerStatus`'s `getAboutInfo` + `getVersionHistory` (`ServerStatus.svelte:26-35`) in favour of the static version.
- Impact: -3 to -4 Worker invocations and one fewer serial round trip (about 100–250 ms to the router on mobile).
- Risk: low. Keep the `user.license` contract in the shim for the mobile app.

**6. Preloaded JS is ~1.29 MB raw (443 KB gzip) over 109 files, plus 168 KB CSS, for `/photos`.**
- Evidence: union of `__vite__mapDeps` for nodes 0 (root), 2 (`(user)` layout) and 26 (photos page). Largest: `BNFnig_X.js` 207 KB (shared `@immich/ui` + mdi icon paths), `CScItrjc.js` 105 KB (socket.io-client + thumbhash + justified-layout), `OTUYh6R_.js` 102 KB, `DHVQM20z.js` 71 KB (lodash/sdk), `CDphBwRm.js` 67 KB, `Wrwo3-VV.js` 50 KB.
- Lazy and NOT in the initial load (good): maplibre (`C-EnwhFs2` 1.09 MB), three/viewer (`CA1Xjfpp2` 590 KB), pdf, the HEVC player (`DMDi13t2` 1.35 MB), the 2 MB `DmMh2lYH2` chunk (only node 38), admin system-settings (`nodes/44` 745 KB), and all 60 or so translation chunks (about 220 KB each, loaded one at a time). The ffmpeg wasm loads at runtime from esm.sh/unpkg (`utils/video-poster-ffmpeg.ts:14-15`), only after the native path fails.
- Dead weight inside the initial chunks: `socket.io-client` (`stores/websocket.ts:11`, a socket that never connects), `PurchaseInfo`, `VersionAnnouncement` + `ServerRestartingModal` (root layout, `+layout.svelte:12,16`), the command palette providers (`+layout.svelte:218-228`, including "Socials", "Sites" and "Mobile app" entries that point at immich.app).
- Impact: removing socket.io and the root-layout modals saves an estimated 60 to 100 KB raw. The rest is shared UI library code, so the realistic win is small compared with items 1 to 5.
- Risk: low. `websocketEvents` is used by shared code, so stub it with a no-op emitter rather than deleting it.

### B. Needs owner decision

**7. Idle background work: nearly none (good).** The 3 s `queue-manager` poll runs only on admin queue pages; `daemonclient-drive.ts:242` loads lazily on upload; `CloudStartingLayout.svelte:24` ticks only while the worker is unreachable and pauses in hidden tabs. No change needed.

**8. Whole feature trees the shim cannot serve.** They are lazy chunks, so the cost is bundle size and dead routes, not startup.
- `/admin/*` (jobs, library management, queues, server status, system settings, users, maintenance), `/auth/register`, `/auth/onboarding`, `/maintenance`, `/buy`, `/people/*`, `/explore`, `/places`, `/tags`, `/map` (maplibre, 1.09 MB), `/utilities/duplicates`, `/partners/*`, `/sharing`, `/shared-links`, `/memory`.
- The shim answers these with stubs (`stubs.ts`: people, tags, partners, jobs, libraries, duplicates, admin → 403).
- Decision: delete the routes outright (smaller build, shorter CI) or keep them to stay mergeable with upstream Immich. Deleting `/admin`, `/buy`, `/auth/register`, `/auth/onboarding`, `/maintenance` is low risk. `/link`, `/s/*` and `/auth/login` must stay (shared links, SSO via auth.daemonclient.uz).
- Risk: sidebar items for people, tags, folders and shared links are already hidden by preferences (`user.ts:120-130`). `map`, `search` and `smartSearch` are advertised as `true` (`server.ts:27,33,35`) although the map style URLs are empty (`server.ts:14-15`) and smart search is a stub `[]`, so those menu entries lead to dead pages. Setting them to `false` is a one-line shim change that also hides the sidebar items; check the mobile app first.

**9. Maintenance-mode and server-restart machinery.** `routes/+layout.ts:17-23` and `+layout.svelte:118-146` keep maintenance redirects and the `ServerRestartingModal` alive although the shim never reports maintenance. Safe to remove. Decision: bundle with upstream-merge policy (item 8).

**10. Lockfile drift.** `pnpm install --frozen-lockfile` fails: `immich/pnpm-lock.yaml` is stale against `immich/web/package.json` (`libheif-js@^1.19.8` added). This is a build-reproducibility issue for CI and deploys, not a runtime one. I restored the lockfile and did not commit a regenerated one.

## Contract notes

Keep the shim stubs the mobile app calls, and prefer changing the web client. Do not touch `/api/auth/*`, `utils/sso.ts` or the SW token and worker-URL handling (login, SSO via auth.daemonclient.uz, logout). Shared links (`/s/*`, `/api/shared-links/me`) stay. Client-side decryption (`service-worker/telegram-media.ts`) is unaffected by every item above.

## Suggested order

1 → 2 → 5 → 4 → 3 → 6, then decide 8 and 9.
