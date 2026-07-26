# Principles review of the master plan

**Verdict:** approve-with-changes

Reviewed against P1–P6, `PARITY.md`, and the code as it actually stands. Every
claim below was checked at file:line.

The plan is mostly right, and in places it is better than right. Phase 1 is
correctly first. Phase 3 is clean against the worker's real budgets. The update
check already in the tree is a model of P3 and needs no work. The CLI design's
rule "the vendors' CLIs authenticate, we do the work" is the correct rule and
nothing of the operator's is in the auth path.

But one task is wrong in the same way the Docker decision was wrong: **Task 2.3
is built on a premise that is false in the code, and shipping it would push
every media byte for every web user back through the worker** — the exact load
Phase 3 exists to prevent — **and silently downgrade web uploads to plaintext**,
which is the Phase 1 bug re-entered from the client side. That tradeoff is not
surfaced anywhere in the plan. It is the third one. Details in V1.

And the plan is missing a whole third of what `PARITY.md` promises: **nothing in
it deploys or de-hardcodes the Photos and Drive web apps.** As the code stands
today, a self-hoster who follows `docs/SELF_HOSTING.md` sends their password to
the operator's worker. Details in V2 and V3.

---

## Principle violations

### V1 — Task 2.3 breaks the client-direct byte path. Its premise is false. (P4, P5, P1, PARITY)

The task says: *"The worker derives its own key; no client needs the raw
material for server-mode ZKE."* `FINDINGS.md` §3 says the same. **Both are
wrong.** Two clients need it, and one of them is the architecture:

| Reader | File:line | Uses |
|---|---|---|
| Photos service worker | `immich/web/src/service-worker/index.ts:358` | `botToken`, `proxyUrl` from `/api/server/telegram-config` |
| Photos service worker | `immich/web/src/service-worker/index.ts:371` | `password`, `salt` from `/api/server/zke-config` → derives the AES key |
| Photos web (upload + download) | `immich/web/src/lib/utils/daemonclient-drive.ts:25, 38` | both, for browser-direct upload/download |

The service worker's own comment states why it exists
(`immich/web/src/service-worker/index.ts:19-21`):

> *"Client-direct media: the SW reads asset bytes straight from Telegram (via
> the user's streaming /proxy) and decrypts them here, so the per-user Worker
> only serves tiny JSON and can never hit its 128MB/CPU/subrequest limits."*

Remove those fields and:

- **P4/P5.** The SW's `telegramMedia` path throws `FALLBACK` and every image,
  thumbnail and video byte routes through the worker again. That is the exact
  128MB / 50-subrequest pressure that Phase 3 spends eight tasks relieving. The
  memory note "worker byte-path offload, 2026-06-19" records that this was built
  *because* the free tier could not carry it. Task 2.3 undoes it.
- **P1, and it re-arms Phase 1.** `daemonclient-drive.ts` `uploadMedia` sets
  `const c = key !== null` and, when the key is null, uploads with
  `encryptionMode: 'off'` — **plaintext to Telegram, from the browser.** Phase 1
  makes the *server* fail closed; Task 2.3 would make the *client* fail open. In
  the same plan.
- **PARITY.** `PARITY.md` states the rule in its own words: *"It may not remove
  or repurpose a field."* This removes three. A self-hoster running a web build
  from before the change against a worker from after it gets the degraded path
  with no signal at all.

**What the real defect is.** `FINDINGS.md` §3 already says it: on hosted, one
worker and one D1 per user means these endpoints only ever hand a user their own
credentials — that is by design, the browser *is* the user. The exposure is
**self-host only**, where one worker serves an open Firebase signup and any
account that can register reads the owner's keys.

**The fix, therefore, is Task 2.4 and only Task 2.4.**

Change 2.3 to:
- Keep the response fields. Do not change the shape.
- Add `Cache-Control: no-store` and confirm neither value can reach a log.
- Write the trust model down: these endpoints hand a user their own bot token
  and their own key, and that is what makes zero-cost byte transfer possible.

Change 2.4 to be unconditional rather than "no-op when `owner_uid` is absent":
- Write `owner_uid` on **both** paths. The hosted provisioner already has the
  uid (`deployment-service/src/index.ts:274`). One code path, and hosted gets
  defence in depth for free.
