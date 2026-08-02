# DaemonClient — master plan

> **For agentic workers:** every task passes the four gates in `docs/GATES.md`
> before it is committed. Each gate runs as a **separate** agent with only that
> gate's brief; the implementer never reviews their own work.

Originally written 2026-07-27 from an independent read of the whole repo.
**Rewritten 2026-08-02** after the operator's directive covering the video
auto-fixer, the Vercel OAuth onboarding step, the mobile long-backup failures,
the full self-host vision, and open-source readiness.

Reference docs (`REPO_MAP.md`, `API.md`, `FINDINGS.md`, `PARITY.md`,
`GATES.md`) hold the verified file:line facts; this is the plan on top of them.

Legend:  ✅ done & committed   ▶ next   ☐ todo   ⏸ blocked (needs operator)

---

## The goal in one paragraph

A zero-cost, fully-serverless personal photo + file cloud. Each user's bytes
live in **their own Telegram channel** (19 MB AES-256-GCM chunks), with their
own **Cloudflare Worker + D1** and **Firebase** login. **Photos** is an Immich
fork (`immich/web` + `immich/mobile`); **Drive is a standalone React app**
(`drive/`). One codebase, two ways to run: **hosted** (operator provisions a
worker per user) and **self-hosted** (a stranger runs everything on their own
accounts).

## Global constraints

These apply to every task. A task that violates one has failed gate 2.

- **Zero operator linkage on self-host.** A self-hosted install must not
  contact, resolve, or embed any address we control. If we vanish, it keeps
  working. Fail *safe*, never *open*: a self-host build missing a URL renders
  it empty rather than falling back to ours.
- **$0 running cost** — Cloudflare Workers free, D1 free, Firebase Spark,
  Vercel Hobby, Telegram.
- **One codebase, two deployments.** No forked "self-host edition".
  Differences are build-time env (`VITE_SELF_HOST` / `PUBLIC_SELF_HOST`) or
  runtime config, never duplicated source. **One bug fixed once reaches both.**
- **Manual setup on self-host, OAuth only on hosted.** Self-hosters type their
  own credentials so nothing is brokered through us; credentials rest only on
  their own machine or server.
- **The worker is free-tier constrained** — 10 ms CPU, 128 MB, subrequest caps.
  Byte-pushing belongs on the client or the processor, never the worker.
- **The mobile sync stream is strict** — one wrong type aborts all sync.
- **Never break existing users' data.** Schema changes are additive; the
  per-user worker fleet updates lazily and some workers run old bundles.

---

## Decision record: is Vercel the right choice for the auto-fixer?

**Answer: yes for steady-state and repair — but the current design cannot do
video at all, and it is not sized for a large first-time backfill.**

Verified against `vercel.com/docs/limits` and `/docs/functions/limitations`
on 2026-08-02 (Hobby / free plan):

| Resource | Hobby, per month |
|---|---|
| Active CPU | **4 CPU-hours** |
| Provisioned memory | 360 GB-hours |
| Invocations | 1,000,000 |
| Fast Data Transfer | 100 GB |
| **Max request/response body** | **4.5 MB — hard, returns 413** |
| Max duration | 300 s |
| Memory | 2 GB / 1 vCPU |
| Bundle size | 250 MB (5 GB with large functions) |

**HEIC, as it works today.** `processor/api/convert.js` measures ~2 s CPU per
12 MP image (asm.js libheif). 4 CPU-hours = 14,400 CPU-seconds ÷ 2 s ≈
**7,200 photos per month**.

- *Steady state:* a normal user shooting ~300 photos/month uses **~4%** of the
  budget. Very comfortable.
- *First backfill:* an iPhone library of 20,000 HEIC photos costs 40,000 CPU-s
  = **11.1 CPU-hours ≈ 2.8× the entire monthly free budget.** This is the real
  constraint, and today nothing throttles it.

**Video, as proposed.** Three findings:

1. **The 4.5 MB body cap blocks the current design outright.** The worker
   POSTs the whole file (`request.arrayBuffer()` in `handleConvert`). A 50 MB
   video is an instant `413 FUNCTION_PAYLOAD_TOO_LARGE`. Video requires
   **range-pull**: the worker sends a URL + auth, the processor fetches only
   the bytes it needs, and the body stays a few hundred bytes.
