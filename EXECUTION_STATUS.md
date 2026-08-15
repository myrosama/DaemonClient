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
| **Next up** | Cut `v2.1.0` — wiring step 2. Both release blockers are closed; `RELEASING.md` has the procedure and CI enforces it. That unblocks P3 (`install.sh` pinning a tag). |
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
| `immich-api-shim` | 297 | `npm test` |
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

## Release blockers — both CLOSED 2026-08-12

Raised by the Gate 3 spec review of P11. Both were latent, and cutting the tag
was what would have activated them.

| # | Problem | Resolution |
|---|---|---|
| A | The managed path set no `BUILD_VERSION`, and `repo = env.UPDATE_REPO \|\| DEFAULT_REPO` meant every hosted worker polled GitHub anyway while reporting `0.0.0`. The first release would have made `updateAvailable` **true, permanently, for every hosted user** — pointing at a CLI they do not have. | **Fixed.** `getUpdateStatus` now returns early unless `isSelfHost(env)`. The check exists so a self-hoster learns a fix shipped; managed users are pushed to. Also stops a daily request per hosted worker that could never produce a useful answer. shim 294 → 297 tests. |
| B | `VERSION` was bumped ahead of its tag with nothing enforcing the rule, so anyone cloning `main` in between stamps an unreleased number and never sees the release when it lands. | **Enforced.** `.github/workflows/release.yml` fails a tag push whose `VERSION` does not match, is not a plain three-part semver, or has no changelog entry. Rule and full procedure in `RELEASING.md`. |

`docs/PARITY.md:104` names "both flavours report the same version string, from
the same source" as an unbuilt gap. A is closed in the direction that matters —
managed users are no longer told something false. Reporting a *real* build
string on managed workers is still open: it needs the version threaded through
`deployment-service`, whose embed script (`deployment-service/scripts/`) is
gitignored, so it is not a two-line change. Tracked below.

## Follow-ups, tracked not dropped

- **Managed workers still report `build: null`.** Harmless now that the update
  check is gated, but `/api/selfhost/status` cannot identify which bundle a
  hosted worker runs. Needs `BUILD_VERSION` threaded through
  `deployment-service/src/index.ts:106` from the `VERSION` file at embed time;
  the embed script is gitignored, so this is tooling work, not a one-liner.

- Delete `selfhost/src/deploy.mjs` and `selfhost/src/env.mjs`. Both have **zero
  importers** — independently verified in the Gate 3 review, including dynamic
  imports and tests — and `deploy.mjs:32` holds a third `BUILD_VERSION` writer
  that bypasses `version.mjs`. Dead code that mentions a symbol makes future
  greps lie, which is how this project has repeatedly fixed things that never
  run. `selfhost/README.md` no longer lists them.
- `selfhost/package.json:3` still declares `"version": "1.0.0"` — a third
  version number in a change whose thesis is "one tracked file".

## P0 — self-hosted bootstrap is broken

Found by the Gate 3 review of Phase 0, from code, not from a doc. **Verified
independently.** This is a product bug, not a documentation bug.

**A fresh self-hosted install cannot be claimed by following the documented
path.** `daemonclient web` → open the dashboard → sign in returns
`Not authenticated`.

The chain:

| Step | Evidence |
|---|---|
| Nothing ever seeds `owner_uid` | it appears **once** in the whole repo, as a key constant — `owner-gate.ts:22`. `setup.mjs` writes only the schema and the ZKE keys. |
| An unclaimed install can only be claimed by a credential with `mayClaim` | `owner-gate.ts:89-98` — `if (!mayClaim) throw new Error('Not authenticated')` |
| A Firebase ID token never has it | `helpers.ts:119` — `requireOwner(env, session.uid, false)` |
| The dashboard only ever presents a Firebase ID token | `accounts-portal/src/App.jsx:411,617,876,1346,1720` — `getIdToken()`, never `POST /api/auth/login` |
| `/api/auth/exchange` does not help — it authenticates the same way | `auth.ts handleExchange` → `requireAuth` → the Firebase branch |

So the only thing that can claim a self-hosted install is `POST /api/auth/login`,
which Photos and the mobile app use and the dashboard does not. A user who signs
into Photos *first* gets a working install; a user who follows the documentation
gets a locked one.

**The gate itself is right** — `owner-gate.ts:16-20` explains why a Firebase ID
token must not claim, and that reasoning holds. The bug is that nothing else
claims either.

**Owner: P10 (account) / P15 (wizard) in `BUILD_ORDER.md`.** The account step
should claim the install explicitly at the end of setup, while it still holds
the password, rather than leaving it to whichever app the user happens to open
first. Do not "fix" this by loosening `mayClaim`.

This is exactly the class of defect Phase 3 exists to catch, found earlier and
more cheaply by reading the code.
