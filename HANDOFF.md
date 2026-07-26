# DaemonClient — handoff

You are taking over a live product mid-flight. Read this whole file before
touching anything.

The previous agent's single largest failure was **planning from assumptions
instead of reading the code**. Five separate fixes were written against code
that is never executed, and two of them passed a full four-gate review. Do not
repeat that. The rule that prevents it is at the bottom, and it is the most
important line in this document.

---

## 1. Do this first — there is a live account takeover

Verify it yourself before you believe it, then fix it as task one.

The shared worker `immich-api`, serving `api.daemonclient.uz`, has **no
`SESSION_SECRET`**:

```
npx wrangler secret list --name immich-api     # returns []
```

So `sessionScope()` (`immich-api-shim/src/selfhost-auth.ts:33`) falls back to
`env.APP_IDENTIFIER`, which is `"default-daemon-client"` — committed publicly at
`immich-api-shim/wrangler.toml:9`. And `requireOwner`
(`immich-api-shim/src/owner-gate.ts:76`) returns immediately when there is no D1
binding, so the owner gate does not protect this host.

**Anyone who reads the public repo can forge a session for any uid**, then call
`GET /api/server/telegram-config` and `GET /api/server/zke-config` to take that
user's Telegram bot token and ZKE password + salt — full read and delete of
their entire library.

That host is the mobile app's default endpoint
(`immich/mobile/lib/widgets/forms/login/login_form.dart:162`) and the web
service worker's fallback.

**The naive fix breaks every login.** `handleLogin`
(`immich-api-shim/src/auth.ts:76-96`) signs with the *user's own* secret read
from Firestore, while `requireAuth` verifies with the *worker's*
`SESSION_SECRET` binding. Set a secret on the shared worker and every token it
mints stops verifying on it.

You must first decide what that worker is for — either it stops serving
authenticated routes and proxies to the per-user worker, or login is issued
per-worker. Design it, gate it, then ship it.

Worth considering as a smaller immediate mitigation: refuse
`/api/server/telegram-config` and `/api/server/zke-config` when `!env.DB`. The
shared worker has no business handing out either.

---

## 2. What the product is

A personal photo and file cloud where **each user's data lives in their own
Telegram channel**, with their own Cloudflare Worker and D1 for the API and
metadata, and Firebase for login. Files are chunked at 19 MB — Telegram's
download cap is 20 MB, so chunks are never merged — and encrypted with
AES-256-GCM. Photos is a fork of Immich (web + mobile); Drive is a standalone
React app, not a fork.

Two flavours of the **same codebase**:

- **Hosted** — the operator provisions a worker per user on their own Cloudflare
  account.
- **Self-hosted** — the user runs every piece on their own accounts.

---

## 3. The goal

1. **Finish the self-hosting feature.** A stranger clones the repo, runs one
   script, and it guides them through: Telegram bot and channel, then Cloudflare
   (OAuth or a pasted token), then Firebase, then a serverless HEIC thumbnail
   processor.
   **Study the processor options yourself.** The repo currently tells users to
   click a Render button backed by a `processor/render.yaml` that **does not
   exist**. Only Vercel is real, and Render is a container, which violates the
   serverless constraint below.
2. **Clean the repository for open-sourcing.**
3. **Make it maintainable.** Security and feature updates will be continuous, and
   **every user — hosted or self-hosted — must receive the same update.** Hosted
   is pushed to; self-hosted pulls from GitHub.
4. **Then continuing work** on Photos and Drive themselves. This does not end
   when self-hosting ships.

### Constraints. None of these are negotiable.

- **Zero cost.** Free tiers are the product, not a stopgap.
- **Telegram is the storage layer.** R2 and S3 are explicitly rejected.
- **Fully serverless.** No Docker, no VPS, no long-running process.
- **A self-hosted install depends on nothing the operator runs.** No shared
  services, no callbacks, no telemetry. It must keep working if the operator
  disappears.
- **One storage per user.** Multi-user is not being built.
- **Free-tier Workers**: 50 *external* subrequests **and** 1,000 to Cloudflare
  services, 128 MB memory, a small CPU slice — all shared with anything
  `waitUntil` spawns. Overrunning produces error 1102, which users experience as
  "sync failed".
- **The mobile app parses the sync stream in a strict Dart isolate.** One value
  of an unexpected type throws, the batch is never acked, the server replays it
  forever, and backup — which is gated on sync succeeding at five separate call
  sites — stops permanently.

---

## 4. What is live

| Piece | Deployed as |
|---|---|
| API worker | `immich-api` (shared) + one `dc-<id>` per user |
| Provisioner | `daemonclient-deployment` |
| Telegram CORS relay | `daemonclient-proxy` |
| Photos | `photos.daemonclient.uz` ← `immich/web/` |
| Drive | `drive.daemonclient.uz` ← `drive/` |
| Accounts / setup | `accounts.daemonclient.uz` ← `accounts-portal/` |
| Marketing | `daemonclient.uz` ← `daemonclient-site/` |
| Mobile | **not released** |
| Self-host CLI | `selfhost/` — not published |

