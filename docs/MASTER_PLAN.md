# DaemonClient — master plan

> **For agentic workers:** every task passes the gates in `docs/GATES.md`
> before commit. Each gate runs as a **separate** agent with only that gate's
> brief; the implementer never reviews their own work.

**Rewritten 2026-08-03** on top of a full repo audit (`docs/AUDIT_2026-08-03.md`).
Supersedes all earlier plans.

---

## The vision, in the operator's words

> Zero cost to us and to them — a tool that gives unlimited, secure cloud
> storage. **One path**: we fix something there, and both the hosted users and
> the self-hosters get it. Self-hosting must not matter to the running hosted
> version at all. The repo must be ready for open-sourcing.

## Scope for this phase

**Web only.** Mobile apps are treated as if they do not exist. They come after
the web is perfect, the repo is clean, and self-hosting works — and only then.

---

## The fact that shapes everything

**There are active beta users, and each one's worker lives in their own
Cloudflare account.** `provisionWorker()` deploys with the *user's* accountId
and API token, so we hold no fleet and cannot mass-deploy. The only way a fix
reaches a hosted user is `deployment-service` redeploying their worker.

Two consequences that drive the whole plan:

1. **Auto-update *is* the one path for hosted users.** No matter how clean the
   code gets, if auto-update is broken nothing we fix reaches anyone. So
   repairing it is a **prerequisite** (Phase 0), not a late-stage nicety.
2. **Breaking changes cost real money now.** Each user owns their D1 and their
   Telegram data. Format changes must be additive and reversible; a user whose
   auto-update is stuck is stranded on an old bundle holding real photos.

They are beta users, which buys latitude — not licence to corrupt data.

---

## PHASE 0 — Make delivery work at all ▶ **PREREQUISITE**

*Nothing below matters until a fix can actually reach a user.*

- [ ] **0.1** Diagnose the auto-update stall against a real user's worker:
      OAuth refresh → deploy, and the single-use refresh-token rotation bug
      (a rotated token is dropped when the deploy fails, permanently stranding
      that user).
- [ ] **0.2** Fix it so a redeploy is idempotent and a failed deploy never
      loses the rotated credential.
- [ ] **0.3** Prove it: confirm a version bump reaches a worker that is not the
      operator's, end to end.
- [ ] **0.4** Report which beta users are stranded and on what bundle.

## Global constraints

- **Zero operator linkage on self-host.** A self-hosted install never contacts,
  resolves, or embeds an address we control. Fail *safe*, never *open*: a
  self-host build with a URL unset renders it empty, never ours.
- **$0 running cost** — Cloudflare free, D1 free, Firebase Spark, Telegram,
  Vercel Hobby.
- **One path.** A given behaviour is implemented **once**. Hosted vs self-host
  is build-time env, never a second copy of the logic.
- **Free-tier worker budgets are law**: 10 ms CPU, 128 MB, 50 subrequests.
  Bytes belong on the client; the worker serves JSON.
- **Self-host changes must never touch the running hosted deployment.**

---

## PHASE 1 — Make the web perfect

*Goal: the web products work flawlessly and depend on the worker for JSON only.*

### 1.1 — Route `video/playback` client-direct ▶ **START HERE**
The SW's direct-route regex omits `video/playback`, so every video stream is
proxied by the worker, which on free-tier limits dies with error 1102 —
surfacing in the browser as a CORS error. Verified as the entire content of the
operator's console log.

**File:** `immich/web/src/service-worker/index.ts:31`

- [ ] Extend `ASSET_BINARY_REGEX` to include `video/playback`
- [ ] Confirm the `dc-manifest` byte path serves ranged video correctly
- [ ] Test: play a multi-chunk video in a browser; zero worker byte requests
- [ ] Gates, commit, deploy, verify live

### 1.2 — Confirm the web needs the worker for nothing but JSON
- [ ] Record every worker request during a full session (browse, view, play,
      upload); assert none carry bytes
- [ ] Document the result in `docs/PARITY.md`

### 1.3 — Fix `www.daemonclient.uz` (DNS does not resolve)
- [ ] Add the DNS record; verify

---

## PHASE 2 — The one path (the heart of the vision)

*Goal: the storage primitive exists exactly once. This is what makes "fix once,
both get it" true rather than aspirational.*

Today, *split into 19 MB chunks → AES-GCM encrypt → `sendDocument` → record a
manifest* is implemented **four times**: `immich/web/.../daemonclient-drive.ts`,
`drive/src/App.jsx`, `immich-api-shim/src/assets.ts`, and
`immich-api-shim/src/webdav.ts`. `CHUNK_SIZE` is hardcoded in five files, twice
inside `App.jsx` alone.

### 2.1 — Extract `packages/dc-core`
One dependency-free TypeScript module, usable in a browser, a Worker, and Node.

- [ ] Define the contract: chunk size, IV layout, AES-GCM parameters, manifest
      JSON shape, Telegram send/fetch, file-id resolution
