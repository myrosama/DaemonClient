# Verified findings

Every item here was checked against the code by an agent that read the actual
lines and reported the file:line. These are not suspicions — they are the
backlog the master plan is built from.

Ordered by how much damage they do.

---

## 1. CRITICAL — self-hosted installs store photos in plaintext, and report themselves as encrypted

**Status: confirmed, not yet fixed. Unrecoverable retroactively.**

The hosted path seeds the encryption keys in two steps. `MIGRATION_SQL`
(`deployment-service/src/index.ts:132`) inserts them **empty**:

```sql
INSERT INTO config (key, value) VALUES ('zke_mode','server'),('zke_enabled','1'),('zke_password',''),('zke_salt','');
```

and then `provisionWorker()` fills them in
(`deployment-service/src/index.ts:331-338`) with a random salt and password.

The CLI's `readMigrationSql` (`selfhost/src/deploy.mjs:126-139`) scrapes that
same `MIGRATION_SQL` **string** out of the TypeScript source — so it inherits
the empty INSERT, and *cannot* inherit the UPDATE that fills them, because that
is code rather than part of the template literal.

Consequence, step by step:

1. Setup runs the scraped SQL → `zke_password=''`, `zke_salt=''`, `zke_enabled='1'`.
2. `getEncryptionKey()` (`immich-api-shim/src/assets.ts:173-187`) requires
   `zkeConfig.password && zkeConfig.salt` — empty strings are falsy → returns `null`.
3. `assets.ts:1063-1064` → `isEncryptedByServer = false`.
4. `assets.ts:1270` (the `encryptChunk` call) is skipped.
5. Plaintext bytes go to Telegram — **under their original filenames**, not `blob.bin`.

**The worst part:** `/api/assets/zke-status` (`assets.ts:236-237`) returns
`{mode:'server', enabled:true}` because it reads only `mode` and `enabled` and
never checks that key material exists. The UI says encryption is on. It is not.

Also: the CLI generates a `STORAGE_KEY`, calls it "File encryption key" to the
user, warns that losing it loses their files — and ships it as
`ENCRYPTION_MASTER_KEY`, **which the worker never reads**. It is declared at
`immich-api-shim/src/index.ts:94` and referenced nowhere else in the shim. It
protects nothing.

**Fix (three independent parts, all needed):**
- (a) In setup, after the schema and before deploy: generate salt + password and
  run the same UPDATE the hosted path runs — **only when `zke_password` is
  currently empty**, so re-running setup never rotates keys and orphans photos.
- (b) Structural: `getEncryptionKey` must **fail closed**. If `enabled` is true
  but the key material is missing, throw and reject the upload instead of
  silently downgrading to plaintext. This is the real bug class; (a) alone
  leaves the trap armed for every future provisioning path.
- (c) `zke-status` must derive `enabled` from `!!(password && salt)`, so it can
  never claim encryption that is not happening.
- (d) Delete `ENCRYPTION_MASTER_KEY` from the shim and the CLI, or wire it up. A
  secret described to users as protecting their files, that protects nothing, is
  a lie in the documentation.

**Drive is unaffected** — it encrypts in the browser
(`drive/src/App.jsx:100-103`) under a separate `drive_zke` key. Two caveats
worth noting separately: Drive defaults to **off** until the user opts in
(`drive.ts:91`), and in `auto` mode the password is stored server-side so the
WebDAV mount can derive it (`drive.ts:100`, `webdav.ts:297-298`) — only
`custom` mode is genuinely zero-knowledge.

---

## 2. CRITICAL — SQL injection reachable by any authenticated user

`handleFinalizeClientUpload` (`immich-api-shim/src/assets.ts:1621-1638`) spreads
the raw request body into the row:

```ts
const body = await request.json() as any;
const photo = { ...body, id: assetId, ownerId: uid, uploadedAt: ... };
```

and `D1Adapter.savePhoto` (`d1-adapter.ts:100-115`) builds the statement from
the **object's keys**:

```ts
const keys = entries.map(([k]) => k);
await this.db.prepare(
  `INSERT INTO photos (${keys.join(', ')}) VALUES (${placeholders})
   ON CONFLICT(id) DO UPDATE SET ${updateSet}`
).bind(...values).run();
```

Values are bound and safe. **Identifiers are string-interpolated.** A crafted
JSON key is arbitrary SQL.

The route is live and reachable — mounted at `index.ts:226-229`, auth-gated at
`assets.ts:190` — and has **no caller anywhere** in the repo. The only mentions
outside the shim are the bundled copy and an aspirational line in
`docs/roadmap/MOBILE_APP.md:53`.

It also has no deduplication at all, so even used as intended it creates a
duplicate row per call.

**Fix:** delete the route. Independently, `savePhoto` must validate keys against
a known column allowlist regardless of who calls it.

---

## 3. HIGH — `/api/server/*` hands out the keys to everything

Two endpoints return secrets, both behind `requireAuth` with **no authorization
check whatsoever**:

| Endpoint | Returns | Line |
|---|---|---|
| `/api/server/zke-config` | the raw ZKE **password and salt** — the master key for every photo | `server.ts:81-82` |
| `/api/server/telegram-config` | the **bot token** in cleartext | `server.ts:105` |

`isAdmin` exists but is **written three times and read zero times**
(`auth.ts:103`, `user.ts:72`, `albums.ts:230`). There is no admin concept in the
worker.

**On hosted this is contained** — one worker and one D1 per user, and a session
is signed with that worker's own secret, so it only ever exposes a user's own
data to themselves.

**On self-host it is serious.** One worker, one D1, one `SESSION_SECRET`, and
`D1Adapter.getConfig` is `SELECT value FROM config WHERE key = ?` with no owner
scoping (`d1-adapter.ts:266-272`). Firebase email/password signup is open by
default, so **any** account that can register in the operator's Firebase project
can log in and fetch the key that decrypts every photo in the install.

**Fix:** never return key material over HTTP — the worker derives the key
itself; no client needs it for server-mode ZKE. Return `{enabled, mode}` and
`{configured, channelId}` respectively. Then store `owner_uid` at setup and gate
config-returning routes on `session.uid === owner_uid`.

---

## 4. HIGH — the public-constant signing fallback is still open, and a test asserts it stays open

`sessionScope` (`selfhost-auth.ts:44`) still falls back to `APP_IDENTIFIER` for
hosted workers, and that value is committed in the repo
(`immich-api-shim/wrangler.toml:9` = `"default-daemon-client"`), plus shipped to
browsers in `accounts-portal/src/hooks/useWorkerSetup.ts:8`.

So against any hosted worker **not yet redeployed** with a per-install secret,
anyone can forge a session for any account.

The fallback was deliberate — removing it before the fleet rolled over would log
everyone out — but it is not self-limiting. Nothing records whether a worker
ever had a secret, so it cannot expire. And
`auth-security.test.ts:86-93` currently asserts that forged
`APP_IDENTIFIER`-signed tokens **are accepted**.

**Fix:** force-redeploy every hosted worker through the existing
`/admin/force-update` path (which already threads `sessionSecret` through
`buildShimBindings`), then delete the fallback and flip that test to assert
rejection. If it must live longer, gate it on a date/version so it hard-fails at
a fixed cutoff rather than persisting forever.

---

## 5. HIGH — sessions cannot be revoked

- `SESSION_TTL_SECONDS = 3650 * 24 * 60 * 60` — about ten years (`auth.ts:14`).
- The token payload is base64, not encrypted, and contains the long-lived
  Firebase `refreshToken` (`auth.ts:89-96`).
- `handleLogout()` (`auth.ts:149-156`) takes **no arguments** — no `env`, no
  request. It sets `Max-Age=0` cookies and returns. It is structurally incapable
  of revoking anything.
- There is no revocation store. `/api/sessions` returns a hardcoded `[]`
  (`stubs.ts:63`).

