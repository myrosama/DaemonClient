# Phase 2 — Close the remaining account-takeover paths

**Goal:** No authenticated user can reach another's data or the install's keys, and no unauthenticated user can forge a session anywhere.

**Status:** not started.

Full task detail is in `MASTER_PLAN.md`. This file tracks execution: tick
the gates as each task passes, and write down anything surprising.

---

## Why this phase is here

These are exploitable today. They come after Phase 1 only because plaintext-at-rest is worse and already happening.

---

## Tasks

### 2.0 — Give every single-asset path an owner filter
`d1-adapter.ts:71,122,135` · `assets.ts:1651` · `albums.ts` · schema in `deployment-service/src/index.ts:118-122`

- [ ] Implemented
- [ ] Gate 1 · Security
- [ ] Gate 2 · Principles
- [ ] Gate 3 · Correctness
- [ ] Gate 4 · Works for real
- [ ] Deployed & committed

**Watch for:** Change the *signatures* — `getPhoto(id, ownerId)` and friends — so
a call site cannot forget the filter. Adding a `WHERE` at each of the ten callers
is the version of this fix that regresses the moment someone adds an eleventh.

The albums migration is the risky half: existing rows have no owner, and a wrong
backfill hides a user's own albums from them. Test the migration, not just the
query.

Blast radius today is nil (hosted is one worker per person) — which means Gate 4
cannot show you a failure on the live install. Prove it with a **two-user D1
fixture**, every single-asset route, asserting 404 for the non-owner.

### 2.1 — Delete `finalize-client-upload`
`assets.ts` route ~359-361, handler ~1621-1638

- [ ] Implemented
- [ ] Gate 1 · Security
- [ ] Gate 2 · Principles
- [ ] Gate 3 · Correctness
- [ ] Gate 4 · Works for real
- [ ] Deployed & committed

**Watch for:** A dead route that hands any authenticated user arbitrary SQL, via column names rather than values. Deleting beats hardening — nothing calls it.

### 2.2 — Make `savePhoto` reject unknown columns
`d1-adapter.ts` ~100-115

- [ ] Implemented
- [ ] Gate 1 · Security
- [ ] Gate 2 · Principles
- [ ] Gate 3 · Correctness
- [ ] Gate 4 · Works for real
- [ ] Deployed & committed

**Watch for:** Defence in depth. 2.1 removes today's route; this removes the class. Test with a key crafted to break out of the identifier list.

### 2.3 — REVERSED. Do not do this. Merged into 2.4.
`server.ts` ~66-109

- [x] Resolved: no code change

**Both** the principles and alternatives reviews reached this independently.
Removing `botToken` / ZKE material from `/api/server/*` would collapse the
browser byte path onto the worker — `immich/web/src/service-worker/index.ts`
reads those fields precisely so the worker never touches the bytes, which is the
load Phase 3 spends eight tasks relieving. It would also make browser uploads
fall through to `encryptionMode:'off'`, re-arming the Phase 1 plaintext bug from
the client side in the same plan. And it deletes response fields, which
`PARITY.md` forbids.

The narrow real defect — any account on a single-worker install can read them —
is closed by the owner gate. See 2.4.

### 2.4 — The owner gate (now the whole boundary)
`selfhost/src/commands/setup.mjs`, `deployment-service/src/index.ts`, `index.ts` router, `drive.ts:50-74`

- [ ] Implemented
- [ ] Gate 1 · Security
- [ ] Gate 2 · Principles
- [ ] Gate 3 · Correctness
- [ ] Gate 4 · Works for real
- [ ] Deployed & committed

**Watch for:** With multi-user ruled out, this is the security boundary, not a
supplement to one. So it goes **in the router before dispatch**, covering every
authenticated route — a route added next year must be covered by default. Per
handler is how one gets missed.

**Fail closed**, but only where that is safe: `SELF_HOST=1` with no `owner_uid`
must refuse and say to re-run setup. Hosted with no `owner_uid` keeps today's
behaviour, or every existing user is locked out on deploy.

