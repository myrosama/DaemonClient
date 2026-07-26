# Scratchpad — current status

**This file is the resume point.** After a context reset, read this first, then
`MASTER_PLAN.md`, then the phase document you are in. Updated after every task.

---

## Right now

**State:** IMPLEMENTING, autonomously. The operator granted full autonomy on
2026-07-27: implement everything, self-test, self-audit, pass the gates without
asking, and only reach out when finished or on something extreme.

**Last updated:** 2026-07-27, ~00:50.

**Uploads from the mobile app are confirmed working by the operator** — that
closes Gate 4 for tasks 1.1 and 1.2.

### Live issue being chased: auto-backup shows "finished" instead of uploading
See `FINDINGS.md` §19. Established: background backup is gated on sync
succeeding (`background_worker.service.dart:112,132`), and "finished" means
remainder 0 in `backup.repository.dart` — every local checksum matched a remote
row. Empty album selection is already surfaced by the page, so that is ruled
out. **Operator reports sync succeeds**, so the sync gate is probably not it.
Going further needs a device log. Phase 3 is the actionable part and is being
done.

### Shipped today (all deployed to deployment-service + immich-api + dc-ozkv3fuz)

| Task | What | Commit |
|---|---|---|
| 1.1 | Encryption fails closed — refuse rather than store plaintext | `0b07a5a` |
| — | Gate 3 (independent) FAILED it: backfills were permanently retiring healable rows. Fixed. | `4756a23` |
| — | Gate 2 found the error message told hosted users to run a CLI they do not have | `49bfc4c` |
| 1.2 | `zke-status` reports three states, not two | `af01af4` |
| — | **Encryption toggle deleted** (operator's call; it could also destroy the key on a transient read) | `df039cd` |
| 3.3 + 3.0 | Stop the isolate accumulating 19 MB copies and an unbounded path cache | `f677cc0` |
| 3.7 | A cached Telegram path can no longer outlive its validity; dead paths self-heal | `229cc08` |
| 4.6a | Attach a HEIC processor, **proving** it belongs to this user | `2b15066` |
| 2.1 + 2.2 | Delete the SQL injection route; allowlist columns so the class is closed | `5d57cde` |
| 2.4 | **The owner gate** — one install, one owner, enforced inside `requireAuth` so every route is covered by construction | `825db6c` |
| 1.2b | Single schema module `schema/schema.mjs` (landed early; a commit referenced it before it was tracked) | `825db6c`, fix in the next commit |

236 tests, 29 files, all green. Shim went `1533a4952213` → `c34620fed144`.

### In flight (subagents)
- Phase 1 tasks 1.2b + 1.3 — unify the schema source, seed real ZKE keys in the
  self-host CLI. **This is the other half of 1.1**: until it lands, a
  self-hosted install cannot upload at all, because the worker now refuses.
- Browser audit of photos.daemonclient.uz.

### Next
- **2.0 is now optional.** With 2.4's gate in `requireAuth`, per-row owner
  filters are defence in depth. Twenty-seven call sites, and a wrong uid at any
  of them reads as "all my photos vanished" — do it deliberately or not at all.
- 2.5 / 2.6 / 2.7 — sessions. 2.6 is still gated on confirming every hosted
  worker has a `SESSION_SECRET`; `wrangler secret list --name <worker>` works,
  but enumerating the fleet needs an API token with more scope than the
  wrangler OAuth session carries (D1 query returned 7403).
- The HEIC onboarding **UI**: the worker endpoint is done and verified
  (`POST /api/server/processor`); what is missing is the portal step for hosted
  and the `daemonclient processor` command for self-host. A Vercel deploy-button
  URL needs no OAuth and no server, so this stays zero-cost.
- Phase 4 (the CLI), Phase 6 (docs + Starlight site).

### A trap that cost time twice
A fix aimed at code that is never executed passes every gate. It happened to
tasks 1.3/1.4 (dead `deploy.mjs`) and again to 1.2 (a field no client reads).
**Grep the consumers before touching an endpoint, and make one test drive the
real path** — several tests here now exist purely to fail if a fix is wired to
nothing.

---

## The document set

| File | What it is |
|---|---|
| `MASTER_PLAN.md` | the phased plan of record — 6 phases, 46 tasks |
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

Worker shim went `1533a4952213` → **`34ccd3fa9a39`**.

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
| Compact-proof restart kit | `c04ccea` |
| **Open relay closed, bot token out of the logs** | `0311248` |

## Known-good vs stale in `selfhost/`

| File | State |
|---|---|
| `src/config.mjs` | **NEW, correct.** Config at `~/.config/daemonclient/config.env`, 0600. |
| `src/api/cloudflare.mjs` | **NEW, correct.** wrangler-OAuth + REST, serialised, scrubbed child env. |
| `src/ui.mjs` | Good. Zero-dependency terminal UI. |
| `src/api/telegram.mjs` | Good. Verifies posting, not just membership. |
| `src/commands/setup.mjs` | **STALE** — calls functions that no longer exist. Task 4.3 rewrites it. |
| `src/state.mjs`, `src/env.mjs` | **DEAD** — superseded by `config.mjs`. Task 4.1 deletes them. |
| `src/deploy.mjs` | **DEAD — zero importers.** Verified. `build.mjs` is the live path (`setup.mjs:23`, `update.mjs:17`). Two plan tasks were aimed here and would have shipped nothing. Task 4.1 deletes it. |
| `src/build.mjs` | **LIVE.** Partly stale against the new Cloudflare layer. |
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

## Decisions — settled 2026-07-26. No open questions.

1. **Session TTL 30 days both flavours, with silent refresh on both.** Self-host
   gets a refresh path instead of a longer expiry → **new Task 2.7**, gated
   after 2.5 and 2.6 and reviewed together with them.
2. **Attic = separate private archive repo**, not a branch. One public repo, one
   branch, one thing for the history scrub to rewrite.
3. **Docs site = Astro Starlight.** Cloudflare's docs are Astro with a *bespoke*
   theme (checked their package.json — no Starlight), so copying them means
   owning a theme forever. Starlight gives the same shape prebuilt.
4. **Task 5.1: operator creates throwaway accounts, I drive the run.** Delete
   those accounts when the phase ends — part of the task.
5. **Self-host never auto-applies updates.** No deploy token inside a worker.
