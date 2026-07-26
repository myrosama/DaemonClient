# Master plan

**Status: awaiting approval. Nothing here has been implemented.**

## What this achieves

Four things the operator asked for: a self-hostable DaemonClient that depends on
nothing we run, a mobile app that works, a repository outsiders can contribute
to, and documentation worth reading — with security intact throughout.

The order is not arbitrary. Phase 1 fixes a bug that is silently storing
people's photos in plaintext right now; nothing else matters until that stops.
Phase 2 closes the remaining ways an account can be taken over. Phase 3 makes
the worker survive its own free-tier budget. Only then do we finish the
self-hosting path, and only then the documentation that describes it — because
documenting something still being rewritten wastes the writing.

## How to read this

Phases run in order. Tasks inside a phase may run in any order unless a
**Depends on** says otherwise.

Every task passes **four gates** before it is committed (see `GATES.md`). Each
task lists its own verification — the actual command, not "run the tests".

The backlog behind these tasks is `FINDINGS.md`, where every item was confirmed
against the code with file and line numbers. `PARITY.md` states the requirement
that hosted and self-hosted stay one product.

---

# Phase 1 — Stop storing photos in plaintext

**Goal:** encryption is either genuinely happening or the upload is refused, and
no endpoint can claim otherwise.

**Why first:** self-hosted installs are writing unencrypted photos to Telegram
under their real filenames *and reporting themselves as encrypted*
(`FINDINGS.md` §1). Every photo uploaded before this lands is already in the
clear and cannot be retroactively protected. Nothing else in this plan is worth
doing first.

### Task 1.1 — Make encryption fail closed
- **What:** when ZKE is enabled but the key material is missing, refuse the
  upload instead of silently writing plaintext.
- **Files:** `immich-api-shim/src/assets.ts` (`getEncryptionKey`, ~173-187; the
  call site at ~1063).
- **How:** `getEncryptionKey` currently returns `null` for both "encryption is
  off" and "encryption is on but broken", and the caller treats them the same.
  Separate them: return `null` only when `zke_mode` is `off`; throw a typed
  error when `enabled` is true and `password`/`salt` are empty. `handleUpload`
  turns that into a clear 5xx naming the fix, rather than a successful upload.
- **Verify:** new `src/zke-failclosed.test.ts` — with `{enabled:1, password:'',
  salt:''}` the upload path rejects and writes nothing; with real key material
  it encrypts; with `mode:'off'` it stores plaintext deliberately and says so.
- **Risk:** medium — a wrong turn here blocks uploads for working installs, so
  the "off" case must stay working.

### Task 1.2 — Stop `zke-status` claiming encryption that is not happening
- **What:** derive `enabled` from whether key material actually exists.
- **Files:** `immich-api-shim/src/assets.ts` (~236).
- **How:** `enabled: !!(cfg.password && cfg.salt) && cfg.enabled`. One line, but
  it is the line that made the original bug invisible.
- **Verify:** same test file — empty key material reports `enabled:false`.
- **Depends on:** 1.1
- **Risk:** low

### Task 1.2b — Unify the schema source
- **What:** one definition of the database schema, imported by both provisioning
  paths.
- **Files:** `deployment-service/src/index.ts`, `selfhost/src/deploy.mjs`,
  `immich-api-shim/src/migrations.ts`.
- **How:** the review pointed out that Phase 1 as drafted fixes the symptom
  rather than the shape. The CLI *regex-scrapes* `MIGRATION_SQL` out of the
  deployment service's TypeScript, and `migrations.ts` holds a second, unrun
  copy. That separation is precisely what produced the plaintext bug, and it
  will produce the next one. Extract the schema to a single module both import.
  Doing this before 1.3 also stops Task 6.5's directory cleanup from breaking
  self-host setup, which currently depends on that file's text.
- **Verify:** `selfhost/test/schema-source.test.mjs` — the CLI and the
  deployment service produce byte-identical SQL; no regex scraping remains.
- **Depends on:** none
- **Risk:** medium — both provisioning paths must keep working.

### Task 1.3 — Seed real keys during self-host setup
- **What:** generate salt and password and write them, matching what the hosted
  provisioner does.
- **Files:** `selfhost/src/commands/setup.mjs` (the existing D1 REST pattern is
  at `setup.mjs:441-449`), `selfhost/src/api/cloudflare.mjs` (`queryD1`,
  `:228-232`).
  **Not `selfhost/src/deploy.mjs`.** The review caught that the plan pointed
  here and `deploy.mjs` has **zero importers** — verified: nothing in `src/` or
  `test/` imports it, while `build.mjs` is imported by `setup.mjs:23` and
  `update.mjs:17`. The fix would have been written, its unit test against a fake
  D1 would have passed, all four gates would have gone green, and a real
  `daemonclient setup` would still leave `zke_password` empty. The plaintext bug
  Phase 1 exists to fix would have survived Phase 1.
- **How:** after the schema runs, `SELECT value FROM config WHERE key =
  'zke_password'`. **Only if empty**, generate 16-byte salt and 32-byte password
  and UPDATE both. The emptiness check is what stops a re-run from rotating keys
  and orphaning every existing photo. Do it over REST with bound parameters.
  Distinguish a **failed** query from an empty result — the review's point is
  that treating a network error as "no key yet" rotates a live key and orphans
  every photo already stored. A failed read aborts; only a successful read
  returning nothing seeds.
- **Verify:** `selfhost/test/zke-seed.test.mjs` — a fake D1 with empty keys gets
  written once; a second run leaves the existing values untouched; **a query
  that throws or returns an error writes nothing at all**. Then the end-to-end
  assertion the dead-module mistake could not have passed: after seeding, read
  `zke_password` back over REST against a real D1 and assert it is non-empty.
- **Also:** seed from `update` and `doctor`, not just `setup`. Existing
  self-hosted installs already have empty keys, and after 1.1 their worker will
  refuse uploads — they need a path to fix it that is not "run setup again from
  scratch".
- **Depends on:** 1.1, 1.2b
- **Risk:** high — rotating an existing key destroys access to stored photos.
  The idempotency check gets its own test.

### Task 1.4 — Remove the encryption key that encrypts nothing
- **What:** delete `ENCRYPTION_MASTER_KEY` from the shim and `STORAGE_KEY` from
  the CLI, or wire them to something real.
- **Files:** `immich-api-shim/src/index.ts` (~94), `selfhost/src/config.mjs`,
  `selfhost/src/commands/setup.mjs` (`:389`, `:421-422`),
  `selfhost/src/commands/update.mjs` (`:116-117`), `selfhost/src/state.mjs`
  (`:15-21`). **Again not `deploy.mjs`** — the live `secret_text` binding is
  written from `setup.mjs` and `update.mjs`; `deploy.mjs:76-82` is dead.
- **How:** the shim never reads it (grep confirms the declaration is the only
  hit). The CLI generates it, calls it "File encryption key" to the user, and
  warns that losing it loses their files. Delete it. The real key material is
  the `zke_*` config rows from 1.3, and the backup warning must move there.
- **Do not touch `deployment-service/src/index.ts:40`.** It declares a variable
  of the same name, and there it is **real**: `ENCRYPTION_MASTER_KEY` encrypts
  every user's stored Cloudflare API token (`index.ts:6-35`, used at `:581`).
  A repo-wide grep-and-delete would decrypt nothing and lock the whole fleet out
  of auto-update. The task is scoped to the shim and the CLI.
- **Verify:** `grep -r ENCRYPTION_MASTER_KEY immich-api-shim/src selfhost/src`
  returns nothing, **and the same grep over `deployment-service/src` still
  returns its hits**; CLI tests pass; the warning text names the right thing.