- [ ] Write the conformance test vectors **first** — fixed input bytes, fixed
      key, expected ciphertext and manifest. These become the definition.
- [ ] Implement `dc-core` against those vectors
- [ ] Gates, commit

### 2.2 — Photos web uses `dc-core`
- [ ] Replace `daemonclient-drive.ts` internals; delete the duplicated logic
- [ ] Round-trip test: upload → read back → bytes identical
- [ ] Gates, commit

### 2.3 — Drive web uses `dc-core`
- [ ] Replace `drive/src/App.jsx` + `crypto.js` upload/download internals
- [ ] Remove both `CHUNK_SIZE` definitions
- [ ] Round-trip test
- [ ] Gates, commit

### 2.4 — The worker uses `dc-core`
- [ ] `assets.ts` and `webdav.ts` import the same module
- [ ] Delete the duplicated implementations
- [ ] Gates, commit

### 2.5 — A test that keeps the path single
- [ ] CI fails if `sendDocument`, an AES-GCM call, or a chunk-size constant
      appears outside `packages/dc-core`
- [ ] Gates, commit

---

## PHASE 3 — Clean the repo

*Goal: a stranger opening the repo sees one coherent project.*

- [ ] **3.1** Delete `frontend/` (29 files serving only a 301); replace with a
      `firebase.json` redirect. Verify `app.daemonclient.uz` still redirects.
- [ ] **3.2** Delete `photos/` (stock cat photos, not a Firebase target).
- [ ] **3.3** Delete the abandoned `aemon-lient` worker.
- [ ] **3.4** Move `backend-server/` (operator Telethon userbot sessions) and
      `HANDOFF.md` to a private repo. **Nothing self-hosted may depend on them.**
- [ ] **3.5** Operator call: keep, split out, or delete `daemon-cli/`.
- [ ] **3.6** Immich branding: `<title>… - Immich</title>`, upstream links.

---

## PHASE 4 — Make it genuinely forkable

*Goal: someone clones this and runs it on their own accounts with no trace of us.*

- [ ] **4.1** Remove the hardcoded operator Firebase API key from all 6 tracked
      files; read from env with no hosted fallback on self-host builds.
- [ ] **4.2** Remove operator identifiers (`sadrikov49`, `daemonclient-c0625`)
      from the 15+ tracked files that carry them.
- [ ] **4.3** A test that fails if an operator hostname or key appears in any
      self-host build output. Wire into CI.
- [ ] **4.4** Rotate the exposed Firebase key. *(Operator)*
- [ ] **4.5** Git history scrub. *(Operator)*

---

## PHASE 5 — Self-hosting, built on the single path

*Goal: one command, fully manual, zero linkage — and it changes nothing for the
hosted deployment.*

- [ ] **5.1** `install.sh` curl bootstrap: detect Node, fetch the CLI, run
      `daemonclient setup`. No root, no global install. Verify on a clean
      container, Linux + macOS.
- [ ] **5.2** Bot creation without our backend: the CLI walks the user through
      BotFather, validates the pasted token, creates the channel, adds the bot,
      exports the invite link. Never touches `backend-server/`.
- [ ] **5.3** Credentials rest only on their machine — audit every one for file
      mode, log exposure, and `ps` visibility. Document rotation.
- [ ] **5.4** Path-based hosting: one Firebase site — `user.web.app` (dashboard),
      `/photos`, `/drive`. Needs Vite `base` and SvelteKit `paths.base` from
      env, and the SW registration (which hardcodes `/service-worker.js`) made
      base-aware.
- [ ] **5.5** Real end-to-end dry run on throwaway accounts: clone → setup →
      deploy → log in → upload → view. The only proof that counts.

---

## PHASE 6 — Keep it honest

- [ ] **6.1** One release action: tag → build worker → deploy hosted → publish
      the GitHub release self-host update-checks watch.
- [ ] **6.2** CI runs the suite with `SELF_HOST=1` and unset; fails on any
      undocumented divergence.
- [ ] **6.3** Both flavours report the same version from one source.
- [ ] **6.4** Fix the auto-update path (harmless today with no users; must work
      before there are any).
- [ ] **6.5** Security backlog from `FINDINGS.md`: retire the `APP_IDENTIFIER`
      signing fallback (§4), encrypt `sessionSecret` at rest and drop the
      refresh token from the session payload (§22), session revocation (§5),
      refuse config routes when `!env.DB` (§16), bot token out of media URLs
      (§21.1).

---

## PHASE 7 — Apps

Deliberately last, and only once Phases 1–6 hold. The decision recorded
2026-08-02: mobile is a **backup client**; playback is not a goal; the fix is
client-direct upload in our existing `immich/mobile` fork so bytes never touch
the worker. Nothing in Phases 1–6 may assume an app exists.

---

## Where we are

**Verified working:** web upload and read are already client-direct; the backup
data is intact (a 101 MB 6-chunk video ffprobes clean end to end); CI is green
across worker, broker, processor, and both web apps.

**Next:** Phase 1.1 — the `video/playback` regex.
