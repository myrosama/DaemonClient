# DaemonClient — master plan

Written 2026-07-27 from an independent read of the whole repo. Organised around
the operator's three goals: **finish self-hosting**, **clean up for open-source**,
and **get ready for constant maintenance** — plus the never-ending **product
work** on Photos & Drive.

Reference docs (`REPO_MAP.md`, `API.md`, `FINDINGS.md`, `PARITY.md`, `GATES.md`)
hold the verified file:line facts; this is the plan built on top of them.

Legend:  ✅ done & committed   ▶ next   ☐ todo   ⏸ blocked (needs operator)

---

## The goal in one paragraph

A zero-cost, fully-serverless personal photo + file cloud. Each user's bytes live
in **their own Telegram channel** (19 MB AES-256-GCM chunks), with their own
**Cloudflare Worker + D1** and **Firebase** login. **Photos** is an Immich fork
(`immich/web` + `immich/mobile`); **Drive is a standalone React app** (`drive/`).
One codebase, two ways to run: **hosted** (operator provisions a worker per user)
and **self-hosted** (a stranger runs everything on their own accounts). Constraints
(non-negotiable): zero cost · Telegram-only storage · fully serverless · a
self-hosted install depends on nothing the operator runs · one storage per user ·
free-tier Worker budgets · the mobile sync stream is strict (one wrong type aborts
all sync).

## Process

Every task passes **4 gates** before commit — (1) completeness, (2) security,
(3) correctness/bugs, (4) works-for-real — reviewed by an **independent agent**,
not the implementer. **The one rule: grep the callers before changing anything.**
Live-auth/worker changes that can't be verified live are implemented + tested +
committed but **deployed only with the operator**.

## Corrections this session verified against code

The handoff's "#1 account takeover" is **contained** — the shared worker holds no
data and config reads need a real Firebase idToken that `firestore.rules` gate
(FINDINGS §23). Drive is **not** an Immich fork. `daemonclient-auth` is a live
component the map omitted. Setup already seeds encryption keys correctly.

═══════════════════════════════════════════════════════════════════════════════

## PHASE 1 — Finish self-hosting
*Goal: a stranger clones the repo, runs one script, and the whole thing runs on
their own accounts — nothing points back at the operator.*

The guided script already exists: **`daemonclient setup`**
(`selfhost/src/commands/setup.mjs`), 7 steps — machine check → Telegram bot +
channel → Cloudflare token (creates Worker + D1) → Firebase → deploy + encryption
keys → optional processor → done. Its tests pass. The gaps are the **web apps and
one real run**, not the CLI.

