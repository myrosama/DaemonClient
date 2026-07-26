# Phase 5 — Prove it end to end

**Goal:** We have watched a real self-hosted install work, rather than inferring it from unit tests.

**Status:** not started.

Full task detail is in `MASTER_PLAN.md`. This file tracks execution: tick
the gates as each task passes, and write down anything surprising.

---

## Why this phase is here

Everything it exercises must exist first.

---

## Tasks

### 5.1 — Real setup against throwaway accounts
—

- [ ] Implemented
- [ ] Gate 1 · Security
- [ ] Gate 2 · Principles
- [ ] Gate 3 · Correctness
- [ ] Gate 4 · Works for real
- [ ] Deployed & committed

**Watch for:** **The first honest test of the whole thing.** Note every point of confusion — those are bugs in the copy, not user error.

### 5.2 — Fix what 5.1 finds
—

- [ ] Implemented
- [ ] Gate 1 · Security
- [ ] Gate 2 · Principles
- [ ] Gate 3 · Correctness
- [ ] Gate 4 · Works for real
- [ ] Deployed & committed

**Watch for:** Depends on 5.1. A second clean run must need no manual intervention.

### 5.3 — Both flavours from one commit, in CI
`.github/workflows/ci.yml`

- [ ] Implemented
- [ ] Gate 1 · Security
- [ ] Gate 2 · Principles
- [ ] Gate 3 · Correctness
- [ ] Gate 4 · Works for real
- [ ] Deployed & committed

**Watch for:** Include the `PARITY.md` guard: fail if the count of hosted/self-host divergence points grows without a note.

### 5.4 — One release, both destinations
`.github/workflows/release.yml`, `docs/RELEASING.md`. Depends on 5.3.

- [ ] Implemented
- [ ] Gate 1 · Security
- [ ] Gate 2 · Principles
- [ ] Gate 3 · Correctness
- [ ] Gate 4 · Works for real
- [ ] Deployed & committed

**Watch for:** If it cannot deploy the fleet **and** publish the release from one tag, it does neither and says why. Shipping to one flavour and forgetting the other is the failure this prevents.

---

## Exit criteria

- [ ] A stranger's install works, verified by doing it.
- [ ] CI proves both flavours from every commit.
- [ ] One release action reaches both kinds of user.

## Notes during implementation

_(append as you go — surprises, decisions, anything the plan got wrong)_

### 5.5 — Update the hosted fleet on a schedule
`deployment-service/wrangler.toml` (new `[triggers]`), `deployment-service/src/index.ts`

- [ ] Implemented
- [ ] Gate 1 · Security
- [ ] Gate 2 · Principles
- [ ] Gate 3 · Correctness
- [ ] Gate 4 · Works for real
- [ ] Deployed & committed

**Watch for:** This deploys to real users' workers unattended. It needs a kill
switch, a cap per run, and per-worker success recorded — a silent failure here
looks identical to success and the fleet drifts again.

Use the **master token**, not the per-user OAuth refresh token. Those rotate on
every use and a spent one is what stalled the fleet before. Every provisioned
worker is on the operator's own account, so the master token can reach them all.

### 5.6 — A self-hosted install notices updates on its own
`immich-api-shim/src/update-check.ts`, `selfhost/src/commands/setup.mjs`

- [ ] Implemented
- [ ] Gate 1 · Security
- [ ] Gate 2 · Principles
- [ ] Gate 3 · Correctness
- [ ] Gate 4 · Works for real
- [ ] Deployed & committed

**Watch for:** Gate 2 is the sharp one here. Nothing may be added that requires
knowing a self-hosted install exists — no registry, no check-in, no push. The
worker polls GitHub anonymously and messages the owner through **their own** bot.
If a design step needs their worker URL on our side, it is the wrong design.

Deduplicate the notification, or one release nags daily forever.
