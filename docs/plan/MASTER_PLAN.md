# Master plan — the installer

Every phase, top to bottom. The current phase is detailed separately; this file
is the shape of the whole thing and does not change often.

**Read in this order:** `../../EXECUTION_STATUS.md` (where we are) →
`PRODUCT_SPEC.md` (what we are building, as the user experiences it) →
`BUILD_ORDER.md` (**the parts to build, and the order to wire them** — work
from this) → `INSTALLER_STACK.md` (how it is delivered) → this file.

This file groups work by *problem to fix*. `BUILD_ORDER.md` groups the same
work by *part to build*, which is the more useful view when actually building.

`PRODUCT_SPEC.md` is the boss. Where a phase here disagrees with it, it wins.

> **Not to be confused with the DaemonClient CLI** — the separate product for
> automating Drive from a terminal. That is parked in the private ops repo and
> comes back later. This plan is about the **installer**.

---

## The goal, stated as a test

> A stranger with no connection to us clones this repository, runs one command,
> answers some questions, and ends with a working private photo and file cloud
> on their own accounts. When we fix something, they find out and can apply it
> with one more command. If we disappear, nothing they have stops working.

Every phase below exists because some part of that sentence is not true yet.

## What is already true

Verified by reading the code on 2026-08-11, not assumed:

| | Evidence |
|---|---|
| The CLI is dependency-free and runs from a bare clone | `selfhost/package.json` has no deps; CI asserts it |
| 68 tests pass, covering schema replay, key seeding, the no-operator guard | `selfhost/test/` |
| Schema application is correct and **fails loudly** | `setup.mjs:262-272` — only `already exists`/`duplicate column` are swallowed, everything else exits 1 |
| Encryption keys are seeded, and setup **aborts** if it cannot | `setup.mjs:456-469` |
| Telegram config is written into the user's own D1, not a config service | `setup.mjs:431-451` |
| A self-host web build cannot contain an operator address | `web.mjs assertNoOperator`, plus `selfhost.test.mjs:128` |
| Setup is resumable — it saves after every step | `markDone` / `saveState` throughout |

This is a good foundation. The plan is not a rewrite.

## What is not true yet

| # | Problem | Evidence | Phase |
|---|---|---|---|
| 1 | The docs describe a `daemonclient password` command that **does not exist**, and an account model (local database accounts) that is not how auth works — it is Firebase | `docs/SELF_HOSTING.md:129,306` vs `bin/daemonclient.mjs:9` (7 commands, no `password`) | 0 |
| 2 | `BUILD_VERSION` is unusable, so the update banner never fires after the first `update` | `setup.mjs:412` reads a **gitignored** root `package.json` → `0.0.0`; `update.mjs:133` writes a git SHA, which `isNewerVersion` either cannot parse or reads as a huge major version | 1 |
| 3 | No GitHub release has ever been published, so the feed the update check polls is empty | `gh release list` → nothing; one dangling `v2.0.0` tag | 1 |
| 4 | A fresh Cloudflare account has no `workers.dev` subdomain and setup never claims one — the install "succeeds" with no URL | `registerSubdomain` is exported at `cloudflare.mjs:254` and **called nowhere**; `setup.mjs:274` only reads it and falls back to `null` | 2 |
| 5 | `enableWorkersDev` failure is swallowed silently | `setup.mjs:417` — `.catch(() => {})` | 2 |
| 6 | **Nobody has ever run this end to end** | no staging environment exists | 3 |
| 7 | Self-hosting makes the user create a Firebase project by hand — register a project, register an app, copy eight config values, enable a provider, add a user | `selfhost-auth.ts`; login goes through Firebase Identity Toolkit | 4 |
| 8 | `daemonclient web` builds three apps including a full SvelteKit build; unverified that it completes | `web.mjs:35-37` | 5 |
| 9 | No `curl … | sh` bootstrap | nothing in the tree | 6 |

---

## Phases

Ordered by dependency, not by size. Each is shippable on its own.

### Phase 0 — Truth
Make every claim in the documentation match the code, and stand up the planning
and status files this process needs. Small, and it comes first because
everything after it is planned against those documents.

**Done when:** no documented command or behaviour is absent from the code, and a
cold agent can resume from `EXECUTION_STATUS.md` in two minutes.

### Phase 1 — The update path
Fix `BUILD_VERSION` at both ends, then cut the first real release.

This is first among the real work because it is the **delivery channel**. Until
it works, nothing else we fix reaches a self-hoster — they will run an install
that believes it is current, forever.

**Done when:** a worker deployed by `setup` and one deployed by `update` both
report the same semver; a published release makes an older install show the
banner; and a test asserts a git SHA can never be stamped as a version again.

### Phase 2 — Setup completeness
Claim a `workers.dev` subdomain when the account has none. Stop swallowing the
failures that leave a user with no URL. Audit every `.catch(() => {})` and
`|| null` in the setup path for the same class of silent success.

**Done when:** setup either produces a reachable URL or fails with a message
saying exactly what to do — never a green summary with a blank address.