2. **ffmpeg.wasm is a non-starter on this runtime.** WASM already failed to
   load on Vercel serverless here — that was the root cause of the HEIC
   autofixer outage fixed 2026-08-01. Use a **static ffmpeg binary** (~80 MB,
   fits the 250 MB bundle) invoked via `child_process`.
3. **`moov` atom placement is the technical risk.** iPhone and Android MP4s
   frequently place `moov` at the *end*, so "fetch the first 5 MB" yields an
   undecodable stream. Needs a two-range fetch (tail for `moov`, head for the
   first keyframe). **Spike this before committing to the approach** (Task B1).

Per-video cost is comparable to HEIC (~1–2 s CPU for one frame from a small
range); transfer is cheap (1,000 videos × 5 MB = 5 GB of 100 GB).

**Alternatives considered and rejected:**

- *Cloudflare Workers* (the user already has an account): the free tier gives
  **10 ms CPU** — three orders of magnitude short of a 2 s HEIC decode. The
  $5/mo paid tier gives 30 s and would work, but breaks the $0 constraint.
  Viable later as an opt-in for people already paying.
- *Client-only, no processor:* free and private, but cannot heal a library
  while no client is open, and cannot fix already-uploaded items.

**Therefore the architecture changes in this order of value:**

1. **Generate thumbnails client-side at upload.** The web app already ships
   `heic2any`; Flutter decodes HEIC natively. Cuts Vercel load ~95% and makes
   the processor a *repair* path rather than the primary one. Biggest win.
2. **Range-pull instead of body-push.** Required for video at all, and it
   removes the 4.5 MB ceiling for large HEIC too.
3. **Throttle the backfill** to stay inside 4 CPU-hours, and report progress
   honestly instead of silently exhausting the quota.

---

## Phase ordering, and why

The operator listed the auto-fixer first. **Phase A (mobile reliability) is
proposed first instead**, because a backup app that dies after 5–6 items
cannot complete a first backup at all — that is the product's core promise,
and it blocks any meaningful test of the auto-fixer at scale. The auto-fixer
improves photos that *are* uploaded; Phase A decides whether they get uploaded.
Reorderable on request.

| Phase | Outcome | Blocking? |
|---|---|---|
| **A** | Mobile completes a long backup; videos play | Yes — core product broken |
| **B** | Auto-fixer covers video + HEIC, inside the free tier | No |
| **C** | Vercel OAuth as onboarding step 3 | ⏸ operator must register the app |
| **D** | Self-host: one curl, fully manual, zero linkage | No |
| **E** | Maintenance: one fix reaches both flavours | No |
| **F** | Open-source ready: cleanup, private split, docs | Last |

═══════════════════════════════════════════════════════════════════════════════

## PHASE A — Mobile reliability (long backups)

*Goal: a user leaves the app open and backs up thousands of items untouched,
and every uploaded video plays.*

### ▶ A1 — Reproduce and instrument the 5–6 item upload stall

Both Android and iOS stop after 5–6 items and need an app restart. A fixed
small count, recoverable only by restart, points at a **leaked or exhausted
resource**, not a network fault. Candidates in order of likelihood:

- An unreleased concurrency slot that never returns on one path (the worker's
  `thumbAcquire`/`thumbRelease` pattern has an analogue in the upload isolate)
- An unclosed file descriptor or `HttpClient` per upload
- An unawaited future leaving the queue believing work is still in flight
- A native platform-channel handle not disposed

**Files:** `immich/mobile/lib/services/background_upload.service.dart`,
`foreground_upload.service.dart`, `immich/mobile/lib/domain/utils/background_sync.dart`

- [ ] Reproduce on a real device with 20+ queued items, capturing logs
- [ ] Instrument each boundary: enqueue → start → bytes sent → response →
      slot released → dispose
- [ ] Run once; identify from evidence **which** counter fails to return
- [ ] Gates, commit the instrumentation separately from the fix

