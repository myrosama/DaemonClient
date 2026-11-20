# Documentation

## Understanding it

| | |
|---|---|
| **[ARCHITECTURE.md](ARCHITECTURE.md)** | How everything works: the storage, encryption, sign-in, the database, and the limits that explain the odd-looking code. **Read this before changing anything.** |
| [API.md](API.md) | Every route of the user's worker, its auth, and who calls it. |
| [openapi.yaml](openapi.yaml) | The same contract, machine-readable. |
| [PARITY.md](PARITY.md) | One codebase, two ways to run it (hosted and self-hosted), and where they legitimately differ. |

## What is happening

| | |
|---|---|
| **[../EXECUTION_STATUS.md](../EXECUTION_STATUS.md)** | Where things actually are. **Read this first.** |
| [ROADMAP.md](ROADMAP.md) | What is being worked on, what comes next, and what is not happening. |
| [plan/ENGINE.md](plan/ENGINE.md) | The native apps on one Rust core: layers, order, how the core is proven. |
| [plan/CONTRACT_V2.md](plan/CONTRACT_V2.md) | The worker contract v2 draft (change feed, bulk create). |
| [plan/REPO_LAYOUT.md](plan/REPO_LAYOUT.md) | Why the repo is grouped into apps/, core/, workers/ and packages/. |
| [plan/GATES.md](plan/GATES.md) | The four gates every change passes. |
| [mobile/README.md](mobile/README.md) | The mobile work: spec, research, plans. |

## Running it yourself

| | |
|---|---|
| [SELF_HOSTING.md](SELF_HOSTING.md) | Setting up your own instance on your own Telegram, Cloudflare and Firebase accounts. The installer is **paused** (see the roadmap); the guide describes what exists. |

The self-host plans (MASTER_PLAN, PRODUCT_SPEC, BUILD_ORDER, INSTALLER_STACK,
PHASE_0, QUESTIONS, DESIGN_NOTES) stay in [plan/](plan/) for when the work
resumes.

## Contributing

| | |
|---|---|
| [../CONTRIBUTING.md](../CONTRIBUTING.md) | Where things live, house style, and the hard constraints. |
| [../SECURITY.md](../SECURITY.md) | Reporting a vulnerability, and the security model. |
| [../apps/photos-web/FORK.md](../apps/photos-web/FORK.md) | What the Photos website changed from Immich's web app. |
