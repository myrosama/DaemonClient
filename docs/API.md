# The DaemonClient API — technical specification

The worker in `workers/user-worker/` is the entire API for Photos, Drive and the
mobile app. It impersonates an Immich server closely enough that a stock Immich
client works against it, while storing everything in the user's own Telegram
channel and D1 database.

**This document is the contract.** Written 2026-07-27 against the code, with
every route checked for whether anything actually calls it. Where it disagrees
with the code, the code is a bug or this is stale — either way, one of them
gets fixed.

---

## How a request reaches a handler

```
client ──▶ photos.daemonclient.uz (static SvelteKit)
             └─ service worker rewrites /api/* to the user's OWN worker
                  │
                  ▼
            dc-<id>.workers.dev          ← per-user: has env.DB (their D1)
                  or
            immich-api.workers.dev       ← shared: NO env.DB, login + proxy only
                  │
                  ├─ requireAuth  (signed session, then the owner gate)
                  └─ handleX by path prefix — index.ts:160-259
```

Two deployments run the **same code**. `env.DB` is the only thing that
distinguishes them, and it changes behaviour in ~40 places. The shared worker
holds no photos; it authenticates and hands the client its per-user worker URL.

**Self-hosted is the same worker again**, with `SELF_HOST=1`, the user's own
Firebase, and no `DEPLOYMENT_SERVICE_URL`.

### Authentication

A session token is `base64(payload).hmac`. The payload is **not encrypted** and
carries `uid`, `email`, the Firebase `idToken` and `refreshToken`, `workerUrl`
and `exp` (`auth.ts:28`). It is signed with the worker's own `SESSION_SECRET`,
so a session minted for one worker does not verify on another.

`requireAuth` (`helpers.ts:79`) requires a signature — always — then applies the
**owner gate** (`owner-gate.ts:76`): on any worker with `env.DB`, the caller must
be `owner_uid`, which the first authenticated user claims. One install, one
owner.

---

## Routes

Legend: **auth** = requires a valid session. **callers** = what in this
repository actually calls it, verified by grep, not by inference.

### Auth — `auth.ts`

| Method | Path | Auth | Callers |
|---|---|---|---|
| POST | `/api/auth/login` | no | web, mobile, `apps/drive-web/src/api.js:48` |
| POST | `/api/auth/logout` | no | web, mobile |
| GET | `/api/auth/status` | yes | web, mobile |

`login` validates against Firebase, reads the user's `config/cloudflare` from
Firestore for their `workerUrl` and `sessionSecret`, and bakes the worker URL
into the token so later requests need no lookup.

### Server info — `server.ts`

| Method | Path | Auth | Callers |
|---|---|---|---|
| GET | `/api/server/config`, `/api/server-info/config` | no | web, mobile |
| GET | `/api/server/features` | no | web, mobile |
| GET | `/api/server/about` | no | web |
| GET | `/api/server/version` | no | web, mobile |
| GET | `/api/server/version-history` | no | web |
| GET | `/api/server/media-types` | no | web |
| GET | `/api/server/statistics` | soft | web admin page |
| GET | `/api/server/storage` | soft | web, mobile |
| GET | `/api/server/license` | no | web |
| GET | `/api/server/ping` | no | mobile |
| GET | `/api/server/telegram-config` | **yes** | Photos SW, `daemonclient-drive.ts:25` |
| GET | `/api/server/zke-config` | **yes** | Photos SW, `daemonclient-drive.ts:38` |
| GET | `/api/server/setup`, `/theme`, `/onboarding` | no | *none* |

**`telegram-config` and `zke-config` return real secrets** — the bot token, and
the ZKE password and salt. That is deliberate: the browser fetches media bytes
straight from Telegram and decrypts locally, which is what keeps the worker
inside its free-tier limits. Removing those fields would push every byte back
through the worker. They are protected by the owner gate, not by obscurity.

### Assets — `assets.ts`

