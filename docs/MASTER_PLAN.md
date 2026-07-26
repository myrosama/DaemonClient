# DaemonClient — master plan

Written 2026-07-27, from an independent read of the whole repository (not from the
previous agent's plan, which was deleted). Where this cites a file:line it was
checked against the code. The reference docs `REPO_MAP.md`, `API.md`,
`FINDINGS.md`, `PARITY.md`, `GATES.md` are kept because their core claims were
re-verified this session — **with the corrections in "What the handoff got wrong"
below.**

---

## The goal, in one paragraph

DaemonClient is a zero-cost, fully-serverless personal photo + file cloud. Each
user's bytes live in **their own Telegram channel** (19 MB AES-256-GCM chunks),
with their own **Cloudflare Worker + D1** as the API and metadata store, and
**Firebase** for login. **Photos** is an Immich fork (`immich/web`,
`immich/mobile`); **Drive is a standalone React app** (`drive/`), not a fork. One
codebase runs two ways — **hosted** (operator provisions a `dc-<id>` worker per
user) and **self-hosted** (a stranger runs every piece on their own accounts).

Four objectives, in order:
1. **Finish self-hosting** — one guided script: Telegram → Cloudflare → Firebase →
   HEIC processor. The processor is **Vercel** (serverless, free); Render is
   wrong (a container, and its `render.yaml` does not exist).
2. **Clean the repo for open-sourcing.**
3. **Make it maintainable** — one release, and every user (hosted *pushed*,
   self-hosted *pulls*) gets the **same** update.
4. **Then keep improving Photos and Drive.**

### Non-negotiable constraints (from the operator)
Zero cost · Telegram is the only storage (no R2/S3) · fully serverless (no Docker,
no VPS) · a self-hosted install depends on **nothing** the operator runs · one
storage per user (no multi-user) · free-tier Worker budgets (50 external + 1000
CF subrequests, 128 MB, small CPU) · the mobile sync stream is strict — one
wrong-typed value aborts all sync permanently, and backup is gated on sync.

---

## What the handoff got wrong (verified against code this session)

- **The "#1 live account-takeover" is largely a false alarm.** A session forged
  with the public `APP_IDENTIFIER` is accepted by the shared `immich-api` worker
  (no `SESSION_SECRET`; no `env.DB` so the owner gate is a no-op). But that worker
  **holds no data** — every config read is `firestoreGet`, which needs a *real*
  Firebase idToken, and `firestore.rules` enforce `request.auth.uid == userId`.
  A forged token's idToken is fake → Firestore 401 → `telegram-config` and
  `zke-config` return **nulls, not secrets**. Per-user `dc-*` workers carry their
  own `SESSION_SECRET` + the owner gate. So there is no live secret leak. The real
  residual issue is the latent **signing fallback** (FINDINGS §4), addressed in
  Phase 2 — carefully, because `immich-api` has no secret and a naive removal
  breaks login verification.
- **Drive is not an Immich fork.** It is a standalone React+Vite app.
- **`daemonclient-auth`** (from `auth-worker/`) is a **6th live component** the
  REPO_MAP omits — a cross-subdomain session broker for the marketing pages.
- **Setup already seeds encryption keys** (`ensureEncryptionKeys`, imports the
  shared schema) — FINDINGS §1's core is fixed; the fail-closed and status honesty
  parts are in place. The plaintext trap is closed for new installs.

---

## The process (unchanged from the operator's design)

Three living documents: this **master plan**; a **current-phase document**; a
**scratchpad** (`docs/plan/SCRATCHPAD.md`) rewritten after every task. Plus memory
files against context resets.

**Each task passes four gates before it is committed.** An **independent reviewer**
(a separate agent, adversarial, not the implementer) runs them — consolidated into
two parallel briefs per task for efficiency, covering all four concerns:
1. **Implementation completeness** — did it do the whole job; anything half-done,
   any key/secret/config it needs but does not have?
2. **Security** — does it introduce, weaken, or fail to protect anything? Fail
   closed? Cross a user boundary? Any secret reaching a log/URL/error?
3. **Correctness / bug hunt** — edge cases, empty/null/large, concurrency, the
   mobile sync contract, real free-tier budgets.
4. **Works for real** — `tsc` clean, full `vitest`, the task's Verify step, the
   new test fails without the change, and a live check where possible.

**The one rule above all: before changing anything, grep its callers and write
them down. If nothing calls it, fixing it changes nothing.**

Deploy safety: for a change to a **live worker's auth/session verification** that
cannot be fully verified live (no operator password on hand), implement + test +
commit, but **do not deploy** without operator confirmation — a broken auth deploy
locks the operator out. Low-risk changes (docs, dead-code removal, self-contained
worker logic with strong tests, non-auth routes) deploy + verify normally.

---

## Phases

### Phase 0 — Repo hygiene & open-source readiness  *(low risk, high value)*
- **0.1** Delete dead/mock code: `daemonclient-immich-bridge/` (mock worker,
  open-CORS, undeployed, zero importers) and `local-server/` (dev proxy scrap,
  zero importers). *(callers verified: only self-references.)*
- **0.2** `tsc --noEmit` clean: fix the 3 `schema-columns.test.ts` errors
  (node types / `import.meta.url`) so Gate 4's typecheck actually passes.
- **0.3** Prune misleading tracked docs and reconcile the reference docs with this
  session's corrections (Drive-not-a-fork, `daemonclient-auth`, §1 status,
  the takeover correction). Keep verified facts; delete/repair what misleads.
