# Phase 0 — Truth

Make every claim in the documentation match the code, and stand up the files
this process needs.

**Why first.** Every later phase is planned against these documents. Planning
against a document that describes a command which does not exist produces work
that cannot fail a test, because it never runs. That has already happened four
times on this project.

**Blast radius:** documentation and planning files only. No product code
changes in this phase, which is why its gates are light.

---

## The findings this phase closes

Each was verified by reading the code on 2026-08-11, with the citation.

### 0.1 — `daemonclient password` does not exist

`docs/SELF_HOSTING.md` documents it twice:

- line 129, in the day-to-day command table: *"change your sign-in password"*
- line 306, in the FAQ: *"the only way to create one is `daemonclient password`
  with your Cloudflare token"*

`selfhost/bin/daemonclient.mjs:9` defines exactly seven commands: `setup`,
`status`, `update`, `web`, `dashboard`, `processor`, `doctor`. There is no
`password`, and no alias for one.

A self-hoster following the FAQ to add a family account runs a command that
does not exist.

### 0.2 — The account model in the docs is wrong

The same FAQ says accounts live *"only in your own database"* and that there is
*"no signup page, no password-reset email"*.

Sign-in actually goes through the user's **Firebase** project
(`immich-api-shim/src/selfhost-auth.ts` header, and `handleLogin` in `auth.ts`
calling Firebase Identity Toolkit). Accounts live in Firebase Authentication and
are added in the Firebase console. Password reset is a Firebase feature that
may well be available.

This is worse than 0.1: it is not a missing command, it is a wrong mental model
of where the user's identity lives.

### 0.3 — Stale claims elsewhere

Sweep the rest of the self-hosting documentation for the same class of problem.
Known candidates, to be verified one by one rather than assumed:

- `docs/SELF_HOSTING.md:63` — "It exists only in your own database."
- Any command in the docs-site (`docs-site/index.html`) command table.
- `CONTRIBUTING.md` — references `daemonclient status` and `daemonclient doctor`
  for bug reports; both exist, so this is expected to pass.
- `README.md` — the self-hosting quickstart.

### 0.4 — Planning and status files

`EXECUTION_STATUS.md`, `docs/plan/MASTER_PLAN.md`, `docs/plan/GATES.md`, this
file, `docs/plan/QUESTIONS.md`, `docs/plan/DESIGN_NOTES.md`.

**Placement decision, made rather than asked:** these live in the **public**
repo. They are product planning, and an open-source project benefits from a
visible roadmap. Anything referencing unfixed security findings stays in the
private repo and is referenced by pointer only — never summarised inline.

---

## Tasks

| # | Task | Gate weight |
|---|---|---|
| 0.1 | Correct or remove every reference to `daemonclient password` | light |
| 0.2 | Rewrite the account-model section and FAQ to describe Firebase accurately, including how a self-hoster actually adds a second account today | light |
| 0.3 | Sweep every other self-hosting doc claim against the code; fix what is wrong | light |
| 0.4 | Land the planning and status files | light |

**Deliberately not in this phase:** *building* the `password` command. Whether
it should exist at all depends on Q1 (Firebase vs local accounts), so building
it now risks building the wrong thing. Phase 0 makes the docs honest about what
exists today; Phase 4 decides what should exist.

## Gates for this phase

Documentation-only, so:

- **Gate 1** — no failing test to write. Instead: for every command or behaviour
  the docs mention, grep the code for it and record the result. That grep *is*
  the test, and it goes in the design note.
- **Gate 2** — not applicable; nothing is deployed. Say so rather than claiming
  a pass.
- **Gate 3** — one review agent, spec-conformance only: does any claim in the
  documentation still lack a corresponding line of code? Security review is not
  proportionate here.
- **Gate 4** — normal. Docs commit, separate from anything else.

## Done when

A grep for every command name and behaviour promised in `README.md`,
`docs/SELF_HOSTING.md`, `docs/ARCHITECTURE.md` and `docs-site/index.html`
returns a real implementation for each one — and the result of that grep is
written into `DESIGN_NOTES.md`, so the next phase can trust the documents it is
planned against.
