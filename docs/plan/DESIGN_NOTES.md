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