### ☐ A2 — Fix the stall at its root
Depends on A1's evidence. **Do not guess before A1 reports.**

- [ ] Failing test: queue N items, assert all N complete
- [ ] Fix the leak A1 identified
- [ ] Verify a 50-item backup completes unattended on both platforms
- [ ] Gates, commit

### ✅/⏸ A3 — Videos over 19 MB unplayable on mobile — **ALREADY FIXED, NEEDS FLEET DEPLOY**

**Measured 2026-08-02, not assumed.** The multi-chunk fix already exists in
git as `611cffc` ("stream full 206 ranges — mobile multi-chunk playback"),
whose own message says *(NOT deployed)*. It reached `dc-ozkv3fuz` with the
2026-08-01 deploy. Verified live against that worker:

- `Range: bytes=0-` on a 101 MB / **6-chunk** `.MOV` returns
  `206`, `content-range: bytes 0-101356527/101356528`
- Streaming it end to end delivers **101,356,528 bytes — byte-exact**

So the "19 MB ceiling" was **never an Immich-mobile protocol limit**. It was
our own truncated-206 bug: native players open with `bytes=0-` and treat a
short 206 as EOF, so single-chunk videos played and multi-chunk froze. No
Immich fork, upstream PR, or new app is required for this.

- [ ] Retest on a real device against a worker carrying `611cffc`
- [ ] **Deploy fleet-wide** — this is Task E4, and it is the highest-value
      action available: real users are still on bundles without this fix

### ☐ A4 — Codec check (do this before assuming playback is solved)
467 of 489 videos are `video/quicktime` (iPhone HEVC) and **zero have an
H.264 rendition** — the `telegramPlaybackChunks` path has produced none. If
sub-19 MB `.MOV` files already play on the operator's device, that device
decodes HEVC and codec is not the blocker; confirm rather than assume.

- [ ] Confirm HEVC playback on both target devices post-deploy
- [ ] Only if it fails: revive the H.264 rendition path

═══════════════════════════════════════════════════════════════════════════════

## PHASE B — Auto-fixer: video + HEIC, inside the free tier

> **Reframed 2026-08-02 after measuring the library.** 220 of 489 videos
> (45%) have no thumbnail — Telegram thumbnails the other 55% for free. The
> decision below is that **the client generates the poster at upload** (we
> already own the `immich/mobile` fork and build our own APK in CI, so this
> needs no upstream PR and no new app), and **Vercel is repair-only** for the
> 220 already-uploaded ones. That inverts the earlier framing: range-pull and
> ffmpeg are a one-time backfill tool, not the steady-state path.

### ☐ B1 — Spike: can we extract a poster frame from a byte range?
**A spike, not a feature.** Output is a decision; it may kill range-pull. Timebox.

- [ ] Collect 5 real MP4s (iPhone, Android, screen recording); locate `moov` in each
- [ ] Determine minimum byte ranges for a first-frame decode
- [ ] Prove a static ffmpeg binary extracts a frame from those ranges alone
- [ ] Write up feasibility, bytes required, CPU per video →
      `docs/roadmap/VIDEO_THUMBNAILS.md`

### ☐ B2 — Range-pull protocol between worker and processor
Removes the 4.5 MB ceiling; prerequisite for video.

- [ ] Request shape `{ source, ranges[], kind }` + owner-pinned auth, body < 1 KB
- [ ] Processor fetches only from an **exact-host allowlist**
      (`api.telegram.org`) — a suffix rule loses to a Cyrillic homograph, as
      this repo already learned
- [ ] Keep the body-push path working for small HEIC (old workers must not break)
- [ ] Tests: allowlist bypass, oversize range, missing auth
- [ ] Gates, commit

### ☐ B3 — Video poster extraction in the processor
Depends on B1 saying yes.

- [ ] Add static ffmpeg; assert bundle stays under 250 MB
- [ ] Extract frame → JPEG at `THUMB_EDGE`, reusing the existing encoder
- [ ] Duration/pixel guards before allocation (mirrors `MAX_PIXELS`)
- [ ] Wire "Fix video thumbnails" in Utilities to the new path
- [ ] Gates, commit

