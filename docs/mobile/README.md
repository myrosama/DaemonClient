# Mobile apps — start here

DaemonClient's mobile apps are **native — SwiftUI on iPhone, Kotlin + Compose
on Android — over one Rust core** (SPEC D26, 2026-11-19). The iPhone app
starts from HomeRoll's code (D27). The Immich Flutter fork they replace is on
branch `archive/p2-flutter-2.3`.

## Read in this order

1. [`docs/plan/ENGINE.md`](../plan/ENGINE.md) **Part 2** — the plan: layers,
   order, how the core is proven, the research (§12). Find the first task not
   done; that is the work.
2. `EXECUTION_STATUS.md` (repo root), the MacBook section — what is in flight.
3. [`SPEC.md`](SPEC.md) — what we build and why; the decisions log (D1–D27).
4. [`docs/plan/CONTRACT_V2.md`](../plan/CONTRACT_V2.md) — the worker contract
   the core is moving to (with the Linux machine).

## Files here

| File | What it is | Who updates it |
|---|---|---|
| `SPEC.md` | what we build and why; the decisions log | only with the operator's approval |
| `RESEARCH.md` | dated findings with sources — storage format, Telegram's measured limits, the worker's API | append; correct under the wrong entry |
| `DESIGN_NOTES.md` | one entry per task: decisions, deviations, gate evidence (the core: 0.3, 1.0–1.9) | after every task |
| `APP_STORE.md` | what Apple's review rules mean for the apps | when a store decision changes |

Code: [`core/`](../../core) (Rust), [`apps/ios`](../../apps/ios),
[`apps/android`](../../apps/android); icons in [`apps/brand`](../../apps/brand).

## Rules that do not bend

- **Four gates per task** (`docs/plan/GATES.md`). Gate 3 = two separate review
  agents, security and spec, never the author. A gate that could not run is
  written down as not run.
- **Records in the same sitting as each commit:** the `DESIGN_NOTES.md` entry,
  ENGINE.md's task state, the `EXECUTION_STATUS.md` section, `NOW.md`.
  Before any `/compact`: records first.
- **The whole core is "full treatment"** under `GATES.md` — it is the chunk /
  encrypt / manifest path.
- **Test on the test account, never the operator's library.**
- **Message the Linux session before any change to `workers/` or anything
  per-user workers run.** Production deploys from Linux.
- No AI attribution in commits. The repo is public: no secrets, tokens, or
  security findings in these files.
