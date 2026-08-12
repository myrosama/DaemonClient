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
| **Phase** | Building — `BUILD_ORDER.md` wiring step 1 (P11) |
| **Just finished** | Repo cleanup + docs rebuild. Readiness investigation (`PHASE_0.md`). Product spec and installer-stack research written from the operator's description of the user journey. |
| **Working on now** | P11 complete — all four gates passed. 82 tests. |
| **Next up** | Two follow-ups **must land before `v2.1.0` is tagged** — see below. Then cut the release (wiring step 2), which unblocks `install.sh` pinning a tag. |
| **Blocked on** | Nothing. |
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
| `selfhost` | 82 | `npm test` |
| `deployment-service` | 8 | `npm test` |
| `processor` | 5 | `npm test` |

Typecheck clean: `immich-api-shim`, `deployment-service`.

## Where things live

| | |
|---|---|
| Public repo | `myrosama/DaemonClient` — the product |
| Private repo | `myrosama/daemonclient-ops` — managed-service code, audits, security findings |
| Open security findings | `daemonclient-ops/docs/AUDIT_FINDINGS_2026-08-06.md` — **not** in this repo, and deliberately not summarised here |

## Must land before `v2.1.0` is tagged

Both were raised by the Gate 3 spec review of P11. Both are currently latent and
become live the moment a release is published — cutting the tag is what
activates them.

| # | Problem | Evidence |
|---|---|---|
| A | **The managed path sets no `BUILD_VERSION` at all.** `buildShimBindings` emits neither it nor `UPDATE_REPO`, so every hosted worker reports `build: null` and `currentVersion: '0.0.0'`. Once `v2.1.0` exists, `updateAvailable` computes **true, permanently, for every hosted user** — telling them to run a CLI they do not have. | `deployment-service/src/index.ts:106-123`, used by all three deploy paths (`:324`, `:599`, `:655`); `immich-api-shim/src/update-check.ts:82,119` |
| B | **`VERSION` is bumped ahead of its release, and nothing enforces the rule.** `VERSION` is `2.1.0`; the newest tag is `v2.0.0`. Anyone cloning `main` today stamps `2.1.0`, so when `v2.1.0` is cut — carrying commits they do not have — `isNewerVersion('v2.1.0','2.1.0')` is false and they never see it. The rule "bump VERSION *at* release, never ahead of it" exists only as a comment. | `VERSION:1` vs `git tag -l`; `version.mjs:24-26` |

`docs/PARITY.md:104` already names A as an unbuilt gap ("both flavours report
the same version string, from the same source"). This is what closing it costs.

## Follow-ups, tracked not dropped

- Delete `selfhost/src/deploy.mjs` and `selfhost/src/env.mjs`. Both have **zero
  importers** — independently verified in the Gate 3 review, including dynamic
  imports and tests — and `deploy.mjs:32` holds a third `BUILD_VERSION` writer
  that bypasses `version.mjs`. Dead code that mentions a symbol makes future
  greps lie, which is how this project has repeatedly fixed things that never
  run. `selfhost/README.md` no longer lists them.
- `selfhost/package.json:3` still declares `"version": "1.0.0"` — a third
  version number in a change whose thesis is "one tracked file".