### ☐ B4 — Client-side thumbnails at upload (the 95% win)
- [ ] Web: generate the HEIC thumbnail with the bundled `heic2any` before
      upload and send it alongside
- [ ] Mobile: same via native decode
- [ ] Processor becomes repair-only
- [ ] Measure Vercel CPU per 100 uploads, before vs after
- [ ] Gates, commit

### ☐ B5 — Backfill throttle and honest quota reporting
- [ ] Cap backfill so a large library cannot silently exhaust 4 CPU-hours
- [ ] Real progress in Utilities ("1,240 of 18,000 repaired")
- [ ] Gates, commit

═══════════════════════════════════════════════════════════════════════════════

## PHASE C — Vercel OAuth as onboarding step 3

Order becomes **Telegram → Cloudflare → Vercel (auto-fixer)**.

> ⏸ **Blocked on the operator:** registering the Vercel OAuth/integration app
> and providing client id + secret, exactly as with Cloudflare OAuth.
> Everything else can be built and tested against a stub.

- ☐ **C1** Operator runbook → `docs/roadmap/VERCEL_OAUTH.md`: where to
  register, redirect URIs, scopes, what to paste where. *(docs only)*
- ☐ **C2** OAuth exchange in `deployment-service`, mirroring the Cloudflare
  flow; secrets never reach the browser. Tests: state/CSRF, token never
  logged, failure closes.
- ☐ **C3** Onboarding step 3 UI in `accounts-portal`; **self-host builds get
  the manual instructions instead, never OAuth**.
- ☐ **C4** Deploy the already-committed `handleAttachProcessor` broker — it is
  in git but **404 in production** today.

═══════════════════════════════════════════════════════════════════════════════

## PHASE D — Self-hosting: one command, zero linkage

Much already exists: `selfhost/` ships a dependency-free CLI with `setup`,
`status`, `update`, `web`, `dashboard`, `processor`, `doctor`, and its tests
pass. This phase closes the gaps in the operator's vision.

- ✅ **D0.1** Photos web self-host independence (SW worker URL configurable)
- ✅ **D0.2** Drive self-host independence (`CENTRAL_API` configurable)
- ☐ **D1 — The curl bootstrap.** `install.sh` served from the repo: detect
  Node, fetch the CLI, run `daemonclient setup`. No root, no global install.
  Verify on a clean container, Linux and macOS.
- ☐ **D2 — Telegram bot creation without our backend.** Today the hosted flow
  creates bots through `backend-server/main.py` using operator-owned userbot
  sessions. The CLI must walk the user through BotFather manually, validate
  the pasted token, create the channel, add the bot, export the invite link.
  **Nothing touches `backend-server/`.**
- ☐ **D3 — Credentials rest only on the user's machine.** Audit every
  credential the CLI collects: where written, file mode, whether it can reach
  a log or `ps`. Document storage location and rotation.
- ☐ **D4 — One site, path-based routing.** Self-host serves everything from
  one Firebase site: `user.web.app` = dashboard, `user.web.app/photos`,
  `user.web.app/drive`. Hosted keeps its subdomains, from the same build.
  - `accounts-portal` and `drive`: Vite `base` from env
  - `immich/web`: SvelteKit `kit.paths.base` from env — **note the service
    worker registration added 2026-08-02 hardcodes `/service-worker.js` and
    must become base-aware, or the SW 404s on self-host**
  - `daemonclient web` deploys all three into one site under those paths
  - Verify on a real Firebase project end to end
- ☐ **D5 — Real end-to-end dry run** on throwaway Telegram/Cloudflare/Firebase
  accounts: clone → setup → deploy → log in from web *and* mobile → upload →
  see it. The only real proof self-hosting works. *(Needs throwaway accounts.)*

═══════════════════════════════════════════════════════════════════════════════

## PHASE E — Maintenance readiness

*Goal: every user — hosted (pushed) and self-hosted (pulls) — gets the **same**
update. Fix once, both get it.*

- ✅ **E0** CI runs worker tests, broker typecheck + tests, processor tests,
  and both web builds on every push (`.github/workflows/ci.yml`, 2026-08-02).
