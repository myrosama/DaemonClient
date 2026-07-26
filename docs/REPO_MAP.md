# What is actually in this repository

Written 2026-07-27 from four read-only surveys — the worker, the CLI and
provisioning, the web apps, the mobile fork — each required to cite file:line
and to answer "does anything call this?" rather than "does this look used?".

**Why it exists.** Four separate fixes in this project were aimed at code that is
never executed: `selfhost/src/deploy.mjs` (zero importers), a `zke-status` field
no client reads, four Cloudflare functions that did not exist, and a warning
written into `selfhost/src/config.mjs`, which nothing writes to disk. Each one
passed review, and two of them passed the four gates. **A plan built on
assumptions produces work that cannot fail a test because it never runs.**

Read this before planning anything. Where it disagrees with `MASTER_PLAN.md`,
this wins.

---

## The shape of the thing

| Piece | Directory | Deployed as | Live? |
|---|---|---|---|
| API worker | `immich-api-shim/` | `immich-api` (shared) + one `dc-<id>` per user | yes |
| Provisioner | `deployment-service/` | `daemonclient-deployment` | yes |
| Telegram CORS relay | `daemonclient-proxy/` | `daemonclient-proxy` | yes |
| Photos web | `immich/web/` | `photos.daemonclient.uz` | yes |
| Drive web | `drive/` | `drive.daemonclient.uz` | yes |
| Accounts / setup | `accounts-portal/` | `accounts.daemonclient.uz` | yes |
| Marketing | `daemonclient-site/` | `daemonclient.uz` | yes |
| Cross-domain session broker | `auth-worker/` | `daemonclient-auth` | yes (hosted only) |
| Mobile | `immich/mobile/` | not released | no |
| Self-host CLI | `selfhost/` | npm bin `daemonclient` | not published |
| HEIC processor | `processor/` | user's own Vercel | manual only |
| Managed Telegram setup | `backend-server/` | Render | hosted only |
| Schema | `schema/schema.mjs` | imported by both provisioners | yes |

### Dead or zombie — do not spend time here
- **`frontend/`** — a hosting target, but every path 301s to Drive
  (`firebase.json:91-97`). The code is deployed and unreachable. It still
  contains the shared-proxy upload path and a hardcoded Firebase config.
- **`landing-page/`, `photos/`, `accounts-portal/landing-page/`,
  `daemonclient-desktop/`** — not hosting targets at all.
- **`selfhost/src/deploy.mjs`, `src/env.mjs`** — zero importers.
- **`selfhost/src/config.mjs`** — only `HOSTILE_ENV_VARS` is imported. Nothing
  ever writes `~/.config/daemonclient/config.env`. The live file is
  `.daemonclient-selfhost.json` via `state.mjs`.
- **`immich-api-shim/src/encryption-service.ts`** — never imported in production.
- **`backend/`** — does not exist. The real one is `backend-server/`.

---

## The mobile app is eight files

This is the single most important correction. `immich/mobile/` is **stock
Immich**: 1167 Dart files, of which **one** carries DaemonClient logic
(`lib/services/background_upload.service.dart`). The rest of the fork is an
app id, a display name, icons, and a default server URL.

**So "fix the mobile app" almost always means "fix the worker's API".** The app
is not broken; the server tells it things it cannot parse, or 404s routes it
calls.

Consequences worth knowing:
- The fork's thumbnail upload (`background_upload.service.dart:266-304`) is
  **unauthenticated** — it uses `getRequestHeaders()`, which returns only
  `customHeaders` (empty by default), and calls top-level `http.post`, which
  never sees the native cookie jar holding the session.
- It only ever runs on **iOS background**. `ForegroundUploadService` — all of
  Android, every foreground and manual upload — sends no thumbnail field at all.
- Nothing in mobile chunks, splits or resumes an upload. One multipart POST per
  asset, and `main.dart:101` configures foreground handling for files **above
  256 MB** against Cloudflare's 100 MB cap. A too-large asset 413s, stays a
  backup candidate forever, and re-fails on every run.

