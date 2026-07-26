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

### 1.1 — Make encryption fail closed
`assets.ts` `getEncryptionKey` (~173-187), call site (~1063)

- [ ] Implemented
- [ ] Gate 1 · Security
- [ ] Gate 2 · Principles
- [ ] Gate 3 · Correctness
- [ ] Gate 4 · Works for real
- [ ] Deployed & committed

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
