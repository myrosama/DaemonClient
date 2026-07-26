# Security review of the master plan

**Verdict:** reject

All twelve items in `FINDINGS.md` are scheduled somewhere in the plan — that
part is sound. The reject is for three reasons:

1. **Two tasks are aimed at the wrong file.** Task 1.3 edits
   `selfhost/src/deploy.mjs`, which nothing imports. The fix would ship and do
   nothing, while its test passed.
2. **Two tasks make the system worse than before they started.** Task 2.5 as
   specified turns an unauthenticated endpoint into a global session-kill switch.
   Task 2.6 deletes the verification-side fallback without touching the
   issuing-side fallback, so the central worker keeps minting tokens the fleet
   will now reject.
3. **The plan's own verification steps explicitly tolerate leaving the
   vulnerability in the artifact that is actually deployed.** Task 2.1's Verify
   accepts `finalize-client-upload` remaining in `deployment-service/src/shim-bundle.ts`
   — the bundle every hosted user's worker runs.

Separately, there is a route neither document mentions that lets any registered
account on a self-hosted install redirect the owner's photo and file uploads
into an attacker-controlled Telegram channel. That is the same outcome as the
issue `SECURITY.md:67` says was fixed on 2026-07-21, reachable through a
different door.

The plan is good work and most of it should survive. It needs a revision pass,
not a rewrite.

---

## Blockers

*(must fix before implementation starts)*

### B1 — Task 1.3 targets a module nothing imports

**Problem.** The task's **Files** are `selfhost/src/commands/setup.mjs` and
`selfhost/src/deploy.mjs`. `selfhost/src/deploy.mjs` has **zero importers** in
the repository. The live deploy path is `selfhost/src/build.mjs`
(`readMigrationSql` at `build.mjs:37-57`, imported by `setup.mjs:23` and
`update.mjs:17`); `deploy.mjs:126-139` is a byte-identical dead copy. The same
mistake sits in Task 1.4, which lists `selfhost/src/deploy.mjs` as a place to
delete `STORAGE_KEY` — the live `secret_text` binding is written at
`setup.mjs:421-422` and `update.mjs:116-117`, not through
`deploy.mjs:76-82`.

Consequence: the key-seeding code is written, the unit test against a fake D1
passes, all four gates go green, and a real `daemonclient setup` still leaves
`zke_password=''`. The plaintext bug that Phase 1 exists to fix survives Phase 1.

**Fix.** Re-target Task 1.3 at `selfhost/src/commands/setup.mjs` (the D1 REST
call path, `setup.mjs:441-449` is the existing pattern) and
`selfhost/src/api/cloudflare.mjs` (`queryD1`, `api/cloudflare.mjs:228-232`). Add
to the task's Verify: *after seeding, read `zke_password` back over REST and
assert it is non-empty* — an end-to-end assertion the dead-module mistake could
not have passed. Re-target Task 1.4 at `setup.mjs:389`, `setup.mjs:421-422`,
`update.mjs:116-117` and `state.mjs:15-21`.

### B2 — Task 1.3's idempotency check is not sufficient, and the plan's own test does not test the case that destroys data

The task says: `SELECT value FROM config WHERE key='zke_password'`, **only if
empty**, generate and UPDATE. Three ways that loses every stored photo:

1. **A failed SELECT is indistinguishable from an empty one.** The CLI's D1 REST
   helper (`api/cloudflare.mjs:228-232`) returns a result envelope; a network
   error, a 5xx, an expired Cloudflare token, or a shape change all produce
   "no rows found" to a naive reader. `setup.mjs:262-265` already demonstrates
   the house habit of swallowing D1 errors that match a pattern. Reading "not
   empty" as the only safe outcome, and treating *anything else* as empty, is
   backwards.
2. **Concurrent runs.** Two `daemonclient setup` invocations — or one the user
   thought had hung, plus the retry — both SELECT empty and both UPDATE. The
   second overwrites the first. Any photo uploaded between them is
   undecryptable. There is no transaction across two HTTP calls to D1.
3. **`zke_password` present but `zke_salt` empty**, or vice versa. The plan
   checks one key.

**Fix.** Do not use read-then-write at all. Make the write itself conditional in
a single statement, then read back and use whatever is actually there:

```sql
UPDATE config SET value = ?1 WHERE key = 'zke_password' AND (value IS NULL OR value = '');
UPDATE config SET value = ?2 WHERE key = 'zke_salt'     AND (value IS NULL OR value = '');
```

