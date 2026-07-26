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
