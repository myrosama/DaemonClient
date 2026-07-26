# Phase 4 — Finish the self-hosting CLI

**Goal:** Someone who has never seen this project can go from `git clone` to a working private cloud, and is told precisely what is wrong when something is.

**Status:** not started.

Full task detail is in `MASTER_PLAN.md`. This file tracks execution: tick
the gates as each task passes, and write down anything surprising.

---

## Why this phase is here

The worker it deploys must be correct first, or we ship a smooth installer for a broken product.

---

## Tasks

### 4.1 — Delete the dead config modules
`selfhost/src/state.mjs`, `env.mjs`, importers

- [ ] Implemented
- [ ] Gate 1 · Security
- [ ] Gate 2 · Principles
- [ ] Gate 3 · Correctness
- [ ] Gate 4 · Works for real
- [ ] Deployed & committed

**Watch for:** Three live config modules is worse than any one of them. Migrate `test/selfhost.test.mjs` too.

### 4.2 — Refuse to run when the environment will sabotage it
`setup.mjs`, `config.mjs`

- [ ] Implemented
- [ ] Gate 1 · Security
- [ ] Gate 2 · Principles
- [ ] Gate 3 · Correctness
- [ ] Gate 4 · Works for real
- [ ] Deployed & committed

**Watch for:** A `.env` in the repo containing `CLOUDFLARE_API_TOKEN` silently overrides browser sign-in; so does an ambient one — **the operator's own machine has one**. Both detectors already exist; wire them into preflight and name the offending file or variable.

### 4.3 — Rewrite setup as probe / repair / verify
`setup.mjs`. Depends on 4.1, 4.2.

- [ ] Implemented
- [ ] Gate 1 · Security
- [ ] Gate 2 · Principles
- [ ] Gate 3 · Correctness
- [ ] Gate 4 · Works for real
- [ ] Deployed & committed

**Watch for:** **Largest task in the plan — split it at the first sign of strain.** No step machine; re-running is a health check. The current file also calls functions that no longer exist, so this is a rewrite rather than a refactor.

### 4.4 — `doctor` becomes setup in read-only mode
`doctor.mjs`, `setup.mjs`. Depends on 4.3.

- [ ] Implemented
- [ ] Gate 1 · Security
- [ ] Gate 2 · Principles
- [ ] Gate 3 · Correctness
- [ ] Gate 4 · Works for real
- [ ] Deployed & committed

**Watch for:** Two implementations of 'is this healthy' would drift.

### 4.5 — Firebase automation
new `selfhost/src/api/firebase.mjs`. Depends on 4.3.

- [ ] Implemented
- [ ] Gate 1 · Security
- [ ] Gate 2 · Principles
- [ ] Gate 3 · Correctness
- [ ] Gate 4 · Works for real
- [ ] Deployed & committed

**Watch for:** Four of five console steps can be automated. Do **not** shell out to `firebase projects:create` — it flattens terms, quota and permission failures into one useless string. The terms acceptance stays manual and must be detected precisely.

### 4.6 — Vercel processor deploy
new `selfhost/src/api/vercel.mjs`, `processor.mjs`. Depends on 4.3.

- [ ] Implemented
- [ ] Gate 1 · Security
- [ ] Gate 2 · Principles
- [ ] Gate 3 · Correctness
- [ ] Gate 4 · Works for real
- [ ] Deployed & committed

**Watch for:** Runtime env vars must use the documented mechanism — setting them on the CLI's own process does nothing for the deployment. That mistake was already caught once.

### 4.7 — Pre-empt the first-run Cloudflare failures
`api/cloudflare.mjs`, `setup.mjs`, `dashboard.mjs`. Depends on 4.3.

- [ ] Implemented
- [ ] Gate 1 · Security
- [ ] Gate 2 · Principles
- [ ] Gate 3 · Correctness
- [ ] Gate 4 · Works for real
- [ ] Deployed & committed

**Watch for:** Three guaranteed failures on brand-new accounts: no workers.dev subdomain, Pages project must pre-exist, multi-account hard error. Helpers exist; wire them in.

### 4.8 — Headless and busy-port handling
`setup.mjs`. Depends on 4.7.

- [ ] Implemented
- [ ] Gate 1 · Security
- [ ] Gate 2 · Principles
- [ ] Gate 3 · Correctness
- [ ] Gate 4 · Works for real
- [ ] Deployed & committed

**Watch for:** Cloudflare has no device flow. Detect it up front rather than hanging for 120 seconds, and check port 8976 before wrangler dies on a raw EADDRINUSE.

### 4.9 — Pin the toolchain
`selfhost/package.json`

- [ ] Implemented
- [ ] Gate 1 · Security
- [ ] Gate 2 · Principles
- [ ] Gate 3 · Correctness
- [ ] Gate 4 · Works for real
- [ ] Deployed & committed

**Watch for:** We parse wrangler's behaviour in several places, so its version must be a choice rather than an accident of directory layout.

---

## Exit criteria

- [ ] One config module, one health implementation.
- [ ] Every credential validated against the real service, with actionable errors.
- [ ] Re-running setup is safe and changes nothing that already works.
- [ ] A brand-new Cloudflare account completes without a manual dashboard visit.
- [ ] A headless machine gets guidance rather than a hang.

## Notes during implementation

_(append as you go — surprises, decisions, anything the plan got wrong)_
