# Phase 1 — Stop storing photos in plaintext

**Goal:** encryption is either genuinely happening or the upload is refused, and
no endpoint can claim otherwise.

**Status:** not started.

Full task detail is in `MASTER_PLAN.md`. This file tracks execution: tick the
gates as each task passes, and write down anything surprising.

---

## Why this is first

Self-hosted installs are, right now, writing unencrypted photos to Telegram
under their original filenames — and `/api/assets/zke-status` reports encryption
as **on**. See `FINDINGS.md` §1 for the exact chain, with line numbers.

Two properties make it the most urgent thing in the plan:

- **Silent.** Nothing surfaces it. The UI says encrypted.
- **Irreversible.** Every photo uploaded before the fix is already in a third
  party's storage in the clear. Fixing it later does not un-leak them.

## The chain, in one paragraph

`MIGRATION_SQL` seeds `zke_password` and `zke_salt` as empty strings. The hosted
provisioner fills them in a *separate* statement that lives in TypeScript, not
in the SQL template — so the CLI, which scrapes that template out of the source,
gets the empty INSERT and none of the fill. `getEncryptionKey` treats empty key
material the same as "encryption is off" and returns `null`. The upload path
reads that as "no encryption configured" and writes plaintext.

Note the shape of the bug, because it recurs: **two things that should have been
one.** The schema and the key generation were separated, and only one of them
was reachable from the second consumer.

---

## Tasks

### 1.1 — Make encryption fail closed ✅ DONE (shim `0ac7fc2b4938`)
`assets.ts` `getEncryptionKey` (~173-187), call site (~1063)

- [x] Implemented
- [x] Gate 1 · Security
- [x] Gate 2 · Principles
- [x] Gate 3 · Correctness
- [x] Gate 4 · Works for real
- [x] Deployed & committed

**Watch for:** the "encryption deliberately off" case must keep working. Three
states, not two: off, on-and-working, on-but-broken.

### 1.2 — Stop `zke-status` claiming encryption that is not happening
`assets.ts` (~236). Depends on 1.1.

- [ ] Implemented
- [ ] Gate 1 · Security
- [ ] Gate 2 · Principles
- [ ] Gate 3 · Correctness
- [ ] Gate 4 · Works for real
- [ ] Deployed & committed

### 1.3 — Seed real keys during self-host setup
`selfhost/src/commands/setup.mjs` (~441-449), `selfhost/src/api/cloudflare.mjs`
(`queryD1` ~228-232). Depends on 1.1.

> **NOT `selfhost/src/deploy.mjs`.** It has zero importers — the live path is
> `build.mjs`, imported by `setup.mjs:23` and `update.mjs:17`. The plan pointed
> at the dead copy. Written there, the fix passes its unit test and all four
> gates and does nothing on a real install.

- [ ] Implemented
- [ ] Gate 1 · Security
- [ ] Gate 2 · Principles
- [ ] Gate 3 · Correctness
- [ ] Gate 4 · Works for real
- [ ] Deployed & committed

**Highest-risk task in the phase.** Writing keys when they already exist makes
every stored photo undecryptable, permanently. A **failed** read is not an empty
one — treat a query that errors as "unknown, do nothing", or a network blip
rotates a live key. Finish with an end-to-end check: read `zke_password` back
over REST against a real D1 and assert it is non-empty. That assertion is the one
the dead-module mistake could not have passed.

The write happens only when the
current value is empty, and that condition needs its own test plus a deliberate
check of what happens when the read *fails* rather than returning empty — a
failed SELECT must not be treated as "empty".

### 1.4 — Remove the encryption key that encrypts nothing
`immich-api-shim/src/index.ts` (~94), CLI config. Depends on 1.3.

- [ ] Implemented
- [ ] Gate 1 · Security
- [ ] Gate 2 · Principles
- [ ] Gate 3 · Correctness
- [ ] Gate 4 · Works for real
- [ ] Deployed & committed

**Note:** the user-facing warning about backing up a key must not simply be
deleted — it must move to the key material that actually matters.

**Do not grep-and-delete repo-wide.** `deployment-service/src/index.ts:40`
declares a variable of the same name and there it is **real** — it encrypts every
user's stored Cloudflare API token (`index.ts:6-35`, used at `:581`). Removing it
would lock the whole fleet out of auto-update. Scope: the shim and the CLI. The
live CLI writes are `setup.mjs:421-422` and `update.mjs:116-117`, not
`deploy.mjs`.

### 1.5 — Write the recovery note for anyone already affected
`docs/SELF_HOSTING.md`. Depends on 1.2.

- [ ] Implemented
- [ ] Gate 2 · Principles
- [ ] Gate 4 · Works for real
- [ ] Committed

**Tone:** plain and non-defensive. State what happened, how to check, and what
the options are. Do not bury it.

---

## Exit criteria

- [ ] An install with broken key material refuses uploads rather than writing plaintext.
- [ ] `zke-status` cannot report encryption that is not happening.
- [ ] A fresh self-host setup produces working encryption; re-running is safe.
- [ ] No secret is described to users as protecting something it does not protect.
- [ ] Anyone already affected can find out and knows what to do.

## Notes during implementation

_(append as you go — surprises, decisions, anything the plan got wrong)_

---

## 1.1 — notes from doing it

**The bug was slightly different from the plan's description, in a way that
mattered.** The plan said to keep the "off" case working. But at the upload site
there *is* no distinct off case: `isServerZke = !isClientZke`, so `mode:'off'`
takes the **server** branch too and reaches `getEncryptionKey` like everything
else. Had the fix keyed on mode, deliberate-plaintext installs would have been
refused along with broken ones.

So the split is on `enabled`, not on mode:
- `enabled` false, or no config at all → `null`, plaintext, on purpose.
- `enabled` true but password or salt empty → **throw**.

Absent config deliberately does NOT throw. The central worker serves users who
never provisioned their own worker and may have no config row; absent config is
not a claim to be encrypting, and refusing there would have broken working users
to fix a bug they do not have.

**Nothing about the encryption itself was touched** — `deriveKey`,
`encryptChunk`, `decryptChunk`, chunking and the Telegram send are exactly as
they were. The change is which of two situations a null return meant.

**Retry-After: 3600 on the refusal.** Added during Gate 1. This fault does not
clear on its own, and the app retries failed uploads on its own schedule — a
few thousand queued photos would otherwise become a few thousand identical
failures against a worker already in a bad state.

**Read paths now throw too** (thumbnail, original, the two backfill jobs). On a
broken install those photos were undecryptable anyway and were being served as
corrupt bytes; an error is more honest. Both background jobs are dispatched
through `waitUntil(... .catch(...))`, verified, so a throw there logs and stops
rather than failing the request.

**Two test-harness traps worth remembering**, neither a product bug:
- `vi.spyOn(fetch).mockResolvedValue(new Response(...))` returns ONE shared
  Response; the second `.json()` reads a consumed body and the upload stalls in
  its retry loop. Use `mockImplementation` and build a fresh Response per call.
- The Telegram send pacer keeps a token bucket per bot in module scope, so tests
  sharing a bot token drain it and wait on a rate limiter unrelated to what they
  are testing. Vary the token per test.

**Not verified live:** an actual upload. That needs a session on a real install,
which means the operator's phone or browser. What is verified live is that all
three workers are serving and auth is intact.