then `SELECT value FROM config WHERE key IN ('zke_password','zke_salt')` and
**abort setup with a named error if either comes back empty** — never proceed to
deploy with half-seeded key material. Explicitly require the task's test to
cover: SELECT throws; SELECT returns `{success:false}`; SELECT returns an
unexpected shape; password set but salt empty; two concurrent seeds. The Verify
as written ("a fake D1 with empty keys gets written once; a second run leaves
the existing values untouched") tests only the two paths that were never going
to be the problem.

Note also that the hosted path guards this differently — `isNewDatabase`
(`deployment-service/src/index.ts:331`), not a SELECT. Two idempotency
mechanisms for the same invariant is a `PARITY.md` violation in itself; say
which one is canonical.

### B3 — Task 2.5 makes an unauthenticated endpoint able to log out the whole install

`handleLogout()` is reached at `auth.ts:38-40`, **before any authentication
check**, and takes no arguments (`auth.ts:149`). Task 2.5 proposes to give it
`(request, env)` and have it increment a `session_epoch` in the config table.

As written, `POST /api/auth/logout` with no credentials at all invalidates every
session on the worker. On a self-hosted install (one worker, one config table,
several users) that is a permanent, trivially repeatable denial of service that
anyone on the internet can run in a loop. Today the same request is harmless.

Two further defects in the same task:

- **The epoch is install-wide.** "A `session_epoch` integer in the config table"
  means one counter for a shared self-host D1. One user logging out logs out
  every user. It must be `session_epoch:<uid>`, and `handleLogout` must bump
  only the caller's own.
- **The central worker cannot stamp the epoch.** Tokens are issued by
  `handleLogin` on the *central* worker (`auth.ts:47-137`), which has **no D1
  binding** — `immich-api-shim/wrangler.toml:14-20` comments the binding out
  deliberately. The epoch lives in the per-user worker's D1. The issuer
  therefore cannot read the value it is supposed to stamp into the token. The
  task is architecturally unbuildable for hosted as described.

**Fix.** (a) `handleLogout` must call `requireAuth` first and 401 without a valid
session. (b) Key the epoch per uid. (c) Decide where the epoch actually lives
for hosted — either the per-user worker mints its own session on first contact,
or the epoch is a claim the per-user worker checks lazily and a token with no
epoch claim is accepted once and then re-issued. Whichever, write it down; the
current text does not survive contact with the deployment topology.

### B4 — Task 2.6 deletes the verifier's fallback but leaves the issuer's

Task 2.6's **Files** are `selfhost-auth.ts:44` and `auth-security.test.ts:86-93`.
The issuing side is not listed. It is `auth.ts:96`:

```ts
}, userSessionSecret || env.APP_IDENTIFIER || 'default');
```

Three things follow, all bad:

1. `userSessionSecret` is only set when `firestoreGet` succeeds *and* returns a
   `sessionSecret` of length ≥ 32 (`auth.ts:84-86`), and the whole lookup is
   wrapped in `catch {}` (`auth.ts:87`). `firestoreGet` returns `null` on **any**
   non-2xx, including 401/403/5xx (`helpers.ts:165-172`). So a transient
   Firestore blip at login mints a token signed with `APP_IDENTIFIER` — which,
   after 2.6, every worker rejects. The user gets a 401 loop with no diagnostic
   and no way out. This is not a rollout-window problem; it is permanent, and it
   fires on the flakiest dependency in the login path.
2. There is a **third** fallback the plan never mentions: `|| 'default'`. If
   `APP_IDENTIFIER` is ever unset, sessions are signed with the literal string
   `default`. `sessionScope` has the same one at `selfhost-auth.ts:44`.
3. `requireAuth(request, env?)` takes env as **optional** (`helpers.ts:79`) and
   passes `env || ({} as Env)` to `sessionScope` (`helpers.ts:92`). Any future
   call site that forgets `env` verifies against scope `'default'` — a value
   published in this file. Every current call site passes env; nothing enforces
   it. In a public repo with outside contributors this is a loaded gun, and it is
   the exact shape of the two bypasses that already shipped.

**Fix, all four parts:**
- `auth.ts` must **fail the login** with a distinct error when no per-worker
  secret can be read, rather than signing with something else. Remove `catch {}`
  around the secret read; distinguish "worker has no secret" from "Firestore is
  down" and say so.
- Delete `|| 'default'` in both places at the same time as `|| env.APP_IDENTIFIER`.
- Make `env` a required parameter of `requireAuth`, and make `sessionScope`
  throw for hosted as it already does for self-host (`selfhost-auth.ts:36-43`) —
  a hosted worker with no secret must refuse to serve, which is what
  `SECURITY.md:50-51` already claims it does.
- Do **not** remove `APP_IDENTIFIER` from `wrangler.toml`. It is also a Firestore
  document path component (`helpers.ts:143`, `helpers.ts:206`); deleting the var
  moves every hosted user's config to a different path.

### B5 — Task 2.6's fleet gate is a human promise with no mechanism

**Depends on:** *"operator confirms the fleet is redeployed."* There is nothing
to confirm it with. `/admin/force-update` (`deployment-service/src/index.ts:570-611`)
takes `accountId, workerName, databaseId, apiToken, sessionSecret` **from the
request body** and is invoked one user at a time; there is no endpoint that
enumerates users or reports which workers have a secret.

Worse, the mechanism can silently undo itself: `buildShimBindings` only adds the
`SESSION_SECRET` binding when `sessionSecret` is truthy
(`deployment-service/src/index.ts:88-91`), and a Cloudflare script PUT replaces
the whole binding set. A force-update call that omits `sessionSecret` **strips**
the secret from a worker that had one. The comment at `index.ts:587-589`
acknowledges this. So the fleet can regress after being "confirmed".

Note too that `auth.ts:84` requires `length >= 32`; a stored secret shorter than
that reads as absent. A presence check is not enough.

**Fix.** Before 2.6, add `GET /admin/fleet-audit` (ADMIN_SECRET-gated) that walks
the provisioned users and reports, per user: `sessionSecret` present, its length,
and the deployed `SHIM_VERSION`. Make Task 2.6's Verify *"fleet-audit reports
zero users without a ≥32-char secret"* — a command with an output, not a
recollection. Separately, make `handleForceUpdate` **refuse** (400) when
`sessionSecret` is absent but the stored config has one, so the redeploy can
never strip it.

### B6 — Task 2.1's Verify accepts leaving the SQL injection in the deployed artifact

The Verify reads: *`grep -rn "finalize-client-upload" … returns only the bundled
copy and the roadmap mention*.* The "bundled copy" is
`deployment-service/src/shim-bundle.ts:9979` — and `SHIM_BUNDLE` is the worker
code that `deployWorker` uploads to **every hosted user's account**
(`deployment-service/src/index.ts:346-349`, `:600-604`). The bundle is
hand-regenerated by `deployment-service/scripts/embed-shim.mjs`; it is **not**
wired into any npm script (`deployment-service/package.json` `deploy` is bare
`wrangler deploy`).

So a fix to `immich-api-shim/src` can pass every gate, be committed, and reach
nobody. This applies to all of Phase 1 and Phase 2, not just 2.1. `GATES.md:111-112`
only requires "deployed, then `/api/health` … checked" — one worker.

**Fix.** Add a rule to `GATES.md` gate 4 and to every worker task's Verify: *the
shim was rebuilt, `SHIM_VERSION` in `shim-bundle.ts` changed, the deployment
service was redeployed, and `fleet-audit` (B5) shows the fleet on the new
version.* Change Task 2.1's Verify to `grep … returns nothing outside
docs/`. If the release automation of Task 5.4 is what makes this bearable, move
it forward to Phase 1 — a security phase that ships to no one is not a security
phase.

### B7 — `/api/drive/config` lets any authenticated account take over the install's Telegram storage

Not in `FINDINGS.md`, not in the plan.

```
drive.ts:66-74   POST /api/drive/config
  merged.botToken  = body.botToken       // any authenticated caller
  merged.channelId = body.channelId
  await db.setJsonConfig('telegram', merged);
```

`setJsonConfig` writes the install-wide `config` row (`d1-adapter.ts:290-292`);
there is no owner scoping (`d1-adapter.ts:266-272`). On a self-hosted install —
one worker, one D1, open Firebase email/password signup — anyone who can
register can point the install's Telegram bot and channel at their own. Every
subsequent Photos upload (`assets.ts` reads the same `telegram` config via
`getCachedConfig`) and every Drive upload then lands in the attacker's channel.

`SECURITY.md:67` lists exactly this outcome as fixed on 2026-07-21. It is open
again through a different route.

The same handler has three more instances of the class:

| Route | Line | What any authenticated user can do |
|---|---|---|
| `GET /api/drive/config` | `drive.ts:50-60` | read the bot token in cleartext — a **third** endpoint doing what Task 2.3 removes from two |
| `POST /api/drive/zke` | `drive.ts:93-106` | overwrite `drive_zke` password/salt — orphans the owner's Drive files, or (in `auto` mode) sets a key the attacker knows |
| `POST /api/drive/dav` | `drive.ts:180-185` | overwrite the single install-wide `dav` record, silently revoking the owner's WebDAV mount |

**Fix.** Bring `drive.ts` into Task 2.3 and Task 2.4 explicitly. `GET
/api/drive/config` genuinely needs the bot token (the browser uploads straight
to Telegram), so it cannot be blanked like `/api/server/telegram-config` — it
must be **owner-gated**, which makes Task 2.4 a hard prerequisite for the Phase 2
exit criterion *"No route returns key material or a bot token"* rather than an
independent task. All four `config`-writing Drive routes must be owner-gated too.
Add to Task 2.3's Verify: an enumeration of every route that reads the `telegram`
or `zke_*`/`drive_zke` config keys, with a test per route.

### B8 — Task 2.4's owner gate fails open, and cannot be provisioned when the plan schedules it

Two separate problems.

**Fails open.** *"Absent (hosted), behave as now."* `owner_uid` would live in the
same D1 `config` table read by `getConfig`, which returns `null` on a missing row
**and** cannot distinguish that from a query failure (`d1-adapter.ts:266-272`
returns `result?.value || null`). A transient D1 error therefore disables the
gate and re-opens finding 3 for the duration. The signal that a worker is
self-hosted is `env.SELF_HOST` — an env var, which cannot transiently vanish.

*Fix:* gate on `isSelfHost(env)` first. If `isSelfHost(env)` and `owner_uid`
cannot be read, **refuse** (503), do not fall through to hosted behaviour.
Additionally the gate must not be defeatable by a config write: verify no route
lets a caller set a config key of its choosing. (`policy.ts:29` writes
`session:${sessionId}` — prefixed, so safe today; that prefix is now
load-bearing and needs a comment saying so.)

**Cannot be provisioned in Phase 2.** The task writes `owner_uid` in
`selfhost/src/commands/setup.mjs`. `setup.mjs` is currently broken — it calls
four functions that do not exist on the Cloudflare API module
(`setup.mjs:211 cf.listAccounts`, `setup.mjs:273 cf.getWorkersSubdomain`,
`setup.mjs:424 cf.deployWorker`, `setup.mjs:425 cf.enableWorkersDev`; the module's
exports are enumerated in `selfhost/src/api/cloudflare.mjs`). Task 4.3 rewrites
the file for exactly this reason. So in Phase 2 the owner_uid write goes into a
file that cannot run, and in Phase 4.3 the rewrite is liable to drop it.

The same applies to Task 1.3's seeding code. **Phase 1's exit criterion "A fresh
self-host setup produces working encryption" cannot be demonstrated until 4.3
lands.**

*Fix:* either move the `setup.mjs` repair (4.3) ahead of the tasks that depend on
it, or split out a minimal "make setup runnable" task into Phase 1 and make 1.3
and 2.4 depend on it. Add "does not lose 1.3's seeding or 2.4's owner_uid write"
to Task 4.3's Verify.

---

## Important

*(must fix before that task is committed)*

### I1 — Task 1.1's fail-closed has three holes

**(a) `client=true` bypasses it entirely.** `assets.ts:1060`:

```ts
const isClientZke = zkeConfig.mode === 'client' || request.url.includes('client=true') || clientUpload;
```

`isClientZke` short-circuits `getEncryptionKey` at `assets.ts:1063`, so
`POST /api/assets?client=true` writes plaintext to Telegram no matter what the
key material says — and nothing verifies the bytes were actually encrypted by the
client. Note it is `request.url.includes(...)`, a substring test over the whole
URL, so any query parameter whose *value* contains that string triggers it. Task
1.2 then still reports `enabled: true`, because it only reads the config. The
central claim of Phase 1 — *"no endpoint can claim otherwise"* — is false while
this stands.

*Fix:* require an explicit `clientUpload=true` **form field** (already present at
`assets.ts:1037`), delete the URL substring test, and refuse the request when
`zke_mode` is `server` but the caller asserts client-side encryption.

**(b) Absent config is treated as "off".** `getZkeConfig` returns `null` when the
`zke_mode` row does not exist (`d1-adapter.ts:313`). `getEncryptionKey` then
returns `null` and the upload proceeds in plaintext. This is reachable: the
schema is scraped out of a TypeScript template literal by `build.mjs:37-57`,
which stops at the **first** backtick after the opener — an interpolation or
escaped backtick added to `MIGRATION_SQL` truncates the SQL silently, and
`setup.mjs:262-265` swallows the resulting errors that match
`/already exists|duplicate column/i`. A truncated schema with no `config` table
produces exactly the bug Phase 1 is fixing, by a different route, and
`doctor.mjs:66` only checks that `photos` and `config` exist.

*Fix:* Task 1.1 must fail closed on *"ZKE config could not be read"* as well as
*"enabled but empty"*. Only an explicit `zke_mode='off'` may produce plaintext.
Separately, `build.mjs`'s scrape needs a sanity assertion (e.g. every table name
the code reads is present in the scraped SQL) before Task 1.3 relies on the
`config` table existing.

**(c) The error message reaches the client.** `index.ts:263-269` returns
`err.message` in the response body for any non-auth throw. Task 1.1's "clear 5xx
naming the fix" therefore becomes an unauthenticated-adjacent information
channel, and — more importantly — this is the same channel through which a D1
error would return its SQL text once Task 2.2 starts rejecting columns.

*Fix:* log the detail, return a stable code. Add a test asserting that a
deliberately-thrown internal error does not appear in the response body.

### I2 — Task 2.2 fixes one of five identical injection sites

`FINDINGS.md` §2 and Task 2.2 both name `savePhoto` (`d1-adapter.ts:100-115`).
The same interpolated-identifier pattern appears at:

- `d1-adapter.ts:129-131` — `updatePhoto`, `` `${k} = ?` `` into `UPDATE photos SET …`
- `d1-adapter.ts:215-220` — `saveAlbum`
- `d1-adapter.ts:382-385` — `saveFile`
- `d1-adapter.ts:392-394` — `updateFile`

Task 2.2's stated purpose is *"2.1 removes today's route, this removes the
class"*. It removes one fifth of the class. `updatePhoto` is reachable from
`handleBulkUpdate` (`assets.ts:611-617`) with a caller-shaped `updates` object;
the keys there are currently allowlisted by hand, which is precisely the
protection that will rot.

*Fix:* a single shared `assertColumns(table, keys)` helper used by all five, with
column sets derived from `MIGRATION_SQL` so they cannot drift from the schema
(`schema-columns.test.ts` already exists and should be extended to assert the
sets match). Test each of the five with the crafted key from Task 2.2's Verify,
not just `savePhoto`.

### I3 — `/api/assets/zke-toggle` lets any authenticated account disable encryption for the install

`assets.ts:244-277`. `POST {mode:'off'}` writes `zke_enabled=0` to the shared
config table. On self-host, any registered account silently downgrades the
owner's future uploads to plaintext. Task 1.1 will treat that as *deliberate*
plaintext and permit it; Task 1.2 will honestly report `enabled:false`, but only
if the owner goes and looks.

The route also holds a key-generation path (`assets.ts:257-258`) guarded by
`if (existing?.password && existing?.salt)` — the same read-then-write shape as
B2. If `getZkeConfig` returns `null` for any reason while `zke_mode` is missing,
the else branch generates and writes **new** key material, orphaning every stored
photo. This is an HTTP-reachable key rotation.

*Fix:* fold `zke-toggle` into Task 2.4's owner gate, and make its key-generation
branch conditional in SQL (as B2) rather than read-then-write. Add it to Task
1.1's test file.

### I4 — CORS reflects any origin containing the substring `localhost`, with credentials

`index.ts:121`:

```ts
const isAllowed = allowed.includes(origin) || origin.includes('localhost');
```

`https://localhost.attacker.example` satisfies that, and the worker then returns
`Access-Control-Allow-Origin: https://localhost.attacker.example` together with
`Access-Control-Allow-Credentials: true` (`index.ts:123,126`). Today the damage
is limited because the session cookies are `SameSite=Lax` (`auth.ts:130-136`), so
a cross-site `fetch` carries no cookie — but that is an accident of a setting on
a different file, and the self-hosted default `ALLOWED_ORIGINS` is
`http://localhost:5173` baked in permanently (`selfhost/src/deploy.mjs:29`,
`setup.mjs:417`, `update.mjs:109`, `dashboard.mjs:152`).

*Fix:* exact-match against a parsed allowlist; permit localhost only when the
origin's *hostname* is exactly `localhost` or `127.0.0.1`. Add a test with
`https://localhost.evil.com`. This is small and belongs in Phase 2.

### I5 — Media responses are cached publicly at the Cloudflare edge

`assets.ts:2021-2023` serves thumbnails with

```
Cache-Control: public, max-age=31536000, immutable
CDN-Cache-Control: public, max-age=31536000
Cloudflare-CDN-Cache-Control: public, max-age=31536000
```

and originals with `public, max-age=86400, immutable` (`assets.ts:2155`,
`assets.ts:2317`). Cloudflare will cache a response to a request bearing an
`Authorization` header **precisely when** the response is marked `public`. Once
cached, the same URL is served to a request with no credentials at all: the
`requireAuth` at `assets.ts:190` becomes decorative for that URL. Asset ids are
UUIDs and so not guessable, but they are not secret either — they appear in the
sync stream, in share links, and in support screenshots.

Task 3.6 edits this exact block and is the moment to fix it.

*Fix:* `private` on every authenticated media response, and drop the
`CDN-Cache-Control` pair. Add it to Task 3.6.

### I6 — The chunk body cache writes decrypted plaintext under a routable URL

`assets.ts:2132`:

```ts
const ck = new Request(`${url.origin}/chunk-cache/${chunk.file_id}`, ...);
```

and the value stored at `assets.ts:2146` is `data` *after*
`decryptChunk` (`assets.ts:2144`) — 19 MB of plaintext photo, written into
`caches.default` with `Cache-Control: public, max-age=86400`, keyed on a URL on
the worker's **own origin**. On an orange-clouded custom domain (hosted runs on
`api.daemonclient.uz`), that key is in the same cache that fronts the worker, so
`GET https://api.daemonclient.uz/chunk-cache/<file_id>` can be answered from
cache without ever reaching the worker's router. Exploitation needs a Telegram
`file_id` (~60+ chars, not guessable), so this is defence-in-depth rather than a
live break — but the file-path cache two hundred lines below already does it
correctly, with a synthetic host: `https://dc-tg-path/${fileId}`
(`assets.ts:3118`). The body cache is the odd one out.

