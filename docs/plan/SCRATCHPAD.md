# Scratchpad — live status

Read `docs/MASTER_PLAN.md` first, then this.

## State
Autonomous run 2026-07-27 on **main** (pushed). Phase 1 (self-hosting) now largely
FUNCTIONAL. Operator away, wants it fully finished + separate-agent gates.

## Phase 1 (self-hosting) — committed & verified this run
- Setup script (`daemonclient setup`) already existed; its worker build path
  VERIFIED for real (builds a 550 KB deployable bundle from source).
- **Processor** Vercel/Node + env fix + test (merge 421ca3e).
- **b6f6494** Photos + Drive web apps self-hostable (build-time worker URL,
  fail-safe, trailing-slash). 4 separate gate agents.
- **7f3c3d1 (security)** the self-host dashboard was POSTing the user's Firebase
  idToken+refreshToken to operator auth.daemonclient.uz on every login — GATED
  behind !IS_SELF_HOST; verified tree-shaken out of self-host build, hosted intact.
  Also Drive isAppDomain now recognises self-host domains.
- **57ec24e** `daemonclient web`: builds all 3 apps (hub/Photos/Drive) self-host +
  deploys to the user's Firebase Hosting (3 sites, firebase.selfhost.json) +
  ALLOWED_ORIGINS. assertNoOperator guard (fails closed). 2 separate gate agents
  (security+correctness); all their findings fixed. Build orchestration verified;
  Firebase deploy needs the user's `firebase login` (documented).
- **ad5a904** Cloudflare-style docs site `docs-site/index.html`.

## Self-host verified: NO operator DATA link
Self-host builds of all 3 apps contain the user's worker and ZERO operator data
host. accounts-portal IS the hub (self-host-aware). The `web` command wires it up.

## Background: HEIC hosted feature (SEPARATE isolated worktree agent — RUNNING)
Auto HEIC thumbnails for HOSTED users + 3rd onboarding step (Vercel processor) in
accounts-portal. Implements+tests+self-reviews on its worktree, does NOT deploy.
When it lands → run SEPARATE gate agents → integrate. NOTE: it edits accounts-portal
(onboarding) — I avoided editing accounts-portal further to prevent merge conflicts.

## Remaining
- Integrate HEIC feature (after its gates).
- **Nav-link cleanup** (LOW, follow-up): self-host bundles still carry DEAD
  operator strings in unreached provisioning/nav code (photos./app.daemonclient.uz
  nav links, daemonclient-deployment, onrender in accounts-portal; drive/immich
  login signup→accounts.daemonclient.uz). Not a data path. Make env-gated/tree-shaken
  for full "nothing linked to us". Do AFTER HEIC integrates (same files).
- **1.5** full e2e (needs Telegram bot creation — can't automate).
- Phase 2 open-source cleanup, Phase 3 maintenance (release action, CI), Phase 4 product.
- FINAL open-source stage: move unneeded stuff to a PRIVATE repo (operator instruction).

## Baseline green
shim tsc clean + 261; selfhost 68; processor 5. All 3 web apps build hosted +
self-host clean. Worker bundle builds (550 KB).
