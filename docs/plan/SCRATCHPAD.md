# Scratchpad — live status

Read `docs/MASTER_PLAN.md` first, then this.

## State
Autonomous run 2026-07-27 on **main** (pushed). Deep in Phase 1 (self-hosting).
Operator away, wants it FULLY finished. Gates: each run as a SEPARATE agent.

## Committed to main this run
- Merge 421ca3e: processor Vercel/Node + repo cleanup + fresh plan.
- b6f6494 (1.2+1.3): Photos + Drive web apps self-hostable (build-time worker URL,
  fail-safe, trailing-slash). 4 gate agents; their trailing-slash bug + fail-open
  footgun fixed. Verified: self-host builds contain the given worker, ZERO operator.
- ad5a904: Cloudflare-style docs site `docs-site/index.html` (self-hosting guide).

## Uncommitted, UNDER GATE (2 separate agents: security + correctness)
- `selfhost/src/commands/web.mjs` — new `daemonclient web`: builds all 3 apps
  (dashboard/Photos/Drive) self-host + deploys to the user's Firebase Hosting
  (3 sites) via `firebase deploy --config firebase.selfhost.json` + updates
  ALLOWED_ORIGINS. Includes `assertNoOperator` guard (refuses to ship a build that
  routes data to the operator). Registered in bin/daemonclient.mjs; SELF_HOSTING.md
  "Web apps — one command" section; .gitignore firebase.selfhost.json.
  Build orchestration VERIFIED (all 3 apps build self-host, data host absent).
  Firebase DEPLOY itself untested (needs the user's firebase login). Awaiting gates
  → fix → commit.

## Background: HEIC hosted feature (SEPARATE isolated worktree agent)
Operator asked (own agent): make HEIC thumbnails automatic for HOSTED users +
add a 3rd onboarding step (Vercel processor, most-comfortable method) in
accounts-portal. Agent implements+tests+self-reviews on its worktree, does NOT
deploy live. When it returns → run separate gate agents → integrate.

## Remaining Phase 1
- Fix+commit `web` command after gates.
- Integrate HEIC feature after its gates.
- **Nav-link cleanup**: accounts-portal self-host bundle still carries operator
  PROVISIONING/nav strings (daemonclient-deployment, onrender, accounts.daemonclient.uz)
  in unreached setup code, and drive/immich login pages have signup→accounts.daemonclient.uz.
  Not a DATA path, but "a link to us" — make configurable/tree-shaken for full independence.
- **1.5 real e2e test**: run CF provisioning for real (throwaway worker on operator
  CF acct → /api/health → clean up). Telegram bot creation can't be automated.

## Operator standing instructions
- Merge to main + work on main (DONE).
- At the FINAL open-source stage: move unneeded stuff to a PRIVATE repo (don't delete).
- No bugs / no security / no bad design — separate agent per gate.

## Baseline green
shim tsc clean + 261; selfhost 68; processor 5. All 3 web apps build hosted + self-host.