Tasks 3.1, 3.2 and 3.3 all rewrite this function.

*Fix:* use a non-routable synthetic origin, and derive the path from
`HMAC(SESSION_SECRET, file_id)` so the key is unguessable even if a `file_id`
leaks. Add to Task 3.2's Verify: *no cache key shares an origin with the worker.*

### I7 — Task 4.1 deletes the live secret store and leaves the secrets on disk

Task 4.1 says *"remove `state.mjs` and `env.mjs`; `config.mjs` is the only one"*.
The direction is right and the facts are inverted:

- `state.mjs` is the **live** store. It is imported by setup, status, update,
  processor, dashboard and doctor, and writes `<cwd>/.daemonclient-selfhost.json`
  (`state.mjs:12`, `state.mjs:40-53`) holding `cloudflareToken`,
  `telegramBotToken`, `sessionSecret` and `storageKey`.
- `config.mjs` is **dead** apart from one exported constant — its only importer
  is `api/cloudflare.mjs:26` for `HOSTILE_ENV_VARS`. `save()`, `load()`,
  `redact()` and `checkPermissions()` have zero callers.
- `env.mjs` has **zero importers at all**.

So the task is a migration of the live store, not a deletion of dead ones, and
nothing in it deletes files. Verify as written (`grep -rn "state.mjs\|env.mjs"
selfhost/` returns nothing) passes while every existing install keeps a
0600 file in the repo clone containing four live secrets — plus a second copy
now in `~/.config`. Three concrete consequences:

