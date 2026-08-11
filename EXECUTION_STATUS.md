# Execution status

**Read this first after any context reset.** Then `docs/plan/MASTER_PLAN.md`,
then the current phase document, then `git log --oneline`.

| | |
|---|---|
| **Date** | 2026-08-11 |
| **Phase** | 0 — Truth (make the docs match the code) |
| **Just finished** | Repo cleanup + documentation rebuild (3 commits). Self-hosting readiness investigation — findings in `PHASE_0.md`. |
| **Working on now** | Nothing. Plan written, awaiting answers to `docs/plan/QUESTIONS.md`. |
| **Next up** | Q1 (Firebase vs local accounts) decides whether Phase 4 is a fix or a rewrite. Everything else can start regardless. |
| **Blocked on** | Operator: the five questions. Q1 and Q2 block phases 4 and 3 respectively; the rest do not block. |
| **Staging** | None exists yet. Phase 3 creates one — throwaway Telegram + Cloudflare + Firebase accounts. Until then no self-host change has been proven on real infrastructure. |

## The single most important fact

**Self-hosting has never been run end to end by anyone.** Every component has
unit tests and the CLI is well-built, but no human has cloned the repo, run
`daemonclient setup`, and ended with a working cloud. Until Phase 3 does that,
every claim about self-hosting working is inference, not evidence.

## Test baseline

Update these numbers when they change; a drop means silently skipped tests.

| Suite | Count | Command |
|---|---|---|
| `immich-api-shim` | 294 | `npm test` |
| `selfhost` | 68 | `npm test` |
| `deployment-service` | 8 | `npm test` |
| `processor` | 5 | `npm test` |

Typecheck clean: `immich-api-shim`, `deployment-service`.

## Where things live

| | |
|---|---|
| Public repo | `myrosama/DaemonClient` — the product |
| Private repo | `myrosama/daemonclient-ops` — managed-service code, audits, security findings |
| Open security findings | `daemonclient-ops/docs/AUDIT_FINDINGS_2026-08-06.md` — **not** in this repo, and deliberately not summarised here |
