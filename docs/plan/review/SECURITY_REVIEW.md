# Security review of the master plan

**Verdict:** reject

All twelve items in `FINDINGS.md` are scheduled somewhere in the plan — that part
is sound, and the phase ordering (plaintext-at-rest before account takeover
before budget) is the right call. The reject is for four reasons:

1. **Two tasks are aimed at the wrong file.** Task 1.3 and part of Task 1.4 edit
   `selfhost/src/deploy.mjs`, which nothing imports. The fix would ship and do
   nothing, while its test passed. Task 4.1 has the live and dead config modules
   the wrong way round.
2. **Two tasks leave the system worse than before they started.** Task 2.5 turns
   an unauthenticated endpoint into a global session-kill switch. Task 2.6
   deletes the verification-side fallback without touching the issuing-side
   fallback, so the central worker keeps minting tokens the fleet will reject.
3. **The plan's own verification steps tolerate leaving the vulnerability in the
   artifact that is actually deployed.** Task 2.1's Verify explicitly accepts
   `finalize-client-upload` remaining in `deployment-service/src/shim-bundle.ts`
   — the code every hosted worker runs.
4. **The largest cross-user hole in the worker is in neither document.** Photos'
   single-asset paths carry no ownership check at all, and the `albums` table has
   no owner column. On a self-hosted install that is cross-user read, modify and
   irreversible delete by asset id. `FINDINGS.md` §3 stops at *reading config*;
   the real boundary failure is one layer down.

The plan is good work and most of it should survive. It needs a revision pass,
not a rewrite. What would change the verdict is at the end.

---

## Blockers

*(must fix before implementation starts)*

### B1 — Task 1.3 targets a module nothing imports

The task's **Files** are `selfhost/src/commands/setup.mjs` and
`selfhost/src/deploy.mjs`. `selfhost/src/deploy.mjs` has **zero importers** in the
repository. The live path is `selfhost/src/build.mjs` (`readMigrationSql` at
`build.mjs:37-57`, imported by `setup.mjs:23` and `update.mjs:17`);
`deploy.mjs:126-139` is a byte-identical dead copy. Task 1.4 repeats the mistake:
it lists `deploy.mjs` as a place to delete `STORAGE_KEY`, but the live
`secret_text` binding is written at `setup.mjs:421-422` and `update.mjs:116-117`,
not through `deploy.mjs:76-82`.

Consequence: the key-seeding code is written, the unit test against a fake D1
passes, all four gates go green, and a real `daemonclient setup` still leaves
`zke_password=''`. The plaintext bug Phase 1 exists to fix survives Phase 1.

**Fix.** Re-target 1.3 at `selfhost/src/commands/setup.mjs` (the existing D1 REST
pattern is `setup.mjs:441-449`) and `selfhost/src/api/cloudflare.mjs`
(`queryD1`, `api/cloudflare.mjs:228-232`). Add to Verify: *after seeding, read
`zke_password` back over REST and assert it is non-empty* — an end-to-end
assertion the dead-module mistake could not have passed. Re-target 1.4 at
`setup.mjs:389`, `setup.mjs:421-422`, `update.mjs:116-117`, `state.mjs:15-21`.

Related trap for 1.4: `deployment-service/src/index.ts:40` also declares
`ENCRYPTION_MASTER_KEY`, and there it is **real** — it encrypts every user's
stored Cloudflare API token (`index.ts:6-35`, used at `index.ts:581`). Task 1.4's
Verify greps only `immich-api-shim/src`, which is correct, but say explicitly in
the task that the deployment-service binding must not be touched.

### B2 — Task 1.3's idempotency check is not sufficient, and its test skips the case that destroys data

*"`SELECT value FROM config WHERE key='zke_password'`. Only if empty, generate and
UPDATE."* Three ways that loses every stored photo:

1. **A failed SELECT is indistinguishable from an empty one.** The CLI's D1 REST
   helper (`api/cloudflare.mjs:228-232`) returns a result envelope; a network
   error, a 5xx, an expired Cloudflare token or a shape change all read as "no
   rows" to a naive caller. `setup.mjs:262-265` already demonstrates the house
   habit of swallowing D1 errors that match a pattern. "Not empty" must be the
   only outcome that permits proceeding; everything else must abort, not seed.
2. **Concurrent runs.** Two `daemonclient setup` invocations — or one the user
   thought had hung, plus the retry — both SELECT empty and both UPDATE. The
   second overwrites the first, and every photo uploaded between them is
   undecryptable. There is no transaction across two HTTP calls to D1.
3. **`zke_password` set but `zke_salt` empty**, or the reverse. The plan checks
   one key.

**Fix.** Do not read-then-write. Make the write conditional in one statement,
then read back and use whatever is actually there:

```sql
UPDATE config SET value = ?1 WHERE key = 'zke_password' AND (value IS NULL OR value = '');
UPDATE config SET value = ?2 WHERE key = 'zke_salt'     AND (value IS NULL OR value = '');
```