- **0.4** README / CONTRIBUTING / SECURITY accuracy pass for a public repo; confirm
  no tracked secrets (history scrub + key rotation stay operator-only).

#### 0.4 findings — open-sourcing readiness (secret sweep, 2026-07-27)

A tracked-repo sweep found **no real secrets** — no live bot tokens, no private
keys. What's there, and why each is an *operator* decision rather than an
overnight edit:

- The **Firebase Web API key** (`AIza…`) is hardcoded in `immich-api-shim/`,
  `deployment-service/` (wrangler.toml — the hosted config), and in dead/legacy
  trees (`frontend/`, `daemon-cli/`). Web keys are public by design, so this is
  not a breach. But two things want doing before open-sourcing: (a) the operator
  still wants this key rotated (it's in git history), and (b) a forker should not
  inherit the operator's Firebase project — configs should read the key from an
  env/placeholder, not hardcode it. Not changed here: editing the live
  `wrangler.toml` values would disturb the running deploy.
- **`HANDOFF.md`** carries the operator's Cloudflare account id and D1 database id
  (not secrets, but operator-specific infra) plus a since-corrected overstated
  finding. It should be removed or sanitized before the repo goes public. Left in
  place for the operator to decide, since they referenced it directly.

### Phase 1 — Finish self-hosting
- **1.1** Processor **Render → Vercel** across `selfhost/src/commands/setup.mjs`,
  `doctor.mjs`, `processor.mjs`, and `docs/SELF_HOSTING.md`. Point at
  `npx vercel deploy --prod`; drop the non-existent `render.yaml`.
- **1.2** Self-host **web-app independence**: the Photos service worker hardcodes
  `DEFAULT_WORKER_URL = https://api.daemonclient.uz` for pre-login traffic — a
  self-hoster's pre-login `/api/server/config` would hit the operator. Make it
  build-time configurable (P3). Verify Drive has no equivalent.
- **1.3** End-to-end self-host dry-run against a throwaway account where feasible;
  document any step that still needs the operator (OAuth app registration).

### Phase 2 — Security hardening  *(code + tests always; deploy per the safety rule)*
- **2.1** Defense-in-depth (SAFE to deploy): refuse `/api/server/telegram-config`
  and `/api/server/zke-config` when `!env.DB`. The SW only calls these on a
  per-user worker (post-login), so this breaks nothing and removes the theoretical
  shared-worker path. Test proves the shared worker returns 4xx.
- **2.2** Retire the `APP_IDENTIFIER` signing fallback (FINDINGS §4) — design a
  path that does not break login on the secret-less shared worker (give
  `immich-api` its own `SESSION_SECRET`, or stop it verifying authenticated
  routes). Flip `auth-security.test.ts` to assert rejection. **Deploy only with
  operator confirmation.**
- **2.3** Encrypt `sessionSecret` at rest in Firestore (FINDINGS §22) and stop
  putting the Firebase `refreshToken` in the session payload.
- **2.4** Session epoch / revocation (FINDINGS §5): `handleLogout(request, env)`
  bumps a `session_epoch`; bounded TTL.
- **2.5** Bot-token-in-URL for media (audit §21.1): move the token to a header
  across SW + `/proxy` + `daemonclient-proxy`. Coordinated, lower priority.

### Phase 3 — Maintainability & parity
- **3.1** One release action: one tagged commit → build worker, deploy hosted
  fleet, publish the GitHub release the self-host update-check watches.
- **3.2** CI proving both flavours from one commit; a test that fails when a new
  `isSelfHost` divergence appears undocumented.
- **3.3** Version honesty: both flavours report the same version from one source.

### Phase 4+ — Continuing Photos & Drive
From FINDINGS, in impact order: `POST /api/sync/ack` unimplemented (every ack a
no-op); the chunk subrequest budget wrong by ~3× (§6) and unbounded `waitUntil`
19 MB copies (§13); timeline double-dispatch (§7); download backpressure (§9);
grid thumbnails serving originals (§10). These need a live device soak and are
sequenced after the self-hosting/open-source work the operator prioritised.

---

## Execution order for this autonomous run

Safest-first, each fully verifiable without the operator's password and without
risking production login: **1.1 → 0.1 → 0.2 → 2.1 → 0.3**, then continue into the
rest of Phase 0/1 and design 2.2. Live-auth deploys (2.2) wait for the operator.