| Method | Path | Auth | Callers |
|---|---|---|---|
| POST | `/api/assets`, `/api/asset/upload` | yes | web upload, mobile backup |
| POST | `/api/assets/bulk-upload-check` | yes | web `file-uploader.ts` |
| GET | `/api/assets/{id}` | yes | web, mobile |
| PUT/PATCH | `/api/assets/{id}` | yes | web, mobile |
| DELETE | `/api/assets` | yes | web, mobile |
| PUT | `/api/assets` | yes | web, mobile |
| GET | `/api/assets/{id}/thumbnail` | yes | web |
| GET | `/api/assets/{id}/original`, `/api/asset/file/{id}` | yes | web, mobile |
| GET | `/api/assets/{id}/video/playback` | yes | web `video-backfill.ts` |
| HEAD | the four media paths above | yes | native players |
| POST | `/api/assets/{id}/thumbnail` | yes | web backfills, **mobile iOS bg** |
| POST | `/api/assets/{id}/playback-rendition` | yes | web `video-backfill.ts` |
| GET | `/api/assets/{id}/dc-manifest` | yes | Photos SW |
| GET | `/api/assets/pending-thumbnail-fix` | yes | web fix modals |
| GET | `/api/assets/zke-status` | yes | web nav bar, Drive util |
| GET | `/api/assets/{id}/ocr` | **no** | web — answered early in `index.ts:166` |
| POST | `/api/trash/restore/assets`, `/api/trash/restore` | yes | web, mobile |
| POST/DELETE | `/api/trash/empty` | yes | web |
| GET | `/api/notifications` | yes | web |
| GET | `/api/map/markers` | yes | web, mobile |
| POST | `/api/download/info`, `/api/download/archive` | yes | web |
| GET | `/api/dashboard/summary` | yes | accounts-portal |

Not called by anything: `/api/assets/upload-plan`, `/api/assets/{id}/chunk-manifest`,
`/api/assets/{id}/replace-video`, `/api/assets/{id}/view`.
Unreachable, shadowed by earlier matches: `/api/assets/worker-config`.

#### The upload contract

`POST /api/assets`, multipart. Fields: `assetData` (the file), `deviceAssetId`,
`deviceId`, `fileCreatedAt`, `fileModifiedAt`, `isFavorite`, `duration`,
optionally `livePhotoVideoId`, `metadata`, and — iOS background only —
`thumbData_base64`.

The worker computes `base64(SHA-1(plaintext))` itself if the client sends no
checksum. **This is load-bearing**: without it `bulk-upload-check` never matches
and the app re-uploads the entire library on every restart.

Then: 19 MB chunks, each AES-256-GCM encrypted when server-ZKE is on, each
`sendDocument`ed to the user's channel. Never merged — Telegram's download cap
is 20 MB.

Refuses with **503 `encryption_unavailable`** when encryption is configured but
the key material is missing, rather than silently storing plaintext.

### Timeline — `timeline.ts`

| Method | Path | Auth | Callers |
|---|---|---|---|
| GET | `/api/timeline/buckets` | yes | web timeline, iPhone app |
| GET | `/api/timeline/bucket` | yes | web timeline, iPhone app |

Both honour `visibility` as Immich does: a named visibility gives just that
view (`timeline` is the main timeline); no visibility (albums, favourites,
trash) gives timeline and archive; `all` gives everything. Locked and hidden
photos appear only when asked for. A month's count and its contents always
agree, and `order=asc` lists months oldest first. The month contents carry
`duration` as Immich text (`H:MM:SS.ffffff`, what the website reads) and
`durationMs`, whole milliseconds or null (what the apps read); uploads may send
either form. After an edit of `dateTimeOriginal` with an offset, the asset's
`localDateTime` is the wall-clock time, `exifInfo.timeZone` is `UTC±H`, and the
month's `localOffsetHours` carries the offset. `GET /api/assets/{id}` and
search results carry `durationMs` too.