then `SELECT value FROM config WHERE key IN ('zke_password','zke_salt')` and
**abort setup with a named error if either is still empty** — never proceed to
deploy with half-seeded key material. Require the test to cover: SELECT throws;
SELECT returns `{success:false}`; SELECT returns an unexpected shape; password
set but salt empty; two concurrent seeds. The Verify as written ("a fake D1 with
empty keys gets written once; a second run leaves the existing values untouched")
tests only the two paths that were never going to be the problem.

Note the hosted path guards the same invariant differently — `isNewDatabase`
(`deployment-service/src/index.ts:331`), not a SELECT. Two mechanisms for one
invariant is a `PARITY.md` problem in its own right; say which is canonical.

### B3 — Task 2.5 lets an unauthenticated caller log out the whole install

`handleLogout()` is reached at `auth.ts:38-40`, **before any authentication
check**, and takes no arguments (`auth.ts:149`). Task 2.5 gives it `(request,
env)` and has it increment a `session_epoch` in the config table.

As written, `POST /api/auth/logout` with no credentials invalidates every session
on the worker. On a self-hosted install that is a permanent, repeatable denial of
service anyone on the internet can run in a loop. Today the same request is
harmless. This is the clearest case of a task leaving the system worse than it
found it.

Two further defects in the same task:

- **The epoch is install-wide.** One counter in a shared self-host D1 means one
  user's logout ends every user's session. It must be keyed per uid.
- **The central worker cannot stamp the epoch.** Tokens are issued by
  `handleLogin` on the *central* worker (`auth.ts:47-137`), which has **no D1
  binding** — `immich-api-shim/wrangler.toml:14-20` comments it out deliberately.
  The epoch lives in the per-user worker's D1. The issuer cannot read the value
  it is meant to stamp. The task is unbuildable for hosted as described.

**Fix.** (a) `handleLogout` must `requireAuth` first and 401 without a valid
session. (b) Key the epoch per uid. (c) Decide where the epoch lives for hosted
— either the per-user worker mints its own session on first contact, or a token
with no epoch claim is accepted once and re-issued. Whichever, write it down;
the current text does not survive contact with the deployment topology.

Also budget it: an epoch check in `requireAuth` is a D1 read on **every**
authenticated request. Phase 3 exists because the subrequest cap is already
blown. Adding one per request in Phase 2, before 3.1's counter exists, is a
regression the plan does not account for. Cache it per isolate with a short TTL,
and say so in the task.

### B4 — Task 2.6 deletes the verifier's fallback and leaves the issuer's

Task 2.6's **Files** are `selfhost-auth.ts:44` and `auth-security.test.ts:86-93`.
The issuing side is not listed. It is `auth.ts:96`:

```ts
}, userSessionSecret || env.APP_IDENTIFIER || 'default');
```

1. `userSessionSecret` is set only when `firestoreGet` succeeds *and* returns a
   `sessionSecret` of length ≥ 32 (`auth.ts:84-86`), and the whole lookup is
   wrapped in `catch {}` (`auth.ts:87`). `firestoreGet` returns `null` on **any**
   non-2xx, including 401/403/5xx (`helpers.ts:165-172`). A transient Firestore
   blip at login therefore mints a token signed with `APP_IDENTIFIER` — which,
   after 2.6, every worker rejects. The user gets a 401 loop, no diagnostic, no
   way out. This is not a rollout-window problem; it is permanent, and it fires
   on the flakiest dependency in the login path.
2. There is a **third** fallback the plan never mentions: `|| 'default'`. If
   `APP_IDENTIFIER` is empty, sessions are signed with the literal string
   `default`. The same literal is at `selfhost-auth.ts:44`.
3. `requireAuth(request, env?)` takes env as **optional** (`helpers.ts:79`) and
   passes `env || ({} as Env)` to `sessionScope` (`helpers.ts:92`). Any call site
   that omits env verifies against scope `'default'`. Every current call site
   passes env; nothing enforces it. In a public repo taking outside
   contributions, this is the exact shape of the two bypasses that already
   shipped.

**Fix, all four parts.**
- `auth.ts` must **fail the login** with a distinct error when no per-worker
  secret can be read. Remove the bare `catch {}`; distinguish "this worker has no
  secret" from "Firestore is down" and say which.
- Delete `|| 'default'` in both places at the same time as `|| env.APP_IDENTIFIER`.
- Make `env` required on `requireAuth`, and make `sessionScope` throw for hosted
  as it already does for self-host (`selfhost-auth.ts:36-43`). A worker with no
  secret must refuse to serve — which is what `SECURITY.md:50-51` already claims
  it does.
- Do **not** remove `APP_IDENTIFIER` from `wrangler.toml`. It is also a Firestore
  document path component (`helpers.ts:143`, `helpers.ts:206`); deleting the var
  moves every hosted user's config to a different path.

### B5 — Task 2.6's fleet gate is a human promise, and the mechanism can undo itself

**Depends on:** *"operator confirms the fleet is redeployed."* There is nothing to
confirm it with. `/admin/force-update`
(`deployment-service/src/index.ts:570-611`) takes `accountId, workerName,
databaseId, apiToken, sessionSecret` **from the request body** and runs one user
at a time; no endpoint enumerates users or reports which workers hold a secret.

The mechanism can regress after being "confirmed": `buildShimBindings` adds the
`SESSION_SECRET` binding only when `sessionSecret` is truthy
(`deployment-service/src/index.ts:88-91`), and a Cloudflare script PUT replaces
the whole binding set. A force-update that omits `sessionSecret` **strips** it
from a worker that had one — the comment at `index.ts:587-589` says as much.
Note also that `auth.ts:84` requires `length >= 32`; a shorter stored secret reads
as absent, so a presence check is not enough.

**Fix.** Before 2.6, add an ADMIN_SECRET-gated `GET /admin/fleet-audit` that walks
provisioned users and reports, per user: `sessionSecret` present, its length, and
the deployed `SHIM_VERSION`. Make 2.6's Verify *"fleet-audit reports zero users
without a ≥32-char secret"* — a command with output, not a recollection. Make
`handleForceUpdate` refuse (400) when `sessionSecret` is absent but the stored
config has one.

**And constrain the endpoint itself before running it across the fleet.** Task
2.6 requires exercising `/admin/force-update` for every user, which is the moment
to notice what it currently accepts:

- `migrationSql` from the request body is executed verbatim against a user's D1
  (`index.ts:576`, `index.ts:589`) — arbitrary SQL, no allowlist.
- `sessionSecret` from the request body becomes the worker's signing key
  (`index.ts:598`) — whoever holds `ADMIN_SECRET` can set a known signing key and
  then mint sessions for that user.
- The gate is `secret !== env.ADMIN_SECRET` (`index.ts:573`, and identically at
  `:617`, `:641`) — a short-circuiting string compare, with **no rate limiting**
  anywhere in the service, and `Access-Control-Allow-Origin: '*'` plus
  `Access-Control-Allow-Headers: … X-Admin-Secret` (`index.ts:157-159`) so any
  web page can preflight and send it.

So `ADMIN_SECRET` is not a redeploy key, it is a fleet-wide account-takeover key.
Use `timingSafeEqual` (it already exists at `webdav.ts:202-208`), drop
`X-Admin-Secret` from the CORS allow-list, and constrain `migrationSql` to a
server-side named migration rather than free text.

### B6 — Task 2.1's Verify accepts leaving the SQL injection in the deployed artifact

The Verify reads: *`grep -rn "finalize-client-upload" … returns only the bundled
copy and the roadmap mention`*. The "bundled copy" is
`deployment-service/src/shim-bundle.ts:9979`, and `SHIM_BUNDLE` is the worker code
uploaded to **every hosted user's account** (`deployment-service/src/index.ts:346-349`,
`:600-604`). The bundle is regenerated by hand via
`deployment-service/scripts/embed-shim.mjs`; it is **not** wired into any npm
script (`deployment-service/package.json` `deploy` is a bare `wrangler deploy`).

So a fix to `immich-api-shim/src` can pass every gate, be committed, and reach
nobody. This applies to all of Phases 1 and 2. `GATES.md:111-112` asks only for
"deployed, then `/api/health` … checked" — one worker.

**Fix.** Add to `GATES.md` gate 4 and to every worker task's Verify: *the shim was
rebuilt, `SHIM_VERSION` changed, the deployment service redeployed, and
fleet-audit (B5) shows the fleet on the new version.* Change 2.1's Verify to
`grep … returns nothing outside docs/`. If Task 5.4's release automation is what
makes this bearable, move it forward — a security phase that ships to nobody is
not a security phase.