1. `~/.config/daemonclient/config.env` has **no `.gitignore` rule**
   (`.gitignore:5-6` match `.env` and `.env.*`, not `config.env`), and
   `config.mjs:70-71` honours a `DAEMONCLIENT_CONFIG` override with no path
   validation. Pointing it inside the clone produces a committable secret file.
2. `.daemonclient-selfhost.json` is gitignored — which means `git clean -xdf`
   deletes it, and with it `storageKey`. `SECURITY.md:71-72` and
   `docs/SELF_HOSTING.md` still tell users to back that file up.
3. `state.mjs:35` renames a corrupt state file to
   `.daemonclient-selfhost.json.corrupt-<ts>` and never removes it. Each is a
   full secret snapshot; they accumulate forever.

*Fix:* rename the task to "migrate to one config store". It must (a) copy the
existing state across, (b) `unlink` the old file and every `.corrupt-*` sibling
after a successful migration, (c) add `config.env` to `.gitignore` and refuse a
`DAEMONCLIENT_CONFIG` path inside a git work tree, (d) update `SECURITY.md:71`
and `docs/SELF_HOSTING.md` in the same commit. Verify must assert the old file is
gone, not just that the import is.

### I8 — Task 4.4's "the report contains no secret" passes by luck

`doctor.mjs:168` prints *"Report (safe to share — secrets are removed)"*.
`doctor.mjs:170-181` calls `redact()` (`state.mjs:68-81`) on a hand-built object
literal containing **no key in `SECRET_KEYS`** (`state.mjs:15-21`). The redactor
removes nothing; the safety is the manual whitelist at `doctor.mjs:171-180`. Any
field a future contributor adds to that literal gets no protection at all unless
its name happens to collide with the secret list. `SECRET_KEYS` also omits
`firebaseApiKey`, `adminEmail`, `adminUserId` and `telegramChannelId`.