Both accept `albumId`; `personId` and `tagId` are accepted and return **empty**,
never the whole library. Each request also dispatches exactly **one** background
heal job, round-robin — two would exceed the subrequest budget.

### Sync — `sync.ts`

| Method | Path | Auth | Callers |
|---|---|---|---|
| POST | `/api/sync/stream` | yes | **mobile only** |
| POST/DELETE | `/api/sync/ack` | — | mobile — **NOT IMPLEMENTED** |

Newline-delimited JSON. Emits, in order: `UserV1` → dedup-loser
`AssetDeleteV1`s → `AssetV1`s → tombstone `AssetDeleteV1`s → `SyncCompleteV1`.

**This is the most fragile contract in the product.** The mobile client parses it
in a strict isolate; one value of the wrong type throws, the batch is never
acked, and the server replays the same record forever. Backup is gated on sync
succeeding at five separate call sites, so a single bad value stops backup
permanently, on every trigger.

Fields whose type must never drift:

| Field | Must be | Guard in the worker |
|---|---|---|
| `isFavorite`, `isEdited` | `bool` | `!!photo.isFavorite` — an int `1` throws |
| `visibility`, `type` | known enum member | `safeVisibility()` clamps |
| `checksum`, `id`, `ownerId`, `originalFileName` | `String` | fallback chains |
| `profileChangedAt` | parseable date | always `toISOString()` |

The server may **add** fields. It may never remove one or change a type: one app
in the store talks to servers of many ages.

Never emitted, though mobile asks for them: `AlbumV1`, `PartnerV1`, `MemoryV1`,
`StackV1`, `PersonV1`, `AssetFaceV1`, `UserMetadataV1`, `AssetExifV1`.

### Albums — `albums.ts`

`GET`/`POST /api/albums`; `GET`/`PATCH`/`DELETE /api/albums/{id}`;
`PUT`/`DELETE /api/albums/{id}/assets`; `PUT /api/albums/{id}/users`;
`PUT`/`DELETE /api/albums/{id}/user/{userId}`. All authenticated, all called by
web and most by mobile.

Not served, and 404 if called: `PUT /api/albums/assets`,
`GET /api/albums/statistics`, `GET /api/albums/{id}/map-markers`.

### Users — `user.ts`

`GET`/`PUT /api/users/me`; `GET`/`PUT /api/users/me/preferences`;
`PUT`/`POST /api/users/me/onboarding`; `GET /api/users`; `GET /api/users/{id}`.

### Search — `search.ts`

| Method | Path | Auth | Returns |
|---|---|---|---|
| POST | `/api/search/metadata` | yes | real results from D1 |
| GET | `/api/search/suggestions`, `/explore`, `/places`, `/cities` | no | `[]` |
| POST | `/api/search/smart` | no | empty assets envelope |

`/api/search/metadata` takes two shapes. The website sends Immich's older flat
body (`q`, `type`, `isFavorite`, `takenAfter`, ...). The apps send Immich v3.2's
`{ filter, size, orderBy, cursor }`; supported filter fields are `type`,
`visibility`, `isFavorite`, `isMotion`, `trashedAt`, `takenAt`, `createdAt`,
`city`, `country`, `make`, `model`, `lensModel`, `originalFileName`,
`albumIds` and `hasAlbums`, with the operators `eq`, `ne`, `gt`, `gte`, `lt`,
`lte`, `like`, `any` and `all`. `personIds`, `tagIds`, `ocr` and any unknown
field or operator match nothing, never the whole library. Deleted photos come
back only when the filter names `trashedAt`; locked photos and Live Photo video
parts (`hidden`) only when it names a `visibility`. Pages: `size` (max 1000)
and the returned `nextCursor`. A filter with more than 20 fields or an `any` /
`all` list longer than 500 is refused (400).

There is no smart search, no people and no places in the isolated per-user
model. These return empty **shaped** results rather than 404, because a client
that gets an error body crashes on `.length`.

### Drive — `drive.ts` (requires `env.DB`)

