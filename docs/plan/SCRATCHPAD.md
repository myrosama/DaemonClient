# Scratchpad — live status

Read `docs/MASTER_PLAN.md` first, then this.

## State
Autonomous run 2026-07-27 on **main** (pushed). Phase 1 (self-hosting) FUNCTIONAL;
HEIC hosted feature MERGED. All green. Operator away; wants it fully finished.

## Everything committed & pushed to main this run (15+ commits)
**Phase 1 — self-hosting (a stranger can host it all, nothing on us):**
- Processor Vercel/Node + env fix + test.
- Photos + Drive web apps self-hostable (build-time worker URL, fail-safe,
  trailing-slash). 4 separate gate agents.
- SECURITY: dashboard was POSTing the user's Firebase refresh token to operator
  auth.daemonclient.uz on every login → gated off + tree-shaken out. Drive
  isAppDomain recognises self-host domains.
- `daemonclient web`: builds all 3 apps self-host + deploys to the user's Firebase
  Hosting (3 sites) + ALLOWED_ORIGINS. assertNoOperator guard. 2 gate agents.
- Cloudflare-style docs site `docs-site/index.html`.
- Setup worker build VERIFIED real (550 KB bundle).

**HEIC hosted auto-fix + onboarding (Task 4.6) — MERGED (bd3feed) + hardened (d7decf9):**
- Attaching a processor wakes the lazy HEIC backfill (resetHeicThumbBackfill).
- Skippable HEIC-processor onboarding step after Cloudflare (guided Vercel deploy),
  routed via a new deployment-service broker that mints a fail-closed scoped worker
  session (never APP_IDENTIFIER). 2 separate gate agents (security+correctness) PASS.
  LOW SSRF finding fixed (isProvisionedWorkerUrl pins the workerUrl fetch) + test.
- NOT deployed to the live fleet — operator's call.

**Repo/docs:** dead code removed, tsc clean everywhere, reference docs reconciled,
4-phase master plan.

## Green baseline (integrated main)
shim tsc clean + **263**; deployment-service tsc clean + **8**; selfhost **68**;
processor **5**. All 3 web apps build hosted + self-host clean (zero operator data host).

## Remaining
- **Nav-link cleanup** (LOW): self-host bundles still carry DEAD operator strings in
  unreached provisioning/nav code (photos./app.daemonclient.uz nav links,
  daemonclient-deployment, onrender in accounts-portal; drive/immich login
  signup→accounts.daemonclient.uz). Not a data path. Make env-gated for full polish.
- **Deploy** (operator): redeploy accounts-portal + deployment-service to make the
  HEIC onboarding live; redeploy the hosted worker fleet if desired.
- **1.5** full e2e (needs Telegram bot creation — needs a human).
- Phase 2 open-source cleanup (Immich branding, templatize Firebase key, rotate key,
  scrub history — operator), Phase 3 maintenance (one-release action, CI), Phase 4 product.
- FINAL open-source stage: move unneeded stuff to a PRIVATE repo (operator instruction).

## Note
Other stale worktrees exist from PRIOR sessions (agent-a1d815 shared-albums, etc.) —
not this session's; left untouched.