- ☐ **E1 — One release action.** One tagged commit → builds the worker,
  deploys the hosted fleet (deployment-service + central worker +
  auto-update), and publishes the GitHub release the self-host update-check
  watches. Cutting a release can't be something you do half of.
- ☐ **E2 — Parity test.** Run the suite with `SELF_HOST=1` and unset; fail
  when a new `isSelfHost` divergence appears undocumented (`PARITY.md` says
  there are exactly 5). Wire into CI.
- ☐ **E3 — Version honesty.** Both flavours report the same version from one
  source at `/api/health` and on the dashboard.
- ☐ **E4 — Fix the stalled auto-update path.** Per-user workers still run old
  bundles; the OAuth refresh → deploy path fails and a rotated refresh token
  is dropped on deploy failure. Until this works, "fix once, both get it" is
  not true for the hosted fleet.
- ☐ **E5 — The open security backlog** (each its own gated task; live-auth
  ones deploy with the operator):
  - Retire the `APP_IDENTIFIER` signing fallback (FINDINGS §4) — carefully;
    naive removal breaks login on the secret-less shared worker
  - Encrypt `sessionSecret` at rest; stop putting the Firebase refresh token
    in the session payload (§22)
  - Session epoch / revocation; bounded TTL (§5)
  - Defense in depth: refuse config routes when `!env.DB` (§16)
  - Move the bot token out of media URLs into a header (§21.1)

═══════════════════════════════════════════════════════════════════════════════

## PHASE F — Open-source readiness

*Goal: a stranger opening the repo sees a clean, honest, secret-free project.*

- ✅ **F0.1** Dead code deleted (`daemonclient-immich-bridge/`, `local-server/`,
  `landing-page/`, `daemonclient-desktop/`); `tsc --noEmit` clean; misleading
  docs reconciled.
- ☐ **F1 — Move operator-only material to a private repo.** Per the standing
  instruction this happens **last**: `backend-server/` (userbot sessions),
  operator scripts, anything carrying real user data.
- ☐ **F2 — Remaining dead/ambiguous trees:** `frontend/` (a live 301 target —
  needs a `firebase.json` change to retire), `photos/`, `daemon-cli/` (a
  separate Python product — keep or split? operator call).
- ⏸ **F3 — Secrets & forkability.** No real secrets are tracked, but the
  operator's **Firebase web key is hardcoded** across configs, so a forker
  inherits the operator's project. Templatize it, rotate the key, sanitize
  `HANDOFF.md`, scrub git history. *(Operator: rotation + history scrub.)*
- ☐ **F4 — Immich branding leaks** (audit §21.5): `<title>Login - Immich</title>`,
  the rainbow splash, upstream links (`buy.immich.app`, `discord.immich.app`).
- ☐ **F5 — Contributor docs:** `CONTRIBUTING.md`, architecture overview, local
  dev setup, the gates. `docs-site/` covers self-hosting end to end.
- ☐ **F6 — License, NOTICE, and public README accuracy pass.**

═══════════════════════════════════════════════════════════════════════════════

## PHASE G — Ongoing Photos & Drive

Never "done". From FINDINGS, in impact order (each needs a live device/soak):
`POST /api/sync/ack` unimplemented (every ack a no-op) · chunk subrequest
budget ~3× wrong (§6) with unbounded `waitUntil` 19 MB copies (§13) · timeline
double-dispatch (§7) · download backpressure (§9) · grid thumbnails serving
whole originals (§10) · >100 MB mobile video (needs chunked upload).

---

## Where we are right now

**Shipped and verified live (2026-08-01 → 08-02):**
- Processor rewritten WASM-free; universal image thumbnailer; pixel-bomb guard
- `pending-thumbnail-fix` gap closed (26 broken PNG/JPEG found and healed)
- Utilities "Automate" pill redesign
- Telegram `invite_link` race fixed (4 call sites, shared helper)
- First-login service-worker race fixed
- Dashboard shows the backend's `/api` base
- CI green across worker, broker, processor, and both web apps

**Next:** Phase A1 — reproduce and instrument the mobile upload stall.

Live status in `docs/plan/SCRATCHPAD.md`.
