# The Self-Hosting Pivot — Design & Readiness Plan

*Written 2026-07-21. Status: PLANNING — hardening phase shipped first (see "What already got fixed").*

The pivot: DaemonClient goes from one centralized signup service to **two first-class ways to run it**:

1. **Managed** (what exists today) — regular people sign up at accounts.daemonclient.uz, we automate the Telegram bot/channel creation, provision their Cloudflare worker + D1, run the shared conveniences. Zero-knowledge stays as-is.
2. **Self-hosted** (new) — power users clone the public repo, run **one script**, and stand up the ENTIRE stack on **their own accounts**: their Telegram bot + channel, their Cloudflare worker + D1, their choice of HEIC processor host (Render / Vercel / Cloud Run / none), optionally their own Firebase project. Nothing of theirs ever touches our infrastructure.

Both flavors run the same code. Self-hosting is a feature, not a fork.

---

## 1. What already got fixed (pre-pivot hardening, shipped 2026-07-21)

| Item | Status |
|---|---|
| Double bot creation during setup | **Fixed** — resumable checkpointed creation, transactional lock, background-threaded `/startSetup` (202), client auto-resume + lock-aware guards. Needs **Render redeploy** to activate the server half. |
| Live photos never uploading (mobile) | **Fixed + deployed** (shim `1533a4952213`) — early-dedup was media-kind-blind; the still's first upload matched its own motion video's row and was dropped. Libraries self-heal on next backup pass. |
| HEIC "fix manually every time" | **Fixed + deployed** (shim `f31490e744a2`) — lazy HEIC thumbnail backfill rides sync/timeline, self-wakes the Render converter, heals every missed thumb automatically. |
| Setup endpoints unauthenticated (`/startSetup`, `/finalizeTransfer`, `/addPhotosBot`) | **Fixed in repo** — Firebase-token auth, uid from token, CORS allowlist. Needs **Render redeploy**. |
| `/addPhotosBot` channel-hijack (attacker bot admin into victim channel by uid) | Same fix as above. |
| Firestore `/global` writable by any signed-in user (announcement phishing) | **Fixed + rules deployed** — client writes denied. |
| Firebase Admin private key tracked in the PUBLIC repo | **Untracked + gitignored.** Still in git history → **owner must revoke the key** (see §6). |
| auth-worker reflected any Origin with credentials | **Fixed + deployed** — origin allowlist; now also on `auth.daemonclient.uz` (carrier-proof). |
| Landing "Get started" ignores active session | **Fixed + deployed** — `/check-session` + session-aware CTAs; portal stage-resolver no longer demotes set-up users to /setup on transient errors. |
| Photos web served with 24h-cached index.html (stale app shells) | **Fixed + deployed** — no-cache index/SW headers; pending SW work shipped. |
| `www.daemonclient.uz` doesn't resolve | **Open — needs operator**: add CF DNS `AAAA www → 100::` (proxied) + redirect rule to apex. |

---

## 2. Target architecture (per-user everything)

Each user — managed OR self-hosted — owns an isolated vertical:

```
[Immich app / photos web / drive web]
        │  session JWT (bakes workerUrl)
        ▼
[THEIR Cloudflare Worker + D1]  ←— the only server their data touches
        │        │
        │        └── [THEIR HEIC processor]  (Render/Vercel/Cloud Run/none — per-user URL from config, NOT hardcoded)
        ▼
[THEIR Telegram bot → THEIR private channel]  = unlimited storage
```

Shared pieces (managed flavor only): accounts portal, auth-worker, deployment-service (provision + auto-update), central `immich-api` worker (login), Render setup automation (`backend-server/main.py` — **does not exist in self-hosted**), operator Firebase project (auth + config docs).

**Code change required for the pivot** (small, do early): the shim's `HEIC_CONVERT_URL` is hardcoded to the operator's Render. Make it read `config/telegram.heicConvertUrl` (or a worker var) with the operator URL as managed-default. Same treatment for `DEPLOYMENT_SERVICE_URL` (self-hosted workers have no deployment service — auto-update must no-op gracefully; it already only fires when the var is set).

## 3. Self-hosted setup — the one-script experience

`git clone … && ./selfhost/setup.sh`

The script is interactive, idempotent, and resumable (state file in `.selfhost-state.json`):

1. **Prereqs check**: node ≥20, `wrangler`, `firebase-tools` (only if they choose hosted web), git.
2. **Telegram**: prompt for bot token (they make the bot at @BotFather — README has a 60-second walkthrough with screenshots) + channel id; script verifies with `getMe` + a test `sendMessage`/`deleteMessage` to the channel, tells them exactly what permission is missing if it fails.
3. **Cloudflare**: `wrangler login` (OAuth — no pasted API tokens unless they insist via `CLOUDFLARE_API_TOKEN`); script creates D1, applies the canonical `MIGRATION_SQL`, deploys the worker with bindings + vars, prints the `workers.dev` URL (custom domain optional).
4. **Auth/config store**: default = **their own Firebase project** (script drives `firebase projects:create` + enables email auth + deploys `firestore.rules` + writes the config docs). This keeps today's code paths unchanged. A later milestone can offer "no-Firebase" mode (worker-local auth in D1), but do NOT block the pivot on that refactor.
5. **HEIC processor (optional)**: choice of (a) Render blueprint (`render.yaml` in repo — one-click), (b) Vercel/Cloud Run container (same Flask app, Dockerfile provided), (c) skip — photos still work; HEIC grid thumbs absent until they add one (the backfill picks them up whenever it appears).
6. **Web apps**: deploy photos/drive/portal builds to their CF Pages (free) — or run locally (`npm run dev`) for the fully-offline flavor.
7. Print a summary card: all URLs, where secrets live, how to update.

