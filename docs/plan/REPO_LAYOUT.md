# Repo layout — APPROVED by the operator 2026-11-20 (§2, the full regroup)

**Asked by the operator 2026-11-20:** *"keep the whole repo cleaned up and
organized … plan an optimal folder architecture, then comes the iPhone
development, then the Android."* Written on the MacBook; **the Linux machine
reviews it** — most folders are live production and theirs. Nothing is moved
until both agree. Builds on the cleanup in PR #6 (`immich/` down to the
website). **The operator approved §2 on 2026-11-20** ("Approved"); the Linux
machine's §6 answers still shape how its moves are made.

## 1. The problem

Twenty top-level folders, named by history rather than role: the Photos
website is called `immich/`, each user's worker `immich-api-shim/`, the Rust
core lives in `mobile/`, and the apps, workers and sites sit side by side
with the docs and scripts. A newcomer cannot tell what runs where.

## 2. The target — grouped by role

```
apps/                     what people install or open
  ios/                    the iPhone app (SwiftUI, from HomeRoll — SPEC D27)
  android/                the Android app (Kotlin + Compose)
  photos-web/             ← immich/                 the Photos website (Immich web fork)
  drive-web/              ← drive/
  accounts-web/           ← accounts-portal/
  site/                   ← daemonclient-site/      the landing site
  docs-web/               ← docs-site/
  app-redirect/           ← hosting/app-redirect/
core/                     ← mobile/                 the Rust workspace, shared by EVERY client:
                                                    dc-engine (the rules, pure — apps natively,
                                                    Photos web + Drive web as WebAssembly, D25),
                                                    dc-core (phone I/O), dc-ffi (Swift/Kotlin),
                                                    dc-wasm (browsers), dc-cli (testing)
workers/                  Cloudflare Workers
  user-worker/            ← immich-api-shim/        each user's worker (Photos + Drive API)
  deployment/             ← deployment-service/
  auth/                   ← auth-worker/
  telegram-proxy/         ← daemonclient-proxy/
packages/
  schema/                 ← schema/                 the shared D1 schema
selfhost/                 unchanged (paused 2026-09-30)
install.sh                stays at the root — its raw GitHub URL is public
docs/                     unchanged paths — public links point into it
scripts/                  unchanged (CI)
```

Root files stay: README, LICENSE, NOTICE, SECURITY, CONTRIBUTING,
CODE_OF_CONDUCT, CHANGELOG, RELEASING, VERSION, EXECUTION_STATUS, the Firebase
files, `.github/`.

## 3. What each move touches

| Move | Owner | Touches |
|---|---|---|
| `mobile/` → `core/` | Mac | `mobile-core.yml`, `.gitignore`, NOTICE, docs; `crypto.rs`'s path to Drive's vectors |
| new `apps/ios/`, `apps/android/` | Mac | — (empty until I1 / A1) |
| `immich/` → `apps/photos-web/` | Linux | `firebase.json` (`photos`), `ci.yml` (`photos-web`), `.gitignore`, NOTICE, FORK.md, docs |
| `drive/` → `apps/drive-web/` | Linux | `firebase.json` (`drive`), `ci.yml`, `.gitignore` (`drive/dist`), `crypto.rs` vectors, docs |
| `accounts-portal/` → `apps/accounts-web/` | Linux | `firebase.json` (`accounts`), `ci.yml`, docs |
| `daemonclient-site/`, `docs-site/`, `hosting/app-redirect/` → `apps/` | Linux | `firebase.json` (`main`, `docs`, `app`) |
| `immich-api-shim/` → `workers/user-worker/` | Linux | `deployment-service`'s embed script (`../immich-api-shim`), `selfhost` (`setup`, `update`, tests), `ci.yml`, `.gitignore` (`wrangler-*.toml`), docs |
| `deployment-service/`, `auth-worker/`, `daemonclient-proxy/` → `workers/` | Linux | `ci.yml`; each `wrangler` config moves with its folder — worker names do not change |
| `processor/` — **deprecated, removed** (operator 2026-11-20: "we dont need it anymore") | Linux | the portal's setup step (`SetupProcessor.jsx`, `config/processor.js`, the `/setup/processor` route, whose Vercel deploy button points at `processor/`), deployment-service's `/processor` attach broker + tests, the worker's `POST /api/server/processor` and the HEIC thumbnail backfill that calls a processor (`assets.ts`) + tests, the `processor` CI job, issue templates, docs-site, `.gitignore`. Processors users already attached keep running in their own Vercel accounts — the worker must stop calling them cleanly. HEIC thumbnails are made by the browser (the website's libheif-js) and by the phone (D23) instead. |
| `schema/` → `packages/schema/` | Linux | every `../schema` import (shim tests, deployment-service, selfhost) |

**Progress:** the MacBook's part is PR #7 (`mobile/` → `core/`, flattened;
`apps/ios`, `apps/android`, `apps/brand`), stacked on PR #6 — merge #6, then
#7, then Linux's moves.

## 4. Order

1. Merge PR #6 (the cleanup).
2. Linux and the operator agree on §2 (or a smaller version — §5).
3. **One reorganisation PR per owner**, in a window with no deploys:
   the Mac's first (`core/`, `apps/ios`, `apps/android`), then Linux's.
4. Linux redeploys every Firebase target and worker from the new paths and
   checks each is live; the Vercel root is updated the same day.
5. Then iPhone development starts (ENGINE.md §9, I0).

## 5. A smaller alternative

If moving every production folder is not worth the risk now: rename only
the three misleading names — `immich/` → `photos-web/`, `immich-api-shim/` →
`user-worker/`, `mobile/` → `core/` — and add `apps/ios`, `apps/android`.
The rest regroups when the websites are rebuilt on the engine (D25).

## 6. The Linux machine's answers (2026-11-20)

1. **§2**, as the operator approved. Order: Linux's fresh-worktree build of
   PR #6 → the operator's OK → merge #6; Linux ships worker release **R3**
   (the delete fix) **before** any move — **PR #7 is not merged while R3 is
   deploying**; then #7; then Linux's one PR; then every Firebase target and
   the 4 central workers redeployed from the new paths and checked live.
   *(The Vercel root change is no longer needed: `processor/` is deprecated,
   operator 2026-11-20.)*
2. **Path readers:** only `install.sh` (stays) and links into `docs/`
   (unchanged) are public; no Render config here; the 4 central workers
   (`daemonclient-deployment`, `daemonclient-auth`, `daemonclient-proxy`,
   `immich-api`) deploy from the CLI — no dashboard holds a path, names stay;
   Actions secrets are repo-level; Firebase reads only `firebase.json`'s
   public paths (site ids stay); Vercel's root directory is the one dashboard
   change — moot now that `processor/` is deprecated. **Hidden:** `deployment-service/scripts/embed-shim.mjs` is
   git-ignored yet every worker release needs it, and it hard-codes
   `../../immich-api-shim/dist/index.js` — Linux un-ignores, commits and
   repoints it; `selfhost` (`build.mjs`, `config.mjs`, `setup`, `doctor`, and
   tests importing `../schema`) — Linux updates it.
3. **`EXECUTION_STATUS.md` stays at the root** — every record points there.

The docs website redesign and changelog (Linux) come after the move, written
once at `apps/docs-web`.
