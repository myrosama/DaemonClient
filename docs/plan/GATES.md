# The four gates

Every task passes all four. They are not a checklist to perform — each catches a
different class of mistake, and blurring two of them means one of those classes
stops being caught.

**Run each gate as a separate agent.** Never review your own work: the previous
agent on this project did, and passed things that were wrong. Two of the fixes
that passed a full review were made to code that is never executed.

---

## Gate 1 — Implement, test first

Write the **failing test first**. It pins the contract before the implementation
has a chance to define it by accident.

- The test names the failure a user would report, not the function under test.
  `stamps a semver so an updated install still sees the next release` beats
  `test buildVersion`.
- Assert invariants, not coincidences. If a value depends on timing, the
  network, or shared state, assert the relationship, never a literal.
- Cover the edges deliberately: zero state, empty input, the exact boundary,
  hostile input. A brand-new install returns `0`, never `null` or `NaN`.
- **Leave the work unstaged** so Gate 3 sees exactly what changed.

Exit: the new test fails before the change and passes after; the whole suite is
green; typecheck is clean.

## Gate 2 — Natural conditions

Deploy it and exercise it for real. Real auth, real database, real HTTP.

A unit test proves the logic. This proves it is **wired and deployed**. The
distinction is not academic here — `importKey('spki')` with trailing bytes
passes on Node and fails on workerd, and that shipped once with 18 green tests
behind it.

For self-hosting, "real" means the Phase 3 staging install on throwaway
accounts, not the operator's own. Until that exists, a task whose Gate 2 cannot
be run says so in its design note rather than claiming a pass.

Exit: a transcript or command output showing the behaviour on real
infrastructure, pasted into the design note.

## Gate 3 — Independent review

Two reviews, **separate agents, neither of which wrote the code**:

- **Security.** Fail-closed behaviour, authentication and ownership, anything
  user-scoped reached without an owner filter, secrets in logs or state files,
  and every input classified by trust level. Hostile client input must never
  throw; malformed *config* must throw loudly.
- **Spec conformance.** Does it do what the phase document said, completely? Is
  anything half-done? Does it add a sixth way hosted and self-hosted diverge?

Then **verify every fix personally**. Never take a reviewer's or a sub-agent's
word that something is done — re-read the diff and re-run the test.

Findings: HIGH and MEDIUM are fixed before shipping. A LOW that will not be
fixed now is **accepted in writing and tracked to the task that will fix it**.
Never silently dropped.

## Gate 4 — Ship

- **Inspect the staged index before committing.** `git commit` takes the whole
  index, and sub-agents and past-you leave stray staged work. This already
  happened once this project: a file written by another session was swept into
  a commit and had to be pulled back out.
- Commit code and documentation separately.
- No AI attribution trailers. This is a standing instruction.
- Push, confirm CI is green, confirm the deploy, then report faithfully — the
  output if it failed, the plain statement if it passed.

## Proportional rigor

Match effort to blast radius. A one-line comment fix does not need three review
agents; a change to `requireAuth` or the chunking path needs all of them and
then some. Rigor spent where it is not needed is rigor unavailable where it is.

The things that always get the full treatment, regardless of diff size:

- anything touching `requireAuth`, session signing, or the owner gate
- anything that widens what `/proxy` will fetch
- anything `sync.ts` emits
- anything in the chunk / encrypt / manifest path
- anything that could make a self-hosted build contact an operator host

## Checkpoint between gates

The operator asked to be checkpointed. Momentum is good; a commit they did not
expect is not.