---

## What kills sync, and therefore backup

Backup is gated on sync at **five** call sites — `background_worker.service.dart`
(:112, :132), `app_life_cycle.provider.dart:117`, `splash_screen.page.dart:326`,
`drift_backup.page.dart:95`. If `syncRemote()` returns false, backup does not
run at all. So "sync is broken" and "backup silently stopped" are one incident.

And a sync failure is **permanent, not transient**: acks are sent only after a
batch commits (`sync_stream.service.dart:174`), so a batch that throws is never
acked and the server replays the same record forever. The client-side escape
hatch is dead code — `StoreKey.shouldResetSync` is read and cleared but **never
set to true anywhere in `lib/`**.

**Values that abort all sync if their type is wrong.** These are `!`-asserted in
the generated Dart; a mismatch throws rather than degrading:

| Field | Demands | Note |
|---|---|---|
| `isEdited`, `isFavorite` | `bool` | an int `1` throws — `sync.ts:225` uses `!!` for exactly this reason |
| `visibility`, `type` | enum member | any other string throws — `sync.ts:22-24` clamps |
| `checksum`, `id`, `ownerId`, `originalFileName` | `String` | |
| `profileChangedAt` | parseable date | `mapDateTime(...)!` |
| `quotaUsageInBytes`, `sequence`, `imageWidth/Height` | `int` | a JSON float throws |

And in our own repository code, `sync_stream.repository.dart:312-313` does
`double.tryParse(map['latitude'] as String)` — **if the server ever emits
latitude as a number rather than a string, sync dies.**

`POST /api/sync/ack` is **not implemented**; it falls through to the catch-all
stub returning `{}`. Every ack the client sends is a no-op.

The worker also never emits `AlbumV1`, `PartnerV1`, `MemoryV1`, `StackV1`,
`PersonV1`, `AssetFaceV1` or `UserMetadataV1`, all of which mobile requests.

---

## Module state that outlives a request

Cloudflare reuses isolates, so everything at module scope persists. On a
**per-user** worker this is harmless. On the **shared** `immich-api` worker
(no `env.DB`, many users) it is not:

| State | Bounded? | Holds |
|---|---|---|
| `assets.ts:3197 sendBuckets` | **no eviction** | keyed by **plaintext bot token** |
| `assets.ts:3405 tgQueues` | **no eviction** | keyed by **plaintext bot token** |
| `helpers.ts:62 tokenCache` | **no eviction** | per-user Firebase idTokens |
| `helpers.ts:153 firestoreCache` | capped 5000 | per-user config incl. bot tokens |
| `assets.ts:73 filePathCache` | capped 2000 | fixed 2026-07-27 |

Worse than the memory: **the backfill completion flags are not uid-scoped** —
`exifBackfillComplete`, `heicThumbBackfillComplete`, `checksumBackfillComplete`,
`livePhotoRepairDone`. The first user in an isolate to finish (or to have no
processor configured) suppresses the backfill for **every other user** on that
isolate.

---

## Where plaintext still reaches Telegram

Encryption is gated on `isEncryptedByServer` / `isServerZke`. These paths are
plaintext regardless:

- `assets.ts:851` — the deliberate thumbnail round-trip. **Operator has reviewed
  and accepted this** (finding §18): the original goes up, Telegram thumbnails
  it, the message is deleted immediately.
- `assets.ts:1614` `sendVideo`, `:1620` `sendPhoto`, `:1512`, `:1942`, `:2975` —
  the non-ZKE thumbnail branches.
- `webdav.ts:283` — Drive over WebDAV uploads **plaintext under the real
  filename** when no `drive_zke` config exists.
- `assets.ts:1565` — plaintext HEIC to the user's own `heicConvertUrl`. By
  design; it is the user's own processor.

---

## Duplication — the reason "fix once, both get it" is hard