On hosted, a Firebase password change does eventually bite, because the embedded
refresh token stops working and `helpers.ts:133` throws. **On self-host it never
bites**: `helpers.ts:94` returns before the refresh block entirely. A leaked
self-hosted token is a ten-year bearer credential with no way to kill it.

**Fix:** a `session_epoch` integer in the config table, stamped into tokens at
issue and checked at verify. `handleLogout` takes `(request, env)` and bumps it.
Bring the TTL down to something bounded and lean on refresh for continuity —
which is what the comment at `auth.ts:5-13` already claims happens.

---

## 6. HIGH — the chunk budget is wrong by 3x, and each chunk is copied 19 MB at a time

`MAX_CHUNKS_PER_RESPONSE = 20` (`assets.ts:2226`) assumes 2 subrequests per
chunk. The real cold cost is **six**:

| | Call | Line |
|---|---|---|
| 1 | `cache.match(ck)` | `assets.ts:2133` |
| 2 | `edgeCache.match(cfCacheKey)` | `assets.ts:3121` |
| 3 | `fetch(getFile)` | `assets.ts:3130` |
| 4 | `edgeCache.put(...)` | `assets.ts:3138` |
| 5 | `fetch(file download)` | `assets.ts:3149` |
| 6 | `cache.put(ck, ...)` in `waitUntil` | `assets.ts:2146` |

Cache API operations count toward the subrequest limit, and `waitUntil` shares
the invocation's budget. 20 chunks × 6 = **120 against a cap of 50**. A
nine-chunk video already exceeds it.

Separately, `assets.ts:2146` does `data.slice(0)` — a full 19 MB copy per chunk,
un-awaited inside `waitUntil`. Up to 20 can be in flight at once (380 MB),
which defeats the "~2 chunks in memory" claim in the comment above it and is a
likelier cause of memory kills than the stream queue.

**Fix:** derive the budget from subrequests, not chunks —
`floor((cap - preamble) / 6)`, about 6-7. Check the body cache *before*
resolving the file path, so a warm chunk costs 1 instead of 6. Serialise the
`cache.put`s or skip caching beyond the first chunk.

---

## 7. HIGH — the timeline never got sync's one-job-per-request fix

`sync.ts:290-302` deliberately round-robins a single background heal job per
invocation, and the comment above it documents exactly this 1102 failure mode.

`timeline.ts:55-69` still dispatches **two** unconditionally: the checksum
backfill (budget 40) and the HEIC thumbnail backfill (budget 24). Neither knows
about the other. **64 against a cap of 50**, on what is otherwise a trivial
request.

**Fix:** apply the same rotation. Better, build the shared budget counter (see
finding 12) so budgets cannot be declared independently of each other.

---

## 8. MEDIUM — the Telegram file-path cache outlives Telegram's own validity

`tgGetFileUrl` (`assets.ts:3108-3144`) has three tiers. The L2 (Cache API) entry
is stored with `max-age=3300` (55 min), and on a hit, `assets.ts:3124`
re-stamps the in-memory L1 entry with a **fresh** 55 minutes from now — with no
age check. One `file_path` can therefore be used for up to **110 minutes**
against Telegram's roughly 60-minute validity.

There is also no invalidation anywhere: `grep filePathCache` finds no `.delete()`
call. `tgDownloadFile` (`assets.ts:3146-3152`) returns the failure without
touching either cache, so a stale path 404s on every retry for the rest of the
TTL.

