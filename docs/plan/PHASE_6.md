# Phase 6 — Documentation worth reading

**Goal:** Someone lands on the repository and understands what it is, how to run it, and where the code lives — without asking.

**Status:** not started.

Full task detail is in `MASTER_PLAN.md`. This file tracks execution: tick
the gates as each task passes, and write down anything surprising.

---

## Why this phase is here

Documenting a moving target wastes the writing.

---

## Tasks

### 6.1 — Rewrite the README
`README.md`

- [ ] Implemented
- [ ] Gate 1 · Security
- [ ] Gate 2 · Principles
- [ ] Gate 3 · Correctness
- [ ] Gate 4 · Works for real
- [ ] Deployed & committed

**Watch for:** Human register. The operator has said plainly that AI-sounding text is unacceptable: no marketing cadence, no triads of adjectives, no hedging. Short sentences, real specifics. Read it aloud before shipping.

### 6.2 — A documentation site
new `docs-site/`. Depends on 6.1.

- [ ] Implemented
- [ ] Gate 1 · Security
- [ ] Gate 2 · Principles
- [ ] Gate 3 · Correctness
- [ ] Gate 4 · Works for real
- [ ] Deployed & committed

**Watch for:** Shaped like Cloudflare's docs — persistent left nav, right-hand page contents, dense calm typography, code copy buttons, search. Renders the markdown already in `docs/` so nothing is written twice. **Ships with real content or not at all.**

### 6.3 — Rewrite the self-hosting guide for the final flow
`docs/SELF_HOSTING.md`. Depends on 5.2.

- [ ] Implemented
- [ ] Gate 1 · Security
- [ ] Gate 2 · Principles
- [ ] Gate 3 · Correctness
- [ ] Gate 4 · Works for real
- [ ] Deployed & committed

**Watch for:** Troubleshooting keyed to the errors the CLI actually prints, not invented ones.

### 6.4 — Architecture and API reference
`docs/ARCHITECTURE.md`, `docs/API.md`. Depends on 6.2.

- [ ] Implemented
- [ ] Gate 1 · Security
- [ ] Gate 2 · Principles
- [ ] Gate 3 · Correctness
- [ ] Gate 4 · Works for real
- [ ] Deployed & committed

**Watch for:** Aimed at someone deciding whether they could fix a bug here. Trace an upload end to end.

### 6.5 — Finish the repository cleanup
repo root

- [ ] Implemented
- [ ] Gate 1 · Security
- [ ] Gate 2 · Principles
- [ ] Gate 3 · Correctness
- [ ] Gate 4 · Works for real
- [ ] Deployed & committed

**Watch for:** **Traps, verified:** `frontend/` is a live `firebase.json` hosting target; `daemonclient-proxy` is the live `TELEGRAM_PROXY`. Neither can simply be deleted. Genuinely dead ones move to an `attic` branch.

---

## Exit criteria

- [ ] The README explains the project to a stranger.
- [ ] The docs site is live and navigable.
- [ ] Every top-level directory is either explained or gone.
- [ ] The hosted service is unaffected by the cleanup.

## Notes during implementation

_(append as you go — surprises, decisions, anything the plan got wrong)_