The report *does* print `workerUrl` unredacted (`doctor.mjs:172`) — a live,
internet-reachable API endpoint — inside the "safe to share" block, and prints
`firebaseProjectId` (`doctor.mjs:78`) and the bot's `@username`
(`doctor.mjs:104`) into the same scrollback a user would copy.
`CONTRIBUTING.md:116` tells people to attach it to bug reports.

*Fix:* make `doctor` redact the **whole state object** and render from the
redacted copy, so the default for a new field is redacted. Task 4.4's Verify must
be: *add a field named `xyzToken` carrying a known value, run doctor, assert the
value does not appear in stdout* — a test that fails if the protection is
removed. Extend `SECRET_KEYS`. Decide deliberately whether `workerUrl` belongs in
a shareable report.

### I9 — The processor's unknown-`kid` path is an unauthenticated outbound-request amplifier, and the comment says the opposite

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
carrying a `kid` Google does not publish therefore forces a fresh
`fetch(CERTS_URL)` on **every** request, before any signature is checked. The
claim in the comment is false. Anyone can hold a self-hosted processor's
outbound quota open, burn its free-tier invocations, and get it rate-limited by
Google.

Two smaller things in the same function:
- `certs[header.kid]` is a raw property read on a `JSON.parse` result, so
  `kid: "constructor"` or `"__proto__"` returns a truthy prototype member.
  `keyFromCert` then throws on `pem.replace` and the request 401s, so it is not
  exploitable — but it is one refactor away from being so. Use
  `Object.prototype.hasOwnProperty.call(certs, kid)`.