**Fix:** store `fetchedAt` in L2 and derive L1 expiry from it (or honour the
cached response's `Age`). On 404/410, delete both cache entries and retry once
with a forced refresh. Note `webdav.ts:265-268` calls `getFile` with no caching
at all — a separate inconsistency.

---

## 9. MEDIUM — full-file downloads have no backpressure

The no-Range branch of `handleOriginal` (`assets.ts:2262-2278`) uses
`start(controller)` and loops, enqueuing every chunk as fast as Telegram
delivers it, never consulting `controller.desiredSize`. The stream's internal
queue grows toward the whole file — about 95 MB for a five-chunk video, against
a 128 MB cap.

The 206 path was fixed to use a `TransformStream` with awaited writes
(`assets.ts:2242`). This path was not.

**Fix:** convert to `pull(controller)` with an index cursor, or reuse the 206
path's pump.

---

## 10. MEDIUM — grid thumbnails can serve whole originals

`assets.ts:1910` falls back to `telegramOriginalId` when no thumbnail or preview
is stored. The guard at `assets.ts:1924-1941` only 404s videos and HEIC-on-grid,
so **a plain JPEG or PNG with no stored thumb serves its full original** under a
`size=thumbnail` URL, cached `immutable` for a year.

Resident cost is ~2x for plain files, ~3x for server-encrypted ones, because
`decryptChunk` (`assets.ts:166-171`) makes two extra copies. Bounded at about
57 MB per request by Telegram's 20 MB download cap — survivable alone, fatal
when a grid fires twenty tiles at once.

**Fix:** extend the guard to 404 on the grid path for *any* fallback to the
original, letting the thumbhash blur stand, and queue a real thumbnail through
the existing backfill.

---

## 11. MEDIUM — early dedup is dead for foreground uploads

`videoHintFromFields` (`upload-dedup.ts:51-59`) reads a `filename` field.
The **foreground** uploader never sends one
(`immich/mobile/lib/services/foreground_upload.service.dart:326-333`) — the name
travels on the file part's Content-Disposition instead
(`upload.repository.dart:109`). Only the background uploader sends the field
(`background_upload.service.dart:458`).

So the hint is always `null`, `earlyDedupDecision` bails (`upload-dedup.ts:33`),
and every foreground retry buffers and hashes the whole file before discovering
it is a duplicate — the exact load the fast path exists to avoid.

Ordering makes the naive fix impossible: the callback fires as soon as
`deviceAssetId` and `deviceId` are seen (`upload-stream.ts:100-107`), while the
file part arrives after all fields.

**Fix:** use the `duration` field, which the foreground path *does* send
(`foreground_upload.service.dart:332`; Dart renders `0:00:00.000000` for stills).
Alternatively defer the check to the `assetData` part *header*, where
`part.filename` is available before the body is consumed
(`upload-stream.ts:91`).

---

## 12. MEDIUM — there is no shared subrequest budget

Three unrelated limits, hand-maintained, none aware of the others:

- `SUBREQUEST_BUDGET = 24` (`assets.ts:2754`, HEIC backfill)
- `SUBREQUEST_BUDGET = 40` (`assets.ts:2912`, checksum backfill)
- `MAX_CHUNKS_PER_RESPONSE = 20` (`assets.ts:2226`)

None counts Cache API operations or D1 queries. Increments are manual
`subrequests++` calls that drift from the code they are meant to measure.

**Fix:** one counter object threaded through a request, incremented inside the
helpers that actually make the calls, so a budget cannot be declared
independently of what it is counting. This is the structural fix that makes
findings 6 and 7 stay fixed.

---

## 13. HIGH — worker state accumulates until the isolate dies, then recovers

**Reported symptom (operator, 2026-07-26):** *"after it gets this problem I
reopen the app and it's good again for some time, then again problem."*

That is the signature of per-isolate state growing until the isolate exceeds its
limits. Device log from that day: **60 × 502, all of them Cloudflare 1102
"Worker exceeded resource limits"**, plus 17 × 503 and 3 × Telegram 429.

Cloudflare reuses a Worker isolate across many requests, and module-level state
lives for the isolate's whole life. Reopening the app makes new connections,
which can land on a fresh isolate — hence "good again for a while". The old
isolate is still fat; it just is not serving that client any more.

What accumulates:

- **`filePathCache` never evicts.** `assets.ts:73` is a module-level `Map`, and
  `grep` finds only `get` and `set` — no `delete`, no size cap. Expired entries
  are read, ignored, and left in place. Every distinct chunk the user ever
  touches adds an entry that is never removed.
- **The 19 MB chunk copies (finding 6).** `assets.ts:2146` does `data.slice(0)`
  per chunk inside an un-awaited `waitUntil`. Up to twenty can be outstanding at
  once. This is almost certainly the dominant term.
- **Budget overruns (findings 6 and 7)** make each failing request cost more
  than the accounting believes, so an isolate reaches the ceiling sooner than
  anything in the code expects.

The three compound: an isolate serving a backup session accumulates cache
entries and pending copies while systematically under-counting its own spend.

**Fix:** findings 6 and 7 remove most of the pressure. Additionally, bound
`filePathCache` — evict on read when expired, and cap the size with simple
oldest-out eviction. An unbounded cache in a process with no defined lifetime is
a leak regardless of what else is happening.

**Verification is not "it feels better".** It needs a sustained upload run
watched for 1102s across a period long enough for an isolate to be reused —
which is exactly what Phase 5.1 is for.

---

## 14 — `daemonclient-proxy` was a fully open proxy · CRITICAL · **FIXED**

`daemonclient-proxy/src/index.js` took `?url=` from any caller, unauthenticated,
and fetched it. No allowlist. It forwarded the caller's entire header set —
`Cookie` and `Authorization` included — to whatever host was named, and reflected
every response header back with `Access-Control-Allow-Origin: *` and
`Access-Control-Expose-Headers: *`.

Usable to reach private and cloud-metadata addresses from inside Cloudflare's
network, to launder arbitrary traffic through the operator's account, and to burn
its request quota. It is bound as `TELEGRAM_PROXY` into every worker and its URL
is handed to browsers, so it is public and discoverable.

The shim's own `/proxy` was closed in `b0202c4`; this is a **separate deployed
worker** with the same job and it was missed. Found by the security review of the
plan, not by the audit that produced findings 1-13.

**Fixed and deployed** (`0311248`): exact host `api.telegram.org`, https, default
port; forwarded headers reduced to what Telegram needs; redirects no longer
followed. Verified live — blocked targets 403, Telegram still passes through.

The shim's `/proxy` was tightened in the same commit: its `.telegram.org` **suffix**
rule accepted a Cyrillic homograph, because `new URL()` normalises
`аpi.telegram.org` to `xn--pi-6kc.telegram.org`, a genuine subdomain. It also had
no test at all, so the earlier hardening had never been verified.

## 15 — The bot token was logged in full on every Telegram 429 · HIGH · **FIXED**

`assets.ts:3097` logged `url.substring(0, 80)`. A Telegram url is
`https://api.telegram.org/bot<TOKEN>/method`; that prefix is 28 characters and a
bot token is ~46, so the whole token went into the logs — on the code path that
fires hardest under load, which is exactly when a backup is running. The token is
full control of the user's channel: read every file, delete all of it.

**Fixed and deployed** (`0311248`): `redactTelegramUrl()` replaces the token and
keeps the rest of the line. A repo-wide sweep for other secrets reaching a logger
found none; the one remaining hit (`helpers.ts:72`) logs Google's *error response*
body, which does not echo the token.

## 16 — `/api/drive/config` is not scoped to the owner · MEDIUM · **planned (2.4)**

`drive.ts:50-74`. On a per-user worker the telegram config lives in
**worker-global D1**, not under a uid: `getCachedConfig` falls through to
`adapter.getJsonConfig(key)` (`cached-config.ts:17-20`). So GET returns the
install's bot token to any authenticated session, and POST overwrites the bot
token and channel for everyone — redirecting all future uploads to a channel of
the caller's choosing.

**Severity depends on which install.** On hosted it is contained: `requireAuth`
verifies against the *worker's* `SESSION_SECRET` binding while login signs with
the *user's own* secret, so a session minted elsewhere does not verify here. It is
**not** contained on a multi-user self-host install — one worker, one secret,
everyone — nor on any worker still missing `SESSION_SECRET`.

Not patched in a hurry, because the correct fix is the `owner_uid` gate that Task
2.4 already builds, and an ad-hoc ownership rule invented now could lock the
operator out of their own worker. Self-host has not shipped, so nothing is
exposed while it waits.

## 17 — No ownership check on any single-asset path · HIGH · **planned (2.0)**

Every *list* query filters on `ownerId`. Every *single-row* accessor does not:
`getPhoto(id)` (`d1-adapter.ts:71`), `updatePhoto(id, fields)` (`:122`),
`deletePhoto(id)` (`:135`). `loadPhotoById` (`assets.ts:1651`) receives a `uid`
and, on the D1 branch, never uses it — so thumbnail, original, HEAD, chunk
manifest, replace-video, playback, thumbnail upload, update, bulk update and
delete all inherit it. The delete path removes the Telegram messages **before**
tombstoning the row, so it is irreversible. `handleAssetInfo` reads any row and
stamps the requester as its owner.

`albums` has **no owner column at all** (`deployment-service/src/index.ts:118-122`)
and `listAlbums()` is `SELECT * FROM albums`.

Drive does this correctly (`drive.ts:150-151`), and that asymmetry is what marks
it an oversight rather than a deliberate single-tenant assumption.

Nil blast radius on hosted — one worker, one database, one person. On a
self-hosted install with a second account it is cross-user read, modify and
permanent delete by asset id. Self-host has not shipped; this must not be what
ships with it. Found by the security review; larger than finding 3, which stops
at *reading config*.

---

## Sources

Two verification agents produced this, each reading the code and reporting
file:line. Where their conclusions differed from the original suspicion, the
code won — finding 2's SQL injection and finding 7's timeline dispatch were both
discovered during verification rather than being on the original list.

## 18 — The plaintext original is uploaded to Telegram on every encrypted upload · HIGH · **open**

Found while writing a test that asserts the encrypted upload path sends
ciphertext. It does not — not only.

`fetchTelegramThumb` (`assets.ts:792`) uploads the **complete plaintext original**
to the user's channel, under its real filename, so that Telegram will generate a
thumbnail for it. The temporary message is then deleted (`assets.ts:1537`).

Observed directly on the encrypted path, with real key material, for a
four-byte fixture:

```
sendDocument  document=32B  name=blob.bin    ← the encrypted chunk
sendDocument  document=4B   name=secret.jpg  ← the plaintext original
deleteMessage
```

This is deliberate and the code says so. It is also the weakest point in the
server-ZKE claim, for three reasons:

1. **Telegram receives the plaintext.** Whatever happens afterwards, the bytes
   were transmitted to and stored by a third party. "Encrypted at rest in your
   channel" is not true of the moment between the two calls.
2. **Deletion is best-effort.** If `deleteMessage` fails — a 429, a network
   fault, or the worker being killed by error 1102 mid-flight — the plaintext
   stays in the channel permanently, and nothing retries or notices. The comment
   at `assets.ts:1530-1536` records that this has already happened once (the
   "PNG raw copy not deleting" regression) and that the delete was moved earlier
   specifically because free-tier workers were dying before reaching it.
3. **It doubles the cost** of every image upload in bandwidth and in Telegram
   send quota — the quota whose exhaustion produces the 429s that make the
   delete fail.

HEIC does not do this (`assets.ts:1514-1523` routes to the per-user processor
instead), so the pattern for avoiding it already exists in the codebase.

**Not fixed here.** It is a deliberate design decision with a real benefit —
free server-side thumbnails — and replacing it means generating thumbnails
another way for every non-HEIC image. That is a task, not an edit, and it needs
the operator's call on the trade. Recorded now so the decision is explicit
rather than inherited.

`zke-failclosed.test.ts` pins the current behaviour: the persisted chunks must
be ciphertext, and the temporary plaintext message must be deleted. Remove the
delete and the suite fails.
