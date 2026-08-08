# How DaemonClient works

This is the long answer. It covers what each piece is, how a byte gets from
your camera roll into Telegram and back, what is encrypted and by whom, why the
code looks the way it does, and where the design's sharp edges are.

If you only want to run it, read [SELF_HOSTING.md](SELF_HOSTING.md) instead.

---

## The one-paragraph version

Every user gets **their own** Cloudflare Worker, **their own** D1 database, and
**their own** Telegram bot and private channel. Files are split into 19 MB
chunks, AES-256-GCM encrypted, and sent to that channel as documents. D1 stores
only an index: filenames, sizes, EXIF, and the list of Telegram `file_id`s that
reassemble each file. There is no shared file server and no operator database
holding anyone's photos. The whole thing fits inside free tiers because
Cloudflare never touches most of the bytes — the browser talks to Telegram
directly.

---

## The parts

| Directory | Deployed as | What it is |
|---|---|---|
| `immich-api-shim/` | one Worker per user (`dc-<id>`), plus one shared `immich-api` | The entire API. Uploads, timeline, albums, sync, Drive, WebDAV, background repair. |
| `deployment-service/` | `daemonclient-deployment` Worker | Managed-service only. Provisions a user's Worker + D1 on **their** Cloudflare account and ships them updates. |
| `selfhost/` | npm bin `daemonclient` | The self-hosting CLI. Does what the deployment service does, on your own machine, with no operator involvement. |
| `accounts-portal/` | `accounts.daemonclient.uz` | Sign-up, the guided setup wizard, the dashboard. |
| `auth-worker/` | `auth.daemonclient.uz` | Managed-service only. Issues the cross-subdomain cookie that makes one sign-in serve all three apps. |
| `immich/web/` | `photos.daemonclient.uz` | The Photos app — a fork of [Immich](https://github.com/immich-app/immich)'s SvelteKit frontend. |
| `immich/mobile/` | not released | The mobile fork. Eight changed files over stock Immich. Not currently being worked on. |
| `drive/` | `drive.daemonclient.uz` | The Drive app. Not a fork — a standalone React SPA. |
| `daemonclient-proxy/` | `daemonclient-proxy` Worker | A CORS relay for `api.telegram.org`, which sends no CORS headers of its own. |
| `processor/` | the user's own Vercel | One stateless function that converts HEIC to a thumbnail. Optional. |
| `daemonclient-site/` | `daemonclient.uz` | The marketing page. Static HTML. |
| `docs-site/` | `docs.daemonclient.uz` | This documentation, as a site. |
| `schema/` | imported, not deployed | The D1 schema. One definition, shared by both provisioners. |
| `hosting/app-redirect/` | `app.daemonclient.uz` | A retired address that 301s to Drive. |

Two things are worth noticing in that table.

**`immich-api-shim` is deployed twice from one source tree.** As `dc-<id>` it
has a `DB` binding and is a complete API for exactly one person. As the shared
`immich-api` it has no `DB` binding at all, and its only jobs are to validate a
login against Firebase and tell the client which per-user Worker to talk to.
`env.DB` being present or absent changes behaviour in roughly forty places;
that is the only switch.

**`deployment-service` and `selfhost` are the same job twice**, because they
must be. The managed service holds a user's Cloudflare token and can push; a
self-hoster runs the CLI and pulls. An install we could reach into would not be
self-hosted.

---

## The storage primitive

Everything else is built on this, so it is worth getting exact.

### Why 19 MB

Telegram's Bot API will not let a bot *download* a file larger than 20 MB.
Uploads can be bigger, which is a trap: you can happily send a 60 MB document
and then discover you can never fetch it back. So files are split at
**19 MB of plaintext** before anything else happens, and chunks are never
merged. The constant lives in `immich-api-shim/src/contracts.ts` as
`DEFAULT_CHUNK_SIZE`.

### What one upload actually produces

A single photo becomes up to **four** stored artefacts, which surprises people:

| Artefact | Where it lives | What it is for |
|---|---|---|
| `thumbhash` | a column in D1 | ~25 bytes. The blurred placeholder the timeline paints instantly, before any network request. |
| `telegramThumbId` | one Telegram message | The small thumbnail Telegram generates for you, free. |
| `telegramPreviewId` | one Telegram message | A larger preview for the detail view. |
| `telegramChunks` | N Telegram messages | The actual file, as a JSON array of `{index, message_id, file_id}`. |

The reason for the first three is CPU, not storage. Generating a thumbnail from
a 40 MB original inside a Worker is not possible on the free plan — so either
the browser does it before upload, or Telegram does it as a side effect of
accepting the file.

### The write path

```
browser                          worker                    Telegram
   │
   ├─ read file, slice at 19 MB
   ├─ derive key (PBKDF2, 100k iterations, SHA-256)
   ├─ encrypt each chunk (AES-256-GCM, fresh 12-byte IV, prepended)
   ├──────── chunk bytes ──────────────────────────────────────▶ sendDocument
   │                                                            ◀ file_id
   ├─ POST /api/assets  (metadata + the file_id list, no bytes) ─▶
   │                                    ├─ SHA-1 the upload
   │                                    ├─ INSERT INTO photos
   │                                    └─ 201
```

On the web the browser does the chunking and encryption itself and the Worker
never sees a byte of the file — the request carries `clientUpload: 'true'` and
a list of `file_id`s. The mobile app posts the whole file to the Worker
instead, which does the same work server-side.

`checksum` is `base64(SHA-1(plaintext))` and it is load-bearing: without it,
`POST /api/assets/bulk-upload-check` never matches and the app re-uploads your
entire library every time it restarts.

### The read path

The trick that makes this free: **the browser reads from Telegram directly.**

A service worker in the Photos app intercepts requests matching

```js
/^\/api\/assets\/[a-f0-9-]+\/(original|thumbnail|video\/playback)/
```

and, instead of letting them reach the Worker, calls
`GET /api/assets/{id}/dc-manifest` — a tiny JSON document listing the
`file_id`s — then fetches those chunks from Telegram through the CORS relay and
decrypts them locally.

For video it does this **range-bounded**: an HTTP `Range` request is mapped to
the specific chunks that cover those bytes, so scrubbing to the middle of a 2 GB
file fetches two chunks, not two thousand. The Worker is never in the byte path
at all.

This is also the answer to a question people ask about the free tier: 100,000
Worker requests a day sounds tight for a photo library, and it would be, if
every thumbnail cost a request. They cost a Telegram request instead.

---

## Encryption

There are three modes, and they protect against different things. Being honest
about which is which matters more than the marketing line.

| Mode | Where the key lives | Who can read plaintext | Used by |
|---|---|---|---|
| **Client-side (ZKE)** | derived in your browser, never transmitted | only your browser | Drive, and web uploads to Photos |
| **Server-side** | `zke_password` + `zke_salt` rows in **your own** D1 | your own Worker, transiently | mobile uploads to Photos |
| **Off** | — | anyone with the channel | never, by default |

Server-side mode is a deliberate trade. It is what allows the Worker to compute
a checksum, extract EXIF, and generate a thumbnail — things a zero-knowledge
server cannot do by definition. The mitigation is that "the server" is a Worker
that serves exactly one person and runs on that person's own Cloudflare account.
It is not a shared machine, and on a self-hosted install it is not our machine
at all.

Key derivation is PBKDF2-SHA256, 100,000 iterations, producing an AES-256-GCM
key. Each chunk gets a fresh 12-byte IV, prepended to the ciphertext.

**An install with encryption enabled and no key refuses uploads** rather than
silently storing plaintext. This was not always true — see the note in
[SELF_HOSTING.md](SELF_HOSTING.md#if-you-set-this-up-before-27-july-2026) about
installs created before 27 July 2026.

Places where plaintext still reaches Telegram, stated plainly:

- The thumbnail round-trip. The original goes up so Telegram will thumbnail it,
  and the message is deleted immediately afterwards. Reviewed and accepted.
- WebDAV uploads to Drive when no `drive_zke` config exists.
- HEIC sent to the media processor — which is the user's own deployment, pinned
  to their own uid.

---

## Authentication

### Two credential shapes

`requireAuth` (`immich-api-shim/src/helpers.ts`) accepts exactly two things,
told apart by counting dots:

- **Three parts** → a Firebase ID token. Verified RS256 against Google's public
  certs, with `aud`, `iss` and `exp` all pinned.
- **Two parts** → one of our own session tokens: `base64(payload).hmac`, signed
  with that install's own `SESSION_SECRET`.

A token with no dot at all is rejected. That is not a stylistic check: there
used to be a fallback that base64-decoded such tokens and trusted the result,
and since "contains no dot" is a property of the attacker's own input, it was a
complete authentication bypass.

Session payloads are signed, **not encrypted** — they carry `uid`, `email`, the
Firebase tokens and the user's `workerUrl`. Signing with the install's own
secret means a session minted for one Worker does not verify on another.

### The owner gate

One install, one owner. The first authenticated caller claims `owner_uid`, and
after that everyone else is a stranger — enforced inside `requireAuth`, not per
route, so a route added next year is covered by default.

The Firebase branch passes `mayClaim = false`. This is load-bearing: one
Firebase project serves the entire managed fleet, so a Firebase ID token
verifies on *every* Worker. Without that flag, any signed-in user could
permanently seize any unclaimed install by being the first to call it.

### One sign-in, three apps

Firebase persists its session per origin, so signing in at
`accounts.daemonclient.uz` leaves Photos and Drive looking signed-out. The fix
is a small dance:

```
accounts.daemonclient.uz  ──POST /create-session──▶  auth.daemonclient.uz
                                                      sets __session cookie
                                                      on .daemonclient.uz
photos.daemonclient.uz    ──GET /session-token───▶  auth-worker
                          ◀── fresh Firebase ID token (never the refresh token)
                          ──POST /api/auth/exchange──▶ their own worker
                          ◀── that worker's session token
```

The refresh token stays in an HttpOnly cookie and never crosses into
JavaScript. `/session-token` mints a *fresh* ID token each time rather than
returning the stored one, because the stored copy expires after an hour while
the shared session is long-lived — returning it would work for an hour and then
mysteriously stop.

This applies to the managed service only. A self-hosted install has no
auth-worker; it signs in against its own Firebase project directly.

---

## The database

One D1 database per user. Five tables, defined once in `schema/schema.mjs` and
imported by both provisioners — they used to be defined three times, which is
exactly how managed and self-hosted installs came to disagree about whether
encryption keys had been seeded.

| Table | Holds |
|---|---|
| `photos` | the asset index: filenames, sizes, EXIF, GPS, thumbhash, and the Telegram id lists |
| `albums`, `album_assets` | albums and their membership |
| `config` | install settings, including `zke_mode`, `zke_password`, `zke_salt` |
| `upload_sessions` | in-flight multi-chunk uploads |
| `files` | Drive's tree — added in schema 1.2.0 |

Two rules the seed depends on. It is `INSERT OR IGNORE`, never `OR REPLACE`,
because the seeded key rows are **empty strings** and replacing a live
`zke_password` with `''` would make every photo already in the channel
permanently undecryptable. And it must be replayable, because
`daemonclient update` runs it on every invocation.

---

## The constraints that explain the odd code

Most of what looks over-engineered here is one of these. All figures are the
Cloudflare Workers **free** plan, from
[their limits page](https://developers.cloudflare.com/workers/platform/limits/).

| Limit | Value | What it forces |
|---|---|---|
| CPU time | **10 ms** per invocation | No image decoding, no video transcoding, no large buffers. HEIC goes to `processor/`. |
| Memory | 128 MB | Responses stream; never more than about two chunks are held at once. |
| Subrequests | **50** external per invocation | A 50-chunk file is already at the ceiling. Background repair jobs run **one per request**, round-robin — two together would blow the budget. |
| Requests | 100,000/day | Why bytes go browser↔Telegram directly instead of through the Worker. |
| Request body | 100 MB | The reason a >100 MB video cannot be uploaded from mobile today. |
| Worker size | 3 MB | The bundle is watched. |

Exceeding CPU or memory does not degrade gracefully — Cloudflare kills the
invocation with **error 1102** and returns an error page with no CORS headers,
so the browser reports it as a CORS failure. If you are staring at an
inexplicable CORS error, check for 1102 first.

And one more, from Telegram: **the bot download cap is 20 MB**, which is where
19 MB chunking comes from and why chunks are never merged.

---

## Managed vs self-hosted

Same code. `SELF_HOST=1` and a different set of accounts.

The product code — upload, sync, thumbnails, albums, EXIF, live photos, Drive,
WebDAV, background repair — does not branch on deployment mode anywhere. Five
places in the whole Worker differ, and all five are plumbing:

| Where | Difference | Why it has to exist |
|---|---|---|
| `helpers.ts` `requireAuth` | self-host returns after the signature check | there is no Firebase refresh token to refresh |
| `helpers.ts` `firestoreGet` | returns null instead of calling Google | config lives in their own D1 |
| `server.ts` `serverConfig` | `externalDomain` from their address | never hand a self-hoster our domain |
| `assets.ts` `webAppOrigin` | same, for a user-facing message | same reason |
| `index.ts` status | reports `self-hosted` vs `managed` | a label |

A sixth divergence is a bug unless it is written down in
[PARITY.md](PARITY.md).

### How updates reach people

```
                 one commit, one release
                            │
            ┌───────────────┴───────────────┐
            ▼                               ▼
       MANAGED                         SELF-HOSTED
       we push                         they pull
       deployment-service redeploys    the worker sees a newer release tag,
       the user's worker on their      shows a note, and `daemonclient update`
       next login (no user action)     applies it on their schedule
```

The asymmetry is deliberate and cannot be removed. We hold managed users'
Cloudflare credentials, so we can push. We do not hold a self-hoster's, so we
cannot — and an install we *could* push to would not be self-hosted. What a
self-hoster is owed is that the update exists, is visible, and is one command.

The self-hosted update check is an anonymous GET to GitHub's public releases
feed. It sends nothing about the install and stops entirely if `UPDATE_REPO` is
cleared.

---

## Known sharp edges

Things a new contributor will otherwise discover the hard way.

**The storage primitive is implemented four times.** `assets.ts`, `webdav.ts`,
`drive/src/App.jsx`, and `immich/web/.../daemonclient-drive.ts` each chunk,
encrypt and upload independently, and `19 * 1024 * 1024` is written out in at
least five files. A bug in chunking has to be fixed in four places, correctly,
every time. This is the single biggest obstacle to "fix once, everyone gets it"
and the most valuable refactor available.

**The mobile sync stream is brittle by construction.** The Dart client parses
it in a strict isolate: one value of an unexpected type throws, the batch is
never acked, and the server replays the same record forever. Backup is gated on
sync succeeding at five separate call sites, so a single bad value stops backup
permanently, on every trigger. `sync.ts` uses `!!x` for booleans and clamps
enums for exactly this reason. Anything it emits needs a test.

**`POST /api/sync/ack` is not implemented.** It falls through to a catch-all
stub returning `{}`, so every ack the client sends is a no-op.

**Module scope outlives a request.** Cloudflare reuses isolates. On a per-user
Worker that is harmless caching. On the shared `immich-api` Worker it is not,
and several caches there are keyed by bot token with no eviction.

**Videos over 100 MB cannot be uploaded from mobile.** That is Cloudflare's
request-body cap. The fix is chunked upload in the app, which is not built.

**HEIC has no thumbnail without a processor.** Workers cannot decode HEIC —
libheif needs far more CPU than an invocation gets — and Telegram will not
thumbnail HEIC the way it does everything else. Every other format, video
included, is unaffected.

---

## Where to go next

| | |
|---|---|
| [API.md](API.md) | every route, its auth, and what actually calls it |
| [openapi.yaml](openapi.yaml) | the same thing machine-readable |
| [PARITY.md](PARITY.md) | the managed/self-hosted contract in detail |
| [SELF_HOSTING.md](SELF_HOSTING.md) | running it yourself |
| [../CONTRIBUTING.md](../CONTRIBUTING.md) | house style and the four constraints |
| [../SECURITY.md](../SECURITY.md) | the security model and how to report a finding |
