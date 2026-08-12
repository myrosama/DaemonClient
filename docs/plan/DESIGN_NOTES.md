# Design notes

One section per task: the decisions made, deviations from the plan, security
findings fixed, and the gate evidence. This is where reasoning is reconstructed
from after a context reset — do not re-derive it, read it.

Append, never rewrite. A note that turns out to be wrong gets a correction
underneath it, not a silent edit, because *why we believed the wrong thing* is
usually the more useful record.

**Format:**

```
## <phase>.<task> — <title>            <date>

**Planned:** what the phase document said.
**Did:** what actually happened, and any deviation with its reason.
**Decisions:** anything chosen at implementation time that the plan left open.
**Security:** findings raised, fixed, or accepted-and-tracked.
**Gate evidence:** G1 test name · G2 transcript · G3 reviewers and findings · G4 commit.
```

---

## 0.0 — Investigation before planning            2026-08-11

**Planned:** nothing; this preceded the plan.

**Did:** read the self-host path end to end rather than planning from the
existing notes, per the operating manual's "plan from the spec, never from
memory". Recorded because two of the findings contradict documents that were
believed accurate.

**Findings, each with the grep that produced it:**

| Finding | Evidence | Status |
|---|---|---|
| `daemonclient password` is documented twice and does not exist | `bin/daemonclient.mjs:9` lists 7 commands; `SELF_HOSTING.md:129,306` | → Phase 0 |
| The documented account model (local DB) is wrong; auth is Firebase | `selfhost-auth.ts` header, `auth.ts handleLogin` | → Phase 0 |
| `setup` stamps `BUILD_VERSION` from the **gitignored** root `package.json` | `setup.mjs:412` → `readVersion` → `0.0.0` on any fresh clone | → Phase 1 |
| `update` stamps a git short SHA, which the comparator cannot use | `update.mjs:133`; `isNewerVersion` regex `/^(\d+)…/` | → Phase 1 |
| `registerSubdomain` is exported and called nowhere | `cloudflare.mjs:254`; grep for callers returns only the export | → Phase 2 |
| `enableWorkersDev` failure is silently swallowed | `setup.mjs:417` `.catch(() => {})` | → Phase 2 |

**Corrections to earlier beliefs.** Two things previously written down turned
out to be false, and are recorded here so they are not re-derived:

- `docs/REPO_MAP.md` (now in the private repo) said self-host migration errors
  are "regex-swallowed". They are not: `setup.mjs:262-272` swallows only
  `already exists` and `duplicate column` and exits 1 on anything else. The
  audit's P0 about swallowed migration failures is about
  `deployment-service`, the **managed** provisioner — not this path.
- The same document said self-host "never registers" a `workers.dev`
  subdomain. Half true: the function to do it exists and is complete; it is
  simply never called. That is a smaller fix than a missing capability.

**The measurement that decided Phase 1's priority.** Running the real
`isNewerVersion` against realistic values:

```
release tag = v2.1.0
  BUILD_VERSION=0.0.0     banner: TRUE    fresh setup (accidentally correct)
  BUILD_VERSION=a1b2c3d   banner: FALSE   after update — regex rejects a leading letter
  BUILD_VERSION=3e2db37   banner: FALSE   after update — parses as major version 3
```

So the first time anyone runs `daemonclient update`, their install stops
reporting updates permanently. This is why Phase 1 is the update path and not
something more visible.

**Gate evidence:** investigation only, no gates. No code changed.

---

## 0.4 — Planning and status files            2026-08-11

**Planned:** stand up the documents the operating manual requires.

**Did:** `EXECUTION_STATUS.md` (root), `docs/plan/{MASTER_PLAN,PHASE_0,GATES,QUESTIONS,DESIGN_NOTES}.md`.

**Decisions:**
- Status file at the repo root, not in `docs/plan/`. It is the first thing a
  cold agent must find; burying it three directories down defeats its purpose.
- Planning documents are public. Reasoning in `PHASE_0.md` §0.4; raised as Q5
  in case the operator disagrees.
- A test baseline table lives in `EXECUTION_STATUS.md` so a silently-skipped
  suite shows up as a number that went down.

**Security:** none applicable — no product code.

**Gate evidence:** G1 n/a (no code) · G2 n/a, stated rather than claimed ·
G3 pending · G4 pending.

---

## 0.6 — Operator answers, and what they changed            2026-08-11

**Planned:** get five questions answered.

**Did:** all five answered. Two changed the plan; one was a question I should
not have asked.

**Decisions:**