### B7 — Photos has no ownership check on any single-asset path

Not in `FINDINGS.md`, not in the plan, and larger than finding 3.

The `photos` table has `ownerId TEXT NOT NULL`
(`deployment-service/src/index.ts:97`) and every *list* query filters on it. The
*single-row* accessors do not:

- `d1-adapter.ts:71-77` `getPhoto(id)` → `SELECT * FROM photos WHERE id = ?`
- `d1-adapter.ts:122-131` `updatePhoto(id, fields)` → `UPDATE photos SET … WHERE id = ?`
- `d1-adapter.ts:135-137` `deletePhoto(id)` → `DELETE FROM photos WHERE id = ?`

`loadPhotoById` (`assets.ts:1651-1657`) takes `uid` and, on the D1 branch, never
uses it. Everything downstream inherits that: `handleThumbnail`
(`assets.ts:1893`), `handleOriginal` (`assets.ts:2090`), `handleMediaHead`
(`assets.ts:2040`), `handleChunkManifest` (`assets.ts:1642`), `handleReplaceVideo`
(`assets.ts:1666`), `handlePlaybackRendition` (`assets.ts:1735`),
`handleThumbnailUpload` (`assets.ts:1787`), `handleUpdateAsset`
(`assets.ts:611-617`), `handleBulkUpdate` (`assets.ts:717`), and
`handleDeleteAssets` (`assets.ts:646-675`) — which deletes the Telegram messages
at `assets.ts:663-668` **before** tombstoning the row, so the delete is
irreversible. `handleAssetInfo` (`assets.ts:567-581`) reads any row and then
stamps the requester as its owner via `toAssetResponseDto(photo, uid)`.

Albums are worse: the `albums` table has **no `ownerId` column at all**
(`deployment-service/src/index.ts:118-122`), `listAlbums()`
(`d1-adapter.ts:236-241`) is `SELECT * FROM albums ORDER BY updatedAt DESC`, and
`albums.ts:23-33` attaches `ownerId: uid` to whatever comes back.

Drive does it correctly — `drive.ts:150-151`:
`if (!existing || existing.ownerId !== uid) return json({message:'Not found'}, 404)`.
That asymmetry is the tell that this is an oversight, not a deliberate
single-tenant assumption.

On hosted (one worker, one D1, one user) the blast radius is nil. On a
self-hosted install with more than one registered account it is cross-user read,
modify and permanent delete by guessing or observing an asset id.
`CONTRIBUTING.md:100-101` names this exact class — *"per-user data reached
without an owner filter"* — as one of the three things to be careful about.

**Fix.** A Phase 2 task of its own, before 2.4. Add `ownerId` to the single-row
accessors (`getPhoto(id, ownerId)`, `updatePhoto(id, ownerId, fields)`,
`deletePhoto(id, ownerId)`) so the filter cannot be forgotten at a call site; add
`ownerId` to the `albums` schema and scope `listAlbums`/`getAlbumAssets`. Verify
with a two-user D1 fixture asserting 404 for every single-asset route, not a
smoke test on one user.

### B8 — `/api/drive/config` lets any authenticated account take over the install's Telegram storage

Also in neither document.

```
drive.ts:66-74   POST /api/drive/config
  merged.botToken  = body.botToken      // any authenticated caller
  merged.channelId = body.channelId
  await db.setJsonConfig('telegram', merged);
```

`setJsonConfig` writes the install-wide `config` row (`d1-adapter.ts:290-292`),
and `getConfig` has no owner scoping (`d1-adapter.ts:266-272`). On a self-hosted
install — one worker, one D1, open Firebase signup — anyone who can register can
point the install's Telegram bot and channel at their own. Every subsequent
Photos upload (which reads the same `telegram` config through `getCachedConfig`)
and every Drive upload then lands in the attacker's channel.

`SECURITY.md:67` lists exactly this outcome as fixed on 2026-07-21. It is open
again through a different door.

Three more in the same handler:

| Route | Line | Any authenticated user can |
|---|---|---|
| `GET /api/drive/config` | `drive.ts:50-59` | read the bot token in cleartext — a **third** endpoint doing what 2.3 removes from two |
| `GET /api/drive/zke` | `drive.ts:88-91` | read `drive_zke` verbatim, **including `password` and `salt`** — the live decryption key for all Drive content and the WebDAV mount (`webdav.ts:296-298`) |
| `POST /api/drive/zke` | `drive.ts:93-106` | overwrite that key — orphans the owner's Drive files, or in `auto` mode sets one the attacker knows |
| `POST /api/drive/dav` | `drive.ts:180-185` | overwrite the single install-wide `dav` record, silently revoking the owner's mount |

**Fix.** Bring `drive.ts` into 2.3 and 2.4 explicitly. `GET /api/drive/config`
genuinely needs the bot token (the browser uploads straight to Telegram), so it
cannot be blanked like `/api/server/telegram-config` — it must be
**owner-gated**, which makes 2.4 a hard prerequisite for the Phase 2 exit
criterion *"No route returns key material or a bot token"* rather than an
independent task. Add to 2.3's Verify: an enumeration of every route reading
`telegram`, `zke_*` or `drive_zke`, with a test per route.

### B9 — `daemonclient-proxy` is a fully open proxy, and it is the one clients actually use

`FINDINGS.md` does not mention it; `SECURITY.md:66` says the open proxy was fixed
on 2026-07-26. The worker's own `/proxy` (`index.ts:182-217`) *was* fixed. The
proxy in the data path was not.

`TELEGRAM_PROXY = "https://daemonclient-proxy.sadrikov49.workers.dev"` is baked
into every provisioned worker (`immich-api-shim/wrangler.toml:10`,
`deployment-service/wrangler.toml`, `deployment-service/src/index.ts:82`) and
handed to clients at `drive.ts:57` (`proxyUrl: env.TELEGRAM_PROXY || null`,
unconditionally) and `server.ts:107`.

`daemonclient-proxy/src/index.js`:

- line 4 — `const targetUrl = url.searchParams.get("url")`. **No allowlist, no
  scheme check, no host check anywhere in the file.**
- line 24 — `new Headers(request.headers)`: forwards **every** inbound header,
  including `Authorization` and `Cookie`, to whatever host the caller names
  (only `Host`/`Cf-Ray`/`Cf-Visitor`/`Cf-Connecting-Ip` are stripped, lines 27-30).
- line 36 — `redirect: "follow"`.
- lines 34, 40-41 — arbitrary method, arbitrary streamed body.
- lines 52-59 — full upstream response returned with
  `Access-Control-Allow-Origin: "*"` and `Access-Control-Expose-Headers: "*"`, so
  any web page can read the response of any cross-origin request it makes
  through it.
