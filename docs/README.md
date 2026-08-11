# Documentation

## Running it

| | |
|---|---|
| **[SELF_HOSTING.md](SELF_HOSTING.md)** | Set up your own instance on your own Telegram, Cloudflare and Firebase accounts. **Start here** if you want to run this yourself. |
| [SETUP_GUIDE.md](SETUP_GUIDE.md) | Signing up and connecting your storage on the hosted service at daemonclient.uz. |

## Understanding it

| | |
|---|---|
| **[ARCHITECTURE.md](ARCHITECTURE.md)** | How everything works: the storage primitive, encryption, auth, the database, and the constraints that explain the odd-looking code. **Read this before changing anything.** |
| [API.md](API.md) | Every route, its auth, and which callers actually exercise it — verified by grep, not by inference. |
| [openapi.yaml](openapi.yaml) | The same contract, machine-readable. Load it into any OpenAPI tool. |
| [PARITY.md](PARITY.md) | One codebase, two ways to run it — and the five places where behaviour legitimately diverges. A sixth is a bug. |

## Contributing

| | |
|---|---|
| [../CONTRIBUTING.md](../CONTRIBUTING.md) | Where things live, house style, and the four hard constraints. |
| [../SECURITY.md](../SECURITY.md) | Reporting a vulnerability, and the security model. |
| [../immich/FORK.md](../immich/FORK.md) | What our Immich fork changed, and what to know before pulling upstream. |

## What is coming

| | |
|---|---|
| [ROADMAP.md](ROADMAP.md) | What is being worked on, what is deliberately not, and what is finished. |

## Current work

The self-hosting feature is being finished phase by phase. Start at the top:

| | |
|---|---|
| **[../EXECUTION_STATUS.md](../EXECUTION_STATUS.md)** | Where we actually are. **Read this first** — it is written so a cold start can resume in two minutes. |
| [plan/MASTER_PLAN.md](plan/MASTER_PLAN.md) | Every phase, what is already true, and what is not true yet — each with the evidence. |
| [plan/PHASE_0.md](plan/PHASE_0.md) | The current phase in detail. |
| [plan/GATES.md](plan/GATES.md) | The four gates every task passes, and why each one exists. |
| [plan/QUESTIONS.md](plan/QUESTIONS.md) | Open decisions for the operator, with recommendations. |
| [plan/DESIGN_NOTES.md](plan/DESIGN_NOTES.md) | Per-task record of what was decided and why. Append-only. |

---

Every component directory also has its own README covering what it is, how to
run it, and how it relates to the rest.

**When a document stops being true, fix it or delete it.** A stale design doc is
worse than none, because someone will follow it.
