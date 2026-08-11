# Open questions for the operator

Only genuine forks — choices with real trade-offs where picking wrong costs a
rewrite. Everything with an obvious default has been decided and is recorded at
the bottom rather than asked.

Answer inline (edit this file) or in chat. **Q1 and Q2 block phases; the rest do
not.**

---

## Q1 — Does self-hosting keep depending on Firebase? **(blocks Phase 4)**

**Today:** a self-hoster must create a Google Firebase project, enable
Email/Password auth, add themselves as a user, and register a web app to get the
config. Sign-in then goes through Firebase Identity Toolkit
(`immich-api-shim/src/auth.ts`, `handleLogin`).

**The tension:** the project's stated premise is *"depends on nothing we run,
and keeps working if we disappear."* Firebase satisfies that literally — it is
*their* Google account, not ours. But it is a third-party dependency on a
company that has discontinued products before, it is the fiddliest part of
setup by a distance, and "unlimited private cloud, also please create a Google
project" is a strange sentence.

| | Keep Firebase | Local accounts in D1 |
|---|---|---|
| Setup effort for the user | ~15 clicks in a console | none — `daemonclient` asks for an email and password |
| Code change | none | a real auth path: password hashing, session issuing, reset flow |
| Risk | a Google dependency | **we would be writing authentication ourselves** |
| Managed service | unaffected | now two auth implementations to keep in step |
| Mobile app | works unchanged | needs the new path too |

**My recommendation: keep Firebase for now, and revisit after Phase 3.**
Writing our own authentication is the single easiest way to introduce a serious
vulnerability into this project, and it would create the exact second
implementation that `PARITY.md` exists to prevent. The setup friction is real
but it is a documentation problem before it is an architecture problem.

If you disagree, this is worth doing *properly and early* rather than
half-done later — so say so now.

**Answer:**

---

## Q2 — Who runs the first end-to-end test, and on what accounts? **(blocks Phase 3)**

Phase 3 needs a Telegram bot, a Cloudflare account and a Firebase project that
are **not** yours, because the whole point is to reproduce a stranger's
experience. Telegram bot creation cannot be automated and should not be — doing
it for the user is exactly what the managed service does.

Options:

1. **You create three throwaway accounts** and run the setup yourself, pasting
   the transcript back. Highest fidelity; costs you maybe an hour.
2. **You create them and I drive**, with you doing only the Telegram and
   Firebase console steps when prompted. Slower for you in wall-clock but less
   thinking.
3. **We use your existing accounts.** Fastest, and it tests the wrong thing —
   your Cloudflare account already has a `workers.dev` subdomain, which is
   precisely the bug in finding #4 that a fresh account would expose.

**My recommendation: option 2.** Option 3 cannot catch the class of bug we
already know is there.

**Answer:**

---

## Q3 — Should one install support more than one person?

The docs currently claim family accounts are possible (via a command that does
not exist). The worker enforces **one install, one owner** at the
authentication chokepoint — `owner-gate.ts`, claimed by the first caller.

So the honest options are: document that it is one person per install, or open
the owner gate to a small allowlist. The second is a real security change to
the boundary that currently makes the isolation guarantee true.

**My recommendation: one person per install, documented plainly.** A second
person can run their own — that is the entire point of the architecture, and it
costs them a free Cloudflare account.

**Answer:**

---

## Q4 — Version scheme: confirm

I have decided the mechanism (a tracked `VERSION` file, read by both `setup` and
`update`, matching the git tag). What I have not decided is the **number**.

The one existing tag is `v2.0.0`, never published as a release. Options: carry
on from there with `v2.1.0`, or restart at `v0.1.0` to signal beta honestly.

**My recommendation: `v0.1.0`.** Nothing has ever been released, self-hosting is
unproven, and a `2.x` version number on software nobody has successfully
installed sets an expectation the software cannot meet. Version numbers are a
promise about stability.

**Answer:**

---

## Q5 — Do these planning documents stay public?

They are in the public repo now — see `PHASE_0.md` for the reasoning. It shows
contributors where the project is going, and everything security-sensitive
stays in the private repo by pointer.

The cost: the "what is not true yet" table is a public list of the project's
current weaknesses.

**My recommendation: keep them public.** Every item in that table is already
visible to anyone who reads the code, and publishing the plan alongside it reads
as confidence rather than exposure.

**Answer:**

---

## Decided without asking

Recorded so they are not silently re-opened.

| Decision | Why |
|---|---|
| `VERSION` file at the repo root, tracked, read by both `setup` and `update` | Root `package.json` is gitignored, so it can never be the source. One tracked file cannot drift from itself. |
| `BUILD_VERSION` falls back to `0.0.0`, never a git SHA | `0.0.0` is older than every release, so a bad read over-notifies. A SHA never notifies at all. Only one of those is recoverable by the user. |
| Planning docs in `docs/plan/`, status file at the repo root | The status file is the thing a cold agent must find first; burying it defeats the purpose. |
| Phase 0 does not build the `password` command | Whether it should exist depends on Q1. Fixing the docs is honest now regardless of the answer. |
| Security findings stay in the private repo, referenced by pointer | They describe unfixed problems on a service with live users. |