- No auth, no rate limit.

`PHASE_6.md`/Task 6.5 correctly flags `daemonclient-proxy` as *live and not
deletable* — but treats that as a cleanup constraint, not a security finding.

**Fix.** This is a Phase 2 task, not a Phase 6 one: apply the same host allowlist
the shim's `/proxy` already has, stop forwarding `Authorization`/`Cookie`, set
`redirect: 'manual'`, and stop returning `Expose-Headers: *`. Then either point
`TELEGRAM_PROXY` at the per-user worker's own `/proxy` (`drive.ts:57` already has
`server.ts:103`'s `selfProxy` pattern available) or retire it. Note this is also
a P3 violation: a self-hosted install handed this URL depends on infrastructure
the operator runs.

### B10 — Task 2.4's owner gate fails open, and cannot be provisioned where the plan schedules it

**Fails open.** *"Absent (hosted), behave as now."* `owner_uid` would live in the
same D1 `config` table read by `getConfig`, which returns `result?.value || null`
(`d1-adapter.ts:266-272`) and cannot distinguish a missing row from a failed
query. A transient D1 error disables the gate and re-opens finding 3 for the
duration. The signal that a worker is self-hosted is `env.SELF_HOST` — an env
var, which cannot transiently vanish.

*Fix:* gate on `isSelfHost(env)` first; if self-host and `owner_uid` cannot be
read, **refuse** (503) rather than falling through to hosted behaviour. Also
verify no route lets a caller choose a config key: `policy.ts:29` writes
`session:${sessionId}`, and that prefix is now load-bearing — comment it.

**Cannot be provisioned in Phase 2.** The task writes `owner_uid` in
`selfhost/src/commands/setup.mjs`, which is currently broken: it calls four
functions that do not exist on the Cloudflare module — `setup.mjs:211
cf.listAccounts`, `setup.mjs:273 cf.getWorkersSubdomain`, `setup.mjs:424
cf.deployWorker`, `setup.mjs:425 cf.enableWorkersDev` (exports are enumerated in
`selfhost/src/api/cloudflare.mjs`). Task 4.3 rewrites the file for exactly this
reason. So the owner_uid write goes into a file that cannot run, and the 4.3
rewrite is liable to drop it.

Worse, `setup.mjs:211` throws a `TypeError` that is caught by the retry loop at
`setup.mjs:214-219`, which blanks the token (`:218`) and **re-prompts for the
Cloudflare API token forever**, telling the user their token is wrong. Anyone
running setup today pastes a live Cloudflare token repeatedly into that loop.

The same blocks Task 1.3. **Phase 1's exit criterion "A fresh self-host setup
produces working encryption" cannot be demonstrated until 4.3 lands.**

*Fix:* move the setup repair ahead of the tasks that depend on it — either
promote 4.3, or split a minimal "make setup runnable" task into Phase 1 and make
1.3 and 2.4 depend on it. Add "does not lose 1.3's seeding or 2.4's owner_uid
write" to 4.3's Verify.

---

## Important

*(must fix before that task is committed)*

### I1 — Task 1.1's fail-closed has three holes

**(a) `client=true` bypasses it entirely.** `assets.ts:1060`:

```ts
const isClientZke = zkeConfig.mode === 'client' || request.url.includes('client=true') || clientUpload;
```

`isClientZke` short-circuits `getEncryptionKey` at `assets.ts:1063`, so
`POST /api/assets?client=true` writes plaintext to Telegram regardless of key
material, and nothing verifies the bytes were actually encrypted client-side.
It is `request.url.includes(...)` — a substring test over the whole URL — so any
query parameter whose *value* contains that string triggers it. Task 1.2 will
still report `enabled: true`, because it reads only the config. Phase 1's central
claim, *"no endpoint can claim otherwise"*, is false while this stands.

*Fix:* require the explicit `clientUpload` form field (already read at
`assets.ts:1037`), delete the URL substring test, and refuse the request when
`zke_mode` is `server` but the caller asserts client-side encryption.

**(b) Absent config is treated as "off".** `getZkeConfig` returns `null` when the
`zke_mode` row is missing (`d1-adapter.ts:313`); `getEncryptionKey` returns `null`
and the upload proceeds in plaintext. This is reachable: the schema is scraped
out of a TypeScript template literal by `build.mjs:37-57`, which stops at the
**first** backtick after the opener — an interpolation or escaped backtick added
to `MIGRATION_SQL` truncates the SQL silently, and `setup.mjs:262-265` swallows
the resulting errors matching `/already exists|duplicate column/i`. A truncated
schema with no `config` table reproduces the exact bug Phase 1 is fixing, and
`doctor.mjs:66` only checks that `photos` and `config` exist.

*Fix:* fail closed on *"ZKE config could not be read"* as well as *"enabled but
empty"*. Only an explicit `zke_mode='off'` may produce plaintext. Separately,
`build.mjs`'s scrape needs a sanity assertion (every table the code reads is
present in the scraped SQL) before 1.3 relies on the `config` table existing.

**(c) The error message reaches the client.** `index.ts:263-269` returns
`err.message` for any non-auth throw; `assets.ts:583` does it explicitly
(`'Error fetching asset: ' + err?.message`). Task 1.1's "clear 5xx naming the
fix" becomes an information channel, and it is the same channel through which a
D1 error — SQL fragments, column names — will surface once Task 2.2 starts
rejecting columns. It already leaks `selfhost-auth.ts:40-42`'s configuration
diagnostic as a 500 body.

*Fix:* log the detail, return a stable code. Test that a deliberately-thrown
internal error does not appear in the response body.

### I2 — Task 2.2 fixes one of five identical injection sites

`FINDINGS.md` §2 and Task 2.2 name `savePhoto` (`d1-adapter.ts:100-115`). The
same interpolated-identifier pattern is at:

- `d1-adapter.ts:129-131` — `updatePhoto`, `` `${k} = ?` `` into `UPDATE photos SET …`
- `d1-adapter.ts:215-220` — `saveAlbum`
- `d1-adapter.ts:382-385` — `saveFile`
- `d1-adapter.ts:392-394` — `updateFile`

The task's stated purpose is *"2.1 removes today's route, this removes the
class"*. It removes one fifth of it. The other four are fed hardcoded key
literals today (`assets.ts:603-609`, `:717`, `drive.ts:127-140`, `:152-156`), so
they are not exploitable — which is exactly the protection that rots.

*Fix:* one shared `assertColumns(table, keys)` used by all five, with column sets
derived from `MIGRATION_SQL` so they cannot drift from the schema
(`schema-columns.test.ts` exists and should assert the sets match). Test all five
with Task 2.2's crafted key, not just `savePhoto`.

### I3 — `/api/assets/zke-toggle` lets any authenticated account disable encryption for the install

