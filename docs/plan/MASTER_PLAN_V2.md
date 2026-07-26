# Master plan, second edition

**Supersedes `MASTER_PLAN.md`.** That plan was written from assumptions about the
code. Four of its tasks were aimed at things that are never executed, and two of
those passed all four gates before anyone noticed. This one is written against
`REPO_MAP.md` and `../API.md`, both of which were produced by reading the code
and checking every claim for a caller.

**The rule that changes everything:** a task does not start until its
*"who calls this?"* line is filled in. If nothing calls it, fixing it changes
nothing and no test will say so.

---

## What we are building

One product, two ways to run it, and the self-hosted way depends on nothing the
operator owns.

Someone clones the repo, runs one command, and ends up with a working photo and
file cloud on **their** accounts: their Telegram bot and channel as storage,
their Cloudflare Worker and D1, their Firebase for login, their serverless
function for HEIC thumbnails. If the operator disappears, their install keeps
working.

The hosted service is the **same software**. Fix once, both get it. Hosted is
pushed to; self-hosted pulls from GitHub.

**Constraints, all non-negotiable:** free tiers are the product · Telegram is the
storage layer, R2/S3 rejected · fully serverless, no containers · one storage per
user, multi-user is not being built · the mobile app aborts sync permanently on
one unexpected value · free-tier Workers get 50 external subrequests, 128 MB, and
a small CPU slice shared with everything `waitUntil` spawns.

---

## Where we actually are

Shipped and verified live since this work began: encryption fails closed ·
`zke-status` tells the truth · the encryption toggle is gone · one schema module
· real keys seeded at setup · the SQL-injection route deleted and the class
closed · the owner gate · isolate memory bounded · Telegram path expiry honest ·
the open relay closed · the bot token out of the logs · `daemonclient update`
un-broken · six 404ing endpoints fixed · security headers on every origin.

Verified against production D1: **1485 photos, all encrypted, no missing
checksums, `owner_uid` correctly claimed.**

---

## Phase 0 — The API contract

**Why first:** this phase did not exist in the previous plan, and it is where the
bugs users actually hit live. The mobile app is eight changed files; it is not
broken. The server 404s routes it calls and emits values it cannot parse.

### 0.1 — Implement `POST /api/sync/ack`
- **Who calls it:** mobile, after every batch — `sync_api.repository.dart:21,25`.
- **Now:** falls through to the catch-all stub returning `{}` 200. Every ack is a
  no-op, so the server has no idea what the client has stored.
- **Do:** accept and persist the ack cursor per user; use it to resume rather
  than replaying from zero.
- **Verify:** a client that acks and reconnects does not receive what it acked.
- **Risk:** medium — changes what the stream emits on reconnect.

### 0.2 — Make one poison record unable to kill sync forever
- **Who calls it:** every mobile sync.
- **Now:** a value of the wrong type throws in a strict Dart isolate, the batch
  is never acked, and the server replays the same record forever. The client's
  own escape hatch (`StoreKey.shouldResetSync`) is **dead code** — read and
  cleared, never set anywhere in `lib/`.
- **Do:** server side, assert the emitted types at the boundary — the guards that
  exist (`!!isFavorite`, `safeVisibility`) prove the shape of the danger; extend
  them to every `!`-asserted field listed in `API.md`. Add a test that feeds the
  emitter a hostile row (int where bool expected, unknown visibility, null
  checksum) and asserts the stream stays parseable.
- **Do also:** give the client a way out — a server-signalled reset already
  exists (`SyncResetV1`, `syncResetEpoch`); make sure bumping the epoch actually
  recovers a wedged install.
- **Verify:** a deliberately corrupt row does not stop the stream.
- **Risk:** high. This is the mechanism behind "sync failed, backup stopped".

### 0.3 — Audit every route against its callers, delete the dead ones
- **Do:** `/api/assets/upload-plan`, `/api/assets/{id}/chunk-manifest`,
  `/api/assets/{id}/replace-video`, `/api/assets/{id}/view`,
  `/api/assets/worker-config` (unreachable), the duplicate `ocr` branch,
  `/api/admin/link-live-photos`, the six `/api/policy/*` routes.