- `MAX_BYTES` is checked at `convert.js:170`, **after**
  `await request.arrayBuffer()` at `:168` has already buffered the whole body.

Everything else in `verifyToken` is correct and should be said so: `alg` is
pinned to RS256 (`:97`) rather than read from the token, `aud` and `iss` are both
checked against `PROJECT_ID` (`:119-120`), `exp` is checked (`:118`), the
`OWNER_UID` pin is applied last (`:126`), and a missing `PROJECT_ID` fails closed
(`:81`).

*Fix:* rate-limit the forced refetch — refuse to refetch more than once per
(say) five minutes, and record the last-refetch time in the module scope
alongside `certsCache`. Add to Task 4.6.

### I10 — Task 4.6 lets an unpinned processor deploy succeed with a warning

Verify: *"a health response lacking `ownerPinned` produces a warning."* A warning.
`convert.js:126` is `if (OWNER_UID && uid !== OWNER_UID)` — an empty `OWNER_UID`
means any account in the Firebase project may use the instance. On self-host with
open signup that is an anonymous HEIC-conversion service on the owner's Vercel
quota, reachable by anyone who registers. Note the asymmetry: a missing
`FIREBASE_PROJECT_ID` fails closed (`convert.js:81`); a missing `OWNER_UID` fails
open.

There is also an ordering problem. `OWNER_UID` is the Firebase uid, which is
produced by Task 4.5. Task 4.6 **Depends on: 4.3**, not 4.5. Run in the order the
plan permits, the processor deploys before the uid exists and can only be
unpinned.

Two more, from the same area:
- The processor URL is accepted with no scheme validation (`setup.mjs:531`,
  `processor.mjs:64`) and persisted as `heicConvertUrl` (`setup.mjs:568`,
  `processor.mjs:106`). The worker POSTs **user photo bytes** to that URL. An
  `http://` value sends image data in cleartext and neither blocks nor warns.
- `handleHealth` is unauthenticated by design (`convert.js:201-205`) and reports
  `problems` in prose. That is reasonable, but it also confirms to a stranger
  that the instance is unpinned and therefore usable.

*Fix:* make Task 4.6 **depend on 4.5**, refuse to deploy without an `OWNER_UID`
(a `--allow-unpinned` escape hatch if you must), reject a non-`https:` processor
URL in the CLI, and add a worker-side `https:` check before posting bytes.

### I11 — Task 4.2's hostile-env detection is defeated three lines away

The task wires the two existing detectors into preflight. Correct as far as it
goes — but `childEnv()` (`api/cloudflare.mjs:48-62`) is a deliberate allowlist
that strips `HOSTILE_ENV_VARS` (`api/cloudflare.mjs:55`), and three call sites
bypass it with a full `...process.env` spread:

- `selfhost/src/deploy.mjs:101-106`
- `selfhost/src/commands/dashboard.mjs:130-135`
- `selfhost/src/build.mjs:28` — and this one sets **no** token override, so an
  ambient `CLOUDFLARE_API_TOKEN` wins outright: exactly the hijack `childEnv`
  exists to prevent.

*Fix:* route every child spawn through `childEnv()`; add a test that spawns with
a poisoned `process.env` and asserts the child does not see it. Add
`build.mjs` and `dashboard.mjs` to Task 4.2's Files.

### I12 — Session signature comparison is not constant-time

