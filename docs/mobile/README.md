# Mobile apps — start here

Two apps on one Rust core, built on the MacBook since 2026-10-04:

- **DaemonClient Photos** — the Immich fork in `immich/mobile`, moved off the
  worker onto the core.
- **DaemonClient Drive** — a new Flutter app.
- **The core** — Rust. Encryption, Telegram transfers, the worker's metadata
  API, and a local media server. Both apps call it; nothing heavy runs on the
  worker.

## After any context reset, read in this order

1. `EXECUTION_STATUS.md` → section **"iOS app — MacBook"**: what is in flight.
2. `docs/mobile/PLAN.md`: find the first unchecked task. That is the work.
3. `docs/mobile/DESIGN_NOTES.md`: the latest entry, for the *why*.
4. `docs/mobile/SPEC.md`: only the sections the current task cites.
5. `git log --oneline -15`.

`RESEARCH.md` holds the findings the spec rests on — read a section when the
spec cites it, not up front.

## Files

| File | What it is | Who updates it |
|---|---|---|
| `README.md` | this page | when the layout changes |
| `RESEARCH.md` | dated findings with sources | append; correct under the wrong entry |
| `SPEC.md` | what we build and why; the decisions log | only with the operator's approval |
| `PLAN.md` | phases → tasks, each with its gate checklist | tick tasks as they ship |
| `DESIGN_NOTES.md` | one entry per task: decisions, deviations, gate evidence | after every task |

## Rules that do not bend

- **Four gates per task** (`docs/plan/GATES.md`). Gate 3 = two separate review
  agents, security and spec, never the author. A gate that could not run is
  written down as not run.
- **Records in the same sitting as each commit:** tick `PLAN.md`, add the
  `DESIGN_NOTES.md` entry, update the status section, update `NOW.md`.
  Before any `/compact`: records first.
- **The whole core is "full treatment"** under `GATES.md` — it is the chunk /
  encrypt / manifest path.
- **Test on the test account, never the operator's library.**
- **Message the Linux session before any change to `immich-api-shim`,
  `deployment-service`, or anything per-user workers run.** Production deploys
  from Linux.
- No push without the operator's review. No AI attribution in commits.
- The repo is public: no secrets, tokens, or security findings in these files.
