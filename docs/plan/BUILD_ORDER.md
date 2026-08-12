# Build order — the parts, and how they wire together

The phases in `MASTER_PLAN.md` are organised around *problems to fix*. This file
is organised around *parts to build*: each one has a contract, is testable on
its own, and is only wired into `install.sh` once it stands up alone.

Read `PRODUCT_SPEC.md` for what the finished thing does.

---

## The shape

```
  install.sh                        shell, zero dependencies
  ├── P1  platform + prerequisites
  ├── P2  local Node
  ├── P3  source fetch
  └── P4  hand-over ──────────────▶ the installer            node + deps
                                    ├── P5   UI kit
                                    ├── P6   state store
                                    │
                                    │   ── steps, in wizard order ──
                                    ├── P7   Telegram
                                    ├── P8   Cloudflare
                                    ├── P9   Firebase
                                    ├── P10  account
                                    │
                                    │   ── the work ──
                                    ├── P11  worker build + deploy
                                    ├── P12  encryption keys
                                    ├── P13  web apps
                                    ├── P14  health check
                                    │
                                    └── P15  wizard orchestration
```

**Build order is not wizard order.** P5 and P6 come first because everything
else uses them. P15 is last because it is the thing that composes the rest.

## Reuse, honestly

Most of the logic exists. What is missing is packaging, verification depth, and
an interface. Marked per part:

| | |
|---|---|
| **reuse** | exists and is good; wire it up |
| **harden** | exists but has a named gap to close |
| **new** | does not exist |

---

## P1 · Platform and prerequisites — `install.sh` **new**

**Contract:** exits 0 having proven the machine can proceed, or exits non-zero
with one actionable sentence.

- Detect `linux|darwin` × `x64|arm64`. Anything else: name it and stop.
- Require `git` (the update path needs it later). Missing → print the one
  install command for that platform.
- Require `curl` or `wget`, and `tar`.

**Test standalone:** run in a container with each prerequisite removed in turn;
assert the message names the missing thing and the exit code is non-zero.

## P2 · Local Node — `install.sh` **new**

**Contract:** a `node` ≥18 exists on `PATH` for the rest of the script, without
touching anything system-wide.

- If `node --version` ≥18 already, use it and say so.
- Otherwise fetch the LTS tarball for the detected platform into
  `~/.daemonclient/node`, **verify against `SHASUMS256.txt`**, extract, prepend
  to `PATH` for this process only.

*Verified 2026-08-11: the dist index, per-release `SHASUMS256.txt`, and tarballs
for all four platform pairs are fetchable. Current LTS is v24 (Krypton).*

**Test standalone:** container with no node → asserts a working node afterwards;
container with node 16 → asserts it is bypassed, not used; corrupt the tarball
→ asserts the checksum fails and nothing is extracted.

## P3 · Source fetch — `install.sh` **new**

**Contract:** the repository at the latest **release tag** in
`~/.daemonclient/src`.

`git clone --depth 1 --branch <tag>`. Never `main` — two people running the
command on the same day must get the same bytes.

**Blocked on Phase 1.** There are no releases, so there is nothing to pin to.
This is the ordering dependency that makes the release work load-bearing for
*installation*, not just updates.

**Test standalone:** clone into a temp dir; assert the checked-out tag matches
the latest release and the tree is complete enough to build.

## P4 · Hand-over — `install.sh` **new**

**Contract:** `npm ci` in the installer package, then `exec` the installer.

Everything after this line is JavaScript with its dependencies present — which
is what makes P5 possible at all.

**Test standalone:** the two together, in a clean container, from `curl` to the
installer's first prompt.

---

## P5 · UI kit — **new** (replaces `ui.mjs`)

**Contract:** one module every other part imports for anything it shows a human.

`@clack/prompts` for questions and framing, `listr2` for the multi-minute
deploy. Wraps them so the rest of the code never imports either directly — one
place to change if the choice turns out wrong.

Must provide: `intro`/`outro`, `text`, `password`, `confirm`, `select`,
`spinner`, `note`, `taskList`, and a single `onCancel` that turns Ctrl-C at any
prompt into a clean exit with resume instructions.

Replaces 299 lines of hand-rolled ANSI in `ui.mjs`.

**Test standalone:** a demo script exercising every widget, run by eye once and
then snapshot-tested for non-TTY output (CI has no terminal).

## P6 · State store — `state.mjs` **harden**

**Contract:** resumable progress, mode 0600, and secrets that must never
persist genuinely never persisting.

Exists and is good: `loadState`, `saveState`, `markDone`, `isDone`, `redact`,
`checkStatePermissions`, `SECRET_KEYS`.

**The gap to close:** `PRODUCT_SPEC.md` §4 says the account password never
touches disk. `SECRET_KEYS` currently governs *redaction in output*; it needs to
also govern *what is allowed to be written at all*, with a test that writes a
password-bearing state object and asserts the file on disk does not contain it.

**Test standalone:** already has tests; add the write-rejection one above.

## P7 · Telegram — `api/telegram.mjs` **harden**

**Contract:** `(botToken) → {username}` and `(botToken, chatId) → {title, canPost}`,
each throwing a message a human can act on.

Exists: `getMe`, `verifyChannelAccess`, `clearWebhook`. The post-then-delete
write check is already there and is the single best thing in this codebase's
setup path — a bot can be a member and still unable to write.

**The gap:** verify it distinguishes *not an admin* from *admin without post
rights* from *chat not found*. Three different fixes for the user; one error
message today would be a wasted support round-trip.

**Test standalone:** against a real throwaway bot — this is not mockable in any
way that proves anything.

## P8 · Cloudflare — `api/cloudflare.mjs` **harden**

**Contract:** `(token) → {accountId, accountName}` verified to hold all three
required permissions; then D1 created and migrated, worker deployed, and a
reachable `*.workers.dev` URL returned.

