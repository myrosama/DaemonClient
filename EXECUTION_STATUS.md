# Execution status

> **The self-host installer is PAUSED — since 2026-09-30, by the operator.**
> Do not resume it unless the operator asks. Current work is fixing bugs in the
> live product. Everything needed to pick self-hosting back up is in
> [Paused 2026-09-30 — how to resume](#paused-2026-09-30--how-to-resume).

**Read this first after any context reset.** For self-host work, then
`docs/plan/PRODUCT_SPEC.md` (what we are building), `docs/plan/BUILD_ORDER.md`
(the parts and their wiring order — this is what to work from),
`docs/plan/MASTER_PLAN.md`, then `git log --oneline`.

> **Two different things share the brand.** The **installer** is what this plan
> builds — an interactive setup script, run once. The **DaemonClient CLI** is a
> separate product for automating Drive from a terminal; it is parked in the
> private ops repo and comes back later.

| | |
|---|---|
| **Date** | 2026-10-05 |
| **Phase** | **Self-host installer PAUSED.** Shipped before the pause: P11, P8, P6, P0, P1/P2/P4, P5, P9, P10; Phase 0 done. |
| **Just finished** | Security hardening across the sign-in hub, accounts portal, Drive, the deployment service and the Firestore rules (see "Security hardening — 2026-10-05" at the end). Bug 1 verified by the operator with a brand-new account. |
| **Live on the web** | 2026-10-05: auth hub `daemonclient-auth` (version fb3b7c32), Firebase Hosting `accounts` and `drive`, `daemonclient-deployment` (version abb34a6e), Firestore rules (released 13:16 UTC) — all from `main` `9b498b4`, each checked live. `photos` is still the 2026-10-04 build from `6dacd43`. Update this row on every deploy. |
| **Working on now** | Photos speed: the thumbnail scheduler (draft PR #3) is being reworked to the priority model the mobile apps use (docs/mobile/SPEC.md §4.9); the boot debloat (draft PR #4) is in review. Then the Drive-on-File-Browser spec, rewritten with the operator's decisions. |
| **Next up** | PR #3 rework → review → deploy; PR #4 review → deploy; the clean Drive spec. Self-host resumes only when asked; where it resumes is in the pause section below, deliberately not here. |
| **Blocked on** | *(self-host, on resume)* **Creating a real Firebase project has never been run.** Every read path is verified against the live CLI, but `projects:create` needs a Google account and burns project quota, so only the operator can prove it. That is the one thing standing between here and a release. |
| **Staging** | None exists yet. Phase 3 creates one — throwaway Telegram + Cloudflare + Firebase accounts. Until then no self-host change has been proven on real infrastructure. |

## iOS app — MacBook

**Built on the operator's MacBook since 2026-10-04**; production work stays on
the Linux laptop. The MacBook session owns this section — the shared top table
above is not edited from there, so the two machines never touch the same lines.

| | |
|---|---|
| **Start here** | **`docs/mobile/README.md`** — reading order, files, rules. |
| **Direction (2026-10-04, replaces the 2026-06-10 plan)** | Two apps — DaemonClient Photos (the Immich fork) and DaemonClient Drive (new) — both Flutter, both on one **Rust core** that does encryption, Telegram transfers and media streaming on the phone. The worker keeps only metadata, as on the web. The old plan (`daemonclient-ops/docs/roadmap-history/MOBILE_APP.md`: one app, worker-side uploads) is superseded. |
| **Shipped** | Before the new direction: `7349bde` rebrand (Android ids only) + CI, `b1a466d` full Flutter source tracked, `d64da81` mobile CI fixes. |
| **Working on now** | **P0 in progress.** 0.1 done (toolchain: Rust 1.99.0, Flutter 3.41.7, CocoaPods, Java 21, Android SDK, iOS 27 Simulator, flutter_rust_bridge 2.13.0). 0.3 done (`dc-core` range planning). Next: 0.2 run the existing Photos app in the Simulator → 0.4 Rust inside the app. Plan: `docs/mobile/PLAN.md`. |
| **Blocked on** | Nothing. (Disk freed to 44 GB on 2026-10-06.) |
| **Rules** | Plan first, approved by the operator. Every change through `GATES.md`. Message the Linux session before touching `immich-api-shim`, `deployment-service` or anything the per-user workers run — the app talks to them, and the native sync parser aborts all sync on one unexpected value. |

## Paused 2026-09-30 — how to resume

Paused after `883b132`, the last code commit. First, see what moved under the
installer while it was paused — bug fixes to the worker reach self-hosters too:

```
git log --oneline 883b132..HEAD -- selfhost/ install.sh immich-api-shim/
```

Then run the test baseline below. A lower count means tests were skipped.

### Where each part stood

In `BUILD_ORDER.md` wiring order. P7 is step 5, so it comes **before** P15.

| # | Part | State at the pause |
|---|---|---|
| 1 | **Gate 3 debt** | Close it before building anything new — see the gate record below. The owner claim (P0) first: it touches the owner gate, which `GATES.md` says always gets the full treatment. |
| 2 | **P7 Telegram** | Not finished. `api/telegram.mjs` already tells *chat not found* (`:45`) and *in the channel but cannot post* (`:58`) apart. It does not separately report *not an admin*, and `verifyChannelAccess`'s messages have no tests (only the module's timeout wiring is tested, in `status-command.test.mjs`). Gate 2 needs a real throwaway bot. |
| 3 | **P8 carry-forwards** | Three items, listed under P8 in `BUILD_ORDER.md`: the installer prints the plain token URL, the permission list says four in code and three in the docs, and `/workers/subdomain` is not probed at validation. |
| 4 | **P15 wizard rewrite** | Bigger than planned. `setup.mjs` is 852 lines (the plan said 627), and `ui.mjs` is still imported by six commands — setup, doctor, update, web, dashboard, processor — plus the entry point `bin/daemonclient.mjs` and `test/selfhost.test.mjs`. Retiring it means moving all of them. `withSpinner()` exists in the kit (`54c4e4c`), but no command uses it yet. |
| 5 | **P13 web apps** | Never run end to end; the Photos SvelteKit build is the heaviest step. `assertNoOperator` in `web.mjs` was widened in `42eebd5` and has had one review, not a second — re-review it here. |
| 6 | **P14 final URL** | Still the 10×2s poll, ending in three URLs rather than one that lands the user signed in. |
| 7 | **Release `v2.1.0`**, then P3 | Waits on the live proof below. |

**CI has been red since 2026-09-19 — found 2026-10-04, after the pause.** Only
`selfhost (20.12.0)` fails; every other job, including the new `secrets` job,
passes. Two causes, both on Node 20.12, the installer's own floor:

- **Ctrl-C at a prompt crashes** instead of cancelling: `util.styleText` rejects
  an array of formats (`['strikethrough', 'dim']`) on 20.12. A real user-facing
  bug — the cancellation path P5 exists to protect.
- `test/schema-replay.test.mjs` imports `node:sqlite`, which 20.12 does not have.

It went red with the 19 Sep push (P5 through P9/P10 landed together) and nobody
looked — Gate 4's "confirm CI is green" was skipped. Fix both before anything
else in self-host: either raise the Node floor to a version that has both, or
make the kit and the test work on 20.12. Decide on evidence from the Node
changelog, not from memory.

### Only the operator can unblock

- **Throwaway accounts** — a Telegram bot, a Cloudflare account, a Google
  account — for the Phase 3 staging install. Gate 2 for P7, P13 and the end-to-end
  run all need them.
- **One live run of `projects:create` and `accounts:signUp`** on the throwaway
  Google account. The last proof before a release.

### Gate record — what actually ran

`GATES.md` asks for all four gates, with Gate 3 as **two** separate reviewers,
security and spec conformance. An earlier version of this file said every part
went through all four. That was not true. From the design notes and the review
agents actually launched:

| Part | Gate 2 — real infrastructure | Gate 3 — independent review |
|---|---|---|
| P11 | Partial: the real comparator, no real worker | Security + spec, two agents |
| P8 | Not run | Security + spec, two agents |
| P6 | Checked against the real state file; no staging | **Never run** — "G3 pending" in the design note, never closed |
| P0 owner claim `8ddfc37` | Not run | **No dedicated review**, and no design-note entry at all. The P9/P10 reviewer traced `owner_uid` into `owner.mjs` in passing. |
| P1/P2/P4 `install.sh` | Partial: platform mapping, and the no-release path | **No dedicated review.** P5's review touched `install.sh` only for the Node floor. |
| P5 UI kit | Real pty, real `^C`, real network, `npm ci` from a clean checkout | One correctness+security agent; the test-adversary agent hit a session limit and its mutation run was redone by the author. No spec review — P5 is "light gates" in `BUILD_ORDER.md`, so this one is the mildest debt. |
| P9/P10 | Real CLI and a real project — **read paths only**; `projects:create` and `signUp` unproven | One correctness+security agent; no spec review, which full-gates parts (P7–P10) require |
| Secret scanner + wider leak guard `42eebd5` | Not run | One agent; its findings fixed; the fixes not re-reviewed |
| `image-size` bump `883b132` | n/a | None — a dependency bump |

`42eebd5` and `883b132` were unpushed at the pause; they went out on
2026-10-04 with the pause records (`2482165`). The new `secrets` CI job passed.
CI as a whole is red, but from the Node 20.12 failure above, not from them.

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
All four re-run and confirmed 2026-09-30.

| Suite | Count | Command |
|---|---|---|
| `immich-api-shim` | 297 | `npm test` |
| `selfhost` | 278 | `npm ci && npm test` |
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
| — | **`firebase login` could hang forever over SSH.** A VPS/NAS/Pi has a TTY but no local browser, so the OAuth redirect to localhost never arrives. Detected now; `--no-localhost` used instead. |
| — | **A test for dead code.** Three times this repo has shipped a function nobody calls. There is now a guard for the class; it found nine more on its first run. |
| — | **A secret scanner** (`scripts/scan-secrets.mjs`) in an opt-in pre-commit hook (`core.hooksPath scripts/hooks`) and in CI, and a wider self-host leak guard: every Google API key in a self-host bundle must be the user's own, and the build fails closed when that key is unknown. `42eebd5`, unpushed at the pause. |
| — | `image-size` 2.0.2 → 2.0.4 in the shim, a dependency bump. `883b132`, unpushed at the pause. |

**Not every one went through all four gates** — the gate record in the pause
section above says exactly which did. Where Gate 3 did run, it found real
defects in P8, P11, P5 and P9/P10 that green test suites had missed — more than once because a
test had been written to agree with the implementation rather than challenge
it. That pattern is the single most useful thing the gates have caught, and the
reason the missing reviews are listed as debt rather than waived; see
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

- ~~Delete `selfhost/src/deploy.mjs` and `selfhost/src/env.mjs`~~ — **done**
  `cd63f84`. Both had zero importers, and `deploy.mjs:32` held a third
  `BUILD_VERSION` writer that bypassed `version.mjs`.
- ~~`selfhost/package.json` declares `"version": "1.0.0"`~~ — **fixed**
  `8541f1f`. The field is gone (the package is `private`, so it needs none),
  and `test/dependencies.test.mjs` fails if it comes back.

- **Raw spinner sites** across `setup`, `doctor`, `update`, `web`,
  `dashboard` and `processor`, all still on `ui.mjs` — 28 when P5 counted them;
  `setup.mjs` has grown since, so recount on resume. Each is an instance of the
  hang class P5 found twice: a leaked spinner blocks process exit in BOTH
  implementations (verified under a pty). The kit now has `withSpinner()`,
  which stops in a `finally` (`54c4e4c`); no command uses it yet. P15 moves the
  raw sites onto it.

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

## Live-product bugs

### 1. New accounts could not use Photos or Drive for their first minutes — fixed 2026-10-04

**Status.** Shipped: `main` `6dacd43` (fix `cbc372c`), deployed 2026-10-04 to
Firebase Hosting `photos`, `drive`, `accounts` and checked on the live sites.
CI green on every job this touches. G2 done: the operator signed up a brand-new
account on 2026-10-05 and both apps worked.

**Symptom.** Every brand-new account, for 1–3 minutes after setup: Photos showed
`Error: 503` (from `loadServerConfig`), Drive "Configuration Error … Failed to
fetch". Both started working on their own a few minutes later.

**Cause, with evidence.** A first-time Cloudflare account gets a brand-new
`<name>.workers.dev` subdomain during provisioning (each is its own delegated
DNS zone). Cloudflare issues its TLS certificate (`*.<name>.workers.dev`,
Let's Encrypt) a minute or two **after** the deploy call returns. Until then the
browser's handshake fails — Chrome logged `ERR_SSL_VERSION_OR_CIPHER_MISMATCH`
against the test account's worker, and minutes later the same worker answered
200 with a certificate issued minutes earlier. The Photos service worker turned
the failed fetch into a synthesized 503. Ruled out on the way: the central API
(200), the worker bundle new users receive (ran it locally exactly as deployed:
200, CORS and preflight correct), CORS configuration.

**Fix.** No error for something that fixes itself; say so, estimate, re-check.
- accounts-portal dashboard: for accounts set up in the last 15 minutes
  (`setupTimestamp`), probe `<worker>/api/health` from the browser
  (`no-cors` — reachability, not CORS) and hold Photos/Drive links with "your
  private cloud is finishing setup — usually 1–3 minutes" until it answers.
  Established users are never probed. `src/utils/waitForWorker.js`,
  `src/utils/cloudStartup.js`.
- Photos: the service worker tags "the user's own worker could not be
  reached" (`DC_WORKER_UNREACHABLE`; never for the shared entry point, so an
  outage is not mislabelled); the root layout shows "isn't ready yet —
  usually 1–3 minutes" with a countdown and auto re-check instead of the error
  page; after login the app re-initialises against the user's worker
  (`resetInit`) so a first login lands there too, not on a stuck spinner.
- Drive: `driveApi` flags the same failure; the app shows the same screen.
- Both apps cap the wait at 5 minutes (as the dashboard does), then say plainly
  that the cloud can't be reached and stop reloading; countdowns pause in
  background tabs; Photos gained a Sign out that also ends the shared session.

**Gate evidence.** G1 — tests first: portal 25, Drive 11, Photos 13 (one through
the real SDK); 8/8 mutations caught. G2 — module run against real hosts
(reachable worker, unreachable host, route-off worker); builds of all three
apps; svelte-check: no errors in changed files. **Not yet:** a real new account
after deploy. G3 — four review rounds, separate security and spec agents;
every HIGH/MEDIUM fixed and re-reviewed. G4 — this commit.

**Known gaps, tracked:**
- No CI job runs the Photos (`immich/web`) unit tests yet.
- `deployment-service` `provisionWorker` ignores `enableWorkersDev`'s result
  (the same defect P8 fixed in self-host only) — a failed route enable would
  leave a new worker unreachable for good, and these screens would then show
  the 5-minute "can't reach" message rather than fix it.
- A dashboard click in the first instant before Firestore answers, or a
  middle-click, is not held.

### 2. Thumbnails take very long when scrolling far down — in progress 2026-10-05

**Symptom (operator).** With ~2,000 photos, scrolling down to an older period
means a long wait before thumbnails appear: loading starts at the top and works
through a queue. Opening a photo also waits behind thumbnail loads.

**Cause (read in code, `immich/web/src/service-worker/index.ts`).** One
first-in-first-out queue of 6 (`thumbAcquire`/`thumbRelease`) serves
thumbnails and opened photos alike; queued requests are never dropped when the
page cancels them; each thumbnail's manifest is fetched from the user's worker
before it takes a slot, so a fast scroll fires dozens of worker calls at once;
video chunks bypass the queue and compete with it.

**Plan.** One scheduler: what the user opened (photo, viewer preview, video)
goes first and pauses new thumbnail work until it loads; thumbnails run newest
first, capped, and are dropped once the page cancels them; the manifest fetch
moves inside the slot. Built by a cloud session as a draft PR from
`feat/photos-media-scheduler`; then all four gates here before it ships.

## Security hardening — 2026-10-05

Operator-ordered after a review of the Drive redesign spec. Implemented
locally, every change through the gates, deployed, verified live, then pushed.

| Component | What it does now |
|---|---|
| Sign-in hub (`auth-worker`) | Sessions are created only from the accounts portal with a JSON body; logout only from our apps; a fresh ID token is readable only by the three apps (the landing page may only ask whether the browser is signed in); Turnstile results must come from our page and widget (hostname + action); after sign-in it returns only a path on our site or one of our https origins; `Vary: Origin`. Rules in `src/policy.ts`, `npm test`. |
| Accounts portal | `return_url` goes through `safeReturnUrl` — only our own pages. |
| Drive | Uploads never go out unencrypted by accident: they wait while the encryption settings load and pause while the key is locked (a banner explains, with Unlock / Cancel). Custom-password users can unlock again: the same password re-derives the key from the stored salt, after a test decrypt of their own files; Settings opens only once the settings are known, and a new key is saved before it is used. `/stream` serves only types that cannot run script as themselves; everything else is text, sandboxed, or a download, with `nosniff`. |
| Deployment service | Writes `config/cloudflare` with its own service account. A newly minted session secret is recorded as pending and goes live only after the worker runs with it; overlapping auto-updates can't split it (conditional write); a rotated refresh token is saved before the deploy. |
| Firestore rules | `config/cloudflare` is read-only for its owner (`scripts/test-firestore-rules.sh`, 14 cases via the Rules API). |

**Gate evidence.** G1: tests first — hub 9, portal 28, Drive 39, deployment
service 29, rules 14/14; deliberate-breakage check 12/13 caught (the 13th is
redundant). G2: each component checked live after deploy (hub status codes and
CORS headers, live bundles, live `sw.js`, the production log line
`[config-write] saved with the service account` on a real signup before the
rules went out, the live ruleset compared with the repo). G3: five rounds of
separate security and correctness agents; every HIGH/MEDIUM fixed and
re-reviewed. G4: code and docs in separate commits, no AI trailers.