`owner_uid` gets written in **two** places — the CLI at setup, and the
deployment service when it provisions or force-updates. Installs predating both
claim it on first authenticated login, once, never overwritten.

Include `/api/drive/config` (GET **and** POST). On a per-user worker the telegram
config is worker-global D1, not per-uid, so GET hands out the install's bot token
and POST redirects all future uploads. Finding 16.

### 2.5 — Make sessions revocable
`auth.ts`, `helpers.ts`

- [ ] Implemented
- [ ] Gate 1 · Security
- [ ] Gate 2 · Principles
- [ ] Gate 3 · Correctness
- [ ] Gate 4 · Works for real
- [ ] Deployed & committed

**Watch for:** **`handleLogout` runs before any auth check** (`auth.ts:38-40`, it
takes no arguments). Give that function the power to bump a global epoch without
adding `requireAuth` first and you have handed any anonymous caller a repeatable
one-request sign-out of the entire install. Assert it by reading the epoch back,
not by checking a response status.

Everyone gets logged out once when this ships. Say so in the commit and the
release note. **TTL is 30 days for both flavours** — decided. Self-host's lack of
a refresh path is fixed by 2.7 rather than papered over with a longer expiry.

### 2.6 — Close the public-constant signing fallback
`selfhost-auth.ts` ~44, **`auth.ts` ~96**, `auth-security.test.ts` ~86-93

- [ ] Implemented
- [ ] Gate 1 · Security
- [ ] Gate 2 · Principles
- [ ] Gate 3 · Correctness
- [ ] Gate 4 · Works for real
- [ ] Deployed & committed

**Watch for:** There are **two** fallbacks, not one. The verifier's is
`selfhost-auth.ts:44`; the issuer's is `auth.ts:96`
(`userSessionSecret || env.APP_IDENTIFIER || 'default'`), fed by a Firestore read
inside a bare `catch {}`. Delete only the verifier's and a transient Firestore
blip mints constant-signed tokens the hardened fleet rejects — the user is logged
out and cannot log back in until the fault clears. A failed lookup must refuse to
issue.

Note the asymmetry that currently protects the fleet: login signs with the
*user's own* secret, `requireAuth` verifies with the *worker's* `SESSION_SECRET`
binding. That mismatch is why a session minted on one worker does not verify on
another's. Do not remove it by accident.

**Gated on every hosted worker having a per-install secret — checked, not
promised.** `wrangler secret list --name <worker>` reports whether
`SESSION_SECRET` exists without revealing it (confirmed working on
`dc-ozkv3fuz`). Enumerate every `dc-*` worker, paste the output here, and treat
one that cannot be enumerated as failing. Deleting this early locks users out.
The test that currently asserts forged tokens are accepted gets flipped to assert rejection.

### 2.7 — Give self-host the same silent refresh hosted has
`helpers.ts` ~94, `auth.ts`. Depends on 2.5 AND 2.6.

- [ ] Implemented
- [ ] Gate 1 · Security
- [ ] Gate 2 · Principles
- [ ] Gate 3 · Correctness
- [ ] Gate 4 · Works for real
- [ ] Deployed & committed

**Watch for:** `requireAuth` has `if (env && isSelfHost(env)) return session;`
before the expiry check. **Find out why it is there before removing it.** If it
guards something real, narrow the guard rather than deleting it — this is auth
code in the phase where auth mistakes are most expensive.

Run the gates against 2.5 + 2.6 + 2.7 **together**, not against 2.7 alone. All
three touch issuance and verification; passing individually proves less than the
combination does.

Why it matters: mobile backup runs in the background, so an expired session does
not prompt for login — it silently stops backing up. A short TTL without refresh
would manufacture the exact failure this plan exists to remove.

---

## Exit criteria

- [ ] No route returns key material or a bot token.
- [ ] No authenticated account can read another's config.
- [ ] Sessions can be revoked; tokens are bounded.
- [ ] No forged token is accepted anywhere.
- [ ] The test suite asserts each of the above, and fails if the protection is removed.

## Notes during implementation

_(append as you go — surprises, decisions, anything the plan got wrong)_
