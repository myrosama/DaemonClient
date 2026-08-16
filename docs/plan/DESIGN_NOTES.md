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

---

## P8 — claim a workers.dev subdomain            2026-08-16

**Planned:** wire `registerSubdomain`, stop `enableWorkersDev` swallowing its
failure, and make "a green summary with a blank address" impossible.

**Did:** shipped, then largely rewritten after Gate 3. The first version passed
93 tests and was broken in two ways neither the tests nor I caught.

**Gate 3 findings, both blocking, neither caught by a green suite:**

1. **The retry loop never ran.** It keyed on Cloudflare code `10035`, which is
   *"multiple attempts to modify a resource at the same time"* — concurrency.
   A name collision is `10031`. So on the exact case the feature existed for,
   the check was false, `ensureSubdomain` rethrew on the first candidate, and
   setup exited. The candidate list was decoration.

   **And the test manufactured a 10035 error**, so the suite was green
   *because the test agreed with the mistake*. This is the second time in three
   parts that a test was written to confirm the implementation rather than
   challenge it — the P11 review found the same shape. The lesson is not "write
   more tests", it is: **when a test and the code agree about an external
   system, at least one of them has to have checked that system.** Codes now
   come from wrangler's source.

2. **The suggested hostname leaked an email address.** It was derived from the
   Cloudflare account name, whose personal-signup default is
   `<your email>'s Account`, so `contact@boboxon.uz's Account` became
   `contact-boboxon-uz-s-account-bd1920.workers.dev` — permanent, public DNS,
   Certificate Transparency logs, on a privacy product, and `doctor` prints the
   URL in a report labelled safe to share. Now a neutral random label, and
   setup **prompts** before claiming: this is account-wide, public and
   effectively one-shot, and the worker name already gets a prompt for less.

**And my own fix had made one case worse.** The resume path
(`isDone(state,'cloudflare')`) returned early without checking whether the
install had an address, so a pre-fix state file skipped the new code entirely —
and since the commit had deleted the "(no workers.dev subdomain)" message, the
summary printed the literal word `null` under a panel reading "Your cloud is
live". Strictly worse than what it replaced, for exactly the users it was meant
to rescue. Fixed with an in-place repair.

**Same class, found in four more commands:** `dashboard.mjs` built with an empty
`VITE_API_BASE`, deployed it, and printed "Dashboard is live" for a page that
could never reach an API; `doctor`/`status`/`update` fetched `null/api/health`
and reported "API not responding" with a fix that could not work.

**A claim of mine that was false.** I told the operator "nothing of ours is in
the install path". The accounts portal was shipping
`curl -fsL https://daemonclient.uz/install.sh | bash` to real users — our
domain, and a 404. True of the plan docs, not of the product.

**And the last thing setup printed was wrong in the dangerous direction.**
`stepFinish` told users the state file "holds your tokens and encryption key".
It does not — the keys are `zke_password`/`zke_salt` in their own D1. As the
final message of the install it is the one people act on, so anyone who backed
up that file believed they were covered and was not. Caught by an external
read-only analysis the operator supplied
(`~/Desktop/findings/daemonclient-analysis-2026-08-16.md`), which also
correctly flagged the now-stale "No dependencies. Ever." rule.

**Decisions:**
- `subdomain.mjs` is its own module because four lines inline in an interactive
  wizard step cannot be tested — which is precisely how `registerSubdomain`
  came to exist, be correct, and be called from nowhere for months.
- `LEGAL` now matches Cloudflare's real rule (max 63, no leading or trailing
  dash). The old one permitted a trailing dash and capped at 55, and the test
  asserting it was byte-identical to the implementation — proving the function
  agreed with itself.

**Security:** HIGH-1 (dead retry) and HIGH-2 (PII in a public hostname) fixed
before push. MEDIUM-3 (message-text matching swallowing real failures) fixed.
MEDIUM-5 (misleading "Deploy failed" for a routing problem) fixed, with retries
for propagation. LOW-6/7/8 fixed or recorded.

**Gate evidence:** G1 — new tests failed first, 82 → 98 · G2 **not run**, no
staging install exists (Phase 3), stated rather than claimed · G3 — two
independent agents, findings above, every fix verified personally · G4 —
`c8f6ee8` + `3d434de`, pushed, CI green.

**Still open, carried into P7/P9:** the installer prints the plain Cloudflare
token URL rather than the pre-scoped one already fixed in the portal; the
permission list says four in code and three in docs; `verifyToken` never probes
`/workers/subdomain`, so a token lacking it now fails late and hard instead of
at validation.
