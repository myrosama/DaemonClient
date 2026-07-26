# Scratchpad — current status

**This file is the resume point.** After a context reset, read this first, then
`MASTER_PLAN.md`, then the current phase file. Updated after every task.

---

## Right now

**State:** PLANNING. Nothing from the master plan has been implemented yet —
implementation is blocked on the operator approving the plan.

**Last updated:** 2026-07-26, during the planning session.

**In flight:** four planning agents (draft, security review, principles review,
alternatives research). Their output becomes `MASTER_PLAN.md`.

**Next action:** finish the plan, present it, wait for the operator's word.

---

## Already shipped this session (deployed, do not re-plan)

Worker shim went `1533a4952213` → `4927d7bf9772` across these.

| What | Commit |
|---|---|
| Mobile bugs: sync abort, deleted photos re-uploading forever, dual upload, 1102 kills, broken thumbnails | `8cfe472` |
| Self-host foundation: session signing, update checks, first CLI | `05fdfc9` |
| **Two critical auth bypasses** + open proxy closed | `b0202c4` |
| Sync regression I introduced (SELECT named columns that do not exist) | `cd21118` |
| Dashboard build guard, AGPL licence, CONTRIBUTING, SECURITY, repo cleanup | `385a743` |
| HEAD/GET agreement, orphan motions, false live-photo pairing | `61da778` |
| Corrected CLI design + config module + Cloudflare layer | `63141e1` |

## Known-good vs stale in `selfhost/`

| File | State |
|---|---|
| `src/config.mjs` | **NEW, correct.** Config at `~/.config/daemonclient/config.env`, 0600. |
| `src/api/cloudflare.mjs` | **NEW, correct.** wrangler-OAuth + REST, serialised, scrubbed child env. |
| `src/ui.mjs` | Good. Zero-dependency terminal UI. |
| `src/api/telegram.mjs` | Good. Verifies posting, not just membership. |
| `src/commands/setup.mjs` | **STALE** — still calls the old APIs. Needs the probe/repair/verify rewrite. |
| `src/state.mjs`, `src/env.mjs` | **DEAD** — superseded by `config.mjs`. Delete. |
| `src/deploy.mjs`, `src/build.mjs` | Partly stale against the new Cloudflare layer. |
| `src/commands/{status,update,processor,doctor,dashboard}.mjs` | Written, not yet reconciled with `config.mjs`. |

## Outstanding, only the operator can do

- Rotate the credentials still in git **history**: three Firebase admin private
  keys, a Telethon session for a personal Telegram account, live bot tokens.
  (Operator has confirmed the tokens are fixed; the **history scrub** is still
  needed before the repo is promoted.)
- `www.daemonclient.uz` DNS does not resolve.
- Redeploy Render for the hosted setup service (auth + double-bot fixes).
