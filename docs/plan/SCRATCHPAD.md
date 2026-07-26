# Scratchpad — live status

Rewritten after every task. Read `docs/MASTER_PLAN.md` first, then this.

## Now
Autonomous run 2026-07-27, on branch `autonomous/selfhost-vercel-and-cleanup`
(NOT pushed — held for operator review). Whole-repo discovery done + independently
verified. Working through the safe, high-value tasks.

## Done this run (each independently reviewed before commit)
- [x] **1.1** Processor Render → Vercel across setup.mjs / processor.mjs /
      doctor.mjs / status.mjs / SELF_HOSTING.md. Also fixed a request-killing bug
      (FIREBASE_PROJECT_ID was told to be left blank; convert.js 401s every
      request when unset) and removed false video-thumbnail claims. Review: SHIP.
      Commit 03cb81c.
- [x] **0.1** Deleted dead `daemonclient-immich-bridge/` (mock worker) and
      `local-server/` (dev scrap). Review: SHIP. Commit 77c0d0a.
- [x] **0.2** `@types/node` (dev only) → `tsc --noEmit` clean; tsconfig types
      array untouched so no Node globals leak into worker source. 261 tests pass.
      Review: SHIP. Commit 5fcd85f.
- [x] **0.3** Reconciled reference docs: `/validate-cf-token` is authenticated
      now (was fixed in 29d61e0), `daemonclient-auth` added as a live component,
      Drive corrected to "not an Immich fork", takeover downgraded (FINDINGS §23),
      processor known-issue marked fixed. (this commit)

## In progress
- [~] **1.1b** Processor Edge → Node runtime (libheif WASM ~1.5MB > Vercel Edge
      1MB Hobby cap). `convert.js` now exports `{ fetch }` (Vercel Node form);
      added `processor/test/handler.test.mjs` (4 tests pass). Independent review
      RUNNING. NOT yet committed. Deploy verification (a real `vercel deploy`)
      needs the operator — flagged.

## Queue (safe, next)
- [ ] **0.4** README / CONTRIBUTING / SECURITY accuracy for a public repo.

## Deferred (need operator / live verification — documented in MASTER_PLAN)
- **2.1** refuse telegram-config/zke-config when !env.DB (marginal value; safe but
  won't deploy a live-worker change unsupervised).
- **2.2** retire APP_IDENTIFIER signing fallback (subtle; breaks login on the
  secret-less shared worker if done naively — design + operator deploy).
- **1.2** SW `DEFAULT_WORKER_URL` self-host independence (build-time config; touches
  the Immich web build — needs a browser check).

## Baseline
- immich-api-shim: `tsc --noEmit` CLEAN; 261 vitest tests pass.
- selfhost: 67 tests pass. processor: 4 tests pass.
- Live CF workers (acct 364fb59a…): immich-api (shared, no DB/secret),
  dc-ozkv3fuz (per-user, DB+SESSION_SECRET), daemonclient-deployment,
  daemonclient-proxy, daemonclient-auth. Prod healthy: 1485 photos, all encrypted.

## Gate policy
Each task: independent adversarial review (separate agent) before commit. Deploy
low-risk changes; DON'T deploy live-auth/worker changes without operator + live check.
