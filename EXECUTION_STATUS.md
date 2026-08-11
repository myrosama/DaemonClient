# Execution status

**Read this first after any context reset.** Then `docs/plan/PRODUCT_SPEC.md`
(what we are building), `docs/plan/BUILD_ORDER.md` (the parts and their wiring
order — this is what to work from), `docs/plan/MASTER_PLAN.md`, then
`git log --oneline`.

> **Two different things share the brand.** The **installer** is what this plan
> builds — an interactive setup script, run once. The **DaemonClient CLI** is a
> separate product for automating Drive from a terminal; it is parked in the
> private ops repo and comes back later.

| | |
|---|---|
| **Date** | 2026-08-11 |
| **Phase** | 0 — Truth (make the docs match the code) |
| **Just finished** | Repo cleanup + docs rebuild. Readiness investigation (`PHASE_0.md`). Product spec and installer-stack research written from the operator's description of the user journey. |
| **Working on now** | Nothing — awaiting a go-ahead to start Phase 0. |
| **Next up** | `BUILD_ORDER.md` wiring step 1: **P11's version fix**, then cut the first release so P3 has a tag to pin to. |
| **Blocked on** | Nothing. All five questions in `docs/plan/QUESTIONS.md` are answered. Phase 3 needs the operator present to create throwaway accounts, but that is scheduling, not a blocker. |
| **Staging** | None exists yet. Phase 3 creates one — throwaway Telegram + Cloudflare + Firebase accounts. Until then no self-host change has been proven on real infrastructure. |

## The single most important fact

**Self-hosting has never been run end to end by anyone.** Every component has
unit tests and the CLI is well-built, but no human has cloned the repo, run
`daemonclient setup`, and ended with a working cloud. Until Phase 3 does that,
every claim about self-hosting working is inference, not evidence.

## Decisions locked in

All five open questions are answered — full reasoning in `docs/plan/QUESTIONS.md`.

| | |
|---|---|
| Auth | **Firebase stays**, but `setup` provisions the project itself. Making the user click through the Firebase console is not acceptable. Four of the five steps are confirmed available in `firebase-tools`; enabling the Email/Password provider has no CLI command and opens Phase 4 as a spike. |
| Tenancy | **One person per install.** Not a family product. The owner gate is not being opened. |
| Version | **`v2.1.0`**, continuing the existing tag rather than inventing a third numbering scheme. |
| Plan docs | **Public.** |
| Entry point | **`curl -fsSL https://get.daemonclient.uz \| sh`** — install.sh checks git, installs a local no-sudo Node if missing (checksummed), clones the latest release tag, runs `npm ci`, hands over. `npm create daemonclient@latest` published as a second door. |
| Firebase email sign-in | **The user flips the toggle themselves**; we open the console page and wait. Spike closed — no Identity Toolkit Admin API. |
| Credential order | **Email/password asked LAST**, after Firebase exists. Never touches disk. |
| Post-setup management | **Deferred to Phase 7.** Named later; cannot be `daemonclient`. |
| Interface | **`@clack/prompts`** (4 deps, built for wizards, real Ctrl-C handling) + **`listr2`** for the multi-minute deploy. Not Ink — 25 deps and built for persistent dynamic UIs, not linear wizards. |
| Dependencies in `selfhost/` | **No longer forbidden.** The rule existed because it ran from a bare clone; publishing to npm removes the reason. |
| `daemonclient` npm name | **Reserved for the Drive CLI.** The installer must not take it. |
| E2E testing | Operator will create throwaway accounts and do the console steps; I drive the rest. |

The principle everything is checked against, in the operator's words:
*"self-hosting means self-hosting — in no way tied to our central system. The
only thing that touches us is the update check."*

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