`GET`/`POST /api/drive/config`; `GET`/`POST`/`PUT /api/drive/zke`;
`GET`/`POST /api/drive/files` (leaves out Trash; `?trashed=1` lists it, with
`expired` by the worker's clock; `POST` takes an optional
`thumb: {message_id, file_id}`); `PATCH`/`PUT`/`DELETE /api/drive/files/{id}`;
`PATCH` also takes `thumb`; `POST /api/drive/files/{id}/trash`, `/restore`,
`/purge` (`purge` marks the item and everything inside it for deletion, only
from Trash, and returns those rows without any message another row still uses);
409 when the item or its folder is being deleted, or a move would put a folder
inside itself or a missing or hidden folder; `GET /api/drive/config` reports
`driveApi: 1` from release W1 on;
`GET`/`POST`/`DELETE /api/drive/dav`; `GET /api/drive/usage` (uncalled).

Drive encrypts **in the browser** under its own `drive_zke` key, separate from
Photos. The worker stores metadata only and never sees Drive plaintext — except
over WebDAV, where it must decrypt to serve a file manager.

### WebDAV — `webdav.ts`

`/dav` and `/dav/*`. HTTP Basic against a **hashed** token, so any file manager
can mount the Drive. `OPTIONS` is unauthenticated so clients can discover it.

### Infrastructure — `index.ts`

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/api/health` | no | used by the CLI |
| any | `/proxy?url=` | **no** | relays to **exactly** `api.telegram.org` over https on the default port |
| any | `/api/selfhost/status` | yes | update check |
| POST | `/api/admin/link-live-photos` | yes | uncalled |

The proxy exists because the Telegram Bot API sends no CORS headers. It is
locked to one host: an allowlist by suffix is not enough, because `аpi.telegram.org`
with a Cyrillic "а" normalises into the real `telegram.org` zone.

### Everything else — `stubs.ts`

Shaped empty responses for the Immich surface this product does not implement:
people, tags, partners, shared links, sessions, api-keys, jobs, libraries,
memories, duplicates, stacks, workflows, plugins, backups, audit, reports.
`/api/admin*` returns 403. The catch-all returns `{}` with 200 so no client
crashes on an unexpected 404.

---

## The deployment service — `workers/deployment/`

Provisions a per-user worker. Not part of the self-hosted product.

| Method | Path | Auth |
|---|---|---|
| POST | `/deploy-worker` | Firebase ID token |
| POST | `/oauth/cloudflare/exchange` | Firebase ID token |
| POST | `/auto-update` | Firebase ID token |
| POST | `/validate-cf-token` | Firebase ID token |
| POST | `/admin/force-update` | `X-Admin-Secret` |
| POST/DELETE | `/admin/announce` | `X-Admin-Secret` |

`/validate-cf-token` takes a Cloudflare token from the request body and forwards
it to Cloudflare to name the account it belongs to. It **used to be
unauthenticated** — an open validation oracle with `ACAO: *`, one outbound
request per anonymous call. It now requires a Firebase ID token first
(`workers/deployment/src/index.ts:616`), so only a signed-in user (the setup
wizard, its one real caller) can reach it. Fixed in commit `29d61e0`.

## Rules this API is held to

1. **The server may add a field. It may never remove one or change its type.**
   One app build talks to servers of many ages, and mobile aborts all sync on an
   unexpected value.
2. **Never 404 something a client calls.** Return the shape, empty.
3. **Never return an error body where a client expects an array.**
4. **Hosted and self-hosted run the same code.** Divergence is a bug unless it
   is written down in `PARITY.md`.
5. **A route that nothing calls should be deleted, not maintained.**
6. **Anything that can reach plaintext user bytes must be the user's own
   infrastructure.**

Deliberate exceptions, written down: on 2026-11-20 the HEIC processor was
removed, so `/api/server/processor` now answers 404 and `/api/selfhost/status`
no longer has a `processor` field. Nothing current calls or reads either; a
Photos page cached from before treats the 404 as "no processor".