| Job | Independent implementations |
|---|---|
| Chunked upload to Telegram | **3** — `drive/src/App.jsx`, `frontend/src/App.jsx`, `immich/web/.../daemonclient-drive.ts` |
| Chunk download / reassembly | **6** — the three above plus two service workers and the Photos SW |
| Client-side AES-GCM + PBKDF2 | **4** — `drive/src/crypto.js` and `frontend/src/crypto.js` are byte-identical copies |
| Worker deploy | **2** — `selfhost/src/api/cloudflare.mjs:291` and `deployment-service/src/cloudflare-api.ts:23` |
| ZKE key seeding | **2, and they disagree** — see below |

The two seeders differ in ways that matter: self-host reads before writing and
writes **salt first**; hosted writes **password first**, interpolates values into
SQL rather than binding them, and only runs on a brand-new database, so a hosted
install whose keys are empty has no repair path.

---

## Provisioning: hosted vs self-hosted, where they diverge

Same schema module, different everything else:

| | self-host | hosted |
|---|---|---|
| schema execution | 15 separate statements, errors regex-swallowed | one call, only if new DB |
| workers.dev subdomain | reads it; **never registers one** | auto-claims up to 3 candidates |
| bindings | sets `SELF_HOST`, `EXTERNAL_DOMAIN`, `UPDATE_REPO`, `BUILD_VERSION` | sets `DEPLOYMENT_SERVICE_URL` |
| `compatibility_date` | `2025-11-25` | `2024-09-23` |
| deploy retry on 429 | none | yes |

`BUILD_VERSION` also disagrees with itself: `setup` writes `readVersion()` — and
the root `package.json` has no `version`, so it is `'0.0.0'` — while `update`
writes the git short SHA. `update-check.ts:82` compares that against GitHub
release tags.

---

## Things that are simply broken

| What | Where | Impact |
|---|---|---|
| `POST /api/sync/ack` unimplemented | falls to `stubs.ts:114` | every ack is a no-op |
| `/api/assets/worker-config` unreachable | shadowed by `assets.ts:416` | dead route |
| `/api/assets/{id}/ocr` in assets.ts unreachable | shadowed by `index.ts:166` | duplicate |
| `status`'s update check | `status.mjs:71` sends no auth | always 401 → always prints "sign in" |
| `sessionSecret` cleartext in Firestore | `deployment-service/src/index.ts:230` | finding §22 |
| `drive_zke` password cleartext in D1 | verified live | auto-mode trade-off, now behind the owner gate |

Fixed on 2026-07-26: schema replay (`update` was broken on every install), six
404ing search routes, onboarding PUT, `filePathCache` growth, 19 MB `waitUntil`
copies, Telegram path expiry, the open relay, bot-token logging, the owner gate,
and `/validate-cf-token` — which now requires a Firebase ID token
(`deployment-service/src/index.ts:616`), so it is no longer the open oracle older
notes describe.

Fixed on 2026-07-27 (this session): the processor deploy — the CLI and
`docs/SELF_HOSTING.md` no longer point at a non-existent `render.yaml`; they
deploy the real Vercel function (`processor/`), which runs on Vercel's Node.js
runtime because the libheif WASM bundle exceeds the Edge size cap. Dead code
(`daemonclient-immich-bridge/`, `local-server/`) removed, and the shim now
typechecks clean.

---

## Verified against production

Queried the operator's own D1 directly:

```
photos 1485 | no_checksum 0 | trashed 103 | encrypted 1485 | plaintext 0
owner_uid   OzkV3fuZU6WEjhjk96Ou2Tv0Uqj1   (claimed correctly by the new gate)
zke_password set (44 chars)  zke_salt set (24 chars)
```

Encryption is genuinely working on the hosted install, every asset, and the
checksum backfill has completed. Phase 1's premise — that installs can silently
store plaintext — is real but did **not** affect this one.

---

## The rule this document exists to enforce

Before implementing anything: **grep the callers.** If nothing calls it, fixing
it changes nothing, and no test will tell you. Write down who calls it in the
task, or do not start the task.
