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

**No dependencies — for now.** Today this runs from a bare clone with nothing
installed: plain `.mjs`, Node 18+, standard library only, and CI fails the build
if a dependency appears.

That rule has an expiry date. The planned entry point is a `curl` of
`install.sh`, which runs `npm ci` before any of our code executes — so the
constraint it protects against ("a stranger has only git and node") stops being
the starting position, and the interface work in `BUILD_ORDER.md` P5 depends on
lifting it. Until `install.sh` exists, the rule stands and the CI guard stays.

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
| `src/ui.mjs` | prompts and output |

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
npm test    # node --test, 98 tests
```

They cover schema replay (a broken replay made `update` fail on every install
that had already been set up — i.e. all of them), the no-operator-host guard,
key seeding, and the Cloudflare API surface.