Production is healthy: 1485 photos, all encrypted, no missing checksums,
`owner_uid` correctly set.

---

## 5. Read these before planning anything

They are **facts with file:line citations, not plans**. The previous agent's
plans were deleted because they were wrong. These survived because re-deriving
them costs roughly four agent-hours, and they document precisely the trap you
would otherwise fall into.

| File | What it is |
|---|---|
| `docs/REPO_MAP.md` | what exists, what actually executes, what is dead — **read first** |
| `docs/API.md` | every endpoint, its callers, its auth, the sync contract |
| `docs/FINDINGS.md` | 22 verified findings, several still open |
| `docs/GATES.md` | the gate definitions |
| `docs/PARITY.md` | hosted and self-hosted are one product |

**Re-verify anything you act on.** They were accurate when written; code moves.

### Things in there that will save you days

- **The mobile app is eight changed files.** It is stock Immich pointed at the
  worker. So "fix the mobile app" almost always means "fix the worker's API".
- `POST /api/sync/ack` is **not implemented** — it falls through to a catch-all
  stub returning `{}`. Every ack the client sends is a no-op.
- `frontend/` is a deployed hosting target whose every path 301s to Drive. Dead.
- `selfhost/src/deploy.mjs`, `selfhost/src/env.mjs` and most of
  `selfhost/src/config.mjs` have zero importers.
- There are three independent Telegram upload implementations, six download
  implementations and four copies of the crypto — two of them byte-identical
  files. This is why "fix once, both flavours get it" is currently hard.

---

## 6. The process

**Three documents, and only three.**

1. **The master plan** — every phase, complete, top to bottom.
2. **The current phase document** — one phase only. Plan the entire phase before
   starting any of its tasks, and review it again when the phase ends. It holds
   a large, concise, unambiguous plan for each task in that phase.
3. **A scratchpad** — rewritten after every single task, describing the current
   state exactly as it is.

Also maintain **memory files**, so nothing is lost to a context reset.

**Write the plan first. It passes all four gates before any implementation
begins. Nothing advances until the gates are finished.** Then work task by task.
Each task passes all four gates. Only then commit and push.

### The four gates

1. **Implementation completeness** — what was this task supposed to do, what
   actually happened, and is anything left undone or half-done?
2. **Security review.**
3. **Test against natural conditions** — real usage, not only unit tests.
4. **Bug check.**

Run each gate with a **separate agent**. Do not review your own work. The
previous agent did, and passed things that were wrong.

### The one rule above all

> **Before implementing anything, grep for its callers and write down who calls
> it.** If nothing calls it, fixing it changes nothing and no test will tell you.

---

## 7. Access

Credentials are **not** in this file — it lives in a public repository. They are
in a local file outside git:

```
/tmp/claude-1000/-home-sadrikov49-Desktop-Daemonclient-DaemonClient/0a7e7ae0-d233-41d5-9033-70316619371b/scratchpad/cf.env
```

`source` it to get `CF_ACCOUNT_ID` and `CF_API_TOKEN`. That token is full-access
and has been shared in a chat transcript — **the operator should rotate it**, and
the R2 keys shared alongside it, which are not used by anything (R2 is rejected).

Everything else you need:

- **Firebase** — project `daemonclient-c0625`, via the Firebase MCP tools. Per-user
  worker config lives at
  `artifacts/default-daemon-client/users/{uid}/config/cloudflare`.
- **Chrome**, for browser testing:
  `/home/sadrikov49/.cache/puppeteer/chrome/linux-131.0.6778.204/chrome-linux64/chrome`
- **GitHub** — `myrosama/DaemonClient`, public, push works.
- **D1** — query directly over the REST API with the Cloudflare token. The
  operator's own database is `277c6a64-2078-4c12-9dc6-d41db83f784d`.

### Deploying a worker change is four steps

Miss one and you ship nothing:

```bash
cd immich-api-shim && npx wrangler deploy --dry-run --outdir dist
node deployment-service/scripts/embed-shim.mjs
cd deployment-service && npx wrangler deploy
cd ../immich-api-shim && npx wrangler deploy
```

Then grep the regenerated `deployment-service/src/shim-bundle.ts` to confirm your
change actually reached the artifact every hosted worker runs.

**Wait about 30 seconds before verifying anything live.** Deploys propagate, and
a too-fast check produced a false result three separate times.

The operator's own worker `dc-ozkv3fuz` cannot auto-update and needs a direct
deploy with a temporary config carrying its D1 binding
(`database_id 277c6a64-2078-4c12-9dc6-d41db83f784d`, account
`364fb59aa7c95374fece6ace0e10c5bd`). Delete that config afterwards, and confirm
`SESSION_SECRET` survived with `wrangler secret list --name dc-ozkv3fuz`.

---

## 8. Outstanding — only the operator can do these

- **Scrub the git history.** Firebase admin private keys and live bot tokens are
  still retrievable from the public repository's history. Rotation is the real
  fix; the scrub is cleanup. Neither is done.
- **Rotate** the Cloudflare API token and the R2 keys shared in chat.
- `www.daemonclient.uz` does not resolve.
- Create throwaway accounts when the end-to-end self-host run needs them.
