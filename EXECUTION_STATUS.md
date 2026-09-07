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
| **Date** | 2026-09-08 |
| **Phase** | Building — `BUILD_ORDER.md`. P11, P8, P6, P0, P1/P2/P4, P5, **P9 and P10** shipped; Phase 0 done. |
| **Just finished** | **P9 + P10, and the wiring that makes them real.** Setup no longer prints a five-step Firebase console errand — it creates the project, registers the web app, creates the account and signs in to prove it. One switch stays manual (Email/Password has no CLI command); setup opens that exact page. |
| **Working on now** | Nothing in flight. Gate 3 on P9/P10 not yet run. |
| **Next up** | **Gate 3 on P9/P10**, then **P15** (the wizard rewrite onto the UI kit) and **P13/P14**. The release is last — see below, the reason it is held has changed. |
| **Blocked on** | **Creating a real Firebase project has never been run.** Every read path is verified against the live CLI, but `projects:create` needs a Google account and burns project quota, so only the operator can prove it. That is the one thing standing between here and a release. |
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
| Entry point | **`curl -fsSL https://raw.githubusercontent.com/myrosama/DaemonClient/main/install.sh \| sh`** — fetched from **GitHub, not from us**, so nothing of ours is in the install path. It checks git, installs a local no-sudo Node if missing (checksummed), clones the latest release tag, runs `npm ci`, hands over. |
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
| `selfhost` | 252 | `npm ci && npm test` |
| `deployment-service` | 8 | `npm test` |
| `processor` | 5 | `npm test` |

Typecheck clean: `immich-api-shim`, `deployment-service`.

## Where things live

| | |
|---|---|
| Public repo | `myrosama/DaemonClient` — the product |
| Private repo | `myrosama/daemonclient-ops` — managed-service code, audits, security findings |
| Open security findings | `daemonclient-ops/docs/AUDIT_FINDINGS_2026-08-06.md` — **not** in this repo, and deliberately not summarised here |

## Shipped since the plan was written

| Part | What it fixed |
|---|---|
| P11 | `BUILD_VERSION` — installs stopped seeing updates after one `update` |
| P8 | a fresh Cloudflare account finished setup with no address at all |
| P6 | the account password could reach disk in cleartext |
| P0 | a fresh install could not be signed into — `owner_uid` was written by nothing |
| P1/P2/P4 | `install.sh` — bootstrap, no sudo, checksummed Node, pinned source |
| P5 | the UI kit — Ctrl-C can no longer return a truthy symbol into state, nor report an abandoned install as a success; four hangs fixed; `curl \| sh` now gets a terminal to ask questions on |
| — | **Node floor 18 → 20.12**, which is what the prompt library actually needs. Node 18 installed cleanly and then died at import. Now enforced in three places and exercised by CI. |
| P9 | the Firebase project, created instead of clicked — four of the five console steps gone |
| P10 | the account, created and then proven by signing in — the fifth manual step was "Add user" |

Every one went through the four gates. Gate 3 (two independent agents) found
blockers in P8 and P11 that green test suites had missed — twice because a test
had been written to agree with the implementation rather than challenge it.
That pattern is the single most useful thing the gates have caught; see
`DESIGN_NOTES.md`.

## Ordering correction — install.sh must come before the UI kit

`BUILD_ORDER.md`'s wiring table put **P5 (UI kit) at step 3** and
**P1–P4 (`install.sh`) at step 7**. That is backwards, and trying to start P5
is what surfaced it.

P5's whole premise is that dependencies are allowed (`@clack/prompts`,
`listr2`). What makes them allowed is `install.sh` running `npm ci` before any
of our code executes. Until that exists, `selfhost/` must still run from a bare
clone — and CI enforces it with a guard that fails the build if a dependency
appears. So P5 cannot be built first without either breaking that promise or
disabling the guard that protects it.

**Revised order:** P1, P2, P4 are buildable now. P3 clones a release tag and is
the one piece that genuinely waits on `v2.1.0`.

## Why `v2.1.0` is not cut yet — restated 2026-09-08

The reason has changed twice now, and both changes are worth keeping visible
because each one was a real correction rather than a rephrasing.

**First reason (expired).** "Nothing consumes a release." That stopped being
true when `install.sh` landed: it pins to the latest release tag and refuses to
install without one.

**Second reason (now fixed).** A tag would have opened a road ending at five
manual Firebase console steps — the thing the locked decision at the top of
this file calls not acceptable. P9 and P10 removed four of them and setup now
opens the page for the fifth.

**The reason today is narrower and factual: nobody has ever created a Firebase
project with this code.** Every read path is verified against the live CLI —
`projects:list`, `apps:list`, `apps:sdkconfig`, the error envelopes, the
resume path that reuses an existing app without duplicating it. But
`projects:create` and `accounts:signUp` write, need a real Google account, and
burn project quota. They are covered by unit tests against recorded shapes and
by nothing else.

That is a one-session job for the operator with a throwaway Google account, and
it is the last thing between here and a release worth cutting.

Both original release blockers remain closed:

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
- ~~`selfhost/package.json` declares `"version": "1.0.0"`~~ — **fixed**
  `8541f1f`. The field is gone (the package is `private`, so it needs none),
  and `test/dependencies.test.mjs` fails if it comes back.

- **28 raw spinner sites** across `setup`, `doctor`, `update`, `web`,
  `dashboard` and `processor`, all still on `ui.mjs`. Each is an instance of the
  hang class P5 found twice: a leaked spinner blocks process exit in BOTH
  implementations (verified under a pty). P15 removes them; before then the kit
  should grow a `withSpinner()` that stops in a `finally`.

- **`firebase-tools` can never be a `selfhost` dependency** — 70 direct
  dependencies, 5.8 MB unpacked, against a package budget of 12. P9 must shell
  out, and `web.mjs:311` already has the function to reuse: `firebaseCli()`,
  which prefers a global `firebase` and falls back to `npx --yes
  firebase-tools`. Reuse it; do not write a second one.

## P0 — self-hosted bootstrap — FIXED 2026-08-17

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

**Fixed** in `selfhost/src/owner.mjs` + `stepDeployWorker`. Setup now claims the
install for the account it just created, using the uid from the sign-in it
already performed (`state.adminUserId`). The gate was **not** loosened — that
would have handed any unowned install to the first stranger with a Firebase
token. Instead the claim happens where the person is demonstrably holding the
Cloudflare token for that database, which is far stronger proof of ownership
than "arrived first".

Reads before writing, refuses a blank uid (owner-gate trims `''` to null, so a
blank row would look unclaimed while existing), treats an unreadable result as
unknown rather than unowned, and exits rather than finishing if the database
belongs to a different account. 107 → 115 tests.

This is exactly the class of defect Phase 3 exists to catch, found earlier and
more cheaply by reading the code.
