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

**My recommendation was:** keep Firebase for now, revisit after Phase 3.

**ANSWERED — 2026-08-11.** Keep Firebase, but **the script creates the project
for them.** The user signs in to their own Google account (`firebase login`,
OAuth in their browser, nothing reaches us) and the CLI provisions everything
from there. Clicking through the Firebase console is not an acceptable setup
step.

Restated principle from the same answer: *"self-hosting means self-hosting —
in no way tied to our central system. The only thing that touches us is the
update check."* The Firebase project must be theirs, under their Google
account, created by them via our script.

### What that requires, and what is verified

Checked against `firebase-tools` on 2026-08-11:

| Step | Command | Verified |
|---|---|---|
| Sign in to their Google account | `firebase login` | ✅ already required by `daemonclient web` |
| Create the project | `firebase projects:create <id>` | ✅ exists |
| Register a web app | `firebase apps:create WEB "<name>"` | ✅ exists |
| Read the SDK config (apiKey, authDomain…) | `firebase apps:sdkconfig WEB <appId>` | ✅ exists |
| **Enable the Email/Password provider** | — | ❌ **no CLI command exists** |
| Create the first user | Identity Toolkit `signUp` REST | ⚠️ fails with `OPERATION_NOT_ALLOWED` until the step above is done |

`firebase auth` offers only `auth:export` and `auth:import`. Enabling the
provider means calling the Identity Toolkit Admin API directly:

```
PATCH https://identitytoolkit.googleapis.com/admin/v2/projects/{project}/config
{ "signIn": { "email": { "enabled": true, "passwordRequired": true } } }
```

which needs a Google OAuth access token with the `cloud-platform` scope. Whether
we can obtain one from the credentials `firebase login` already stores — without
adding a `gcloud` dependency — is **unproven**. Phase 4 opens with a spike to
settle it.

Two other risks worth knowing before the phase starts:

- **Project quota.** A Google account can create a limited number of projects
  (commonly ~12–30, and brand-new accounts are sometimes restricted pending
  billing verification). `projects:create` can fail for reasons we cannot fix,
  so the flow must degrade to "here is the one console page to open" rather
  than dead-end.
- **API enablement.** `identitytoolkit.googleapis.com` may need enabling on a
  fresh project before the call above works. `web.mjs:153` already handles this
  class of error for Hosting, so there is a pattern to copy.

**If the spike fails**, the fallback is: automate the four steps that work, and
reduce the manual part from "register a project, register an app, copy eight
config values, enable a provider, add a user" to **one toggle in one console
page**. That is still a large improvement and it is the floor, not the target.

**Answer: keep Firebase; automate project creation. Phase 4 rewritten.**

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

**ANSWERED — 2026-08-11: option 2.** The operator will help with testing.
Phase 3 is unblocked; it needs scheduling, not a decision. They create the
throwaway Telegram, Cloudflare and Firebase accounts and do the console steps
when prompted; I drive the rest and keep the transcript.

---

## Q3 — Should one install support more than one person?

The docs currently claim family accounts are possible (via a command that does
not exist). The worker enforces **one install, one owner** at the
authentication chokepoint — `owner-gate.ts`, claimed by the first caller.

So the honest options are: document that it is one person per install, or open
the owner gate to a small allowlist. The second is a real security change to
the boundary that currently makes the isolation guarantee true.

**My recommendation: one person per install, documented plainly.**

**ANSWERED — 2026-08-11: one person per install.** In the operator's words,
*"it's not meant for family (yet) — every user will host an independent
system."* The owner gate stays exactly as it is.

Consequence for Phase 0: `docs/SELF_HOSTING.md:305-306` currently invites the
reader to *"add family accounts that way if you want them"*, via a command that
does not exist, describing a model we are not building. That paragraph gets
removed, not corrected.

---

## Q4 — Version scheme: confirm

I have decided the mechanism (a tracked `VERSION` file, read by both `setup` and
`update`, matching the git tag). What I have not decided is the **number**.

The one existing tag is `v2.0.0`, never published as a release. Options: carry
on from there with `v2.1.0`, or restart at `v0.1.0` to signal beta honestly.

**WITHDRAWN — 2026-08-11.** The operator called this a dumb question, and they
are right: it has an obvious default and I should have taken it rather than
spending their attention. Recorded here only so the reasoning is not
re-derived.

**Decided: `v2.1.0`.** It continues the existing `v2.0.0` tag rather than
inventing a third numbering scheme alongside it and `WORKER_VERSION` (1.2.0),
and it avoids a published version that sorts *below* a tag already in the
repository. Beta status is communicated by the README badge and by
`docs/ROADMAP.md`, which is where it belongs — a version number is a poor place
to put a caveat.

---

## Q5 — Do these planning documents stay public?

They are in the public repo now — see `PHASE_0.md` for the reasoning. It shows
contributors where the project is going, and everything security-sensitive
stays in the private repo by pointer.

The cost: the "what is not true yet" table is a public list of the project's
current weaknesses.

**My recommendation: keep them public.**

**ANSWERED — 2026-08-11: public.** Confirmed.

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
