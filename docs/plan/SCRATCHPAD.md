# Scratchpad — current status

**This file is the resume point.** After a context reset, read this first, then
`MASTER_PLAN.md`, then the phase document you are in. Updated after every task.

---

## Right now

**State:** PLANNING COMPLETE, awaiting approval. **No task has been
implemented.** Implementation starts only when the operator gives the word.

**Last updated:** 2026-07-26.

**In flight:** three review agents against the master plan — security,
principles fit, and alternatives research. Their output lands in
`docs/plan/review/` and `docs/plan/ALTERNATIVES.md`. Findings get folded into
the plan before implementation.

**Next action:** fold the reviews in, present the plan, wait for approval.

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

Worker shim went `1533a4952213` → `4927d7bf9772`.

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
