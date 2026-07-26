# The four gates

Every task in `MASTER_PLAN.md` passes all four before it is deployed or
committed. A gate that fails sends the task back to implementation — not to a
"we'll fix it later" list, because that list is where security work goes to die.

Gates run **in order**. A task that fails gate 1 is not worth reviewing for
style.

Each gate is run by a separate agent with only that gate's brief, so a reviewer
looking for security holes is not simultaneously wondering whether the tests
pass. The implementer does not review their own work.

---

## Gate 1 — Security

**Question:** does this change introduce, weaken, or fail to protect anything?

- [ ] Does it touch authentication, session handling, or the trust boundary
      between a user's worker and anything else? If yes, it needs a test that
      would **fail** if the protection were removed.
- [ ] Can any secret reach a log, an error message, a process argument (visible
      in `ps`), a bug report, or git? Trace each one from where it enters to
      where it rests.
- [ ] Does it cross a user boundary? Every query touching per-user data needs an
      owner filter — this project has shipped unfiltered ones before.
- [ ] Does it widen what an endpoint accepts or returns? What does the widest
      possible input do?
- [ ] Is any new input interpolated into SQL, a shell command, a URL, or HTML?
      Identifiers as well as values — `savePhoto` was injectable through column
      **names**, not parameters.
- [ ] Does it fail **closed**? When a dependency is missing or a check cannot be
      performed, does it refuse, or does it quietly continue in a weaker mode?
      The plaintext-photo bug was exactly this.
- [ ] If it half-completes, is the resulting state safe?
- [ ] Would a malicious contributor find anything exploitable here once the repo
      is public?

**Evidence required:** the specific test that proves the protection holds, or a
written argument for why no test is possible.

---

## Gate 2 — Principles fit

**Question:** does this belong in this project, built this way?

- [ ] **P1 Security first** — was security a design input, or something bolted on?
- [ ] **P2 Open source** — does this make the repo more approachable to a
      contributor, or add operator-specific baggage?
- [ ] **P3 Self-hosted independence** — does a self-hosted install now depend on
      anything the operator runs? Check for default URLs, shared OAuth apps,
      callbacks, telemetry. **This is the one most easily broken by accident.**
- [ ] **P4 Serverless** — no container, no long-running process, scales to zero.
- [ ] **P5 Free** — works on the real free tiers, at plausible library sizes,
      against the worker's actual budgets.
- [ ] **P6 Telegram storage** — no drift toward object storage.
- [ ] **Parity** (`PARITY.md`) — does this add a sixth way hosted and
      self-hosted differ? Would this fix reach both kinds of user? Does it
      remove or repurpose a field an older client depends on?
- [ ] **Simplest thing** — is this a second implementation of something that
      already exists? Reusing the hosted path always beats writing a
      self-host-specific one.

**Evidence required:** for anything that adds a divergence between the two
flavours, a written justification. Otherwise, a plain confirmation.

**This gate exists because of two rejected pieces of work:** a Docker container
that broke P4, and a bespoke auth system that duplicated something working.
Both were built before being questioned.

---

## Gate 3 — Correctness

**Question:** what does this do wrong?

Run by an agent whose only brief is to find bugs. It should assume the code is
wrong and try to prove it.

- [ ] Every edge case in the task's **How** is handled.
- [ ] Empty, null, zero, one, and very large inputs.
- [ ] Concurrency: two of these at once, on the same asset, on the same account.
      What if one fails halfway?
- [ ] Errors: does every failure path leave things consistent? Is any error
      swallowed?
- [ ] Resource use: memory and subrequests against the real limits, not the
      assumed ones — the chunk budget was wrong by 3x because nobody counted.
- [ ] **Does it break something else?** Especially the mobile sync contract:
      one unexpected value aborts all sync permanently, so any change to what
      the stream emits needs a test.
- [ ] Does the change do what the task said, and nothing more?

**Evidence required:** a list of what was examined and what was found. "Looks
fine" is not a result.

---

## Gate 4 — Works for real

**Question:** do we know it works, or do we merely believe it?

- [ ] `npx tsc --noEmit` clean.
- [ ] `npx vitest run` — the whole suite, not just the new file.
- [ ] `cd selfhost && npm test` when the CLI changed.
- [ ] The task's own **Verify** step passes, as written.
- [ ] The new test **fails without the change**. Confirm it, do not assume it.
- [ ] Verified against something live where possible: a real request to a real
      worker, a real run of the command.
- [ ] For worker changes: deployed, then `/api/health` and one real user-facing
      operation checked.

**Evidence required:** the actual command output. Not a description of it.

---

## After all four pass

1. Deploy (worker changes: the four-step shim pipeline, then the affected worker).
2. Commit, with a message saying what was wrong and how we know it is fixed.
3. Update `SCRATCHPAD.md`: what changed, what is next.
4. Tick the task off in its phase document.

## When a gate fails

Fix it and re-run **that gate and every gate after it**. A correctness fix can
introduce a security problem; a security fix can break the tests.

If the same task fails twice on the same gate, stop and reconsider the task
rather than patching it a third time — the plan may be wrong, not the code.