- **Verify:** a test asserts every path in `API.md` is reachable and every
  reachable path is in `API.md`. That test is what stops this drifting again.
- **Risk:** low. Deleting a route nothing calls cannot break a caller.

### 0.4 — Serve what mobile asks for, or say so
- **Now:** the worker never emits `AlbumV1`, `PartnerV1`, `MemoryV1`, `StackV1`,
  `PersonV1`, `AssetFaceV1`, `UserMetadataV1`.
- **Do:** decide per type — emit an empty set so the client stops asking, or
  document it as unsupported. Silence is the one option that costs a round trip
  every sync.
- **Risk:** low.

---

## Phase 1 — Complete

1.1 fail closed · 1.2 honest status · 1.2b one schema · 1.3 real keys · 1.4 the
fake key deleted · 1.5 the recovery note. All shipped, deployed and verified.

---

## Phase 2 — The remaining exposure

### 2.5 — Make sessions revocable
`handleLogout` runs **before any auth check** (`auth.ts:38`), so giving it the
power to bump a global epoch would hand any anonymous caller a repeatable
sign-out of the whole install. `requireAuth` first, then the bump.

### 2.6 — Delete the public-constant signing fallback
**Two** fallbacks: the verifier at `selfhost-auth.ts:44` and the issuer at
`auth.ts:96`, the latter fed by a Firestore read inside a bare `catch {}`.
Removing one without the other mints tokens the fleet rejects. Gated on
confirming every hosted worker has a `SESSION_SECRET` — checked with
`wrangler secret list`, not promised.

### 2.7 — Give self-host the same silent refresh hosted has
30-day TTL both flavours. Mobile backup runs in the background, so an expired
session does not prompt — it silently stops backing up.

### 2.8 — Encrypt `sessionSecret` at rest *(new — finding §22)*
It sits in Firestore in **cleartext** beside a `refreshToken` that is encrypted.
Since the session payload is unencrypted base64 carrying the Firebase refresh
token, anyone with a session token can mint idTokens forever, read that
document, take the signing secret, and forge sessions permanently. Encrypt it
with the function already next to it, and stop putting the refresh token in the
payload.

### 2.9 — Stop the shared worker hoarding other people's secrets *(new)*
- **Who calls it:** every request to `immich-api`.
- **Now:** `sendBuckets` and `tgQueues` are keyed by **plaintext bot token** with
  no eviction; `tokenCache` holds per-user Firebase tokens unbounded. On a
  per-user worker this is nothing. On the shared one it is a growing pile of
  live credentials in isolate memory.
- **Do:** key by a hash, cap the maps, evict on idle.
- **Risk:** low.

### 2.10 — uid-scope the backfill flags *(new)*
`exifBackfillComplete`, `heicThumbBackfillComplete`, `checksumBackfillComplete`
and `livePhotoRepairDone` are global. The first user in an isolate to finish — or
to simply have no processor configured — suppresses the backfill for **everyone
else** on that isolate.

### 2.11 — Close `/validate-cf-token` *(new)*
Unauthenticated, `ACAO: *`, forwards an attacker-supplied Cloudflare token to
Cloudflare on every call.

*Dropped: 2.0 (per-row owner filters) and 2.3 (gutting the config endpoints).
The owner gate covers 2.0; 2.3 was reversed by two independent reviews.*

---

## Phase 3 — Budget

3.0, 3.3, 3.4, 3.7 shipped. Remaining:

### 3.1 — One subrequest counter, counting the right budget
Free-tier Workers get **50 external** subrequests **and 1,000** to Cloudflare
services. D1 is on the second. Counting D1 against the 50 makes the worker
refuse work it can afford.

### 3.2 — Closed as already-fixed
Half shipped in April; the other half — capping chunks per response — would
reintroduce the truncated-206 bug that froze mobile video playback.

### 3.5 / 3.6 / 3.8 — Backpressure, thumbnail guard, early dedup. Unchanged.

---

## Phase 4 — Make self-hosting real

