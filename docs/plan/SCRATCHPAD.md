# Scratchpad — current status

**This file is the resume point.** After a context reset, read this first, then
`MASTER_PLAN.md`, then the phase document you are in. Updated after every task.

---

## Right now

**State:** PLANNING COMPLETE, awaiting approval on the rest. **One task has
shipped** — Task 3.4, released early because the operator was actively hitting
error 1102. Everything else waits for the word.

**Last updated:** 2026-07-26, ~21:15.

**In flight:** two review agents — security, and alternatives research. The
**principles review has landed and is folded in** (see the bottom of
`MASTER_PLAN.md` for what it changed; the headline is that Task 2.3 was reversed
because it would have broken the web media path and re-armed the Phase 1
plaintext bug from the client side).

**Next action:** fold in the remaining two reviews as they land, then present
for approval.

### Task 3.4 — DONE (shim `ea08d9704ab2`, commit `1af4daa`)
The timeline fired two background jobs per request whose budgets sum to 64
against a cap of 50; sync had already been fixed the same way. Now rotates one
per request. All four gates passed, tests fail without the change, deployed to
the deployment service, the central worker, and `dc-ozkv3fuz`, verified live.
Tick it in `PHASE_3.md`.

**This is one of three causes of the 1102s.** The other two — the 19 MB
per-chunk copies queued in `waitUntil`, and the chunk budget being wrong by 3x —
are Tasks 3.2 and 3.3 and are NOT yet fixed. Expect 1102s to continue, less
often.

---

## The document set

| File | What it is |
|---|---|
| `MASTER_PLAN.md` | the phased plan of record — 6 phases, 31 tasks |
| `PHASE_1.md` … `PHASE_6.md` | working docs: gate checklist per task, notes as you go |
| `GATES.md` | the four gates every task passes before commit |
| `FINDINGS.md` | the verified backlog — every item confirmed at file:line |
| `PARITY.md` | hosted and self-hosted are one product; fix once, both get it |
| `ALTERNATIVES.md` | research into other ways to build each piece |
| `review/` | the security and principles reviews of the plan |
| `../roadmap/SELFHOST_CLI_DESIGN.md` | authoritative CLI design, verified against real tools |

## The plan in one screen

| Phase | Goal | Why there |
|---|---|---|
| 1 | Stop storing photos in plaintext | silent, irreversible, happening now |
| 2 | Close account-takeover paths | exploitable today |
| 3 | Survive the free-tier budget | the crashes users actually see |
| 4 | Finish the self-hosting CLI | the worker must be right first |
| 5 | Prove it end to end | everything it exercises must exist |
| 6 | Documentation + docs site | documenting a moving target wastes the writing |

## Already shipped this session (deployed — do not re-plan)

Worker shim went `1533a4952213` → `ea08d9704ab2`.

| What | Commit |
|---|---|
| Mobile bugs: sync abort, deleted photos re-uploading forever, dual upload, 1102 kills, broken thumbnails | `8cfe472` |
| Self-host foundation: session signing, update checks, first CLI | `05fdfc9` |
| **Two critical auth bypasses** + open proxy closed | `b0202c4` |
| A sync regression I introduced (SELECT named columns that do not exist) | `cd21118` |
| Dashboard build guard, AGPL licence, CONTRIBUTING, SECURITY, repo cleanup | `385a743` |
| HEAD/GET agreement, orphan motions, false live-photo pairing | `61da778` |
| Corrected CLI design + config module + Cloudflare layer | `63141e1` |
| Doc set organised | `889a606` |
| Master plan, four gates, phase docs | `d9b4369` |
| Principles review folded in | `504dc50` |
| **Task 3.4** — timeline one job per request | `1af4daa` |

## Known-good vs stale in `selfhost/`

| File | State |
|---|---|
| `src/config.mjs` | **NEW, correct.** Config at `~/.config/daemonclient/config.env`, 0600. |
| `src/api/cloudflare.mjs` | **NEW, correct.** wrangler-OAuth + REST, serialised, scrubbed child env. |
| `src/ui.mjs` | Good. Zero-dependency terminal UI. |
| `src/api/telegram.mjs` | Good. Verifies posting, not just membership. |
| `src/commands/setup.mjs` | **STALE** — calls functions that no longer exist. Task 4.3 rewrites it. |
| `src/state.mjs`, `src/env.mjs` | **DEAD** — superseded by `config.mjs`. Task 4.1 deletes them. |
| `src/deploy.mjs`, `src/build.mjs` | Partly stale against the new Cloudflare layer. |
| `src/commands/{status,update,processor,doctor,dashboard}.mjs` | Written, not yet reconciled with `config.mjs`. |

## Outstanding — only the operator can do these

- **Rotate the credentials still in git history** (operator has confirmed the
  tokens themselves are fixed; the **history scrub** is still outstanding before
  the repo is promoted): three Firebase admin private keys, a Telethon session
  for a personal Telegram account, live bot tokens.
- Confirm every hosted worker has been redeployed with a per-install
  `SESSION_SECRET` — **Task 2.6 is gated on this**, and deleting the fallback
  early would lock users out.
- `www.daemonclient.uz` DNS does not resolve.
- Redeploy Render for the hosted setup service (auth + double-bot fixes).

## Open questions for the operator

1. Session TTL after Task 2.5 — self-host has no refresh path, so a short TTL
   means frequent logins there. Thirty days, or longer for self-host only?
2. Task 6.5 attic branch — a branch in this repo, or a separate archive repo?
3. Docs site generator — preference, or shall I pick for lowest maintenance?
4. Task 5.1 throwaway accounts — will you create them, or should I script the
   run for you to execute?