`assets.ts:244-277`. `POST {mode:'off'}` writes `zke_enabled=0` to the shared
config table. On self-host, any registered account silently downgrades the
owner's future uploads to plaintext. Task 1.1 will treat that as *deliberate*
plaintext and permit it; Task 1.2 will honestly report `enabled:false`, but only
if the owner looks.

The route also holds an HTTP-reachable key-generation path
(`assets.ts:251-259`), guarded by `if (existing?.password && existing?.salt)` —
the same read-then-write shape as B2. If `getZkeConfig` returns `null` for any
reason, the else branch writes **new** key material and orphans every stored
photo.

*Fix:* fold into 2.4's owner gate; make the key-generation branch conditional in
SQL as in B2; add it to 1.1's test file.

### I4 — The full Telegram bot token is written to the worker's logs

`assets.ts:3097`:

```ts
console.warn(`[tgFetch] 429 on ${url.substring(0, 80)}..., waiting ${retryAfter}s …`);
```

`url` is `https://api.telegram.org/bot<TOKEN>/<method>`. The prefix through
`/bot` is 28 characters, so `substring(0, 80)` retains 52 characters of what
follows — a Telegram bot token is about 46. **The complete token lands in Workers
logs on every Telegram 429**, which is the highest-volume path there is. The same
line is in the shipped bundle (`deployment-service/src/shim-bundle.ts`).

`GATES.md:23-25` asks of every task: *"Can any secret reach a log …? Trace each
one from where it enters to where it rests."* This one already has. It needs its
own task in Phase 1 or 2 — it is one line, and it is the kind of thing a
contributor will find within a day of the repo going public.

*Fix:* log the method, never the URL. Grep for every `console.*` that takes a
Telegram URL and audit the same way.

### I5 — `/validate-cf-token` is a public Cloudflare-token validation oracle

`deployment-service/src/index.ts:257` routes it with **no authentication**;
`handleValidateToken` (`index.ts:655-669`) forwards the caller's string to
`https://api.cloudflare.com/client/v4/accounts` and returns
`{valid, accountId, accountName}`. `Access-Control-Allow-Origin: '*'`
(`index.ts:157`), no rate limit.

Any web page can call it. It is an ideal back end for a phishing page that wants
to confirm harvested Cloudflare tokens — and disclose the account they belong to
— without touching Cloudflare from attacker infrastructure.

*Fix:* require a valid Firebase ID token (`validateFirebaseToken` already exists
at `index.ts:671`), and tighten the CORS origin. Phase 2.

### I6 — CORS reflects any origin containing the substring `localhost`, with credentials

`index.ts:121`:

```ts
const isAllowed = allowed.includes(origin) || origin.includes('localhost');
```

`https://localhost.attacker.example` satisfies that, and the origin is then
reflected into `Access-Control-Allow-Origin` (`index.ts:123`) alongside
`Access-Control-Allow-Credentials: 'true'` (`index.ts:126`). Today the damage is
contained because the session cookies are `SameSite=Lax` (`auth.ts:130-136`), so
a cross-site `fetch` carries no cookie — but that is a property of a different
file, and it stops being true the moment anything relaxes SameSite. The headers
are applied to every response, including `/proxy` and the stubs
(`index.ts:256-259`).

`http://localhost:5173` is already in `ALLOWED_ORIGINS`
(`immich-api-shim/wrangler.toml:11`, and the self-host default at
`selfhost/src/deploy.mjs:29`, `setup.mjs:417`, `update.mjs:109`,
`dashboard.mjs:152`), so the substring branch buys nothing.

*Fix:* delete the substring test; exact-match a parsed allowlist, permitting
`localhost`/`127.0.0.1` only as an exact hostname. Test with
`https://localhost.evil.com`. Also note `index.ts:120`
(`env.ALLOWED_ORIGINS.split(',')`) throws when the var is unset, so a
self-hosted worker missing it 500s on every request.

### I7 — Media responses are cached publicly at the Cloudflare edge

`assets.ts:2021-2023` serves thumbnails with

```
Cache-Control: public, max-age=31536000, immutable
CDN-Cache-Control: public, max-age=31536000
Cloudflare-CDN-Cache-Control: public, max-age=31536000
```

and originals with `public, max-age=86400, immutable` (`assets.ts:2155`,
`:2317`). Cloudflare caches a response to a request bearing an `Authorization`
header **precisely when** the response is marked `public`. Once cached, the same
URL is served to a request with no credentials at all, and the `requireAuth` at
`assets.ts:190` becomes decorative for that URL. Asset ids are UUIDs and so not
guessable, but they are not secret — they appear in the sync stream, in share
links, and in screenshots attached to bug reports.

Task 3.6 edits this exact block.

*Fix:* `private` on every authenticated media response; drop the
`CDN-Cache-Control` pair. Add to 3.6.

### I8 — The chunk body cache writes decrypted plaintext under a routable URL

`assets.ts:2132`:

```ts
const ck = new Request(`${url.origin}/chunk-cache/${chunk.file_id}`, { method: 'GET' });
```

and the value stored at `assets.ts:2146` is `data` *after* `decryptChunk`
(`assets.ts:2144`) — 19 MB of plaintext photo written into `caches.default` with
`Cache-Control: public, max-age=86400`, keyed on a URL on the worker's **own
origin**. On an orange-clouded custom domain (hosted runs on
`api.daemonclient.uz`) that key is in the cache that fronts the worker, so
`GET https://api.daemonclient.uz/chunk-cache/<file_id>` can be answered without
reaching the router. Exploitation needs a Telegram `file_id` (60+ chars, not
guessable), so this is defence-in-depth rather than a live break — but the
file-path cache two hundred lines below already does it correctly with a
synthetic host, `https://dc-tg-path/${fileId}` (`assets.ts:3118`). The body cache
is the odd one out.

Tasks 3.1, 3.2 and 3.3 all rewrite this function.

*Fix:* non-routable synthetic origin, and derive the path from
`HMAC(SESSION_SECRET, file_id)` so the key is unguessable even if a `file_id`
leaks. Add to 3.2's Verify: *no cache key shares an origin with the worker.*

### I9 — Task 4.1 deletes the live secret store and leaves the secrets on disk

The direction is right; the facts are inverted.

- `state.mjs` is the **live** store — imported by setup, status, update,
  processor, dashboard and doctor, writing `<cwd>/.daemonclient-selfhost.json`
  (`state.mjs:12`, `:40-53`) with `cloudflareToken`, `telegramBotToken`,
  `sessionSecret` and `storageKey`.
- `config.mjs` is **dead** apart from one exported constant — its only importer
  is `api/cloudflare.mjs:26` for `HOSTILE_ENV_VARS`. `save()`, `load()`,
  `redact()` and `checkPermissions()` have zero callers.
