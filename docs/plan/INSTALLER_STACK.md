# How the installer is built and delivered

Research, not preference. Every number below was pulled from the npm registry
on 2026-08-11.

---

## The finding that changes the architecture

`selfhost/` has a hard rule: **no dependencies**, because it must run from a
bare `git clone` with nothing installed. That rule is the reason the current
setup output is hand-rolled ANSI escapes in `ui.mjs` (299 lines of them).

**The one-line installer removes that constraint.**

`install.sh` fetches the source and runs `npm ci` *before* the wizard starts, so
by the time any of our code executes, its dependency tree is already installed.
The no-dependency rule was solving "a stranger has only git and node" — and the
bootstrap script's whole job is to make that no longer the starting position.

This is worth stating plainly because it is easy to carry an old constraint
into a new design and conclude that a good interface is impossible here. It
isn't. It was impossible under the old distribution model.

| | Old model | New model |
|---|---|---|
| Entry | `git clone`, `npm install`, `node selfhost/bin/daemonclient.mjs setup` | one `curl` of `install.sh` **from GitHub** |
| Dependencies | forbidden | installed by the bootstrap before we run |
| Interface ceiling | hand-rolled ANSI | anything |
| Node | assumed present | installed locally if missing |

**What still has to be true:** the installer builds the worker from *source*, so
the repository is fetched either way — by the bootstrap script rather than by
the user. One command instead of three.

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

**Entry point:** the script is fetched from **GitHub**, not from us.

```
curl -fsSL https://raw.githubusercontent.com/myrosama/DaemonClient/main/install.sh | sh   # not built yet — P1-P4
```

Changed on the operator's point, and they were right. The earlier plan had this
as `https://get.daemonclient.uz`, which means **we** host and serve the script
that a stranger pipes into their shell. That is a trust hop that buys nothing:
if anything of ours were ever compromised, that file is exactly what an
attacker would want to change, and the user has no way to tell.

Fetching from the repository removes it. The script sits in public source where
it can be read before it is run, at a host the user must already trust to get
the code at all. Uglier one-liner, one fewer thing to trust.

A `get.daemonclient.uz` vanity redirect may exist later for the short version,
but GitHub stays canonical and the docs show the long form — a redirect we
control is the same trust hop wearing a nicer name.

One line, as specified. The script does everything in order and hands over to
the installer.

### What `install.sh` does

| # | Step | Detail |
|---|---|---|
| 1 | Detect platform | linux/darwin × x64/arm64. Anything else exits with a clear message rather than half-working. |
| 2 | Require `git` | Needed so `daemonclient update` can pull later. Missing → the one command to install it, per platform. |
| 3 | Node ≥18 | If a good enough Node is on `PATH`, use it. If not, fetch the official LTS tarball into `~/.daemonclient/node` — **no sudo, nothing system-wide**. Verified against `SHASUMS256.txt` from nodejs.org before extracting. |
| 4 | Fetch the source | `git clone --depth 1 --branch <latest release tag>` into `~/.daemonclient/src`. Pinned to a **release**, never `main`. |
| 5 | Install dependencies | `npm ci` inside the installer package. |
| 6 | Hand over | `exec` the installer. From here it is the wizard in `PRODUCT_SPEC.md`. |

Everything lands under `~/.daemonclient`. Uninstall is `rm -rf ~/.daemonclient`,
and the script says so.

**Verified before writing this down (2026-08-11):** the Node dist index and
per-release `SHASUMS256.txt` are fetchable, current LTS is v24 (Krypton), and
tarballs exist for the four platform pairs above. GitHub's codeload tarball
endpoint answers 200.

### Step 4 depends on Phase 1

`install.sh` pins to the latest **release tag**, and there are currently no
releases. Until Phase 1 publishes one, the installer has nothing to pin to.
That is a real ordering dependency between phases, not a detail — the release
work is load-bearing for installs, not only for updates.

### On piping a script into a shell

This was raised as a concern and the operator chose curl. Fair — it is what
users expect, and refusing it costs more in adoption than it buys in safety.
What it does mean is that the script has to earn the trust it is asking for:

- **Short and readable.** Someone should be able to `curl … | less` and
  understand the whole thing in a minute. The website says so next to the
  command.
- **No `sudo`, ever.** Nothing is installed system-wide. If the script cannot
  do something without root, it prints the command and stops.
- **Checksummed downloads.** The Node tarball is verified against the official
  `SHASUMS256.txt`, not trusted because it came over TLS.
- **Pinned, not floating.** A release tag, so two people running the same
  command on the same day get the same bytes.
- **Idempotent.** Running it twice is safe and resumes rather than restarting.

### Also published to npm

`create-daemonclient`, so `npm create daemonclient@latest` works for anyone who
already has Node and would rather not pipe a script. Same installer, second
door. `daemonclient` on npm stays reserved for the Drive CLI.

## Open spikes

### Cloudflare pre-scoped token link — mostly answered by existing code

It turns out the hosted signup flow already does this, and the installer simply
never got it. `accounts-portal/src/pages/SetupWorker.jsx:12` builds:

```
https://dash.cloudflare.com/profile/api-tokens
  ?permissionGroupKeys=[{"key":"workers_scripts","type":"edit"},
                        {"key":"d1","type":"edit"},
                        {"key":"account","type":"read"}]
  &name=DaemonClient
```

(URL-encoded in the source.) So the parameter shape is
`permissionGroupKeys` — a JSON array of `{key, type}` — plus `name`.

**Verified 2026-08-12:** Cloudflare carries the query string through its login
redirect, re-encoded into `redirect_uri`. That matters more than it sounds: a
self-hoster clicking this link will usually *not* be signed in yet, and the
pre-fill still has to survive the round trip. It does.

**Not verified:** whether the permissions actually render pre-ticked on the
token screen. That needs a signed-in session and I stopped rather than sign in
to the operator's live account. It is a ten-second check for the operator —
open the URL above while logged in and see whether the three rows are already
selected.

Evidence that it works is decent but not conclusive: it is in production and
used by real users in the hosted flow. This project has, however, repeatedly
turned up plausible code that never runs (`registerSubdomain` is complete and
called nowhere; `daemonclient password` is documented and does not exist), so
"it is written and deployed" is not the same as "it works".

**Discrepancy to resolve when wiring this into the installer:** the URL
pre-fills **three** permissions, while `REQUIRED_TOKEN_PERMISSIONS`
(`selfhost/src/api/cloudflare.mjs:33`) lists **four** — the fourth being
`Cloudflare Pages · Edit`, needed only for the optional dashboard. Either the
link gains a fourth key or the installer stops asking for Pages. Decide when
P8 is built; do not paper over it.

**Fallback if the pre-fill does not render:** the current behaviour — a plain
link plus an exact list of the permissions.

**Closed by the operator, 2026-08-11:** the Firebase email-provider spike. We
are not calling the Identity Toolkit Admin API. The script opens the console's
provider page and the user flips one switch — see `PRODUCT_SPEC.md` §3. The
API route was undocumented, fragile across `firebase-tools` versions, and would
have saved exactly one click.
