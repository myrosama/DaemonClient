# Scratchpad — current status

**This file is the resume point.** After a context reset, read this first, then
`MASTER_PLAN.md`, then the phase document you are in. Updated after every task.

---

## Right now

**State:** PLANNING COMPLETE. All three reviews are in and folded in. **Waiting
on the operator's approval to start implementation.** Two things shipped early
because they were live problems, not plan items.

**Last updated:** 2026-07-26, ~22:00.

**The security review returned `reject`** — and it was right. Ten blockers, all
folded into `MASTER_PLAN.md`; see "The security review returned reject" at the
bottom of that file. The four that mattered:
1. Tasks 1.3 and 1.4 edited `selfhost/src/deploy.mjs`, which **nothing imports**
   (verified). Both would have passed all four gates and changed nothing on a
   real install. Re-targeted at `setup.mjs` / `update.mjs` / `build.mjs`.
2. Task 2.5 would have given an **unauthenticated** caller a global sign-out
   switch — `handleLogout` is routed before any auth check. Reworked.
3. Task 2.6 deleted the verifier's fallback and left the issuer's
   (`auth.ts:96`). Both now go together.
4. **Photos has no ownership check on any single-asset path**, and `albums` has
   no owner column. Now Task 2.0 — but **demoted** by the operator's scope call
   below, since its severity assumed multi-user.

**Scope set by the operator, 2026-07-26: one storage per user.** Multi-user is
not being built for either flavour; it may be reconsidered later. Consequences,
already folded in: Task 2.0 keeps the cheap half (accessor signatures) and drops
the albums backfill; **Task 2.4's owner gate becomes the whole boundary**, so it
must be enforced in the router across every authenticated route rather than per
handler.

**Next action:** present the corrected plan for approval. Nothing else starts
until then.

### Shipped early — Task 3.4 (shim `ea08d9704ab2`, commit `1af4daa`)
The timeline fired two background jobs per request whose budgets sum to 64
against a cap of 50; sync had already been fixed the same way. Now rotates one
per request. All four gates passed, tests fail without the change, deployed to
the deployment service, the central worker, and `dc-ozkv3fuz`, verified live.

**This was one of the causes of the 1102s, not the only one.** The 19 MB
per-chunk copies queued in `waitUntil` (Task 3.3) are still there and are
probably the dominant term. Expect 1102s to continue, less often.

The "chunk budget is wrong by 3x" line that used to sit here was **wrong**, and
the alternatives review caught it: the body cache already short-circuits a warm
chunk (`assets.ts:2131-2134`, shipped April), and D1 was never on the
50-subrequest budget in the first place. See Task 3.2, which is now mostly
"do not do this".

### Shipped early — two live vulnerabilities (shim `34ccd3fa9a39`, commit `0311248`)
Found by the security review, exploitable while the plan was being written, so
not deferred. Both through the four gates, both verified live.

- **`daemonclient-proxy` was a fully open proxy** — any url, any caller, no
  auth, the caller's Cookie and Authorization forwarded on, every response
  header reflected with `ACAO: *`. The shim's `/proxy` was closed back in
  `b0202c4`; this is a separate deployment and was missed. Both now require the
  exact host `api.telegram.org`. The shim's `.telegram.org` **suffix** rule was
  itself too loose — `аpi.telegram.org` with a Cyrillic "а" normalises to the
  real subdomain `xn--pi-6kc.telegram.org` — and had **no test at all**.
- **The bot token was logged in full** on every Telegram 429
  (`url.substring(0, 80)` over `.../bot<TOKEN>/method`).

Two more the review found are **planned, not patched**: `/api/drive/config`
(finding 16 → Task 2.4) and the missing asset ownership checks (finding 17 →
Task 2.0). Neither is exploitable on hosted today. With multi-user ruled out,
the owner gate closes both; finding 17 is now defence behind it, not the fix.
Reasoning in `FINDINGS.md`.

### Update channel — designed, not built (Tasks 5.5, 5.6)
Researched on the operator's ask. Two things found in the code:
- **There is no Cron Trigger anywhere in this repo.**
- **The hosted fleet updates from one place only** —
  `accounts-portal/src/App.jsx:1744`, fired when someone loads the *accounts
  portal*. Not Photos login. Most users never return there, which is why
  `dc-ozkv3fuz` stalled through daily logins.

Design: 5.5 puts the hosted fleet walk on a daily cron using the **master
token** (all provisioned workers are on the operator's account; the per-user
OAuth refresh tokens are what kept failing). 5.6 gives each self-hosted install
a cron on **its own** worker plus a notification through **its own** Telegram
bot. `update-check.ts` was already the right shape — anonymous GitHub poll,
cached in their D1, no telemetry — it just had no alarm clock and no audience.

**Declined:** a worker of ours that tells self-hosters to update. It would need
to know where they are, i.e. a registry of self-hosted installs — telemetry to
collect, a target to hold, and a P3 violation. GitHub is already the tunnel.

**Deploy note:** `dc-ozkv3fuz` kept its `SESSION_SECRET` across the direct
wrangler deploy — confirmed with `wrangler secret list --name dc-ozkv3fuz`.
Worth re-checking after any future direct deploy, because losing it silently
re-arms the public-constant signing fallback for that worker.

---

## The document set

| File | What it is |
|---|---|
| `MASTER_PLAN.md` | the phased plan of record — 6 phases, 45 tasks |
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

## Open questions for the operator

1. Session TTL after Task 2.5 — self-host has no refresh path, so a short TTL
   means frequent logins there. Thirty days, or longer for self-host only?
2. Task 6.5 attic branch — a branch in this repo, or a separate archive repo?
3. Docs site generator — preference, or shall I pick for lowest maintenance?
4. Task 5.1 throwaway accounts — will you create them, or should I script the
   run for you to execute?
5. **Does a self-hosted install ever apply an update by itself?** (Task 5.6.)
   Recommendation: **no** — notify through their own bot, apply with
   `daemonclient update`. Auto-applying means storing a deploy-capable
   Cloudflare token *inside* their worker, so a worker compromise becomes a
   Cloudflare account compromise. Cost of saying no: a lazy self-hoster can sit
   on a vulnerable install forever and we cannot know, by design.