- `env.mjs` has **zero importers at all**.

So the task is a migration of the live store, not a deletion of dead ones, and
nothing in it deletes files. The Verify (`grep -rn "state.mjs\|env.mjs"
selfhost/` returns nothing) passes while every existing install keeps a 0600 file
in the repo clone holding four live secrets, plus a second copy now in
`~/.config`. Three consequences:

1. `~/.config/daemonclient/config.env` has **no `.gitignore` rule** —
   `.gitignore:5-6` match `.env` and `.env.*`, not `config.env` — and
   `config.mjs:70-71` honours a `DAEMONCLIENT_CONFIG` override with no path
   validation. Pointed inside the clone, that is a committable secret file.
2. `.daemonclient-selfhost.json` *is* gitignored, which means `git clean -xdf`
   deletes it, and with it `storageKey`. `SECURITY.md:71-72` and
   `docs/SELF_HOSTING.md` still tell users to back that file up.
3. `state.mjs:35` renames a corrupt state file to
   `.daemonclient-selfhost.json.corrupt-<ts>` and never removes it. Each is a
   full secret snapshot; they accumulate indefinitely.

*Fix:* rename the task "migrate to one config store". It must (a) copy the state
across, (b) `unlink` the old file and every `.corrupt-*` sibling after a verified
migration, (c) add `config.env` to `.gitignore` and refuse a `DAEMONCLIENT_CONFIG`
path inside a git work tree, (d) update `SECURITY.md:71` and
`docs/SELF_HOSTING.md` in the same commit. Verify must assert the old file is
gone, not just that the import is.

### I10 — Task 4.4's "the report contains no secret" passes by luck

`doctor.mjs:168` prints *"Report (safe to share — secrets are removed)"*.
`doctor.mjs:170-181` calls `redact()` (`state.mjs:68-81`) on a hand-built object
literal containing **no key in `SECRET_KEYS`** (`state.mjs:15-21`). The redactor
removes nothing; the safety is the manual whitelist at `doctor.mjs:171-180`. Any
field a contributor adds gets no protection unless its name happens to collide.
`SECRET_KEYS` also omits `firebaseApiKey`, `adminEmail`, `adminUserId` and
`telegramChannelId`.

The report prints `workerUrl` unredacted (`doctor.mjs:172`) — a live,
internet-reachable API endpoint — inside the "safe to share" block, and prints
`firebaseProjectId` (`doctor.mjs:78`) and the bot's `@username`
(`doctor.mjs:104`) into the same scrollback a user would copy.
`CONTRIBUTING.md:116` tells people to attach it to bug reports.

*Fix:* redact the **whole state object** and render from the redacted copy, so
the default for a new field is redacted. Verify must be: *add a field named
`xyzToken` with a known value, run doctor, assert the value does not appear in
stdout* — a test that fails if the protection is removed. Extend `SECRET_KEYS`.
Decide deliberately whether `workerUrl` belongs in a shareable report.

### I11 — The processor's unknown-`kid` path is an unauthenticated outbound amplifier, and its comment says the opposite

`processor/api/convert.js:99-106`:

```js
let certs = await googleCerts();
if (!header.kid || !certs[header.kid]) {
  // … The result is cached either way, so this cannot be used to force
  // repeated outbound requests.
  certs = await googleCerts(true);
}
```

`googleCerts(true)` ignores the cache unconditionally (`convert.js:32`). A token
carrying a `kid` Google does not publish forces a fresh `fetch(CERTS_URL)` on
**every** request, before any signature check. The comment's claim is false.
Anyone can hold a processor's outbound quota open, burn its free-tier
invocations, and get it rate-limited by Google.

Two smaller ones in the same function: `certs[header.kid]` is a raw property read
on a `JSON.parse` result, so `kid: "constructor"` returns a truthy prototype
member (it then throws in `keyFromCert` and 401s, so not exploitable — but use
`Object.prototype.hasOwnProperty.call`); and `MAX_BYTES` is checked at
`convert.js:170`, *after* `await request.arrayBuffer()` at `:168` has buffered
the whole body.

Everything else in `verifyToken` is correct and worth saying so: `alg` is pinned
to RS256 (`:97`) rather than read from the token, `aud` and `iss` are both checked
against `PROJECT_ID` (`:119-120`), `exp` is checked (`:118`), the `OWNER_UID` pin
is applied last (`:126`), and a missing `PROJECT_ID` fails closed (`:81`).

*Fix:* rate-limit the forced refetch — at most once per five minutes, tracked
alongside `certsCache`. Add to Task 4.6.

### I12 — Task 4.6 lets an unpinned processor deploy succeed with a warning

Verify: *"a health response lacking `ownerPinned` produces a warning."* A warning.
`convert.js:126` is `if (OWNER_UID && uid !== OWNER_UID)` — an empty `OWNER_UID`
means any account in the Firebase project may use the instance, which on
self-host with open signup is an anonymous HEIC-conversion service on the owner's
Vercel quota. Note the asymmetry: a missing `FIREBASE_PROJECT_ID` fails closed
(`convert.js:81`); a missing `OWNER_UID` fails open.

Ordering compounds it: `OWNER_UID` is the Firebase uid, produced by Task 4.5, but
4.6 **Depends on: 4.3**, not 4.5. Run in the order the plan permits, the
processor deploys before the uid exists and can only be unpinned.

Two more from the same area:
- The processor URL is accepted with no scheme validation (`setup.mjs:531`,
  `processor.mjs:64`) and persisted as `heicConvertUrl` (`setup.mjs:568`,
  `processor.mjs:106`). The worker POSTs **user photo bytes** to that URL; an
  `http://` value sends image data in cleartext, and the CLI neither blocks nor
  warns.
- `handleHealth` is unauthenticated by design (`convert.js:201-205`), which is
  reasonable, but it also confirms to a stranger that the instance is unpinned
  and therefore usable.

*Fix:* make 4.6 depend on 4.5; refuse to deploy without `OWNER_UID` (an
`--allow-unpinned` escape hatch if needed); reject non-`https:` processor URLs in
the CLI *and* worker-side before posting bytes.

### I13 — Task 4.2's hostile-env detection is defeated three lines away

The task wires the two existing detectors into preflight — correct as far as it
goes. But `childEnv()` (`api/cloudflare.mjs:48-62`) is a deliberate allowlist
that strips `HOSTILE_ENV_VARS` (`:55`), and three call sites bypass it with a
full `...process.env` spread:

- `selfhost/src/deploy.mjs:101-106`
- `selfhost/src/commands/dashboard.mjs:130-135`
- `selfhost/src/build.mjs:28` — and this one sets **no** token override, so an
  ambient `CLOUDFLARE_API_TOKEN` wins outright: exactly the hijack `childEnv`
  exists to prevent.