Exists and is substantial: `verifyToken`, `REQUIRED_TOKEN_PERMISSIONS`,
`memberships`, `createD1`, `queryD1`, `deployWorker`, `getSubdomain`,
`registerSubdomain`, `enableWorkersDev`.

**Two gaps, both already found:**

- `registerSubdomain` is complete and **called nowhere**. A fresh account has no
  `workers.dev` subdomain, so setup ends with a blank API address and a cheerful
  summary. Wire it, and fail loudly if it cannot be claimed.
- `enableWorkersDev` failure is swallowed (`setup.mjs:417` `.catch(() => {})`),
  which produces the same blank-URL outcome by a second route.

**Plus the open spike:** can a link pre-select the three permissions on the
token screen? Undocumented; needs a real browser. Fallback is the current plain
link plus an exact list.

**Test standalone:** against a throwaway Cloudflare account that has never had a
subdomain — the only configuration that exercises the bug.

## P9 · Firebase — **new**

**Contract:** `() → {projectId, apiKey, authDomain, appId}` for a project that
did not exist beforehand.

`firebase login` → `projects:create` → `apps:create WEB` → `apps:sdkconfig WEB`.
All four verified to exist and be non-interactive.

Then open
`https://console.firebase.google.com/project/<id>/authentication/providers`,
say which switch to flip, and wait for Enter. **Decided, not a spike** — the
Admin API route was undocumented and saved one click.

**Must handle:** project-quota refusal (Google caps projects per account), and
`identitytoolkit.googleapis.com` not yet enabled. `web.mjs:153` already handles
that error class for Hosting; copy the pattern.

**Test standalone:** against a throwaway Google account. Also test the refusal
path by exhausting quota or mocking the error body.

## P10 · Account — **new**

**Contract:** `(email, password, apiKey) → uid`, then a sign-in round-trip that
proves it works.

Identity Toolkit `signUp`, then `signInWithPassword` to confirm. Runs **last**
among the questions, because P9 has to have finished for there to be anywhere
to create it.

**Must handle:** `OPERATION_NOT_ALLOWED` — meaning the user pressed Enter
without actually flipping the switch in P9. That is the single most likely
human error in the whole flow, and the message must say exactly that rather
than surfacing a raw API error.

**Test standalone:** against a throwaway project, both with the provider on and
deliberately off.

## P11 · Worker build and deploy — `build.mjs` + `deploy.mjs` **reuse**

**Contract:** `(repoRoot) → bundle`, then deployed with the right bindings.

Exists: `buildWorkerBundle`, `workerVars`, `deployWorker`, `buildCheck`.

**One change:** `BUILD_VERSION` comes from the tracked `VERSION` file, not the
gitignored root `package.json` and not a git SHA. This is the Phase 1 fix, and
`VERSION` + `selfhost/src/version.mjs` are already written and deliberately
unstaged waiting for it.

**Test standalone:** already covered; add one asserting a git SHA can never be
stamped as a version.

## P12 · Encryption keys — `zke.mjs` **reuse**

**Contract:** keys present after it runs, existing keys never overwritten.

Exists, reads before writing, and setup already aborts if it fails — which is
correct, because an install whose key state is unknown cannot upload. 82 tests
cover this area. Nothing to do but call it.

## P13 · Web apps — `web.mjs` **harden**

**Contract:** three apps built self-host and deployed to their Firebase Hosting;
`ALLOWED_ORIGINS` updated; three URLs returned.

Exists, including `assertNoOperator`, which fails the build if an operator
address survives into the bundle.

**The gap:** never verified end to end. `immich/web` is a full SvelteKit build
and the heaviest step in the whole installer. Needs a real run before it can be
claimed to work.

## P14 · Health check and the final URL — **harden**

**Contract:** poll until the worker answers, then print **one** URL — their
dashboard, not the workers.dev API address.

Exists as a 10×2s poll in `setup.mjs:471-483`. What is missing is the ending
`PRODUCT_SPEC.md` asks for: one URL that lands them signed in, not three URLs
and an explanation.

## P15 · Wizard orchestration — **new** (rewrites `setup.mjs`)

**Contract:** the linear flow from `PRODUCT_SPEC.md`, calling P7 → P8 → P9 →
P10 → P11 → P12 → P13 → P14, resumable at every boundary via P6, rendered
through P5.

Written **last**, when every part it calls already works alone. This is the
inversion of how the current `setup.mjs` grew, and it is why it is 627 lines
with the logic and the presentation interleaved.

---

## Wiring order

Each row is shippable and leaves the tree working.

| Step | Parts | Proves |
|---|---|---|
| 1 | P11 version fix | a release can be cut and an updated install still sees the next one |
| 2 | *cut the first release* | P3 has something to pin to |
| 3 | P5, P6 | the interface and the state layer stand alone |
| 4 | P7, P8 | credentials verify against real services, on a fresh account |
| 5 | P9, P10 | a Google project appears from nothing and an account signs in |
| 6 | P15 | the wizard runs end to end from a clone |
| 7 | P1–P4 | `install.sh` reaches step 6 on a machine with nothing on it |
| 8 | P13, P14 | one URL, signed in, Photos and Drive working |

Step 8 is the product. Everything before it is a part that can be demonstrated
on its own, which is the point — no step depends on a part that has not already
been shown to work.

## Gates

Per `GATES.md`. Proportionality for this work:

- **P1–P4** touch nobody's credentials but run on a stranger's machine as the
  first thing they do. Full gates.
- **P7–P10** handle live credentials. Full gates, and Gate 2 means a throwaway
  account, not a mock.
- **P5, P14** are presentation. Light gates.
- **P11, P12** touch encryption and versioning. Full gates.
