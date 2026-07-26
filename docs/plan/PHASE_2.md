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

### 2.3 — Stop serving key material over HTTP
`server.ts` ~66-109

- [ ] Implemented
- [ ] Gate 1 · Security
- [ ] Gate 2 · Principles
- [ ] Gate 3 · Correctness
- [ ] Gate 4 · Works for real
- [ ] Deployed & committed

**Watch for:** **Audit the readers first.** A client may depend on a field; find out before removing it. Drive uses its own `drive_zke` path and should be unaffected — verify rather than assume.

### 2.4 — Add an owner check for single-worker installs
`selfhost/src/commands/setup.mjs`, `server.ts`, `index.ts`

- [ ] Implemented
- [ ] Gate 1 · Security
- [ ] Gate 2 · Principles
- [ ] Gate 3 · Correctness
- [ ] Gate 4 · Works for real
- [ ] Deployed & committed

**Watch for:** Hosted is one worker per user, so this is a no-op there. Must not break it. Depends on 2.3.

### 2.5 — Make sessions revocable
`auth.ts`, `helpers.ts`

- [ ] Implemented
- [ ] Gate 1 · Security
- [ ] Gate 2 · Principles
- [ ] Gate 3 · Correctness
- [ ] Gate 4 · Works for real
- [ ] Deployed & committed

**Watch for:** Everyone gets logged out once when this ships. Say so in the commit and the release note. Self-host has no refresh path, so pick a TTL that does not force weekly logins there.

### 2.6 — Close the public-constant signing fallback
`selfhost-auth.ts` ~44, `auth-security.test.ts` ~86-93

- [ ] Implemented
- [ ] Gate 1 · Security
- [ ] Gate 2 · Principles
- [ ] Gate 3 · Correctness
- [ ] Gate 4 · Works for real
- [ ] Deployed & committed

**Watch for:** **Gated on the operator confirming every hosted worker has been redeployed with a per-install secret.** Deleting this early locks users out. The test that currently asserts forged tokens are accepted gets flipped to assert rejection.

---

## Exit criteria

- [ ] No route returns key material or a bot token.
- [ ] No authenticated account can read another's config.
- [ ] Sessions can be revoked; tokens are bounded.
- [ ] No forged token is accepted anywhere.
- [ ] The test suite asserts each of the above, and fails if the protection is removed.

## Notes during implementation

_(append as you go — surprises, decisions, anything the plan got wrong)_