*Fix:* route every child spawn through `childEnv()`; test by spawning with a
poisoned `process.env` and asserting the child does not see it. Add `build.mjs`
and `dashboard.mjs` to 4.2's Files.

### I14 — Session signature comparison is not constant-time

`helpers.ts:40`: `if (parts[1] !== expectedSig) return null;` — a plain string
compare of an HMAC. `webdav.ts` gets this right (`timingSafeEqual` at
`webdav.ts:202-208`, used at `:222`) for the far less sensitive mount password.
Remote timing attacks on a 44-char base64 signature are impractical, so this is
not urgent — but Task 2.5 rewrites this exact function and the helper already
exists. Same note for `secret !== env.ADMIN_SECRET`
(`deployment-service/src/index.ts:573`, `:617`, `:641`), where there is also no
rate limiting.

---

## Minor

- **Task 1.2 is two lines, not one.** `assets.ts:233-241` has a D1 branch
  (`:236`) and a Firestore branch (`:239`). Fixing only the named line leaves the
  central worker still claiming encryption it cannot see. The Verify's fixture
  `{enabled:1, …}` also does not match the real shape — `getZkeConfig` returns
  `enabled` as a boolean (`d1-adapter.ts:317`).

- **Task 2.6's flipped test asserts too little.** `rejects.toThrow()` passes
  whether `sessionScope` throws or `verifySignedSessionToken` returns null.
  Assert the specific behaviour, and add a companion test that a hosted worker
  with no `SESSION_SECRET` refuses to serve (per B4).

- **`decodeSession` is an exported, unverified session decoder.**
  `helpers.ts:51-58` base64-decodes a token and returns `SessionData` with no
  signature check. No live call site uses it — but it is exported from the module
  every route imports, in a public repo, named exactly what a contributor would
  reach for, and it is the inlined equivalent of the original bypass. Delete it,
  or make it non-exported and rename it `decodeSessionUnverified`.

- **The self-host branch of `requireAuth` accepts a token forever on signature
  alone.** `helpers.ts:94` returns before the Firebase freshness check. Combined
  with the ~10-year `exp` (`auth.ts:14`), disabling the Firebase account has zero
  effect on self-host. This is the self-host arm of finding 5 and is materially
  worse there; Task 2.5's TTL decision should be made with it in view.

- **`requireAuth` can return a session with an unusable `idToken`.** If
  `session.idToken` is garbage, `idTokenExpired` is true, but the refresh block is
  guarded by `env?.FIREBASE_API_KEY && session.refreshToken` (`helpers.ts:102`);
  if either is absent the function falls through and returns anyway. Inert on a
  D1-bound worker, but "authenticated" has been asserted.

- **The worker's own `/proxy` follows redirects.** `index.ts:210-215` never sets
  `redirect`, so the Workers default is `follow` and the allowlist
  (`index.ts:192-193`) is evaluated only on the pre-redirect URL. The host check
  itself is not bypassable by URL-parsing tricks — WHATWG `URL` handles
  `https://api.telegram.org@evil.com` correctly — but a `Location` from any
  `*.telegram.org` host is followed anywhere. It is also unauthenticated, so
  anyone can burn a victim worker's free-tier quota through it, and
  `upstream.headers` is copied verbatim (`index.ts:216`).

- **`handleStubs` is entirely unauthenticated** (`stubs.ts:5`, catch-all at
  `:114-115`). Every stub returns an empty object or array, so nothing leaks —
  but an anonymous caller gets 200 for any unknown path and
  `console.log('[STUB] Unhandled: ' + path)` writes attacker-chosen text into the
  logs. `/api/admin/*` is held off by a string-prefix 403 at `stubs.ts:78`, not by
  an auth check.

- **`/api/server/statistics` and `/storage` swallow auth failures**
  (`server.ts:26`, `:48`) and return 200 with zeros rather than 401. Confusing to
  debug, and it means "did that request authenticate" is unanswerable from the
  status code.

- **Free version fingerprinting.** `/api/health` is unauthenticated
  (`index.ts:174-181`) and `X-Worker-Version` is stamped on every response
  (`index.ts:261`), so an unpatched worker can be identified fleet-wide without
  credentials. Worth a decision, not necessarily a change.

- **`refreshFirebaseToken` does not URL-encode the refresh token**
  (`helpers.ts:68`) when interpolating it into an `x-www-form-urlencoded` body.

- **`deployment-service` parses the body before authenticating**
  (`index.ts:268-270`), and ignores `disabled`/`emailVerified` on the Firebase
  lookup result (`index.ts:679-683`) — a disabled account still provisions.

- **`splitSql` splits on a bare `;`** (`setup.mjs:286-291`, `update.mjs:75`). Safe
  against today's schema; will corrupt the statement stream the first time a
  `DEFAULT` value or trigger body contains a semicolon. Task 1.3's generated
  values are base64, so the encoding is load-bearing — say so in a comment.

- **`deploy.mjs:41` interpolates `WORKER_NAME` raw into TOML** while every other
  field uses `JSON.stringify`. Dead module today; it comes back with the module.

- **The SIGINT handler skips cleanup.** `bin/daemonclient.mjs:83-88` calls
  `process.exit(130)`, which does not run pending `finally` blocks, so
  `immich-api-shim/.wrangler-selfhost-<pid>.toml` (`deploy.mjs:66`, unlinked at
  `:87`) can be left in the tree. Contents are account ids, not secrets, and
  `.gitignore:124` only matches `wrangler-dc-*.toml`.

- **`newSessionSecret` is variable-length.**
  `deployment-service/src/index.ts:73` strips `+/=` *before* slicing to 43, so
  the length is nondeterministic. Never realistically below the 32 threshold, but
  a length check on a generated secret is a smell.

- **`update-check.ts:103` interpolates `env.UPDATE_REPO` into a GitHub API path**
  with no validation. Operator-controlled, so low, but the resulting `releaseUrl`
  is rendered by the dashboard.

- **`GATES.md` gate 4 requires deployment of one worker.** Given B6, add "and the
  fleet" for anything in Phases 1–2.

---

## Missing tasks

*(security work the plan does not cover at all)*

All twelve `FINDINGS.md` items are scheduled: 1 → 1.1–1.5, 2 → 2.1/2.2,
3 → 2.3/2.4, 4 → 2.6, 5 → 2.5, 6 → 3.1/3.2/3.3, 7 → 3.4, 8 → 3.7, 9 → 3.5,
10 → 3.6, 11 → 3.8, 12 → 3.1. Nothing on that list is orphaned. B7, B8, B9, I4
and I5 above are all new tasks in their own right. What follows is the rest.