`helpers.ts:40`: `if (parts[1] !== expectedSig) return null;` — a plain string
compare of an HMAC. `webdav.ts` gets this right (`timingSafeEqual`, used at
`webdav.ts:222`); the session path does not. Remote timing attacks on a 44-char
base64 signature are impractical, so this is not urgent — but Task 2.5 rewrites
this exact function and the helper already exists in the codebase. Same note for
`secret !== env.ADMIN_SECRET` at `deployment-service/src/index.ts:573`, `:617`,
`:641`.

---

## Minor

- **Task 1.2 is two lines, not one.** `assets.ts:233-241` has both a D1 branch
  (`:236`) and a Firestore branch (`:239`). Fixing only the named line leaves the
  central worker still claiming encryption it cannot see. Also, the Verify's
  fixture `{enabled:1, …}` does not match the real shape — `getZkeConfig` returns
  `enabled` as a boolean (`d1-adapter.ts:317`).

- **Task 2.6's flipped test asserts too little.** `rejects.toThrow()` passes
  whether `sessionScope` throws or `verifySignedSessionToken` returns null.
  Assert the specific behaviour, and add a companion test that a hosted worker
  with **no** `SESSION_SECRET` refuses to serve at all (per B4).

- **`decodeSession` is an exported, unverified session decoder.**
  `helpers.ts:51-58` base64-decodes a token and returns `SessionData` with no
  signature check. No live call site uses it — but it is exported from the
  module every route imports, in a public repo, named exactly what a contributor
  would reach for. This is the shape of both bypasses that already shipped.
  Delete it, or rename it `decodeSessionUnverified` and make it non-exported.

- **`/proxy` is unauthenticated and follows redirects.** `index.ts:182-217`. The
  host allowlist (`:192-193`) is correct and not bypassable through URL parsing,
  but the endpoint takes no credentials, so anyone can burn a victim worker's
  free-tier request quota through it, and `fetch` defaults to
  `redirect: 'follow'` — if `api.telegram.org` ever 302s elsewhere the allowlist
  is moot. `upstream.headers` is copied verbatim into the response
  (`index.ts:216`). Set `redirect: 'manual'`, strip hop-by-hop and `Set-Cookie`,
  and consider requiring a session.

- **`refreshFirebaseToken` does not URL-encode the refresh token.**
  `helpers.ts:68` interpolates it into an `x-www-form-urlencoded` body.

- **`splitSql` splits on a bare `;`.** `selfhost/src/commands/setup.mjs:286-291`
  and `update.mjs:75`. Safe against today's schema; will corrupt the statement
  stream the first time a `DEFAULT` value or trigger body contains a semicolon.
  Task 1.3's generated values are base64, so no `;` — worth a comment saying the
  encoding is load-bearing.

- **`deploy.mjs:41` interpolates `WORKER_NAME` raw into TOML** while every other
  field uses `JSON.stringify`. Dead module today; if any of it is revived, this
  comes with it.

- **The SIGINT handler skips cleanup.** `bin/daemonclient.mjs:83-88` calls
  `process.exit(130)`, which does not run pending `finally` blocks — so
  `immich-api-shim/.wrangler-selfhost-<pid>.toml` (`deploy.mjs:66`, unlinked at
  `:87`) can be left in the tree. Contents are account ids, not secrets, and
  `.gitignore:124` only matches `wrangler-dc-*.toml`.

- **`newSessionSecret` is variable-length.**
  `deployment-service/src/index.ts:73` strips `+/=` *before* slicing to 43, so
  the length is nondeterministic. Never realistically below the 32 threshold, but
  a length check on a generated secret is a smell.

- **`update-check.ts` interpolates `env.UPDATE_REPO` into a GitHub API path**
  with no validation (`update-check.ts:103`). Operator-controlled, so low, but
  the resulting `releaseUrl` is rendered by the dashboard.

- **`GATES.md` gate 4 requires deployment of one worker.** Given B6, add "and the
  fleet" for anything in Phases 1–2.

---

## Missing tasks

*(security work the plan does not cover at all)*

All twelve `FINDINGS.md` items are scheduled: 1 → 1.1–1.5, 2 → 2.1/2.2,
3 → 2.3/2.4, 4 → 2.6, 5 → 2.5, 6 → 3.1/3.2/3.3, 7 → 3.4, 8 → 3.7, 9 → 3.5,
10 → 3.6, 11 → 3.8, 12 → 3.1. Nothing on that list is orphaned. What follows is
work neither document mentions.

**M1 — Own the writable side of the config table.** `FINDINGS.md` §3 and Task 2.3
are entirely about *reading* key material. The larger hole is *writing* it:
`POST /api/drive/config` (B7), `POST /api/drive/zke`, `POST /api/drive/dav`,
`POST /api/assets/zke-toggle` (I3) and `POST /api/policy/worker`
(`policy.ts:88-101`) all write install-wide config from any authenticated
session, with no owner check. Needs its own task in Phase 2: enumerate every
write to `config`, and gate each.

**M2 — Constrain the firebase-tools OAuth token (Task 4.5).** The plan says
*"`firebase login` for OAuth only (Google's own verified client), then REST
directly"*. Reading a token out of firebase-tools' config store gives the CLI a
credential whose scopes are firebase-tools' scopes, not ours — `firebase login`
requests `cloud-platform`, `firebase`, `userinfo.email` and more. That token can
create billing-linked projects, read Firestore, deploy functions and enumerate
every project the user owns, and it lives in `~/.config/configstore/firebase-tools.json`
(world-readable in some installs) for as long as its refresh token is valid. The
plan constrains none of this.