### 4.0 — Atomic config write
`state.mjs` truncates in place with no temp file and no fsync.

### 4.1 — Delete the dead modules
`deploy.mjs`, `env.mjs`, and the unreachable parts of `config.mjs` — **the file
my own task-1.4 warning was written into.** Fourth instance of the trap.

### 4.2 — Refuse to run when the environment will sabotage it
A `.env` in the working directory silently overrides a browser sign-in.

### 4.3 — Rewrite `setup` as probe / repair / verify
Every credential checked against the real service, with an error that names the
missing permission.

### 4.4 — `doctor` is setup in read-only mode. Mostly done; reconcile.

### 4.5 — Firebase automation.

### 4.6 — **Make the processor deploy real** *(rewritten)*
The CLI and `docs/SELF_HOSTING.md` tell users to click a Render button backed by
`processor/render.yaml` — **which does not exist**. Only Vercel is real, and only
by hand. Ship a genuine one-click path, fix the false documentation, and stop
reporting a `videoPoster` capability the processor never advertises.

### 4.7 — Register a workers.dev subdomain when the account has none
Hosted auto-claims one; self-host reads it, finds none, and gives up — leaving
`workerUrl` null and the dashboard build broken.

### 4.8 — Headless and busy-port handling.
### 4.8b — De-hardcode the web apps. `drive/src/api.js:14` points login at the operator's worker with no override.
### 4.8c — Deploy the web apps from the CLI.
### 4.9 — Pin the toolchain.

### 4.10 — Collapse the duplicated implementations *(new)*
Three independent Telegram upload paths, six download paths, four copies of the
same AES-GCM + PBKDF2 code — two of them byte-identical files. Parity cannot be
enforced across six copies; a fix lands in one and the others rot.

---

## Phase 5 — Prove it

5.1 real setup on throwaway accounts (operator creates them, I drive) · 5.2 fix
what it finds · 5.3 CI proves both flavours from every commit · 5.4 one release,
both destinations · 5.5 **update the hosted fleet on a schedule** — today it
fires only when someone loads the accounts portal, which is why workers drift ·
5.6 self-hosted installs notice updates via a cron on their **own** worker and a
message through their **own** bot.

### 5.7 — Mobile: fix the thumbnail upload *(new)*
It is **unauthenticated** (`getRequestHeaders()` returns only `customHeaders`,
empty by default, and top-level `http.post` never sees the native cookie jar),
sends form-encoded rather than JSON, generates the thumbnail twice, and only
runs on iOS background — **Android never sends one at all.**

### 5.8 — Mobile: handle files over 100 MB honestly *(new)*
`main.dart:101` configures foreground handling for files above **256 MB** against
Cloudflare's 100 MB cap. A too-large asset 413s, stays a backup candidate
forever, and re-fails every run. At minimum, detect and report it instead of
retrying into a wall.

---

## Phase 6 — Documentation

6.1 README · 6.2 the docs site (**Astro Starlight**) · 6.3 self-hosting guide ·
6.4 architecture and API reference — **`docs/API.md` now exists and is the
source** · 6.5 repository cleanup, including the zombie `frontend/` and the four
dead frontend directories, into a **separate private archive repo**.

---

## Order of work

1. **Phase 0** — what users hit today.
2. **Phase 2.8–2.11** — the exposure the survey found.
3. **Phase 3.1** — correct budget accounting.
4. **Phase 4** — self-hosting, the actual feature.
5. **Phase 5** — prove it, including the two mobile fixes.
6. **Phase 6** — write it down.

Every task: gates 1–4, deploy, commit, **push**, tick the phase doc. One task per
commit, so a bad one can be reverted alone.

---

## Only the operator can do these

- **Scrub the git history.** Three Firebase admin keys, a Telethon session and
  live bot tokens are still retrievable from a public repo.
- **Rotate the Cloudflare token and R2 keys** shared in chat on 2026-07-27.
- Confirm every hosted worker has a `SESSION_SECRET` — gates 2.6.
- `www.daemonclient.uz` does not resolve.
- Create throwaway accounts for 5.1.