- On self-host, a worker with no `owner_uid` must **refuse** config routes, not
  serve them. As written ("Absent (hosted), behave as now") a self-host install
  where the setup write failed silently keeps the hole open — fail closed, the
  same rule Phase 1 is built on.
- Promote 2.4 above 2.3 in the phase; 2.3 currently gates it, and it is the
  weaker of the two.

If genuine key-hiding is wanted later, the answer is **client-mode ZKE** (the
key never leaves the browser, derived from the user's own passphrase) — a
product decision with a real migration, not a field deletion.

### V2 — P3: the Photos web app posts a self-hoster's password to the operator (not in the plan)

`immich/web/src/service-worker/index.ts:26`

```ts
const DEFAULT_WORKER_URL = 'https://api.daemonclient.uz';
```

A compile-time constant, not a build variable. `workerBase()` returns it
(`:184`) for **all pre-login traffic**, which includes `POST /api/auth/login`.
A self-hoster who builds and deploys `immich/web` exactly as
`docs/SELF_HOSTING.md:81-95` instructs — *"Point the app at your API address"*,
for which no mechanism exists — sends their email and password to the operator's
worker. `immich/web/src/routes/auth/login/+page.svelte:203` also links signup to
`accounts.daemonclient.uz`.

This is the plainest P3 violation in the repository and it is also a P1 issue.
Nothing in the plan touches it.

**Fix:** a Phase 4 task. `DEFAULT_WORKER_URL`, the signup link and the external
domain come from build-time env with **no hosted default when the self-host flag
is set** — copy the pattern `accounts-portal/src/config/firebase.js:28-31`
already uses, which refuses to fall back rather than guessing. Then a
`daemonclient photos` command that builds and deploys it to Cloudflare Pages,
the same way `dashboard.mjs` already does.

### V3 — P3: the Drive web app is hard-wired to the operator's central worker (not in the plan)

`drive/src/api.js:14`

```js
const CENTRAL_API = 'https://immich-api.sadrikov49.workers.dev';
```

Every `login()` goes there. Plus `drive/src/App.jsx:23, 448` (onboarding and
signup at `accounts.daemonclient.uz`), `:740` (an error message telling the
self-hoster to finish setup on the operator's site), and `:2088`, which
**redirects any non-matching hostname to `https://drive.daemonclient.uz`** — so
a self-hoster's Drive deployment bounces its users onto the operator's domain.

`PARITY.md` promises Drive to self-hosters in the operator's own words. Today
Drive is not self-hostable at all, and the plan does not make it so.

**Fix:** same as V2 — build-time config with no hosted fallback, plus a deploy
command. This is the larger of the two; `drive/` has no self-host mode at all,
where `accounts-portal/` already does.

### V4 — P2 / parity: the canonical schema lives inside the hosted control plane and is obtained by regex

`selfhost/src/deploy.mjs:126-139` and `selfhost/src/build.mjs:49-51` read the
schema by string-scanning the operator's control plane:

```js
const source = path.join(repoRoot, 'deployment-service', 'src', 'index.ts');
const grab = (name) => { const start = text.indexOf(`const ${name} = \``); ... };
```

Meanwhile `immich-api-shim/src/migrations.ts` holds a **second** copy of the
schema in a migration system that `assets.ts:814` notes is never run.

Three problems:

1. This is the exact shape of the Phase 1 bug. `PHASE_1.md` names it: *"two
   things that should have been one."* Task 1.3 seeds the keys in the CLI and
   leaves the split intact — the next provisioning path re-opens the trap, which
   is precisely what finding 1(b) warns about.
2. It is brittle in a silent way. A reformat, a prettier run, or a backtick
   inside the template breaks a self-hoster's schema with no test failing.
3. **Task 6.5 is a live hazard against it.** 6.5 moves dead directories to an
   attic. If `deployment-service` — the operator's hosted control plane, which a
   self-hoster has no other use for — is ever moved or trimmed, self-host setup
   dies. A self-hoster currently has to carry the operator's control plane in
   their clone to get a database (P2 baggage).

**Fix, and it belongs in Phase 1 before Task 1.3:** one exported schema module
under `immich-api-shim/src/` (fold `migrations.ts` into it or replace it),
imported by `deployment-service` and by the CLI. Put the key seeding *in that
module*, so schema and key material cannot separate again. Then 1.3 is three
lines instead of a new code path, and 6.5 is safe.

---

## Where the plan is already correct — no objection

State these plainly so they are not re-litigated:

- **The update check is exemplary P3.** `immich-api-shim/src/update-check.ts`:
  anonymous public GitHub endpoint, **nothing about the install is sent**, repo
  overridable via `UPDATE_REPO`, cached 12h in the install's own D1, fails to
  `"unknown"` and never blocks a request, never self-mutates. The header comment
  states the constraint ("an update check must not become telemetry") and the
  code honours it. Leave it alone.
- **`firebase login` / `vercel login` / `wrangler login` are the vendors' own
  first-party clients.** Cloudflare's is `54d11594-84e4-41aa-b438-e81b8fa78ee7`
  (`SELFHOST_CLI_DESIGN.md:47`), `firebase-tools` uses Google's verified client
  (§10.2), `vercel login` is RFC 8628 against Vercel's own client (§12.1). The
  design explicitly excludes the operator's own CF OAuth app
  (`ffa260b791c9a72c5020dacaa5c1035f`, line 109) as hosted-only. **P3 clean.**
  Nothing of the operator's is in any auth path. Rule R2 ("CLIs authenticate; we
  do the work") is the right call and is also why the errors will be usable.
  - One small addition: pass the analytics opt-out to `firebase-tools` and
    `vercel` for the same reason `WRANGLER_SEND_METRICS=false` is already in R3.
    Not our telemetry, but a self-hoster should not be opted in by our CLI.
- **The processor has no operator fallback.** `heicConvertUrl` is per-install
  config; absent → conversion is skipped and HEIC thumbnails stay blank
  (`assets.ts:2767-2768`). No default URL anywhere.
- **The Telegram proxy has no operator fallback for self-host.**
  `handleTelegramConfig` (`server.ts:105-109`) prefers the install's own
  `/proxy` whenever `env.DB` is bound; `env.TELEGRAM_PROXY` is only reached by
  the central worker. Good — and worth a comment so nobody "simplifies" it.
- **Phase 3 is P4/P5-correct throughout.** Everything stays inside the worker,
  adds no dependency, and the arithmetic in 3.2 is right (6 subrequests/chunk
  against a cap of 50 → 6-7 chunks). 3.1's rule — increment inside the helper
  that makes the call, never at the call site — is the correct structural fix.
- **No P6 drift anywhere.** Nothing in 31 tasks moves toward R2/S3. The word
  does not appear. Good.
- **4.1 and 4.4 are exactly the right instinct** — one config module, one health
  implementation. That is the anti-duplication reflex the project needs more of.
- **Task 2.1 (delete the dead route) over "harden it"** is the right call and
  the reasoning given is the right reasoning.

---

## Over-engineering

### Cut Task 6.2 (the documentation site), or defer it past this plan

It is scope creep, and the plan half-admits it ("Risk: medium — scope creep").
Against it:

- The repo is *currently trying to shed* static sites. `6.5` proposes attic-ing
  `landing-page` and `photos`; `daemonclient-site` and `accounts-portal` stay.
  Adding `docs-site/` in the same phase moves in the opposite direction.
- GitHub already renders `docs/*.md` with navigation, search and anchors, for
  free, for an audience that at this stage is a handful of contributors and
  self-hosters who arrive at the README.
- Nothing else in the plan depends on it except 6.4, which does not need it.
- The value in Phase 6 is entirely in **6.1, 6.3 and 6.4** — real content. A site
  with thin content is worse than no site.

Recommendation: ship 6.1/6.3/6.4/6.5. If a site is still wanted afterwards, it
is one config file over the same markdown and can be done any afternoon. If the
operator wants it regardless, the non-negotiable constraint is that it renders
`docs/` and never becomes a second copy to forget to update — which the task
already says, and which most static generators quietly break by needing their
own nav config.

### Task 3.3's verification is the wrong test

*"a test asserting at most N concurrent cache writes"* will be brittle and will
be deleted within a year. The fix is a one-line behaviour change. Assert the
behaviour: **no full-body clone**, and **at most one `cache.put` per response**.

### Open question 1 — do not give self-host a different session TTL

*"Thirty days, or longer for self-host only?"* — a self-host-only TTL is a
**sixth divergence point** (`PARITY.md` counts five) bought for a comfort issue.
The refresh path in question is the shim's own signed token; re-minting one
needs nothing Firebase-specific. Give both flavours the same bounded TTL and the
same refresh. If that turns out to be real work, take the longer TTL for both
rather than forking the behaviour.

---

## Duplication

1. **The schema, twice, read by regex from a third place.** V4 above. The single
   most important simplification available in this plan.
2. **Task 2.4 as written creates two behaviours** ("absent → behave as now").
   One rule, applied on both paths, with the hosted provisioner writing
   `owner_uid` it already holds.
3. **`dashboard.mjs:55-56` asks the user to type the Photos and Drive URLs** —
   because nothing deploys them. Once V2/V3 land, deploy them the way the
   dashboard is deployed and stop asking. Also note `dashboard.mjs` still
   imports `state.mjs` (`:21`), which Task 4.1 deletes — 4.1's blast radius is
   larger than "three commands", check every importer.
4. **Task 4.4** is the good example of avoiding this. Apply the same reasoning
   to 2.3/2.4 and to V4.

---

## Parity risks

1. **Task 2.3 removes response fields.** Direct violation of `PARITY.md`'s
   stated compatibility rule. See V1. This is the one to fix before anything
   else in Phase 2.
2. **Task 2.5 changes the token payload.** Verify covers "no epoch → behaves as
   today" for the *server*. It must also cover the *clients*: the Photos service
   worker parses the token's first segment and reads `workerUrl` out of it
   (`service-worker/index.ts`, the `workerUrlFromToken` helper). **Adding** a
   field is fine; reordering, renaming or changing the encoding is not. Add that
   assertion to 2.5's verification, and state in the task that every user is
   logged out exactly once.
3. **Task 2.6's gate can become permanent.** It depends on an operator action
   (fleet redeploy) that is also listed in `SCRATCHPAD.md` as outstanding. As
   `FINDINGS.md` §4 itself suggests, put a **date or version cutoff** in the
   fallback now, so it expires whether or not the redeploy happens. A security
   fix should not be indefinitely blocked on a task nobody is holding.
   - Note the self-host half already throws correctly
     (`selfhost-auth.ts:36-42`) — 2.6 is hosted-only work.
4. **Task 3.6 (404 for grid thumbnails) touches a mobile path.** Likely safe —
   it is an image request, not the sync stream — but `PARITY.md` warns about the
   strict isolate and this plan has one chance to check it. Make it an explicit
   line in 5.1's checklist rather than an assumption.
5. **Task 5.3's divergence guard needs a real number.** Today it is **five**
   non-test call sites of `isSelfHost`: `server.ts:117`, `helpers.ts:94`,
   `helpers.ts:153`, `index.ts:70`, `assets.ts:56`. Write `5` into the test so
   it ratchets. (`PARITY.md`'s table lists these five correctly.)

---

## Missing

What the principles demand and the plan does not cover:

1. **Photos web for self-host** (V2). No task deploys or de-hardcodes
   `immich/web`. Without it there is no Photos web app for a self-hoster, and
   the current documentation describes a flow that silently points at the
   operator. Phase 4 task.
2. **Drive web for self-host** (V3). Same, larger. `PARITY.md` promises it.
   Phase 4 task.
3. **`ALLOWED_ORIGINS` for three apps, not one.** It defaults to
   `http://localhost:5173` (`deploy.mjs:29`) and only `dashboard.mjs:150-157`
   ever adds to it. Whatever deploys Photos and Drive must register their
   origins too, or both apps are dead on arrival with a CORS error a self-hoster
   cannot diagnose. This is a five-line fix that turns into a support burden if
   missed.
4. **A P3 regression test in CI.** The highest-value single check in this plan:
   grep the self-host build output and the shim for `daemonclient.uz`,
   `sadrikov49.workers.dev` and `accounts.daemonclient`, and fail if any appears
   outside an explicitly hosted-only default. V1, V2 and V3 would all have been
   caught by it, and it keeps them caught once the repo is public and strangers
   are sending patches. Add to Task 5.3.
5. **Mobile against a self-hosted server, verified.** The prefill at
   `immich/mobile/lib/widgets/forms/login/login_form.dart:162` is only used when
   nothing is stored and the field stays editable — that part is fine, no change
   needed. But nothing in the plan proves the app works against a self-hosted
   worker end to end. Make 5.1 explicit: fresh install → type the self-hosted
   URL → login → **sync stream parses** → backup → thumbnail → byte-exact
   download. Sync stream first, because that is the failure that bricks
   permanently.
6. **Phase 1 leaves existing self-hosters with a hard-failing worker.** After
   1.1, an install with `zke_enabled=1` and empty key material refuses uploads —
   correct — but 1.3 only seeds during `setup`. Someone who already ran setup and
   then runs `daemonclient update` gets a worker that refuses every upload and no
   path out. Run the same idempotent "seed only if empty" in `update` and report
   it in `doctor`.
7. **The git history scrub is a blocker on Phase 6, and the plan does not say
   so.** `SCRATCHPAD.md` lists three Firebase admin private keys, a personal
   Telethon session and live bot tokens still in history. Phase 6 is the phase
   that invites strangers in (P2). Make the scrub an explicit exit criterion of
   Phase 6 — no amount of README quality compensates for it.

---

## Order

**Phase 1 first: agree, without reservation.** Silent, irreversible, cheap to
fix, and every hour of delay adds photos that cannot be un-leaked. There is no
argument for anything else going first. The plan's own reasoning is correct.

Four adjustments:

1. **Move the schema unification (V4) into Phase 1, ahead of 1.3.** The plan
   diagnoses the bug as "two things that should have been one" and then fixes
   the symptom while leaving the split. Unify first and 1.3 becomes three lines
   in the right place; leave it and the next provisioning path re-opens it.
2. **Re-order Phase 2: 2.1, 2.2, 2.4, 2.5, (2.3 rescoped), 2.6.** 2.4 is the
   task that actually closes finding 3; 2.3 currently gates it and, as written,
   causes more damage than it prevents.
3. **Consider 3.1–3.4 before the back half of Phase 2.** Weak preference, either
   works. The argument for moving them up: 1102 is what users hit daily, while
   the remaining Phase 2 items are (per `FINDINGS.md` §3) contained on hosted and
   closed on self-host by the owner gate alone. If Phase 2 shrinks as
   recommended, the question mostly disappears.
4. **Phase 4 has a single-point bottleneck.** 4.5, 4.6 and 4.7 all say *Depends
   on: 4.3*, and 4.3 is the one flagged "high risk — split if it grows past one
   review". Split it now, deliberately: make 4.3a the probe/repair/verify
   *interface* (one small file, no behaviour change), then 4.3b–4.7 are
   independent and can be written and reviewed in parallel. Otherwise the
   riskiest task in the plan blocks four others.

Phase 4 after 1–3, Phase 5 after 4, Phase 6 last: all correct, minus 6.2 and
plus the two new web-app tasks in Phase 4.

---

## Summary of required changes

| # | Change | Principle | Task |
|---|---|---|---|
| 1 | Do not remove `botToken`/`password`/`salt`; fix the exposure with the owner gate instead | P1 P4 P5 PARITY | 2.3 → 2.4 |
| 2 | Make the owner gate unconditional and fail-closed on self-host | P1 | 2.4 |
| 3 | New task: de-hardcode and deploy Photos web for self-host | P3 | Phase 4 |
| 4 | New task: de-hardcode and deploy Drive web for self-host | P3 PARITY | Phase 4 |
| 5 | One schema module; seed keys in it | P2, dup | Phase 1, before 1.3 |
| 6 | CI grep for operator URLs in self-host artifacts | P3 | 5.3 |
| 7 | Seed keys in `update`/`doctor`, not only `setup` | P1 | 1.3 |
| 8 | Cut the docs site, or defer it | scope | 6.2 |
| 9 | Date/version cutoff on the `APP_IDENTIFIER` fallback | P1 | 2.6 |
| 10 | `ALLOWED_ORIGINS` covers all three apps | usability | Phase 4 |
| 11 | 5.1 covers mobile end-to-end, sync stream first | PARITY | 5.1 |
| 12 | History scrub is an exit criterion of Phase 6 | P1 P2 | 6 |
| 13 | Same session TTL both flavours | PARITY | 2.5 |