Add to Task 4.5, as requirements rather than notes:
- read the token at the moment of use and never copy it into our own state file
  (`state.mjs`/`config.mjs`) — it must not become a fourth stored secret;
- never pass it on a command line; never include it in an error message
  (`api/cloudflare.mjs:83` currently surfaces a child's raw stderr line, and
  `bin/daemonclient.mjs:76` tells users to re-run with `DEBUG=1` and paste the
  result);
- name in the task the exact REST endpoints it will be used against, and assert
  in the test that no other host is contacted with it;
- print, before `firebase login` runs, what the user is granting and to what.
  A self-hosting CLI that quietly acquires cloud-platform scope is a
  P3 problem as much as a security one;
- offer a documented path for users who will not grant it (do the four console
  steps by hand), and make that path a first-class branch, not a failure mode.

**M3 — Rate limiting.** `takeToken` exists for upload sessions
(`policy.ts:108`) and nothing else. `/api/auth/login` (`auth.ts:47`) proxies
straight to Firebase with no throttle; `/proxy` (`index.ts:182`) is
unauthenticated; `/dav` Basic auth (`webdav.ts:217-223`) can be brute-forced at
whatever rate the worker will serve. On a free-tier worker, quota exhaustion is
itself the denial of service.

**M4 — Dependency and supply-chain policy for a public repo.** `CONTRIBUTING.md:80`
says *"No new dependencies in `selfhost/`"* and that is well-judged, but nothing
covers the rest. The shim bundles `libheif-js`, `@jsquash/jpeg`, wrangler,
firebase-tools and vercel, several invoked via `npx` at whatever version resolves
today (Task 4.9 pins wrangler and says the other two are "documented"). A
malicious version of any of them runs in the same process as the Cloudflare API
token (`deploy.mjs:104`), the bot token, and the ZKE password. Needs: lockfiles
committed and CI-enforced, `npm ci` not `npm install`, exact pins for anything
`npx` invokes, and a CI check that a PR touching `package-lock.json` says why.

**M5 — CI secret hygiene for the public repo.** Phase 5.3/5.4 add workflows that
will hold `ADMIN_SECRET` and a Cloudflare token. Nothing in the plan says
`pull_request_target` is banned, that workflows must not run on forks with
secrets, or that the fleet-deploy job is environment-gated. A repo that is about
to accept outside PRs needs this before it accepts the first one, not in Phase 6.

**M6 — Secret-scanning and history.** The repo is public and the plan's Phase 6.5
moves directories to an `attic` branch — which preserves history rather than
removing it. There is a standing note that a Firebase key needs revoking. Add a
task: run a scanner over full history, revoke everything it finds, and turn on
push protection. `immich-api-shim/wrangler.toml:7-12` commits a Firebase web API
key (public by design) and the live `DEPLOYMENT_SERVICE_URL`; decide deliberately
that both are fine to publish rather than discovering it later.

**M7 — Nothing in the plan revokes a self-hosted user.** `FINDINGS.md` §5 covers
session revocation; there is no story for *account* revocation. On self-host,
Firebase email/password signup is open by default and there is no admin concept
in the worker (`isAdmin` is written three times and read zero — `auth.ts:103`,
`user.ts:72`, `albums.ts:230`). An operator who discovers a stranger has
registered on their install has no documented way to remove them. Either the
setup must disable open signup by default (Identity Toolkit admin config, which
Task 4.5 already touches), or `doctor` must report every registered uid that is
not `owner_uid` and tell the operator what to do. The first is better: **open
signup on a single-tenant install should be off, and that is a one-line change in
the same API call Task 4.5 already makes.**

**M8 — `/api/selfhost/status` is a config-status oracle with a side effect.**
`index.ts:24-78` requires auth but no owner check. Any authenticated account on a
self-hosted install learns whether the bot, channel and processor are configured,
gets the library photo count, *and* causes the worker to call
`https://api.telegram.org/bot<owner's token>/getMe` (`index.ts:43`) on demand.
Include it in Task 2.4's route list.

**M9 — Version honesty (`PARITY.md` §3) has no task.** `PARITY.md` asks that both
flavours report the same version from the same source at `/api/health`. Today
`/api/health` (`index.ts:174-181`) reports `WORKER_VERSION`, a hand-edited
constant (`index.ts:85`), while `SHIM_VERSION` (`shim-bundle.ts:3`) and
`BUILD_VERSION` are separate. Given B6, "which build is this worker actually
running" is the question the whole fleet audit depends on. Fold it into Task 5.3
or give it its own.

---

## What would change the verdict

Fix B1–B8 in the plan document — they are all specification errors, not
implementation errors, and none of them requires writing code to resolve. Fold
I1, I2, I3 and B7 into their Phase 1 and Phase 2 tasks. Add M1 and M7 as Phase 2
tasks, M2 as a rewrite of Task 4.5's brief, and M5 before the repo takes its
first outside pull request. With those in, this is an
**approve-with-changes** plan; the ordering, the phase boundaries, and the
insistence that each task carry its own executable Verify are all right.

One structural suggestion. Every Verify in the plan is a unit test or a grep.
`GATES.md:22` asks for *"a test that would fail if the protection were removed"*,
which is the correct standard — but a grep over `src/` cannot meet it while the
deployed artifact is a separate checked-in bundle, and a unit test with a fake D1
cannot meet it for a bug whose cause is a real D1 returning something unexpected.
The tasks that guard against catastrophe (1.3, 2.5, 2.6) need a Verify that runs
against something real.
