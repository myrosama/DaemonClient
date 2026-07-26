# Scratchpad — live status

Rewritten after every task. Read `docs/MASTER_PLAN.md` first, then this.

## State
Autonomous run 2026-07-27 complete for this session. Branch
`autonomous/selfhost-vercel-and-cleanup` — **7 commits, NOT pushed** (held for
operator review). Everything green.

## Done this run (each independently gate-reviewed by a separate agent before commit)
| Commit | Task | What |
|---|---|---|
| 77c0d0a | 0.1 | delete dead mock worker `daemonclient-immich-bridge/` + `local-server/` |
| 5fcd85f | 0.2 | `@types/node` (dev) → `tsc --noEmit` clean; tsconfig types untouched |
| 03cb81c | 1.1 | processor Render→Vercel; fixed the "leave FIREBASE_PROJECT_ID blank" request-killer; removed false video claims |
| 04b866c | —  | fresh MASTER_PLAN + this scratchpad |
| 8705829 | 0.3 | reconcile REPO_MAP/API/FINDINGS/HANDOFF (validate-cf-token authed, daemonclient-auth live, Drive not a fork, §23 takeover downgrade) |
| 749a138 | 1.1b | processor Edge→Node runtime + `processor/test/handler.test.mjs` (5 tests) |
| b4d19a8 | 0.4c | delete dead `landing-page/` + `daemonclient-desktop/` |

Self-hosting processor path is now correct end-to-end: right platform (Vercel),
right runtime (Node, for the CPU-heavy WASM decode), right env var (project id
required), honest capabilities (HEIC-only), and tested.

## Verified green (whole branch)
- immich-api-shim: `tsc --noEmit` CLEAN; 261 vitest tests pass.
- selfhost: 67 node:test pass. processor: 5 node:test pass.

## 0.4 secret sweep (no code change — finding)
No real secrets tracked. Only the public Firebase web key (hardcoded in configs +
dead trees) and operator infra ids in HANDOFF.md. Blockers = operator decisions:
rotate the key, templatize configs so forkers don't inherit the operator's
Firebase project, remove/sanitize HANDOFF.md. Documented in MASTER_PLAN Phase 0.4.

## Not done — needs operator or a live check (documented in MASTER_PLAN)
- **2.2** retire APP_IDENTIFIER signing fallback — subtle: naive removal breaks
  login on the secret-less shared worker. Design first, operator deploys.
- **2.1** refuse telegram-config/zke-config when !env.DB — safe but marginal;
  won't deploy a live-worker change unsupervised.
- **1.2** SW `DEFAULT_WORKER_URL='https://api.daemonclient.uz'` self-host
  independence. Design ready (`import.meta.env`/`$env` gate, default preserved for
  hosted) but immich/web uses NO `import.meta.env` today — needs a real web build
  check before touching the SW (SW breakage takes down the whole Photos web app).
- Deploy of anything above + a real `vercel deploy` of the processor.

## Next-session start
`git checkout autonomous/selfhost-vercel-and-cleanup`, re-read MASTER_PLAN, then
continue Phase 1 (1.2) / Phase 2 with the operator for live-auth deploys.