- ✅ **1.1** Media processor deploy fixed — Vercel (not a non-existent Render
  file), Node runtime (the libheif WASM is too heavy for Edge), `FIREBASE_PROJECT_ID`
  documented as required (it 401'd every request when blank), HEIC-only honesty,
  and a test. *(This is only the optional HEIC-thumbnail helper — small.)*
- ▶ **1.2** **Photos web app self-host independence.** Its service worker hardcodes
  `DEFAULT_WORKER_URL = https://api.daemonclient.uz`
  (`immich/web/src/service-worker/index.ts:26`), so a self-hoster's pre-login
  traffic and login hit the operator. Make it build-time configurable; default
  stays the hosted value so production is unchanged. Verify by actually building
  the web app.
- ☐ **1.3** **Drive web app self-host independence.** `drive/src/api.js:14`
  hardcodes `CENTRAL_API = immich-api.sadrikov49.workers.dev` for login. Same fix:
  build-time configurable, hosted default preserved.
- ☐ **1.4** **Web deploy for self-hosters.** One documented, scripted way to build
  Photos + Drive pointed at *their* worker, and to set `ALLOWED_ORIGINS`. Fold into
  the CLI or a short doc + env template.
- ☐ **1.5** **Real end-to-end dry run** on throwaway Telegram/Cloudflare/Firebase
  accounts: clone → `setup` → deploy → log in from web *and* mobile → upload →
  see it. This is the only real proof self-hosting works. *(Needs accounts.)*
- ⏸ **1.6** One-button **Cloudflare OAuth** for setup — blocked on the operator
  registering the OAuth app. Paste-a-token already works, so this is a nicety.

═══════════════════════════════════════════════════════════════════════════════

## PHASE 2 — Clean up for open-sourcing
*Goal: a stranger opening the repo sees a clean, honest, secret-free project.*

- ✅ **2.1** Delete dead code: `daemonclient-immich-bridge/` (mock worker),
  `local-server/`, `landing-page/`, `daemonclient-desktop/`.
- ✅ **2.2** `tsc --noEmit` clean.
- ✅ **2.3** Reconcile misleading docs (validate-cf-token is authed now;
  daemonclient-auth live; Drive not a fork; §23 takeover downgrade).
- ☐ **2.4** Remaining dead/ambiguous trees: `frontend/` (a live 301 target — needs
  a `firebase.json` change to retire), `photos/` (dir, verify), `daemon-cli/`
  (a separate Python product — keep or split out? operator call), and confirm the
  untracked `functions/` scrap stays untracked.
- ⏸ **2.5** **Secrets & forkability.** No real secrets are tracked, but the
  operator's **Firebase web key is hardcoded** across configs, so a forker would
  inherit the operator's project. Templatize it (read from env/placeholder) and
  rotate the key. Remove/sanitize `HANDOFF.md` (carries operator infra ids). Git
  history scrub. *(Operator: rotation + history scrub.)*
- ☐ **2.6** **Immich branding leaks** (audit §21.5): `<title>Login - Immich</title>`,
  the rainbow splash, upstream links (`buy.immich.app`, `discord.immich.app`, …).
- ☐ **2.7** Public-repo front matter: README/CONTRIBUTING/SECURITY/LICENSE/NOTICE
  accuracy pass (README is already good; verify claims after the above).

═══════════════════════════════════════════════════════════════════════════════

## PHASE 3 — Maintenance readiness
*Goal: security + feature updates ship continuously, and **every** user — hosted
(pushed) and self-hosted (pulls) — gets the **same** update. Fix once, both get it.*

- ☐ **3.1** **One release action.** One tagged commit → builds the worker, deploys
  the hosted fleet (deployment-service + central worker + auto-update), and
  publishes the GitHub release the self-host update-check watches. Cutting a
  release can't be something you do half of.
- ☐ **3.2** **CI proving both flavours** from one commit: run the suite with
  `SELF_HOST=1` and unset; a test that fails when a new `isSelfHost` divergence
  appears undocumented (PARITY.md says there are exactly 5).
- ☐ **3.3** **Version honesty**: both flavours report the same version from one
  source at `/api/health` and the dashboard.
- ☐ **3.4** **The open security backlog** (each its own gated task; live-auth ones
  deploy with the operator):
  - Retire the `APP_IDENTIFIER` signing fallback (FINDINGS §4) — carefully; naive
    removal breaks login on the secret-less shared worker.
  - Encrypt `sessionSecret` at rest + stop putting the Firebase refresh token in
    the session payload (§22).
  - Session epoch / revocation; bounded TTL (§5).
  - Defense-in-depth: refuse config routes when `!env.DB` (§16, Task was 2.1).
  - Move the bot token out of media URLs into a header (audit §21.1).

═══════════════════════════════════════════════════════════════════════════════

## PHASE 4 — Ongoing Photos & Drive
*Goal: the product keeps improving after self-hosting ships. Never "done".*

From FINDINGS, in impact order (each needs a live device / soak, so sequenced last):
`POST /api/sync/ack` is unimplemented (every ack a no-op) · the chunk subrequest
budget is ~3× wrong (§6) with unbounded `waitUntil` 19 MB copies (§13) · timeline
double-dispatch (§7) · download backpressure (§9) · grid thumbnails serving whole
originals (§10) · >100 MB mobile video (needs chunked upload).

═══════════════════════════════════════════════════════════════════════════════

## Where we are right now

Phase 1: 1.1 ✅, **1.2 next**. Phase 2: 2.1–2.3 ✅. Phases 3–4: not started.
Committed on branch `autonomous/selfhost-vercel-and-cleanup` (pushed). Live status
in `docs/plan/SCRATCHPAD.md`.
