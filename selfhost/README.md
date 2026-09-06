# selfhost — the self-hosting CLI

Builds and maintains a complete DaemonClient install on accounts you own.
Nothing in the resulting stack points at us.

```bash
node bin/daemonclient.mjs setup
```

User-facing documentation lives in
[../docs/SELF_HOSTING.md](../docs/SELF_HOSTING.md). This file is about the code.

## Commands

| Command | What it does |
|---|---|
| `setup` | the guided install: Telegram bot + channel, Cloudflare token, worker + D1, encryption keys, your sign-in |
| `web` | builds all three web apps against *your* worker and deploys them to your Firebase Hosting |
| `status` | what is running and whether it is healthy |
| `update` | replays migrations, rebuilds from your checkout, redeploys |
| `processor` | attach or change the optional HEIC media processor |
| `dashboard` | open the local dashboard |
| `doctor` | diagnose a broken install; every secret redacted, safe to paste into an issue |

## Two rules for this directory

**Dependencies are budgeted, not banned.** This used to run from a bare clone
with nothing installed, and CI failed the build if a dependency appeared. The
entry point is now a `curl` of `install.sh`, which runs `npm ci` before any of
our code executes, so that starting position no longer holds and the rule was
lifted for `BUILD_ORDER.md` P5.

The *risk* it guarded did not go away: every package here runs on a stranger's
machine, fetched by a command they piped into a shell, at the moment they are
pasting in a Cloudflare API token. So `test/dependencies.test.mjs` replaced it
with limits that hold the same ground — a **12-package** transitive budget,
**exact pins only** (a `^` range would break `install.sh`'s promise that two
people running the same command get the same bytes), **no install scripts**, and
a lockfile that agrees with `package.json`. Raising the budget is allowed and
has to be argued for in the commit.

Today that is **one** direct dependency, `@clack/prompts`, and six packages in
total. `listr2` was in the plan and is not used — `@clack/prompts` 1.7 covers
it, at 6 packages instead of 24.

**Nothing may point at operator infrastructure.** `test/selfhost.test.mjs`
enforces this by grepping the built output for our Cloudflare subdomain and
failing if it appears. `assertNoOperator` in `src/commands/web.mjs` does the
same for the web builds. If a self-host build ever contacts a host of ours, it
is a bug of the highest severity in this project — the promise is that the
install keeps working if we disappear.

## Layout

| File | Responsibility |
|---|---|
| `bin/daemonclient.mjs` | argument parsing, command dispatch |
| `src/commands/*.mjs` | one file per command above |
| `src/api/cloudflare.mjs` | Workers + D1 over the Cloudflare REST API |
| `src/api/telegram.mjs` | bot verification — it posts to the channel and deletes the message, because a bot can be a member and still unable to write |
| `src/build.mjs` | builds the worker bundle from `../immich-api-shim` |
| `src/bindings.mjs` | the worker's bindings — one definition, used by both `setup` and `update` |
| `src/version.mjs` | the release version stamped into `BUILD_VERSION`, read from the tracked root `VERSION` |
| `src/subdomain.mjs` | claims the account's `workers.dev` subdomain — the address the whole install is reached at. Fails loudly rather than leaving it blank |
| `src/state.mjs` | reads and writes `.daemonclient-selfhost.json` — the install's credentials, created readable only by the owner |
| `src/zke.mjs` | generates and seeds the encryption key material — into the user's D1, never into the state file |
| `src/ui-kit.mjs` | **every prompt and every message.** Wraps `@clack/prompts` — the wrapper exists because clack signals Ctrl-C by *resolving with a symbol*, and a symbol is truthy, so a direct caller would save one to disk as `null` and fail three steps later somewhere unrelated |
| `src/ui.mjs` | the previous hand-rolled ANSI. Still used by the commands `ui-kit.mjs` has not reached; P15 removes it |

## State

Everything the install needs is in `.daemonclient-selfhost.json` in the user's
clone: tokens, ids and the session secret. **Not** the encryption keys — those
live in the user's D1 (`zke_password`, `zke_salt`) and nowhere else, which is
what `doctor --show-keys` reads. It is gitignored, chmod 600, and
losing it means losing access to files already in Telegram. `doctor --show-keys`
prints the key material so it can be backed up.

Setup writes after every step, so an interrupted run resumes rather than
restarting.

## Tests

```bash
npm ci
npm test    # node --test, 174 tests
```

They cover schema replay (a broken replay made `update` fail on every install
that had already been set up — i.e. all of them), the no-operator-host guard,
key seeding, the Cloudflare API surface, and the supply-chain limits above.

Two of them are worth knowing about, because they exist for bugs the rest of
the suite structurally *could not* find:

- **`test/status-command.test.mjs` runs the real binary under a real pty.**
  `ui.mjs`'s spinner short-circuits to a no-op when `stdout.isTTY` is false, and
  `node --test` is never a TTY — so a spinner left running, which hangs the
  process forever on a real terminal, was unreachable from an ordinary test.
- **`test/ui-kit.test.mjs` drives real prompts through injected streams** and
  asserts on what came back, never on what the source says. This project has
  twice shipped a green suite that endorsed a live bug because the test was
  written to agree with the implementation.

`node scripts/ui-demo.mjs` shows every widget on one screen, including the
failure path, for the judgements a test cannot make.