### Phase 3 — Prove it end to end
Create throwaway Telegram, Cloudflare and Firebase accounts and run the whole
thing as a stranger would: clone, setup, upload a photo, view it, deploy the web
apps, take an update.

This is the phase that converts inference into evidence. **It needs a human** —
Telegram bot creation cannot be automated, and it must not be, since doing it
for the user is precisely what the managed service does and self-hosting exists
to avoid.

**Done when:** a written transcript of a complete run exists, every defect it
surfaced is either fixed or filed, and the run has been repeated cleanly.

### Phase 4 — The script creates their Firebase project
**Decided (Q1):** Firebase stays, and setup provisions the project itself.
Clicking through the Firebase console is not an acceptable setup step. The user
runs `firebase login` — OAuth against *their* Google account, in *their*
browser, nothing reaching us — and the CLI does the rest.

Four of the five steps are confirmed to exist in `firebase-tools`:
`projects:create`, `apps:create WEB`, `apps:sdkconfig WEB`, and login itself.
The fifth — **enabling the Email/Password provider** — has no CLI command, and
`firebase auth` offers only import/export. It needs the Identity Toolkit Admin
API with a `cloud-platform`-scoped OAuth token.

So the phase **opens with a spike**: can we get that token from the credentials
`firebase login` already stores, without adding a `gcloud` dependency? Until
that is answered, nothing else in the phase is planned in detail — planning past
an unverified premise is the failure this project keeps repeating.

- **If the spike succeeds:** setup provisions the project end to end.
- **If it fails:** automate the four steps that work and reduce the manual part
  to *one toggle on one console page*. That is the floor, not the target.

Either way, the phase also settles the account model in code: no `password`
command unless there is something for it to do, and the owner gate untouched
(Q3 — one person per install).

**Done when:** a stranger reaches a working sign-in without being asked to copy
a config object out of a web console.

### Phase 5 — The web apps
Verify `daemonclient web` end to end, on the evidence from Phase 3. Confirm all
three builds complete on a normal machine, that `assertNoOperator` holds, and
that `ALLOWED_ORIGINS` is set correctly for the sites it creates.

**Done when:** the three URLs it prints all serve a working app that talks to
the user's own worker.

### Phase 6 — The installer people actually run
The re-skin and the distribution change, together, because neither is worth
much alone.

Publish as **`create-daemonclient`** so the entry point is
`npm create daemonclient@latest`. That single change removes the no-dependency
constraint — see `INSTALLER_STACK.md` — which is what makes a good interface
possible at all. Rebuild the prompts on `@clack/prompts` (4 deps, built for
wizards, first-class Ctrl-C handling) and the deploy phase on `listr2`, so
several minutes of work reads as progress rather than a hang.

The logic is kept: the Telegram write-check, the Cloudflare permission probe,
key seeding, resumable state. Only `ui.mjs` is replaced.

The installer fetches the repository itself rather than asking the user to
clone first, so the whole thing is genuinely one command.

**Done when:** a stranger runs one line from the website and reaches a working
sign-in, and `daemonclient` is still free on npm for the Drive CLI.

### Phase 7 — Managing an install after setup **(later — not now)**
Raised by the operator 2026-08-11, explicitly deferred: *"after the user does
the setup, to manage everything — they write something to their CLI and it
shows the status and settings for the whole self-hosted stuff."*

The commands mostly exist already — `status`, `update`, `doctor`, `processor`,
`web` — so this is largely about making them reachable and coherent rather than
writing them. Three things need deciding when we get here, recorded now so they
are not rediscovered:

- **The name.** It cannot be `daemonclient`, which is reserved for the Drive
  CLI. The installer leaves the source in `~/.daemonclient/src`, so a shim on
  `PATH` is easy; what it is *called* is the open question.
- **Where settings live.** Some are worker bindings, some are D1 `config` rows,
  some are in `.daemonclient-selfhost.json`. A settings command has to present
  one surface over three stores, or be honest about which is which.
- **Overlap with the dashboard.** `/api/selfhost/status` already exists and the
  dashboard already renders it. A terminal tool that duplicates it is worse
  than one that does the things a browser cannot — rotating a token, changing
  the channel, taking an update.

**Not started, and not blocking anything.** The installer has to be good first;
a management tool for an install nobody has successfully created is worth
nothing.

---

## What is explicitly out of scope

Written down so it does not get relitigated every phase.

- **Mobile apps.** Parked behind the web, deliberately.
- **Multi-user tenancy.** One install, one owner — confirmed by the operator
  (Q3): *"it's not meant for family (yet); every user will host an independent
  system."* The owner gate is not being opened.
- **Anything that makes a self-hosted install depend on infrastructure we run.**
  This is the premise, not a preference.
- **Object storage.** Telegram is the storage layer.
- **The managed service's own bugs.** Tracked separately in the private repo;
  they only enter this plan where the same code serves both.

## The rule this plan is held to

> **Before implementing anything, grep for its callers and write down who calls
> it.** If nothing calls it, fixing it changes nothing and no test will tell
> you. `registerSubdomain` is in this plan precisely because that grep was run.