- **Q1 reframed the phase entirely.** The answer was not "keep Firebase" or
  "drop Firebase" — it was *"keep Firebase, and the script creates the project
  for them."* Clicking through the Firebase console is not an acceptable setup
  step. Phase 4 was rewritten from "resolve a fork" to "provision their project
  end to end", which is more work and better work.

  Verified before planning it, per the manual: `firebase projects:create`,
  `apps:create WEB` and `apps:sdkconfig WEB` all exist. Enabling the
  Email/Password provider does **not** — `firebase auth` offers only
  `auth:export` / `auth:import`. That step needs the Identity Toolkit Admin API
  and a `cloud-platform`-scoped OAuth token, and whether we can get one from the
  credentials `firebase login` already stores is unproven. So Phase 4 opens with
  a spike rather than a plan built on an assumption.

- **Q4 was a bad question.** The operator called it dumb and was right: version
  numbering has an obvious default and I spent their attention on it. The manual
  is explicit — *"escalate genuine forks; decide everything else yourself"*.
  Decided `v2.1.0`, continuing the existing tag rather than inventing a third
  scheme next to it and `WORKER_VERSION`.

  The lesson is recorded rather than just the outcome: a question is only worth
  asking if a wrong answer costs a rewrite. A version number does not.

- **Q3 removes documentation rather than correcting it.** Family accounts are
  out of scope, so `SELF_HOSTING.md:305-306` gets deleted. Correcting it would
  still imply the model exists.

**Restated constraint** the whole plan is now checked against, in the operator's
words: *"self-hosting means self-hosting — in no way tied to our central system.
The only thing that touches us is the update check."*

**Security:** none — no product code changed.

**Gate evidence:** G1 n/a · G2 n/a · G3 pending · G4 this commit.

---

## P11 — BUILD_VERSION from a tracked file            2026-08-11

**Planned:** `BUILD_ORDER.md` P11 — stamp `BUILD_VERSION` from the tracked
`VERSION` file instead of the gitignored root `package.json` (setup) and the
git short SHA (update). Add a test asserting a SHA can never be stamped.

**Did:** Gate 1 complete. Gates 2 and 3 **not** complete — see below.

- `VERSION` (root, `2.1.0`), `selfhost/src/version.mjs` with
  `readVersion` / `buildVersion`.
- `setup.mjs` — deleted the local `readVersion` that read the root
  `package.json`; imports `buildVersion`.
- `update.mjs` — stops stamping `head`. It still *prints* `head`, because
  "which source did I build from" and "which release am I on" are different
  questions and the user wants both.
- `selfhost/test/version.test.mjs` — 9 tests. 68 → 77.

**Decisions:**
- The test duplicates the worker's `isNewerVersion` verbatim rather than
  importing it. The point is to fail if the CLI's stamp and the *worker's*
  parser ever stop agreeing, and the worker is TypeScript that cannot be
  imported here without a build step.
- Fallback is `0.0.0`, never a SHA. `0.0.0` is older than every release so a
  bad read over-notifies; a SHA never notifies at all. Only one of those is
  recoverable by the user.

**Two things found by checking rather than assuming:**

1. **My own test was wrong.** `VERSION is tracked by git` asserted only that
   the file exists and that no `^VERSION$` line appears in `.gitignore`.
   Neither proves tracked — and it passed while `VERSION` was untracked, which
   is the same class of mistake as the bug it guards. Now uses
   `git ls-files --error-unmatch` and `git check-ignore`. It currently fails,
   correctly, because `VERSION` is not committed yet.

2. **A third `BUILD_VERSION` writer exists**: `selfhost/src/deploy.mjs:32`,
   `workerVars`. It is **dead** — `deploy.mjs` and `env.mjs` both have zero
   importers, confirmed by grep. So the fix is complete for every live path,
   but the dead files should be deleted: they make future greps lie, which is
   how this project has repeatedly ended up fixing code that never runs.
   **Tracked as a follow-up, not silently dropped.**

**Gate evidence:**
- **G1 PASS.** New tests failed before the change (2 failures on the wiring
  assertions), pass after. Suite 77/77 with `VERSION` staged; 76/77 while it is
  not, by design.
- **G2 PARTIAL, and stated rather than claimed.** No staging install exists
  (Phase 3 builds one), so the binding has not been observed on a real worker.
  What *was* verified live: `buildVersion()` returns `2.1.0`, and against the
  real comparator `v2.2.0`→banner, `v2.1.0`→no banner, `v2.0.0`→no banner.
- **G3 NOT RUN.** Both review agents — security and spec-conformance — were
  terminated by an API session limit before producing findings. **P11 is
  therefore uncommitted.** Nothing ships without an independent review.

**Next action:** re-run both Gate 3 agents. If they pass, commit `VERSION`,
`version.mjs`, the test and the two rewires together, then cut `v2.1.0` as the
first real release (wiring step 2), which unblocks `install.sh` pinning a tag.
