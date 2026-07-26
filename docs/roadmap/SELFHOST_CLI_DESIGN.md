# DaemonClient self-host setup CLI — corrected design

## Verdict on the operator's six points

1. Plain env-format config file — **KEEP the format, CHANGE the location** to `~/.config/daemonclient/config.env`.
2. Test every value on every run; re-running is the health check — **KEEP, unchanged. This is the spine of the design.**
3. Precise failure detection — **KEEP, and it implies an architectural rule: never shell out to a CLI that swallows the error you need.**
4. Cloudflare via browser OAuth — **KEEP the goal. Reuse of our OAuth app: NO, definitively. Register a new one: NO. Use `wrangler login` (Cloudflare's own first-party client). Browser-only with no token fallback: NOT POSSIBLE — Cloudflare has no device flow.**
5. Vercel for the HEIC processor via one browser sign-in — **KEEP. Easier than Cloudflare: `vercel login` is a real RFC 8628 device flow, so it works over SSH.**
6. All config in the user's own D1 — **CHANGE. Bootstrap secrets stay on disk; D1 gets runtime app settings only.**

---

## Architectural rules (apply to every step)

**R1 — One config file, outside the repo.** `$DAEMONCLIENT_CONFIG` → else `--config <path>` → else `$XDG_CONFIG_HOME/daemonclient/config.env` (dir 0700, file 0600). Dotenv syntax, grouped and commented, written with `fs.openSync(file,'w',0o600)` (never write-then-chmod). If a legacy `selfhost/.env` exists, load it but warn and offer to move it. **Refuse to run** if a `.env` exists in the repo root or in `immich-api-shim/`, and say why: wrangler will read it and override your Cloudflare login.

**R2 — CLIs authenticate; we do the work.** `wrangler login`, `firebase login`, `vercel login` exist to own the OAuth dance. Everything after that is our own REST calls with the token they stored. Exceptions, because bundling genuinely needs them: `wrangler deploy`, `wrangler pages deploy`, `wrangler secret put`, `vercel deploy`.

**R3 — Clean child environments.** One `childEnv()` helper. Whitelist `PATH HOME SHELL LANG TMPDIR XDG_* *_PROXY`, add `WRANGLER_SEND_METRICS=false` and `CLOUDFLARE_ACCOUNT_ID`. Always delete `CLOUDFLARE_API_TOKEN CLOUDFLARE_API_KEY CLOUDFLARE_EMAIL CF_API_TOKEN CF_API_KEY CF_EMAIL VERCEL_TOKEN` unless the user explicitly chose the token path.

**R4 — Serialize all wrangler calls** behind one in-process mutex. Never parallel; the refresh-token rotation has no locking and a race permanently breaks the login.

**R5 — No state machine.** No `steps`, no `markDone`, no `isDone`. Every step is `probe() → repair() → verify()` and every step is idempotent. `setup` and `doctor` are the same code path; `doctor` just runs with `--no-repair`.

**R6 — Machine-readable channels only.** `WRANGLER_OUTPUT_FILE_PATH=<tmp.ndjson>` for deploy results, `--json` for d1 list, REST JSON everywhere else. No stdout regexes.

**R7 — Every failure names the thing that is wrong and the action that fixes it.** Model on `telegram.mjs:196-227`.

---

## The flow

### Step 0 — Preflight
Node ≥ 18. Config dir exists with 0700. Check ambient `CLOUDFLARE_*`/`CF_*`/`VERCEL_TOKEN` and warn by name. Check for a forbidden `.env` (R1). Print the absolute config path in the header of every command.

### Step 1 — Load and plan
Parse `config.env` with dotenv semantics; on a syntax error report `line N: <problem>`. Print a checklist of the seven subsystems, each marked unknown, and fill it in as probes complete.

### Step 2 — Telegram (unchanged, already correct)
Probe: `getMe(token)`, then `verifyChannelAccess` — which actually sends and deletes a message, because membership is not permission. Repair: prompt for token / channel id, walk them through adding the bot as admin. `deleteWebhook` at the end. Store `TELEGRAM_BOT_TOKEN` (secret), username, channel id, title.

### Step 3 — Cloudflare authentication
1. Try the stored path first: locate wrangler's global config (legacy `~/.wrangler` if that dir exists, else `${XDG_CONFIG_HOME:-~/.config}/.wrangler` on Linux, `~/Library/Preferences/.wrangler` on macOS, `%APPDATA%/xdg.config/.wrangler` on Windows) + `/config/default.toml`; read `oauth_token`.
2. Validate it: `GET /memberships` with `Authorization: Bearer`. 401 → needs login. Success → we are done, no browser.
3. If login is needed: check `DISPLAY`/`SSH_CONNECTION` and that TCP **8976** is free. If the port is busy, say so by name and offer the token path — do not let wrangler die on an uncaught `EADDRINUSE`. If headless, say so up front and offer (a) `ssh -L 8976:localhost:8976`, (b) the pasted-token fallback.
4. Print one line explaining what the consent screen is, then run `wrangler login` with **no `--scopes`**, inherited stdio, clean env (R3). Cloudflare's own client `54d11594-84e4-41aa-b438-e81b8fa78ee7`, callback `http://localhost:8976/oauth/callback`. Nothing of ours is involved.
5. Fallback path (headless/CI/refusal): keep `verifyToken()` from `cloudflare.mjs:112` verbatim — it probes each capability separately and names the missing permission. Store as `DC_CF_TOKEN`, never as `CLOUDFLARE_API_TOKEN`.
6. Run `wrangler whoami` once to force a refresh, re-read the TOML, and use the fresh `oauth_token` as the bearer for all subsequent REST.

### Step 4 — Account selection
`GET /memberships`. Exactly one → take it. More than one → prompt in OUR UI. Persist `CLOUDFLARE_ACCOUNT_ID` and inject it into every child process from here on.

### Step 5 — workers.dev subdomain (new; a guaranteed first-run failure otherwise)
`GET /accounts/{id}/workers/subdomain`. On error code **10007** the account has never registered one: prompt for a subdomain and `PUT` it ourselves, or send them to `https://dash.cloudflare.com/<account>/workers/onboarding` and re-probe. Must happen BEFORE any deploy.

### Step 6 — D1 database
Probe `GET /accounts/{id}/d1/database?per_page=100`, match on `<worker>-db`. Absent → `POST` to create. Read `uuid`. Never parse `d1 create` stdout.

### Step 7 — Schema
Import `MIGRATION_SQL` from `schema/schema.mjs` — the single definition the hosted provisioner imports too — split it with `splitStatements`, and run each statement via `POST /accounts/{id}/d1/database/{uuid}/query` with real `{sql, params}` binding. Tolerate `already exists` / `duplicate column` — re-running is normal. Then verify by querying `sqlite_master` for the expected table set, so 'migrated' means observed, not assumed.

> This step used to scrape the SQL out of `deployment-service/src/index.ts` as text. That is what let the two provisioners drift apart over `zke_password`; do not reintroduce it.

### Step 7b — Encryption key material
The schema seeds `zke_password` / `zke_salt` **empty** and the worker refuses uploads while they are (fail-closed, not plaintext). `selfhost/src/zke.mjs` fills them, from `setup`, `update` **and** `doctor` — existing installs are already in the broken state and need a repair path. It writes only when a successful read shows no password: a read that fails is "unknown", and unknown writes nothing, because rotating a live key makes every stored photo undecryptable.

### Step 8 — Generate and store the local secrets
`SESSION_SECRET` and `STORAGE_KEY`: generate if absent, and never regenerate silently. Print the STORAGE_KEY warning loudly, once: lose this and files already in Telegram cannot be decrypted.

### Step 9 — Deploy the worker
Write the generated toml to `os.tmpdir()` with an **absolute** `main` (verified working via dry-run), 0600, unlink in `finally`. `wrangler deploy --config <tmp>` with `WRANGLER_OUTPUT_FILE_PATH` set; read `targets[0]` from the NDJSON `{"type":"deploy"}` entry as `WORKER_URL`. Then `wrangler secret put SESSION_SECRET` and `wrangler secret put ENCRYPTION_MASTER_KEY`, each over a piped stdin (`child.stdin.write(v); child.stdin.end()`), never argv. Verify by fetching `WORKER_URL/health`.

### Step 10 — Firebase (mostly automated; one unavoidable manual step)
1. Probe: if `FIREBASE_PROJECT_ID` + `FIREBASE_API_KEY` are set, do a live `signInWithPassword`. Passing means all of the below already landed. Reuse `explainFirebaseError()` (setup.mjs:367) as the error map; add `CONFIGURATION_NOT_FOUND` and `Firebase Tos Not Accepted`.
2. Auth: `npx firebase-tools login` (Google's own verified client, ephemeral localhost port, grants `cloud-platform`). Then read the refresh token from `~/.config/configstore/firebase-tools.json` and mint access tokens via `POST https://www.googleapis.com/oauth2/v3/token`. **Do all subsequent work over REST, not via the firebase CLI**, so Google's real error codes survive.
3. Project: `POST cloudresourcemanager/v1/projects` → poll → `POST firebase.googleapis.com/v1beta1/projects/{id}:addFirebase` → poll.
4. **The one manual step**: if `:addFirebase` returns PERMISSION_DENIED matching `/Tos Not Accepted/i`, print exactly — *'Open https://console.firebase.google.com, create any project, accept the terms when prompted, then delete it. This is once per Google account. Re-run this command afterwards.'* Adopt or delete the orphaned GCP project first so the retry does not hit a 409.
5. Email/Password: `PATCH https://identitytoolkit.googleapis.com/admin/v2/projects/{id}/config?updateMask=signIn.email.enabled,signIn.email.passwordRequired`. On `404 CONFIGURATION_NOT_FOUND`, `POST v2/projects/{id}:identityPlatform:initializeAuth` first, then retry.
6. Web app + key: `POST v1beta1/projects/{id}/webApps` (poll the LRO), then `GET v1beta1/projects/-/webApps/{appId}/config` → `apiKey`. Reuse an existing web app if one is registered.
7. Admin user: `POST v1/accounts:signUp` with the bearer token, `targetProjectId` and `emailVerified:true` (better than the public API-key route — no unverified-email prompt later). Prompt for the password, show it once, never write it to config. Store the returned `localId` as `FIREBASE_USER_ID`.
8. Degradation ladder: full automation → on ToS/quota failure offer **'pick an existing Firebase project'** (`GET v1beta1/projects`, then run 5-7 against it, which sidesteps both failure modes) → only then fall back to today's manual console walkthrough.

### Step 11 — Runtime config into D1
Write the `telegram` config row (bot token, username, channel id, and `heicConvertUrl` once step 12 runs) via the REST query endpoint with bound params. If a wrangler d1 path is ever needed instead, hex-encode: `CAST(x'<hex>' AS TEXT)`.

### Step 12 — HEIC processor on Vercel (optional; default yes)
Delete the Render walkthrough at setup.mjs:512-527 — `processor/` is a Vercel serverless function now (vercel.json rewrites `/health` and `/convertHeicThumbnail` to `api/convert.js`), with no render.yaml in the tree.
1. `vercel login` — RFC 8628 device flow with Vercel's own client id (verified in dist), prints a code and a URL, **works headless with no port forwarding**. Token lands in `auth.json` under `com.vercel.cli`, so subprocesses pick it up.
2. `vercel deploy --cwd processor --yes --prod --project <name> -e OWNER_UID=<FIREBASE_USER_ID> -F json` (all flags verified against CLI 57.0.0). Parse the JSON for the URL. Gitignore the `.vercel/` link dir it drops into `processor/`.
3. Verify: `GET <url>/health`, require `service` to contain `daemonclient`, surface any `problems[]`. Keep the existing 60s timeout and the 'a sleeping free instance takes a minute to wake' message.
4. Keep 'skip' and 'I already have one, here is the URL' as first-class options — everything works without it, HEIC thumbnails just stay blank.

### Step 13 — Dashboard on Cloudflare Pages (optional)
1. Write `accounts-portal/.env.selfhost` with the VITE_* values, `npx vite build --mode selfhost`.
2. **`wrangler pages project create <name> --production-branch main`**, tolerating 'already exists'. Non-negotiable: without it the deploy throws 'This command cannot be run in a non-interactive context'.
3. `wrangler pages deploy dist --project-name <name> --commit-dirty=true` — note `pages deploy` accepts **no** `--config`, so account context goes through the env. Read the URL from the NDJSON `{"type":"pages-deploy"}` entry.
4. Add the resulting origin (plus Photos/Drive URLs) to `ALLOWED_ORIGINS` and redeploy the worker, or CORS blocks everything.
5. Keep the 'just build it, I will upload dist/ myself' option.

### Step 14 — Finish
Print worker URL, sign-in email, bot → channel, processor URL, dashboard URL. Print the absolute config path and the STORAGE_KEY backup warning. List `daemonclient status | doctor | update | processor | dashboard | config --edit`.

---

## Implementation order

1. **`src/config.mjs`** replacing both `state.mjs` and `env.mjs` (dotenv-accurate parse with line numbers, XDG path resolution, 0600, redact). Migrate `test/selfhost.test.mjs` off `state.mjs`, then delete it — two live config modules is worse than either one.
2. **`src/api/cloudflare.mjs` rewrite**: `childEnv()`, the wrangler mutex, TOML token reader, REST client, and the whole ctx-based resource API. Delete `--param` and `subdomain get`.
3. **`src/api/firebase.mjs`** (new): login shell-out + the five REST calls.
4. **`src/api/vercel.mjs`** (new): login shell-out + deploy + health probe.
5. **`src/commands/setup.mjs` rewrite** as `probe/repair/verify` per subsystem, with `doctor` as `--no-repair` over the same list. Note the current file is broken anyway (it calls `cf.enableWorkersDev`, which does not exist, and passes the old positional signature to ctx-based functions), so this is a rewrite, not a refactor.
6. Pin `wrangler` in `selfhost/package.json`; decide 3.114.17 vs 4.114.0 (v4 removes the every-invocation 'legacy version' nag, which matters in a first-run CLI for non-experts; nothing we depend on changes semantically).
7. Note in `docs/roadmap/CLOUDFLARE_OAUTH.md` that `ffa260b791c9a72c5020dacaa5c1035f` is deliberately hosted-only and is **not** part of the self-host path.

## What the user actually does, end to end

Best case (returning Google account, desktop with a browser): paste a Telegram bot token, add the bot to a channel, click Allow twice (Cloudflare, Google), type an email and password, click Allow once more (Vercel). Everything else is automatic.

Worst case (brand-new Google account): the above, plus one visit to console.firebase.google.com to accept the Firebase terms, then re-run. Once per Google account, ever.

Headless VPS: the above, but Cloudflare needs either `ssh -L 8976:localhost:8976` or a pasted API token. Vercel and Firebase are fine as-is.