**M1 — Own the writable side of the config table.** `FINDINGS.md` §3 and Task 2.3
are entirely about *reading* key material. The larger hole is *writing* it:
`POST /api/drive/config` (B8), `POST /api/drive/zke`, `POST /api/drive/dav`,
`POST /api/assets/zke-toggle` (I3) and `POST /api/policy/worker`
(`policy.ts:88-101`) all write install-wide config from any authenticated
session, with no owner check. Needs a Phase 2 task: enumerate every write to
`config`, and gate each.

**M2 — Constrain the firebase-tools OAuth token (Task 4.5).** The plan says
*"`firebase login` for OAuth only (Google's own verified client), then REST
directly"*. Reading a token out of firebase-tools' config store gives the CLI a
credential with *firebase-tools'* scopes, not ours — `cloud-platform`, `firebase`,
`userinfo.email` and more. That token can create billing-linked projects, read
Firestore, deploy functions and enumerate every project the user owns, and it
lives in `~/.config/configstore/firebase-tools.json` for as long as its refresh
token is valid. The plan constrains none of it.

Add to 4.5 as requirements, not notes:
- read it at the moment of use and never copy it into our own state
  (`state.mjs`/`config.mjs`) — it must not become a fourth stored secret;
- never pass it on a command line; never let it into an error message
  (`api/cloudflare.mjs:83` currently surfaces a child's raw stderr line, and
  `bin/daemonclient.mjs:76` tells users to re-run with `DEBUG=1` and paste the
  result);
- name in the task the exact REST endpoints it will be used against, and assert
  in the test that no other host is contacted with it;
- print, before `firebase login` runs, what the user is granting and to what. A
  self-hosting CLI that quietly acquires `cloud-platform` scope is a P3 problem
  as much as a security one;
- make the manual four-console-steps path a first-class branch for users who will
  not grant it, not a failure mode.

**M3 — Rate limiting.** The only 429 in the shim is a per-uid, per-isolate,
post-authentication token bucket on one endpoint (`policy.ts:108`, backed by
`quotaCache` at `policy.ts:41`) — a quota knob, not a security control. Nothing
throttles `POST /api/auth/login` (`auth.ts:47`), `/dav` Basic auth
(`webdav.ts:325`), `/proxy`, or any deployment-service endpoint including
`/admin/force-update`. On a free-tier worker, quota exhaustion is itself the
denial of service. Related: `auth.ts:66` relays Firebase's error string verbatim,
so `EMAIL_NOT_FOUND` and `INVALID_PASSWORD` are distinguishable — free user
enumeration.

**M4 — Dependency and supply-chain policy for a public repo.** `CONTRIBUTING.md:80`
says *"No new dependencies in `selfhost/`"*, which is well-judged, but nothing
covers the rest. The shim bundles `libheif-js` and `@jsquash/jpeg`; wrangler,
firebase-tools and vercel are invoked via `npx` at whatever resolves today (4.9
pins wrangler and merely "documents" the other two). A malicious version of any
of them runs in the same process as the Cloudflare API token
(`deploy.mjs:104`, `dashboard.mjs:132`), the bot token, and the ZKE password.
Needs: lockfiles committed and CI-enforced, `npm ci` not `npm install`, exact pins
for anything `npx` invokes, and a CI check that a PR touching
`package-lock.json` explains why.

**M5 — CI secret hygiene, before the first outside PR.** Phase 5.3/5.4 add
workflows that will hold `ADMIN_SECRET` and a Cloudflare token. Nothing says
`pull_request_target` is banned, that workflows must not run on forks with
secrets, or that the fleet-deploy job is environment-gated. Given B5, a workflow
that can reach `/admin/force-update` can take over any hosted account. This
belongs before the repo accepts its first pull request, not in Phase 6.

**M6 — Secret scanning and history.** The repo is public and Task 6.5 moves
directories to an `attic` branch, which preserves history rather than removing
it. Add a task: scan full history, revoke everything it finds, turn on push
protection. `immich-api-shim/wrangler.toml:7-12` commits a Firebase web API key
(public by design) and the live `DEPLOYMENT_SERVICE_URL`; decide deliberately
that both are fine to publish rather than discovering it later.

**M7 — Nothing revokes a self-hosted account.** `FINDINGS.md` §5 covers session
revocation; there is no story for *account* revocation. On self-host, Firebase
email/password signup is open by default and there is no admin concept in the
worker (`isAdmin` is written three times and read zero — `auth.ts:103`,
`user.ts:72`, `albums.ts:230`). An operator who finds a stranger registered on
their install has no documented way to remove them, and per B7/B8 that stranger
can read their photos and redirect their uploads. Either setup must **disable
open signup by default** — one field in the Identity Toolkit admin config call
Task 4.5 already makes — or `doctor` must list every registered uid that is not
`owner_uid`. The first is better and cheaper.

**M8 — `/api/selfhost/status` is a config oracle with a side effect.**
`index.ts:24-78` requires auth but no owner check. Any authenticated account on a
self-hosted install learns whether the bot, channel and processor are configured,
gets the library photo count, *and* causes the worker to call
`https://api.telegram.org/bot<owner's token>/getMe` (`index.ts:43`) on demand.
Include it in 2.4's route list.

**M9 — Version honesty (`PARITY.md` §3) has no task.** `PARITY.md` asks both
flavours to report the same version from the same source at `/api/health`. Today
`/api/health` reports `WORKER_VERSION`, a hand-edited constant (`index.ts:85`),
while `SHIM_VERSION` (`shim-bundle.ts:3`) and `BUILD_VERSION` are separate.
Given B6, "which build is this worker actually running" is the question the whole
fleet audit depends on. Fold into 5.3 or give it its own task.

---

## What would change the verdict

Fix B1–B6 and B10 in the plan document — they are specification errors, not
implementation errors, and none needs code to resolve. Add B7, B8 and B9 as Phase
2 tasks; they are more severe than several items already scheduled there. Fold
I1, I2 and I3 into their Phase 1 and Phase 2 tasks, and I4 and I5 into Phase 2 as
one-line fixes. Add M1 and M7 to Phase 2, M2 as a rewrite of 4.5's brief, and M5
before the repo takes its first outside pull request. With those in, this is an
**approve-with-changes** plan; the phase ordering, the boundaries, and the
insistence that every task carry its own executable Verify are all right.

One structural note. Almost every Verify in the plan is a unit test or a grep.
`GATES.md:22` asks for *"a test that would fail if the protection were removed"*,
which is the correct standard — but a grep over `src/` cannot meet it while the
deployed artifact is a separate checked-in bundle, and a unit test against a fake
D1 cannot meet it for a bug whose cause is a real D1 returning something
unexpected. The three tasks that guard against catastrophe — 1.3, 2.5, 2.6 —
each need a Verify that runs against something real.
