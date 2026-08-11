# How the installer is built and delivered

Research, not preference. Every number below was pulled from the npm registry
on 2026-08-11.

---

## The finding that changes the architecture

`selfhost/` has a hard rule: **no dependencies**, because it must run from a
bare `git clone` with nothing installed. That rule is the reason the current
setup output is hand-rolled ANSI escapes in `ui.mjs` (299 lines of them).

**The one-line installer removes that constraint.**

If the entry point is `npm create daemonclient@latest`, the package is fetched
from the npm registry with its dependency tree resolved. There is no bare clone
to protect. The no-dependency rule was solving "a stranger has only git and
node" — and the new entry point means a stranger has npm, which is the thing
that makes dependencies free.

This is worth stating plainly because it is easy to carry an old constraint
into a new design and conclude that a good interface is impossible here. It
isn't. It was impossible under the old distribution model.

| | Old model | New model |
|---|---|---|
| Entry | `git clone` then `node selfhost/bin/daemonclient.mjs setup` | `npm create daemonclient@latest` |
| Dependencies | forbidden | fine |
| Interface ceiling | hand-rolled ANSI | anything |
| Source of truth | the clone | the published package |

**What still has to be true:** the installer builds the worker from *source*, so
it needs the repository regardless. The package therefore clones the repo itself
(or downloads a release tarball) rather than the user doing it first. That is a
better first experience anyway — one command, not three.

---

## Choosing the interface library

Four candidates, all real, all current:

| Package | Version | Deps | Weekly installs | Shape |
|---|---|---|---|---|
| **`@clack/prompts`** | 1.7.0 | **4** | 17.7M | Purpose-built for setup wizards |
| `@inquirer/prompts` | 8.5.2 | 10 | 35.2M | The classic, rewritten |
| `enquirer` | 2.4.1 | 2 | 33.5M | Mature, less opinionated styling |
| `ink` | 7.1.1 | **25** | 5.7M | React for terminals |

### Recommendation: `@clack/prompts`, with `listr2` for the deploy phase

**Why not Ink,** despite it being what Claude Code is built on. Ink is a
rendering engine for *persistent, dynamic* terminal UIs — a REPL that redraws
as state changes. Our installer is a **linear wizard**: ask, verify, advance.
Writing React components and managing a render loop to ask four questions is
using the heaviest tool available for the shape it fits worst, and it brings 25
dependencies into a security-sensitive install path.

**Why Clack.** It is built for exactly this shape and nothing else:
`intro`/`outro` framing, `text`, `password`, `confirm`, `select`, `spinner`,
`note`, and — the one that matters most — **first-class cancellation**.
`isCancel()` makes Ctrl-C at any prompt a handled case rather than a stack
trace over a half-written state file. That is spec item 4 in
`PRODUCT_SPEC.md`, and getting it right by hand is fiddly.

Four dependencies, and the output is genuinely good-looking without any work.

**Why `listr2` alongside it.** Step 5 is several minutes of real work across
about eight sub-tasks. `listr2` renders exactly that: concurrent or sequential
tasks, each with its own spinner, completed ones staying visible with a tick.
It is the difference between a four-minute deploy that reads as progress and
one that reads as a hang. 3 dependencies, 44M weekly installs.

### What we keep from what exists

The existing `selfhost/src` is not thrown away. The parts that matter are the
**logic**, and they are good:

- `api/telegram.mjs` — the post-then-delete write check
- `api/cloudflare.mjs` — the permission probe, D1 creation, worker deploy
- `zke.mjs` — key seeding that reads before writing
- `state.mjs` — resumable state, mode 0600
- `schema/schema.mjs` — one schema for both provisioners

Only `ui.mjs` is replaced, and the command files are rewritten to call Clack
instead of it. This is a re-skin plus a distribution change, not a rewrite.

---

## Delivery

**Entry point:** `npm create daemonclient@latest`

Verified available on npm: `create-daemonclient`, `daemonclient-setup`,
`daemonclient-installer`, and `daemonclient` itself. **`daemonclient` stays
reserved for the Drive CLI** — the separate product for automating Drive from a
terminal, which is not what this is.

**Why `npm create` over `curl … | sh`:**

- Node is already a hard requirement — the installer builds the worker bundle.
  A curl script would spend most of its length detecting and installing Node,
  and would be a second thing to maintain and sign.
- `npm create` is a pattern users already recognise from `npm create vite`,
  `npm create astro`, and everything else in that family.
- Piping a remote script into a shell is the exact habit security people ask
  people to break. A project whose pitch is "your data, your infrastructure"
  should not open with it.

A `curl -fsSL https://get.daemonclient.uz | sh` shim can exist later as a
convenience that checks for Node and then calls `npm create`. It is not the
primary path, and it is not needed for the product to be finished.

**Website integration:** `daemonclient.uz` shows the one line with a copy
button. That is the whole of the landing page's job in this flow.

---

## Open spikes

Neither is planned as certain, because neither is verified.

| Spike | Question | Fallback if it fails |
|---|---|---|
| **Cloudflare pre-scoped token link** | The dashboard supports token templates, but the URL parameters that pre-select permissions are undocumented. Does a link land on the token screen with Workers Scripts · Edit, D1 · Edit and Account Settings · Read already ticked? | The current behaviour — a plain link and an exact list of three permissions. |
| **Firebase email provider** | Enabling Email/Password has no CLI command. Can we call the Identity Toolkit Admin API with a token derived from what `firebase login` already stores, without adding a `gcloud` dependency? | Automate the other four steps; leave one toggle on one console page. |

Both are checked with a real browser and a real account before the phase that
depends on them is planned in detail.