- **Depends on:** 1.3
- **Risk:** low

### Task 1.5 — Write the recovery note for anyone already affected
- **What:** document what to do if photos were uploaded before this fix.
- **Files:** `docs/SELF_HOSTING.md`.
- **How:** be honest — those files are in the channel unencrypted under their
  real names. Options: leave them, or delete and re-upload once encryption is
  confirmed on. Include the command to check
  (`/api/assets/zke-status` after 1.2 tells the truth).
- **Verify:** a reader can determine their own exposure and act on it.
- **Depends on:** 1.2
- **Risk:** low

**Exit criteria**
- An install with broken key material refuses uploads instead of writing plaintext.
- `zke-status` cannot report encryption that is not happening.
- A fresh self-host setup produces working encryption, and re-running is safe.
- No secret is described to users as protecting something it does not protect.

---

# Phase 2 — Close the remaining account-takeover paths

**Goal:** no authenticated user can reach another's data or the install's keys,
and no unauthenticated user can forge a session anywhere.

**Why here:** these are exploitable today. They come after Phase 1 only because
plaintext-at-rest is worse and already happening.

### Task 2.0 — Give every single-asset path an owner filter
- **What:** the row accessors take an `ownerId` and use it; `albums` gets an
  owner column.
- **Files:** `immich-api-shim/src/d1-adapter.ts`, `immich-api-shim/src/assets.ts`,
  `immich-api-shim/src/albums.ts`, `deployment-service/src/index.ts` (schema).
- **Why it exists:** the security review found this, and it is larger than the
  config-exposure finding the plan was built around. Every *list* query filters
  on `ownerId`. Every *single-row* accessor does not — `getPhoto(id)`
  (`d1-adapter.ts:71`), `updatePhoto(id, fields)` (`:122`), `deletePhoto(id)`
  (`:135`). `loadPhotoById` (`assets.ts:1651`) is handed a `uid` and, on the D1
  branch, never uses it. Everything downstream inherits it: thumbnail, original,
  HEAD, chunk manifest, replace-video, playback, thumbnail upload, update, bulk
  update, and delete — which removes the Telegram messages *before* tombstoning
  the row, so it is irreversible. `handleAssetInfo` reads any row and then stamps
  the requester as its owner. The `albums` table has **no owner column at all**
  and `listAlbums()` is `SELECT * FROM albums`.
  Drive gets this right (`drive.ts:150-151` checks `existing.ownerId !== uid`),
  and that asymmetry is what says this is an oversight rather than a deliberate
  single-tenant assumption.
- **Blast radius — revised by the operator, 2026-07-26.** **Multi-user is not
  being built, at all. One storage per user, both flavours.** That decision
  demotes this task: the security review's severity rested on a second account
  existing on one install, and by design there will not be one. The real
  boundary is Task 2.4's owner gate, which refuses every non-owner at the door.
  This task becomes **defence in depth behind that gate**, not the fix itself.
- **So do the cheap half, skip the risky half.** Changing the accessor
  signatures costs almost nothing and stops the next call site reintroducing the
  bug. The albums schema migration — a new column plus a backfill over existing
  rows, which can hide a user's own albums from them — buys nothing once the
  gate is closed. Drop it unless it falls out for free.
- **How:** change the signatures — `getPhoto(id, ownerId)`,
  `updatePhoto(id, ownerId, fields)`, `deletePhoto(id, ownerId)` — so the filter
  cannot be forgotten at a call site rather than relying on each caller to add a
  `WHERE`. Add `ownerId` to the `albums` schema and scope `listAlbums` and
  `getAlbumAssets`.
- **Verify:** `src/asset-ownership.test.ts` against a two-user D1 fixture,
  asserting 404 on **every** single-asset route for the non-owner — not a smoke
  test on one route. A schema migration test that existing albums get an owner.
- **Depends on:** nothing. Do it first in the phase; 2.4 builds on it.
- **Risk:** medium — the albums migration touches existing rows, and a wrong
  backfill hides a user's own albums from them.

### Task 2.1 — Delete `finalize-client-upload`
- **What:** remove the route and its handler.
- **Files:** `immich-api-shim/src/assets.ts` (route ~359-361, handler ~1621-1638).
- **How:** it spreads the raw request body into `savePhoto`, whose column names
  are string-interpolated into SQL — arbitrary SQL for any authenticated user.
  It has no caller anywhere in the repo. Deleting is correct; hardening a dead
  route is not.
- **Verify:** the grep must come back clean **including
  `deployment-service/src/shim-bundle.ts`**. The review caught the original
  wording accepting "only the bundled copy" as a pass — but that bundle is the
  code every hosted worker actually runs, so leaving it there leaves the
  injection deployed on the whole fleet. The bundle is generated, so the real
  check is: re-run `embed-shim.mjs`, then grep the regenerated file. Not green
  until it is gone from there too, and the task is not done until the pipeline
  has been run and the fleet is on the new bundle.
- **Risk:** low

### Task 2.2 — Make `savePhoto` reject unknown columns
- **What:** validate keys against the real column list before building SQL.
- **Files:** `immich-api-shim/src/d1-adapter.ts` (~100-115).
- **How:** a `const PHOTO_COLUMNS = new Set([...])` derived from the schema;
  filter incoming keys and drop unknowns with a warning. Defence in depth — 2.1
  removes today's route, this removes the class.
