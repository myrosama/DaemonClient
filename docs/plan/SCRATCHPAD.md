# Scratchpad — live status

Rewritten after every task. Read `docs/MASTER_PLAN.md` first, then this.

## State
Autonomous run 2026-07-27, on **main** (branch merged + pushed). Deep into Phase 1
(self-hosting). Operator away, wants it finished fully + a Cloudflare-docs-style
docs page + real script tests. Gates: **each of the 4 run as a separate agent**.

## Self-host web architecture (verified this session)
Three web apps, all deployable to the user's own Firebase Hosting, all pointing at
the user's own worker — **nothing points at the operator** in a self-host build:
- **accounts-portal = THE HUB** (main page). Already self-host-aware
  (`IS_SELF_HOST`, `App.jsx:2620` → `/dashboard`, config from worker D1). Needs the
  full Firebase web config at build (VITE_FIREBASE_* incl. appId + messagingSenderId).
- **Photos** (immich/web): uses ONLY the worker (no Firebase SDK). Build with
  `PUBLIC_DAEMONCLIENT_WORKER_URL=<worker>`.
- **Drive** (drive/): uses ONLY the worker (no Firebase SDK). Build with
  `VITE_SELF_HOST=1 VITE_API_BASE=<worker>`.

## Done / in flight this run
- ✅ merged the earlier branch to main (processor Vercel/Node, cleanup, docs).
- 🔬 **1.2 + 1.3** sever operator links in Photos + Drive — IMPLEMENTED + build-
  verified (hosted build unchanged; self-host build targets given worker, operator
  host ABSENT). **4 gate agents running** (security/design/correctness/works-real).
  Files: drive/src/api.js, immich/web/{svelte.config.js, src/app.d.ts,
  src/service-worker/index.ts}. NOT committed until gates pass.

## Remaining Phase 1 (self-hosting) tasks
- **1.4a** Setup captures FULL Firebase web config (appId, messagingSenderId —
  authDomain/storageBucket derive from projectId). Hub needs them; setup only
  collects apiKey+projectId today.
- **1.4b** `daemonclient web` command: write per-app env → build all 3 → generate
  the user's firebase.json (3 hosting sites) → `firebase deploy` (firebase-tools,
  needs their login) → add deployed origins to worker ALLOWED_ORIGINS. This is the
  "script sets it up for them / host on Firebase serverless" deliverable.
- **1.4c** Wire it into `setup` (offer web deploy at the end).
- **1.5** Real end-to-end test: run the CF provisioning pipeline for real
  (throwaway worker on the operator's CF acct, verify /api/health, clean up).
  Full Telegram bot creation can't be automated (no Telegram acct) — test the rest.

## Phase 2 additions (from operator)
- Docs site, styled like Cloudflare docs, "highlight every detail". New deliverable.
- At the LAST open-source stage: move unneeded stuff to a PRIVATE repo (don't just
  delete). Operator instruction.

## Baseline green
shim tsc clean + 261; selfhost 67; processor 5. Drive + immich/web build OK both
hosted and self-host.