`./selfhost/update.sh` = `git pull` + re-run deploys (wrangler is idempotent; D1 migrations via the same self-healing ALTER pattern already used).

**Update notifications, zero infra**: the worker already knows its `SHIM_VERSION`. Once a day (piggybacked on sync's existing waitUntil, like every backfill) it compares against the latest GitHub release tag (`api.github.com/repos/<repo>/releases/latest` — public, no token, cache the result in D1). When newer: `/api/server/about` grows an `updateAvailable` field and the web apps show a small banner: "Update available — run ./selfhost/update.sh". Managed workers keep the existing deployment-service auto-update and never show the banner.

## 4. Repo cleanup for open-sourcing

Inventory (verify each before deleting — several dirs look dead but aren't):

- **KEEP**: `immich-api-shim`, `deployment-service`, `auth-worker`, `accounts-portal`, `drive`, `immich/` (fork: web + mobile source of truth), `daemonclient-site`, `backend-server` (managed-only; document that), `daemonclient-proxy` (**still referenced as TELEGRAM_PROXY by the shim — not dead**), `docs`, `e2e-tests`, `scripts`, `firebase.json`, `firestore.rules`.
- **RETIRE**: `frontend/` (legacy app — still deployed as the `app` hosting target; retire the target with it), `landing-page/` (superseded by daemonclient-site), `photos/` (pre-Immich experiment?), `daemon-cli`, `daemonclient-desktop`, `daemonclient-immich-bridge`, `local-server`, `immich-docker-backup`, root `dist/`, `scratch/`, `screenshots/`, root-level `*_DEPLOYED.md`/session logs, `backend-server/venv|myenv` (gitignore covers them going forward).
- Move retired dirs to an `attic/` branch (not main) so nothing is lost but the front page is clean.

**README structure** (the repo's face): what DaemonClient is (one paragraph + screenshot), how it works (the per-user diagram above), managed quickstart (link), self-host quickstart (the one script), architecture doc link, contributing guide, security policy (how to report), license. Docs live in `docs/` — the roadmap files already there are a good base.

## 5. photos.daemonclient.uz → Google-Photos-grade seamlessness

Honest gap list, ordered by user-visible impact:

1. **Broken grid thumbs** — WAS the #1 gap; HEIC now auto-heals (shipped today). Video posters still have the manual fix flow → same backfill treatment is the natural next step (transcode/poster via the per-user processor).
2. **Cold-start latency** — free-plan worker + D1 first-hit. Mitigations that exist: SW caching, thumbhash placeholders, edge-cached thumbs. Next: cache timeline buckets in the SW (stale-while-revalidate) so reopening the app paints instantly like Google Photos, then reconciles.
3. **Search** — currently filename/metadata only. Google-grade semantic search needs embeddings; candidate zero-cost path: Workers AI (free tier) CLIP embeddings at upload + vectorize-lite in D1. Phase 2.
4. **Android motion photos** — embedded video is not extracted (needs real CPU; candidate job for the per-user processor).
5. **Sharing** — cross-user shared albums are BUILT but held for security review (branch worktree).
6. **>100MB mobile videos** — deferred (CF body cap; needs chunked upload in an app fork).

## 6. Security actions ONLY THE OWNER can do (do these first)

1. **Revoke the leaked Firebase Admin key** — public since 2026-04-22. GCP Console → IAM → Service Accounts → `firebase-adminsdk-fbsvc@daemonclient-c0625.iam.gserviceaccount.com` → Keys → delete the key whose id matches `private_key_id` in the old `backend-server/service_account.json`. Render keeps working (it uses the `FIREBASE_CREDENTIALS_JSON` env var — make a fresh key for it if that env var held the same key).
2. **Rotate the Cloudflare API token** pasted in an old session (`cfut_kDgs…`).
3. **Redeploy Render** so the authenticated + checkpointed setup goes live (dashboard → Manual Deploy, or connect the repo for auto-deploy).
4. **History scrub before promoting the repo**: the key (and possibly other secrets) live in git history. Run `gitleaks detect` for the full list, then `git filter-repo` (or BFG) to purge, force-push, and have any forks re-clone. Revocation (step 1) is what actually kills the risk; the scrub is hygiene.
5. **www DNS** (§1 last row).

## 7. Suggested build order

1. Owner actions above (key revocation is minutes and closes the only live hole).
2. Parameterize operator URLs in the shim/config (small PR — unblocks everything else).
3. Repo cleanup + README + LICENSE choice (AGPL-3.0 matches the Immich upstream fork obligations — verify before choosing anything else).
4. `selfhost/setup.sh` MVP: Telegram verify + wrangler provision + own-Firebase bootstrap (steps 1-4 of §3). Ship without HEIC/web-hosting options first.
5. Update banner (GitHub releases check) + `update.sh`.
6. HEIC processor blueprint (render.yaml + Dockerfile) — also becomes the managed per-user HEIC story.
7. Video-poster backfill; then parity items (§5) in order.