- **Verify:** `src/d1-adapter-columns.test.ts` — a key like `` `id`, x) VALUES
  (…-- `` is dropped, a legitimate partial update still writes.
- **Risk:** low

### Task 2.3 — Gate the config endpoints instead of gutting them
- **What:** keep `/api/server/zke-config` and `/api/server/telegram-config`
  returning what they return, and put an owner check in front of them.
- **Files:** `immich-api-shim/src/server.ts`.
- **How:** **This task was reversed by the principles review, and the review is
  right.** The original plan was to stop returning the bot token and ZKE
  material. Those fields are load-bearing: `immich/web/src/service-worker/index.ts:46,356-361,373`
  reads them so the browser can fetch media bytes straight from Telegram, and
  its own comment (`:19-21`) says that path exists so the worker "can never hit
  its 128MB/CPU/subrequest limits". Removing them would push every web media
  byte back through the worker — the exact load Phase 3 spends eight tasks
  relieving — and make browser uploads fall through to `encryptionMode:'off'`,
  re-arming the Phase 1 plaintext bug from the client side. It would also delete
  response fields, which `PARITY.md` forbids.
  The actual defect is narrower: on a single-worker self-hosted install with an
  open Firebase signup, *any* account can read them. That is closed by the owner
  gate alone. Merged into 2.4.
- **Verify:** covered by 2.4's tests, plus a web upload confirmed still
  encrypting after the change.
- **Risk:** low (now a no-op pointing at 2.4)

### Task 2.4 — Add an owner check for single-worker installs
- **What:** store `owner_uid` at setup and gate config routes on it.
- **Files:** `selfhost/src/commands/setup.mjs`, `immich-api-shim/src/server.ts`,
  `immich-api-shim/src/index.ts`.
- **This is now the security boundary for self-host, not a supplement to one.**
  The operator has ruled out multi-user entirely: one storage per user, both
  flavours. So there is exactly one legitimate account per install, and the gate
  can be blunt — refuse anyone who is not the owner, everywhere, rather than
  route by route. That is easier to get right and easier to audit than owner
  filters spread across every accessor, and it is why Task 2.0 shrank.
  Being the whole boundary raises the bar on this task: it must cover **every**
  authenticated route, not just the config-returning ones, and a route added
  later must be covered by default. Put the check in the router before dispatch,
  not in each handler.
- **How:** hosted installs are one worker per user, so this is a no-op there.
  Self-host is one worker with an open Firebase signup, so any account that can
  register can currently read the install's config. Write `owner_uid` during
  setup; require `session.uid` to match.
  **Fail closed:** the review caught that "no `owner_uid` means allow" is
  fail-open — a self-hosted install whose config row failed to write would be
  wide open. So: when `SELF_HOST=1` and `owner_uid` is absent, **refuse** and
  say to re-run setup. Hosted (no `SELF_HOST`) keeps today's behaviour, because
  there the worker already belongs to exactly one person.
  **Where `owner_uid` gets written.** The review caught that the plan scheduled
  the write in `selfhost/src/commands/setup.mjs` only — so a hosted worker never
  gets one, and any install provisioned before this task has none either. Add
  it in two places: the CLI at setup time, and the deployment service when it
  provisions or force-updates a worker (it already knows the uid it is
  provisioning for). For installs that predate both, `owner_uid` is claimed by
  the first uid to authenticate after the upgrade, written once, and never
  overwritten — a self-hosted operator logs into their own install before
  publishing its URL, so first-login is the owner in practice.
- **Also gate `/api/drive/config`** (`drive.ts:50-74`). It is not in
  `FINDINGS.md`. On a per-user worker the telegram config lives in **worker-global
  D1**, not under a uid — `getCachedConfig` falls through to
  `adapter.getJsonConfig(key)` (`cached-config.ts:17-20`). So GET returns the
  install's bot token to *any* authenticated session, and POST overwrites the
  bot token and channel for everyone, redirecting all future uploads. On hosted
  this is contained by the per-worker `SESSION_SECRET`: a session minted for one
  user does not verify on another's worker. It is **not** contained on a
  multi-user self-host install, where everyone shares one worker and one secret,
  and it is not contained on any worker still missing `SESSION_SECRET` (see 2.6).
  Same owner gate, same test file.
- **Verify:** `src/owner-gate.test.ts` — with `owner_uid` set, a different uid
  gets 403 and the owner gets 200; with it unset **and `SELF_HOST=1`**, both are
  refused; with it unset and no `SELF_HOST`, both behave as today. Cover
  `/api/drive/config` GET *and* POST, not just the server config routes.
- **Risk:** medium — must not break hosted, which has no `owner_uid`. This is
  now the whole fix for the config-exposure finding, so its tests carry weight.

### Task 2.5 — Make sessions revocable
- **What:** an epoch that logout can bump.
- **Files:** `immich-api-shim/src/auth.ts`, `immich-api-shim/src/helpers.ts`.
- **How:** `session_epoch` integer in the config table, stamped into the token
  at issue, compared at verify. Reduce the TTL from ten years to something
  bounded and lean on refresh for continuity — which the comment at
  `auth.ts:5-13` already claims. Self-host has no refresh path
  (`helpers.ts:94`), so pick a TTL that does not force weekly logins there.
- **`handleLogout` must be authenticated first.** The review caught that the
  plan as written creates a new vulnerability. `handleLogout` is routed at
  `auth.ts:38-40` and takes no arguments — it runs **before any auth check**,
  because logout has never needed one. Giving that function the power to
  increment a global epoch hands any anonymous caller a one-request denial of
  service that signs out every session on the install, repeatable forever. So:
  `requireAuth` at the top of `handleLogout`, and only then the bump. A logout
  without a valid session still clears the cookie and returns 200 — it just
  cannot touch the epoch.
- **Verify:** `src/session-revocation.test.ts` — a token minted before a bump is
  rejected after it; a fresh one is accepted; no epoch present behaves as today;
  **and an unauthenticated POST to `/api/auth/logout` does not change the
  epoch**, asserted by reading it back, not by the response status.
- **Risk:** medium — every user is logged out once when this ships. Say so.

### Task 2.6 — Close the public-constant signing fallback
- **What:** force the hosted fleet onto per-install secrets, then delete the
  `APP_IDENTIFIER` fallback.
- **Files:** `immich-api-shim/src/selfhost-auth.ts` (~44),
  `immich-api-shim/src/auth.ts` (~96),
  `immich-api-shim/src/auth-security.test.ts` (~86-93).
- **How:** redeploy every hosted worker through `/admin/force-update`, which
  already threads `sessionSecret`. Confirm each has one. Then delete the
  fallback and **flip the test** that currently asserts forged tokens are
  accepted, so it asserts rejection.
- **Delete the issuer's fallback too, not just the verifier's.** The review
  caught that the plan only removed `sessionScope`'s fallback
  (`selfhost-auth.ts:44`). The *issuing* side is `auth.ts:96` —
  `userSessionSecret || env.APP_IDENTIFIER || 'default'` — where
  `userSessionSecret` comes from a Firestore read wrapped in a bare `catch {}`
  (`auth.ts:75-87`). Remove one without the other and a transient Firestore
  failure mints a token signed with the public constant, which the hardened
  fleet then rejects: the user is silently logged out and cannot log back in
  while the fault lasts. Both sides go in the same task, and a failed lookup
  must **refuse to issue** rather than fall back.
- **Note the asymmetry while it exists:** login signs with the *logged-in
  user's* secret (from their Firestore config) while `requireAuth` verifies with
  the *worker's* `SESSION_SECRET` binding. That mismatch is what currently stops
  a session minted on one worker from verifying on another's — it is doing real
  work, and 2.6 must not remove it by accident.
- **Verify:** the flipped test; a forged `APP_IDENTIFIER`-signed token gets 401
  against a live worker; and a login whose Firestore lookup fails returns an
  error rather than a constant-signed token.
- **Fleet gate, mechanically.** The review's point stands that "operator
  confirms" is a promise, not a check. Before the fallback is deleted, enumerate
  the account's `dc-*` workers and assert each has a `SESSION_SECRET` binding —
  `wrangler secret list --name <worker>` reports it without revealing the value
  (confirmed working against `dc-ozkv3fuz`). Paste that output into the phase
  doc. A worker that cannot be enumerated counts as failing.
- **Cutoff:** the review noted that gating a security fix on an operator action
  can defer it indefinitely. So the fallback also gets a hard date: past it, the
  branch throws regardless of fleet state. A worker that missed the redeploy
  then fails loudly instead of staying forgeable forever.
- **Depends on:** operator confirms the fleet is redeployed.
- **Risk:** high — deleting this before every worker has a secret locks users
  out. The fleet check gates the deletion.

**Exit criteria**
- No route returns key material or a bot token.
- No authenticated account can read another's config.
- Sessions can be revoked; tokens are bounded.
- No forged token is accepted anywhere.

---

# Phase 3 — Make the worker survive its own budget

**Goal:** ordinary use stops producing error 1102, which the app reports to
users as sync and backup failure.

**Why here:** these are the crashes users actually see, and they are cheap to
fix once the security work has settled the same files.

**The symptom, in the operator's words:** *"after it gets this problem I reopen
the app and it's good again for some time, then again problem."* That is state
accumulating in a reused Worker isolate until it exceeds its limits; a new
connection lands on a fresh isolate and the cycle restarts. The device log for
that day shows 60 × 502, every one of them Cloudflare 1102. See `FINDINGS.md`
§13 — the tasks below are what actually fixes it.

### Task 3.1 — One shared subrequest counter
- **What:** replace three hand-maintained budgets with one counter.
- **Files:** new `immich-api-shim/src/budget.ts`; `assets.ts`, `timeline.ts`,
  `sync.ts`.
- **How:** a small object created per invocation and threaded through. Increment
  **inside** the helpers that make the calls (`tgGetFileUrl`, `tgDownloadFile`,
  cache reads/writes), never at call sites, so a budget cannot drift from what it
  counts. Expose `remaining()` and `canAfford(n)`.
- **Count external and internal separately.** The alternatives review caught that
  the plan lumped D1 into the 50. It is not there. Cloudflare's limits page and
  the 2026-02-11 changelog both state it: free-plan Workers get **50 external
  subrequests *and* 1,000 subrequests to Cloudflare services** per invocation —
  verified against the current docs, not assumed. D1, KV, R2 and the Cache API
  are on the 1,000. Counting a D1 query against the 50 makes the worker refuse
  work it can comfortably afford, which is a self-inflicted version of the bug
  this phase exists to fix. Two counters, or one with two dimensions.
- **Verify:** `src/budget.test.ts` — a fake chunk fetch reports the right
  external cost for a cold chunk and for a cached one; a D1 query moves the
  internal counter and leaves the external one alone; `canAfford` refuses past
  the right cap.
- **Risk:** medium — touches hot paths; the tests must cover cache hits and misses.

### Task 3.2 — Cost the chunk budget correctly
- **What:** ~~derive `MAX_CHUNKS_PER_RESPONSE` from real cost~~ — **mostly
  dropped. Read this before doing anything.**
- **Files:** `immich-api-shim/src/assets.ts` (~2226).
- **The first half is already done.** `getChunk` checks the chunk **body** cache
  at `assets.ts:2131-2134`, before any file-path resolution — shipped
  2026-04-27 in `4b40008`. A warm chunk already costs one subrequest, not six.
  Verified. Nothing to do.
- **The second half would reintroduce a bug the code says was fixed.** Deriving
  `MAX_CHUNKS_PER_RESPONSE` from a 50-subrequest cap gives about 7 chunks, i.e.
  a truncated 206. The comment at `assets.ts:2186-2195` records what that costs:
  native players (ExoPlayer, AVPlayer) open playback with `bytes=0-` and treat a
  short 206 as end-of-file, so multi-chunk videos played their first window and
  froze — while browsers, which re-request politely, looked fine. That is the
  mobile video bug, and shortening the 206 is how you get it back. The streaming
  path holds ~2 chunks in memory, so the 128 MB cap that motivated the old
  truncation does not bind.
- **What remains:** with 3.1's corrected accounting, confirm a long multi-chunk
  range actually stays inside the **external** budget. If it does, this task is
  closed as already-fixed. If it does not, the lever is concurrency (3.3), not
  response length.
- **Verify:** `src/range-stitch.test.ts` stays green unchanged — that suite is
  the regression test for the freeze, and any change here that needs it edited
  is the wrong change.
- **Depends on:** 3.1
- **Risk:** was medium; now low, because the answer is mostly "do not".

### Task 3.3 — Stop copying 19 MB per chunk into `waitUntil`
- **What:** remove the un-awaited full-size copy.
- **Files:** `immich-api-shim/src/assets.ts` (~2146).
- **How:** `data.slice(0)` clones the whole chunk for the cache write, and up to
  twenty can be in flight. Serialise the writes, or skip caching beyond the
  first chunk of a large response.
- **Verify:** a test asserting at most N concurrent cache writes; memory-shaped
  behaviour observed under a multi-chunk fetch.
- **Depends on:** 3.1
- **Risk:** medium

### Task 3.4 — Give the timeline the same one-job rotation sync has
- **What:** dispatch at most one background job per invocation.
- **Files:** `immich-api-shim/src/timeline.ts` (~55-69).
- **How:** `sync.ts:290-302` already does this and documents why. The timeline
  still fires two backfills whose budgets sum to 64 against a cap of 50. Reuse
  the same rotation.
- **Verify:** `src/timeline.test.ts` — one `waitUntil` per call; successive
  calls rotate through the jobs.
- **Risk:** low

### Task 3.5 — Backpressure on full-file downloads
- **What:** convert the no-Range path to a pulling stream.
- **Files:** `immich-api-shim/src/assets.ts` (~2262-2278).
- **How:** `start()` enqueues every chunk as fast as Telegram delivers, queuing
  the whole file. Use `pull(controller)` with an index cursor, or the same
  `TransformStream` pump the 206 path uses.
- **Verify:** extend `src/range-stitch.test.ts` — a no-Range fetch of the
  synthetic three-chunk file is byte-identical, and the stream pulls rather than
  pushes.
- **Risk:** medium

### Task 3.6 — Never serve a whole original as a grid thumbnail
- **What:** extend the 404 guard to any fallback to the original.
- **Files:** `immich-api-shim/src/assets.ts` (~1910, guard ~1924-1941).
- **How:** the guard covers video and HEIC; a plain JPEG with no stored thumb
  still serves its full original, cached immutable for a year. On the grid path,
  404 for *any* original fallback and let the thumbhash blur stand.
- **Verify:** `src/thumbnail-guard.test.ts` — plain photo with no thumb returns
  404 on grid, still serves on `size=preview`.
- **Risk:** low

### Task 3.7 — Expire Telegram file paths honestly
- **What:** stop a cached path outliving Telegram's validity, and purge on failure.
- **Files:** `immich-api-shim/src/assets.ts` (~3108-3144).
- **How:** an L2 hit re-stamps L1 with a fresh 55 minutes regardless of age, so
  a path can live 110 minutes against Telegram's ~60. Store `fetchedAt` and
  derive expiry from it. On a 404/410 download, delete both cache entries and
  retry once with a forced refresh.
- **Verify:** `src/filepath-cache.test.ts` — an aged L2 entry does not extend
  L1; a 404 evicts and retries once.
- **Risk:** low

### Task 3.0 — Bound the file-path cache
- **What:** stop `filePathCache` growing for the life of the isolate.
- **Files:** `immich-api-shim/src/assets.ts` (~73, ~3108-3144).
- **How:** it is a module-level `Map` with `get` and `set` and no `delete`
  anywhere — expired entries are read, ignored, and left in place. Cloudflare
  reuses isolates, so it grows until the isolate dies. Evict on read when
  expired, and cap the size with oldest-out eviction. Folds naturally into 3.7,
  which is already rewriting this code.
- **Verify:** `src/filepath-cache.test.ts` — the map never exceeds the cap under
  a thousand distinct ids; expired entries are removed rather than skipped.
- **Risk:** low

### Task 3.8 — Revive early dedup for foreground uploads
- **What:** make the fast path work for the uploader that actually uses it most.
- **Files:** `immich-api-shim/src/upload-dedup.ts`, `upload-stream.ts`.
- **How:** the hint reads a `filename` field the foreground uploader never
  sends. Use `duration`, which it does send (`0:00:00.000000` for stills).
  Failing that, defer the check to the `assetData` part header where
  `part.filename` exists before the body is read.
- **Verify:** extend `src/upload-dedup.test.ts` with the real foreground field
  set — the hint resolves and the fast path engages; the live-photo kind check
  still holds.
- **Risk:** low

**Exit criteria**
- No code path can exceed the subrequest cap by construction.
- Memory stays bounded on the largest file a user can store.
- The timeline and sync both dispatch at most one background job.
- A cached Telegram path can never be used past its validity.

---

# Phase 4 — Finish the self-hosting CLI

**Goal:** someone who has never seen this project can go from `git clone` to a
working private cloud, and get told precisely what is wrong when something is.

**Why here:** the worker it deploys must be correct first, or we would be
shipping a smooth installer for a broken product.

Design of record: `docs/roadmap/SELFHOST_CLI_DESIGN.md`, verified against how
wrangler, Vercel and Firebase actually behave.

### Task 4.0 — Make the config write atomic
- **What:** stop `config.mjs:save()` being able to destroy the one
  unrecoverable value it stores.
- **Files:** `selfhost/src/config.mjs` (~183-187), `.gitignore`.
- **Why:** `fs.openSync(file, 'w', 0o600)` **truncates in place**, then writes,
  with no temp file and no `fsync`. A crash, a full disk, or a killed terminal
  between those two steps leaves an empty file — and the file's own header says
  `STORAGE_KEY` is the only thing that can decrypt what is already in the user's
  Telegram channel. The failure mode is "self-hoster loses every file they have
  stored", from an interrupted save. `'w'` also follows symlinks, so a
  pre-existing symlink at that path redirects the credentials elsewhere.
  Found by the alternatives review; verified in the code.
- **How:** write to `config.env.tmp` in the same directory with `wx` and mode
  0600, `fsync`, then `rename` over the target — rename is atomic within a
  filesystem, so the file is either the old contents or the new one, never
  empty. `wx` on the temp file refuses to follow a symlink. Keep the existing
  0600-from-creation behaviour, which is already right.
- **Also:** add `config.env` and `config.env.tmp` to `.gitignore`. The default
  location is `~/.config/daemonclient/`, so this is a backstop rather than the
  main protection — but this repository has committed a `.env` before
  (`6468388`, still in its history), which is exactly why the backstop is worth
  the one line.
- **Verify:** `selfhost/test/config-atomic.test.mjs` — a save interrupted after
  the temp write leaves the original file intact and readable; a symlink at the
  config path does not get followed; permissions are still 0600 afterwards.
- **Risk:** low, and it removes a high-severity one.

### Task 4.1 — Delete the dead config modules
- **What:** remove `state.mjs`, `env.mjs` **and `deploy.mjs`**; `config.mjs` is
  the only config module and `build.mjs` the only build path.
- **Files:** `selfhost/src/state.mjs`, `selfhost/src/env.mjs`,
  `selfhost/src/deploy.mjs`, and every importer.
- **How:** three live config modules is worse than any one of them. Migrate the
  commands and `test/selfhost.test.mjs` onto `config.mjs`, then delete.
  `deploy.mjs` has zero importers and is a byte-identical stale copy of logic
  that lives in `build.mjs` — it is what two Phase 1 tasks were mistakenly
  aimed at. Deleting it is how that mistake stops being possible.
- **Verify:** `grep -rn "state.mjs\|env.mjs\|deploy.mjs" selfhost/` returns
  nothing; `cd selfhost && npm test` green.
- **Risk:** low

### Task 4.2 — Refuse to run when the environment will sabotage it
- **What:** detect the two conditions that silently break Cloudflare sign-in.
- **Files:** `selfhost/src/commands/setup.mjs`, `selfhost/src/config.mjs`.
- **How:** a `.env` in the repo root or `immich-api-shim/` containing
  `CLOUDFLARE_API_TOKEN` is read by wrangler and overrides browser sign-in.
  An ambient `CLOUDFLARE_API_TOKEN` does the same — the operator's own machine
  has one. Both detectors already exist in `config.mjs`; wire them into
  preflight and name the file and variable in the message.
- **Verify:** `selfhost/test/hostile-env.test.mjs` — each condition is detected
  and the message names the offending file or variable.
- **Risk:** low

### Task 4.3 — Rewrite setup as probe / repair / verify
- **What:** one shape per subsystem; re-running is a health check.
- **Files:** `selfhost/src/commands/setup.mjs`.
- **How:** no step machine, no `markDone`. For each of Telegram, Cloudflare,
  Firebase, worker, processor, dashboard: `probe()` reports state, `repair()`
  prompts and fixes, `verify()` re-probes. Idempotent throughout. The current
  file also calls functions that no longer exist, so this is a rewrite.
- **Verify:** `selfhost/test/setup-flow.test.mjs` with fakes — a fully
  configured install runs clean with zero prompts; a broken value prompts for
  only that one.
- **Depends on:** 4.1, 4.2
- **Risk:** high — the largest single piece. Split if it grows past one review.

### Task 4.4 — `doctor` becomes setup in read-only mode
- **What:** one code path, two entry points.
- **Files:** `selfhost/src/commands/doctor.mjs`, `setup.mjs`.
- **How:** run the same probes with `repair` disabled, then print the redacted
  report. Two implementations of "is this healthy" would drift.
- **Verify:** `selfhost/test/doctor.test.mjs` — doctor never prompts and never
  writes; the report contains no secret.
- **Depends on:** 4.3
- **Risk:** low

### Task 4.5 — Firebase automation
- **What:** automate the four console steps that can be automated.
- **Files:** new `selfhost/src/api/firebase.mjs`.
- **How:** `firebase login` for OAuth only (Google's own verified client), then
  REST directly — project create, `:addFirebase`, enable Email/Password via the
  Identity Toolkit admin config, register a web app, read the API key, create
  the user. Do **not** shell out to `firebase projects:create`: it flattens
  terms, quota and permission failures into one useless string. One step stays
  manual — accepting the Firebase terms, once per Google account — and it must
  be detected and explained precisely, not guessed at.
- **Verify:** `selfhost/test/firebase.test.mjs` against recorded responses,
  including the terms-not-accepted path.
- **Depends on:** 4.3
- **Risk:** high — many external failure modes. Every one needs its own message.

### Task 4.6 — Vercel processor deploy
- **What:** deploy the HEIC function without the user leaving the terminal.
- **Why it matters more than "one more setup step":** it is what retires the
  manual HEIC fix. Every other image gets a free thumbnail from Telegram — the
  worker sends the original, Telegram thumbnails it, the message is deleted.
  Telegram will not do that for HEIC, so HEIC images currently have no thumbnail
  until the user runs the fix tool from the web by hand. This function is the
  automated replacement, and it runs on the **user's own** Vercel account, so
  plaintext still never reaches operator infrastructure. Hosted users get the
  same thing through the same `heicConvertUrl` config.
- **Files:** new `selfhost/src/api/vercel.mjs`; `selfhost/src/commands/processor.mjs`.
- **How:** `vercel login` is a real device flow, so it works over SSH where
  Cloudflare's does not. Runtime environment variables must be set with the
  documented mechanism — **not** by setting them on the CLI's own process, which
  does nothing for the deployment. Parse the URL from JSON output. Pin
  `OWNER_UID` so the instance serves one account.
- **Verify:** `selfhost/test/vercel.test.mjs` — the command line includes the
  env flags; a health response lacking `ownerPinned` produces a warning.
- **Depends on:** 4.3
- **Risk:** medium

### Task 4.7 — Pre-empt the first-run Cloudflare failures
- **What:** handle the three things that break on brand-new accounts.
- **Files:** `selfhost/src/api/cloudflare.mjs`, `setup.mjs`, `dashboard.mjs`.
- **How:** a fresh account has no `workers.dev` subdomain (deploy hard-fails
  non-interactively) — detect error 10007 and register one. A Pages project must
  exist before `pages deploy` — create it first, tolerating "already exists".
  Multi-account users hit a hard error — resolve the account ourselves and pass
  it explicitly. All three helpers exist; wire them in.
- **Verify:** `selfhost/test/first-run.test.mjs` against fakes for each case.
- **Depends on:** 4.3
- **Risk:** medium

### Task 4.8 — Headless and busy-port handling
- **What:** say what is wrong before a 120-second hang.
- **Files:** `selfhost/src/commands/setup.mjs`.
- **How:** Cloudflare has no device flow, so a VPS user cannot complete browser
  sign-in without port forwarding. Detect no-display up front and offer
  `ssh -L 8976:localhost:8976` or the token path. If 8976 is occupied, say so —
  wrangler otherwise dies with a raw `EADDRINUSE` stack trace.
- **Verify:** `selfhost/test/headless.test.mjs` — both conditions produce the
  guidance, neither reaches the hang.
- **Depends on:** 4.7
- **Risk:** low

### Task 4.8b — De-hardcode the web apps
- **What:** remove the operator's URLs from the Photos and Drive clients.
- **Files:** `immich/web/src/service-worker/index.ts` (~26, ~184),
  `drive/src/api.js` (~14, ~48), `drive/src/App.jsx` (~2088).
- **How:** the principles review found the plan was missing a third of what
  `PARITY.md` promises, and something worse: the Photos service worker defaults
  to `https://api.daemonclient.uz` for pre-login traffic, so **a self-hoster
  following our own guide posts their password to the operator's worker**. Drive
  hardcodes `immich-api.sadrikov49.workers.dev` for login and redirects unknown
  hostnames to `drive.daemonclient.uz`. All three become build-time config, with
  the operator's values as the hosted default only.
- **Verify:** `grep` for those hosts in a self-host build output returns
  nothing; a Drive login on a self-hosted deployment reaches that worker and no
  other, confirmed in the network panel.
- **Risk:** medium — touches the login path of both web apps.

### Task 4.8c — Deploy the web apps from the CLI
- **What:** `daemonclient dashboard` also builds and deploys Photos and Drive.
- **Files:** `selfhost/src/commands/dashboard.mjs`.
- **How:** `PARITY.md` says a self-hoster gets the same services. Today the CLI
  deploys the worker and the portal; Photos and Drive are left as a manual
  exercise, so most self-hosters would never have them. Same Cloudflare Pages
  path, one project each, origins added to `ALLOWED_ORIGINS`.
- **Verify:** after setup, all three URLs load and sign in against the
  self-hosted worker.
- **Depends on:** 4.8b
- **Risk:** medium

### Task 4.9 — Pin the toolchain
- **What:** stop depending on whichever wrangler happens to be nearby.
- **Files:** `selfhost/package.json`.
- **How:** we parse wrangler's behaviour in several places, so its version must
  be a choice rather than an accident of directory layout. Pin it; document
  `firebase-tools` and `vercel` as invoked via `npx` at a stated version.
- **Verify:** a clean clone runs setup with no ambient global installs.
- **Risk:** low

**Exit criteria**
- One config module, one health implementation.
- Every credential validated against the real service, with actionable errors.
- Re-running setup is safe and changes nothing that already works.
- A brand-new Cloudflare account completes without a manual dashboard visit.

---

# Phase 5 — Prove it end to end

**Goal:** we have watched a real self-hosted install work, rather than inferring
it from unit tests.

**Why here:** everything it exercises must exist first.

### Task 5.1 — Real setup against throwaway accounts
- **What:** run the whole flow on fresh accounts and record what happens.
- **How:** new Telegram bot and channel, new Firebase project, a Cloudflare
  account, optionally Vercel. Take notes at every point of confusion — those are
  bugs in the copy, not user error.
- **Who does what — decided.** The **operator creates the accounts** (signup
  needs phone and captcha) and hands over the credentials; **I drive the run**
  end to end, so every failure is observed directly rather than relayed. The
  accounts must be genuinely disposable — nothing shared with a real one.
- **Delete the accounts when the phase ends.** Part of the task. A throwaway
  Cloudflare account left alive with a working token is a live credential
  nobody is watching.
- **Verify:** photo uploads from the mobile app, appears on the web, thumbnail
  renders, download matches byte for byte.
- **Risk:** high — the first honest test of the whole thing.

### Task 5.2 — Fix what 5.1 finds
- **What:** whatever it is.
- **Verify:** a second clean run needs no manual intervention.
- **Depends on:** 5.1

### Task 5.3 — Both flavours from one commit, in CI
- **What:** prove hosted and self-hosted build and pass together.
- **Files:** `.github/workflows/ci.yml`.
- **How:** typecheck plus tests for the worker and the CLI, in both modes. Add
  the guard from `PARITY.md`: fail if the number of hosted/self-host divergence
  points grows without a note. A self-host-only regression is otherwise
  invisible until a stranger hits it.
  **Plus the single highest-value check available:** grep every self-host build
  artifact for `daemonclient.uz`, `sadrikov49`, and the operator's Firebase
  project, and fail on a hit. That one rule would have caught all three of the
  P3 violations the principles review found in the web apps.
- **Verify:** CI green; a deliberate divergence fails it.
- **Risk:** low

### Task 5.4 — One release, both destinations
- **What:** make it impossible to ship to one flavour and forget the other.
- **Files:** `.github/workflows/release.yml`, `docs/RELEASING.md`.
- **How:** from one tag: build, deploy the hosted fleet, publish the GitHub
  release the self-hosted update check watches. If it cannot do both, it does
  neither and says why.
- **Mark the release's nature.** A `security:` prefix or label on the release,
  because 5.6 uses it to decide how loudly to tell the owner. A convention in
  our own repo costs nothing and is the only severity signal a self-hosted
  install can get without us knowing anything about it.
- **Verify:** a dry run shows both steps from one tag.
- **Depends on:** 5.3
- **Risk:** medium

### Task 5.5 — Update the hosted fleet on a schedule, not on a page visit
- **What:** a Cron Trigger on the deployment service that walks the fleet.
- **Files:** `deployment-service/wrangler.toml` (add `[triggers] crons`),
  `deployment-service/src/index.ts`.
- **Why:** the hosted fleet updates from exactly one place today —
  `accounts-portal/src/App.jsx:1744`, a fire-and-forget call fired when someone
  loads the **accounts portal**. Not on Photos login, not on app sync. Most
  users never return to that page after setup, so the fleet drifts and a
  published security fix reaches almost nobody. This is why `dc-ozkv3fuz` sat on
  an old shim through daily logins. **There is no Cron Trigger anywhere in this
  repo** — verified.
- **How:** a daily cron on the deployment service: read the users whose
  `lastDeployedVersion` ≠ `SHIM_VERSION` and deploy each. Every provisioned
  worker lives on the operator's own Cloudflare account, so the **master token
  can deploy them** — no dependence on a per-user OAuth refresh token that may
  already be spent, which is the failure that stalled the fleet in the first
  place. Rate-limit the walk, and record per-worker success so a persistent
  failure is visible instead of silent.
- **Keep the on-login nudge** as the fast path for someone who just logged in.
- **Verify:** a worker deliberately pinned to an old version is on the current
  one within a day, with nobody visiting any page. A worker whose deploy fails
  is reported, not swallowed.
- **Risk:** medium — it deploys to real users' workers unattended, so it needs a
  kill switch and a cap on how many it touches per run.

### Task 5.6 — Make a self-hosted install notice an update without being watched
- **What:** a Cron Trigger on the **owner's own** worker, and a notification
  through their **own** Telegram bot.
- **Files:** `immich-api-shim/src/update-check.ts`, `selfhost/src/commands/setup.mjs`
  (provision the trigger), the self-host wrangler config the CLI generates.
- **Why:** `update-check.ts` is already right in shape — it polls GitHub
  anonymously, caches 12 hours in the install's own D1, sends nothing about the
  install, and never self-mutates. What it lacks is a heartbeat and an audience:
  it only runs when a request happens to hit the worker, and it reports to a
  dashboard banner nobody is looking at. An install whose owner does not open
  the dashboard never learns anything.
- **How:** the CLI provisions a daily Cron Trigger on the user's own worker as
  part of setup. On a hit, the worker sends **one message via the user's own bot
  to their own channel** — the bot already exists, it is already the storage
  layer, and it reaches their phone. Louder wording when the release is marked
  security (see 5.4). Deduplicate so one release produces one message, not one a
  day forever.
- **Explicitly NOT a service of ours.** No registry of self-hosters, no
  check-in, no push. Nothing about the install leaves it except an anonymous
  GET to GitHub, which is what already happens. A worker of ours that told
  installs to update would require knowing where they are — collecting that is
  telemetry, keeping it is a target, and depending on it breaks P3 outright.
  **GitHub is the tunnel; it already is.** What was missing was the alarm clock.
- **Applying stays manual** — `daemonclient update` (git pull, prompted; rebuild;
  redeploy with the owner's own credentials). See the note below on why.
- **Verify:** an install left alone for a day, with a release published, sends
  exactly one Telegram message and shows the banner. Two days produce no second
  message. A GitHub outage produces neither an error to the user nor a retry
  storm.
- **Depends on:** 5.4
- **Risk:** low

> **Why self-host does not auto-apply.** Today the deploy credential lives only
> on the owner's machine, in `config.env`. Auto-applying inside the worker would
> mean storing a deploy-capable Cloudflare token **in the worker** — turning any
> worker compromise into a compromise of their whole Cloudflare account, and
> making an unattended `git pull` + deploy the normal path. That is the shape
> supply-chain incidents take, and `update.mjs` already says so in its own
> header. Anyone who wants it unattended can run `daemonclient update` from a
> scheduler on their own machine, or from a GitHub Action in their own fork with
> their own secrets — their infrastructure, their decision, still nothing of
> ours. **Open question 5 asks whether the operator agrees.**

**Exit criteria**
- A stranger's install works, verified by doing it.
- CI proves both flavours from every commit.
- One release action reaches both kinds of user.
- A hosted worker updates without its user doing anything.
- A self-hosted owner hears about a security release without opening anything.

---

# Phase 6 — Documentation worth reading

**Goal:** someone lands on the repository and understands what it is, how to run
it, and where the code lives — without asking.

**Why last:** documenting a moving target wastes the writing.

### Task 6.1 — Rewrite the README
- **What:** the front page.
- **Files:** `README.md`.
- **How:** what it is, why it exists, the architecture in one diagram, both ways
  to run it, honest limitations. Written in a human register — the operator has
  said plainly that AI-sounding text is not acceptable. Short sentences, real
  specifics, no marketing cadence, no triads of adjectives.
- **Verify:** read it aloud. Anything that sounds like a press release gets cut.
- **Risk:** medium — easy to write, hard to write well.

### Task 6.2 — A documentation site
- **What:** a browsable docs site, in the shape of Cloudflare's docs.
- **Files:** new `docs-site/`.
- **Generator: Astro Starlight.** Decided. Cloudflare's own docs are Astro with
  a bespoke in-house theme — their `package.json` has no Starlight in it — so
  copying them means owning a hand-built theme, which is precisely the "docs
  site becomes a project of its own" risk. Starlight is the same framework with
  the wanted shape already built.
- **How:** the operator specifically likes the Cloudflare docs layout — a
  persistent left-hand navigation tree, a page-contents rail on the right, dense
  and calm typography, code samples with copy buttons, and search. Starlight
  ships all of that; the work is content and navigation structure, not chrome.
  Deploys to Cloudflare Pages for free. Sections: Getting started, Self-hosting,
  Architecture, API reference, Contributing, Security. Source of truth stays the
  markdown in `docs/` — the site renders it, so nothing is written twice.
- **Verify:** builds clean, deploys, search works, every nav link resolves, and
  it is legible on a phone.
- **Depends on:** 6.1
- **Risk:** medium — scope creep. It ships with real content or not at all.

### Task 6.3 — Rewrite the self-hosting guide for the final flow
- **What:** match what the CLI actually does.
- **Files:** `docs/SELF_HOSTING.md`.
- **How:** the Firebase flow, browser sign-in, the config file location, the
  processor step, updates, and troubleshooting keyed to the errors the CLI
  actually prints.
- **Verify:** followed literally on a clean machine during 5.1, it works.
- **Depends on:** 5.2
- **Risk:** low

### Task 6.4 — Architecture and API reference for contributors
- **What:** what lives where, and what the API does.
- **Files:** `docs/ARCHITECTURE.md`, `docs/API.md`.
- **How:** the request path from phone to Telegram and back; why each constraint
  exists; the endpoint list with shapes. Aim it at someone deciding whether they
  can fix a bug here.
- **Verify:** every endpoint in the router appears; a reader can trace an upload
  end to end.
- **Depends on:** 6.2
- **Risk:** low

### Task 6.5 — Finish the repository cleanup
- **What:** decide the fate of the legacy directories.
- **Files:** repo root.
- **How:** **Traps, verified:** `frontend/` is still a live `firebase.json`
  hosting target, and `daemonclient-proxy` is the live `TELEGRAM_PROXY` for
  hosted users. Neither can simply be deleted. For the genuinely dead ones
  (`landing-page`, `photos`, `daemon-cli`, `daemonclient-desktop`,
  `daemonclient-immich-bridge`, `local-server`), push them to a **separate
  private archive repo** and then delete them here.
- **Not an `attic` branch — decided.** A branch would be publicly visible, would
  puzzle contributors, and the history scrub would have to rewrite it too or the
  leaked keys stay reachable from the public repo. One public repo, one branch.
- **Verify:** hosted service unaffected after the change; `git ls-files` shows
  only what a contributor needs; `git branch -r` shows only `main`; the archive
  repo is private and contains what was removed.
- **Risk:** medium — deleting something live breaks production.

**Exit criteria**
- The README explains the project to a stranger.
- The docs site is live and navigable.
- Every top-level directory is either explained or gone.

---

## Risks

| Risk | Mitigation |
|---|---|
| Key rotation destroys access to stored photos | 1.3 writes only when empty; its own test |
| Session changes lock everyone out | 2.6 gated on fleet redeploy; 2.5 logs out once, announced |
| Budget work regresses byte-exactness | `range-stitch.test.ts` already proves it; keep it green |
| Setup rewrite is too big for one review | Split at the first sign of it |
| Docs site becomes a project of its own | Ships with real content or not at all |
| Removing a `/api/server` field breaks a client | 2.3 audits readers before removing |

## Decisions — settled by the operator, 2026-07-26

No open questions remain. Implementation may start.

1. **Session TTL: 30 days for both, with silent refresh on both.** Self-host
   gets a refresh path rather than a longer expiry, so there is one number and
   no asymmetry. That is **new Task 2.7**, and it touches token issuance while
   2.5 and 2.6 are in flight — so it goes *after* both, and its gates are run
   against the combined behaviour, not against 2.7 alone.
2. **Attic: a separate private archive repo**, not a branch here. The public
   repo keeps only `main`, contributors meet no mystery branch, and the history
   scrub has one repo to rewrite instead of two.
3. **Docs site: Astro Starlight.** Cloudflare's own docs are Astro with a
   **bespoke in-house theme** — checked their `package.json`, there is no
   Starlight in it. Matching them exactly would mean building and then owning
   that theme, which is the "docs site becomes a project of its own" risk the
   reviews flagged. Starlight is the same framework with the shape already
   built: left nav, right contents rail, search, copy buttons, dark mode. We
   write content, not chrome.
4. **Phase 5.1: the operator creates the throwaway accounts, I drive the run.**
   Signup needs phone and captcha, which I cannot do. They hand over
   credentials for genuinely disposable accounts; I run setup end to end, log
   every failure directly, fix, and re-run until clean. **Delete those accounts
   afterwards** — that is part of the task, not an afterthought.
5. **Self-hosted installs never auto-apply.** Confirmed. Notify through the
   owner's own bot, apply with `daemonclient update`. No deploy-capable
   Cloudflare token is ever stored inside a worker. The accepted cost: someone
   can sit on a known-vulnerable install indefinitely and we cannot know, by
   design, because we do not know they exist.

### Task 2.7 — Give self-host the same silent refresh hosted has
- **What:** remove the self-host early return in `requireAuth` so both flavours
  renew a session the same way, then set one 30-day TTL.
- **Files:** `immich-api-shim/src/helpers.ts` (~94), `immich-api-shim/src/auth.ts`.
- **How:** `requireAuth` currently does `if (env && isSelfHost(env)) return
  session;` before the expiry check, so a self-hosted session is trusted for its
  whole TTL and its Firebase token is never renewed. A self-hosted install has
  its own `FIREBASE_API_KEY` and the session carries a `refreshToken`, so the
  existing refresh path works there unchanged — **first establish why that early
  return exists** before deleting it, and say so in the task notes. If it guards
  something real, keep the guard and narrow it.
- **Why it matters more than it looks:** on mobile the backup runs in the
  background. An expired session does not show a login prompt — it silently
  stops backing up until the user next opens the app. That is the exact failure
  mode this whole plan is trying to eliminate, so a short TTL without refresh
  would have manufactured a new instance of it.
- **Verify:** `src/session-refresh.test.ts` — a self-host session with an
  expired Firebase token is renewed rather than rejected; a genuinely expired
  *session* (past 30 days) is still rejected; a failed refresh does not fall
  back to accepting the stale token.
- **Depends on:** 2.5 and 2.6, both of which touch the same issuance path.
- **Risk:** medium — it is auth code, in the phase where auth mistakes cost the
  most. Run its gates against 2.5 + 2.6 + 2.7 together.


---

# What the reviews changed

The plan was drafted, then reviewed for security, principles fit, and better
alternatives. This is what the reviews altered, so it is visible that they did
something rather than rubber-stamping.

**Task 2.3 was reversed outright.** As drafted it removed the bot token and ZKE
material from `/api/server/*`. The principles review found those fields are read
by `immich/web/src/service-worker/index.ts` so the browser can pull media bytes
straight from Telegram — the very mechanism that keeps the worker under its
limits. Removing them would have pushed all web media back through the worker
while Phase 3 was busy relieving exactly that load, and would have made browser
uploads fall back to unencrypted, re-arming the Phase 1 bug from the client
side, in the same plan. Verified in the code before accepting. The narrower real
defect is closed by the owner gate alone.

**Task 2.4 became fail-closed.** "No `owner_uid` means allow" is fail-open — a
self-hosted install whose config write failed would have been wide open.

**Two whole tasks were missing (4.8b, 4.8c).** The plan covered the worker and
the dashboard but not Photos and Drive, which is a third of what `PARITY.md`
promises. Worse, the review found `DEFAULT_WORKER_URL = 'https://api.daemonclient.uz'`
in the Photos service worker and a hardcoded operator worker in Drive's **login**
call — so a self-hoster following our own guide would post their password to the
operator's infrastructure. That is a P3 violation and a security bug, and
neither the plan nor `FINDINGS.md` had noticed it.

**Task 1.2b was added.** Phase 1 as drafted fixed the plaintext symptom without
fixing its shape: the CLI regex-scrapes the schema out of the deployment
service's source while a second copy sits unused in `migrations.ts`. That
separation caused the bug and would cause the next one.

**Task 2.6 gained a cutoff.** Gating a security fix on an operator action can
defer it forever.

**Task 3.0 was added** after the operator's device log and their observation
about reopening the app: `filePathCache` is unbounded and never evicts.

**One recommendation was declined.** The principles review argued for cutting
the documentation site (6.2) as scope creep. The operator asked for it
specifically, including the shape they want it to take, so it stays — but it
runs last, renders the markdown that already exists rather than duplicating it,
and ships with real content or not at all.

---

## The security review returned **reject**, and it was right

It came back after the plan was drafted. Its verdict was reject, not
reject-the-idea — the phasing survived, ten specific tasks did not. Folded in
above; the four that mattered:

**Two tasks were aimed at a file nothing imports.** Tasks 1.3 and 1.4 edited
`selfhost/src/deploy.mjs`. It has zero importers — verified. Both fixes would
have been written, tested against a fake D1, passed all four gates, and changed
nothing on a real install. This is the failure mode the gates are least able to
catch on their own: every gate can pass on code that is never executed. Gate 4's
"verified live" is the only one that would have caught it, which is an argument
for taking that gate literally rather than as a formality.

**Two tasks left the system worse than they found it.** Task 2.5 would have
handed an unauthenticated caller a global sign-out switch, because
`handleLogout` is routed before any auth check. Task 2.6 deleted the verifier's
fallback and left the issuer's, so a transient Firestore failure would mint
tokens the hardened fleet rejects.

**A verification step accepted leaving the vulnerability deployed.** Task 2.1's
grep tolerated the SQL injection remaining in `shim-bundle.ts` — the artifact
every hosted worker runs.

**The largest hole was in neither document.** Photos has no ownership check on
any single-asset path, and `albums` has no owner column. That is now Task 2.0,
first in the phase.

### Three of its findings were live, so they were fixed immediately

Not deferred to the plan, because they were exploitable while the plan was being
written. Shipped and verified live — see `FINDINGS.md` §14-16 and commit
`0311248`:

- `daemonclient-proxy` was a **fully open proxy** — any url, any caller, no
  auth, caller's Cookie and Authorization forwarded to the target, every
  response header reflected back with `ACAO: *`. The shim's own `/proxy` was
  closed in `b0202c4`; this is a separate deployment and was missed. Both now
  require the exact host `api.telegram.org`. The suffix rule the shim shipped
  with was itself insufficient: a Cyrillic "а" normalises
  `аpi.telegram.org` to the genuine subdomain `xn--pi-6kc.telegram.org`.
- The bot token was **logged in full** on every Telegram 429.
- `/api/drive/config` — analysed rather than patched. It is contained on hosted
  by the per-worker `SESSION_SECRET`; it is not contained on multi-user
  self-host, which has not shipped. Folded into Task 2.4 instead of rushed.

---

## The alternatives review changed Phase 3 and added a task

It looked for work already done and dependencies not worth their cost. Five of
its findings were corrections rather than suggestions; all five were verified
before being accepted.

**Task 3.2 shrank to almost nothing.** Half of it shipped in April — `getChunk`
already checks the chunk *body* cache before resolving a file path
(`assets.ts:2131-2134`, commit `4b40008`). The other half was actively
dangerous: capping `MAX_CHUNKS_PER_RESPONSE` against a 50-subrequest budget
means a truncated 206, and `assets.ts:2186-2195` records that native players
treat a short 206 as end-of-file — that is the mobile video freeze, and the plan
was about to reintroduce it.

**Task 3.1 was counting the wrong budget.** Free-plan Workers get 50 *external*
subrequests **and** 1,000 to Cloudflare services; D1 is on the second. Checked
against Cloudflare's current limits page and the 2026-02-11 changelog rather
than assumed. Counting D1 into the 50 would have made the worker refuse work it
could afford — the same class of bug Phase 3 exists to remove.

**Task 4.0 was added.** `config.mjs:save()` truncates the config file in place
with no temp file and no fsync, and `STORAGE_KEY` is the one value in it that
cannot be regenerated. An interrupted save loses every file the self-hoster has
stored.

**It independently reached the same conclusion as the principles review on Task
2.3** — that removing `botToken` and the ZKE material from `/api/server/*` would
collapse the browser byte path onto the worker. Two reviews arriving at that
separately is why 2.3 is reversed rather than merely questioned.
