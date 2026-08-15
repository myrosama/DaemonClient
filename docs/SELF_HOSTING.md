# Self-hosting DaemonClient

Run the whole thing yourself, on accounts you own. Nothing touches our servers —
not your files, not your credentials, not even a telemetry ping.

You need three things, all free:

| | | |
|---|---|---|
| **Telegram** | a bot and a private channel | stores your files |
| **Cloudflare** | Workers + D1 on the free plan | runs the API |
| **Node 18+** | on the machine you set up from | runs the setup |

One more is optional: a small **media processor** (also free) that turns iPhone
HEIC photos into grid thumbnails. Skip it and everything still works — HEIC
photos just show no grid thumbnail. (Every other format is thumbnailed by
Telegram automatically.)

---

## Setup

```bash
git clone https://github.com/myrosama/DaemonClient.git
cd DaemonClient/immich-api-shim && npm install && cd ..
node selfhost/bin/daemonclient.mjs setup
```

The setup asks for each credential in turn, tells you exactly where to get it,
and checks it against the real service before moving on. It saves after every
step, so if you stop halfway (or something fails) you can run it again and pick
up where you left off.

It takes about ten minutes, most of which is you clicking around in Telegram and
Cloudflare.

### What it will ask for

**A Telegram bot token.** Message [@BotFather](https://t.me/botfather), send
`/newbot`, answer two questions, copy the token.

**A channel.** Make a new private channel, add your bot to it as an
administrator with permission to post, edit and delete messages. Forward any
message from the channel to [@userinfobot](https://t.me/userinfobot) to get the
channel id (it looks like `-1001234567890`).

The setup does not take your word for any of this: it posts a message to the
channel and deletes it again, because a bot can be a member of a channel and
still be unable to write to it.

**A Cloudflare API token.** At
[dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens),
create a **Custom Token** with exactly these permissions:

- Account · Workers Scripts · Edit
- Account · D1 · Edit
- Account · Account Settings · Read

Do not use a Global API Key. The custom token can create your worker and
database and nothing else.

**An email and password.** This is the account you will sign in with, in the
web apps. It lives in **your own Firebase project** — Firebase Authentication,
under your Google account. There is no public signup page, and nobody can
create an account on your server but you.

### When it finishes

You get a summary with your API address, something like
`https://daemonclient-a1b2c3.yourname.workers.dev`. That address is your server.

---

## Using it

### Mobile app

Install the DaemonClient app, and on the login screen enter your API address as
the server URL, then your email and password. Backup works exactly as it does on
a managed account.

### Web apps — one command

The web side is three apps, all in this repo: the **dashboard** (your main page —
sign in, then open Photos or Drive), **Photos**, and **Drive**. One command builds
all three from your own checkout, each pointed at *your* worker and *your*
Firebase, and deploys them to **Firebase Hosting** on your own project (free):

```bash
daemonclient web
```

It builds, creates three Firebase Hosting sites, deploys, and adds their addresses
to your worker's `ALLOWED_ORIGINS` for you. Firebase Hosting deploy signs in with
your own Google account (`firebase login` — a browser opens; nothing reaches us).
When it finishes you get three addresses:

```
https://<project>.web.app          ← dashboard (open this one)
https://<project>-photos.web.app   ← Photos
https://<project>-drive.web.app    ← Drive
```

Open the dashboard, sign in, and open Photos or Drive from there.

**Prefer to run them yourself, or deploy elsewhere?** Each app takes its worker
URL from a build-time variable, and defaults to the operator's host *only* when
you are not building for self-host — so a self-host build never points at us:

| App | Build with |
|---|---|
| Photos (`immich/web`) | `PUBLIC_SELF_HOST=1 PUBLIC_DAEMONCLIENT_WORKER_URL=<your-worker> npm run build` |
| Drive (`drive`) | `VITE_SELF_HOST=1 VITE_API_BASE=<your-worker> npm run build` |
| Dashboard (`accounts-portal`) | `VITE_SELF_HOST=1 VITE_API_BASE=<your-worker> VITE_FIREBASE_API_KEY=… VITE_FIREBASE_AUTH_DOMAIN=<project>.firebaseapp.com VITE_FIREBASE_PROJECT_ID=<project> VITE_PHOTOS_URL=… VITE_DRIVE_URL=… npx vite build --mode selfhost` |

Then host the built folders anywhere static (Firebase Hosting, Cloudflare Pages,
Netlify, your own nginx) and add each address to `ALLOWED_ORIGINS`, or the
browser blocks its API calls.

`daemonclient web` and `daemonclient dashboard` add the addresses *they*
create, but there is no command for adding one of your own: edit
`allowedOrigins` in `.daemonclient-selfhost.json` and run `daemonclient update`,
or set the variable directly in the Cloudflare dashboard. For local dev,
`npm run dev` in `immich/web` or `drive` works too — set the same variables.

---

## Day to day

```bash
daemonclient status      # what is running, and is it healthy
daemonclient update      # rebuild from the current source and redeploy
daemonclient dashboard   # build the dashboard and deploy it to Cloudflare Pages
daemonclient processor   # add or change the media processor
daemonclient doctor      # diagnose a broken install
```

(Either run them as `node selfhost/bin/daemonclient.mjs <command>`, or
`npm link` inside `selfhost/` once to get the `daemonclient` command.)

### Updates

Your worker checks GitHub once a day for a newer release and shows a note on the
dashboard when there is one. It never updates itself — that stays your decision,
and your server never phones home to us.

To take an update:

```bash
git pull
daemonclient update
```

`update` re-applies any new database changes, rebuilds from the source in your
folder, and redeploys. Your files, database and sign-in are untouched, and it
deliberately reuses your existing secrets: a new session secret would sign you
out everywhere, and a new encryption key would make files already in Telegram
unreadable.

---

## The optional media processor

Cloudflare Workers cannot decode HEIC — not a limitation of this project, just
more CPU than a worker is allowed to use. The processor is a small service that
does that one job, so iPhone photos get a grid thumbnail.

**Deploy it free on Vercel:**

```bash
cd processor
npx vercel deploy --prod
```

Then set two environment variables on the Vercel project (dashboard → Settings →
Environment Variables) and redeploy:

| Variable | Value |
|---|---|
| `FIREBASE_PROJECT_ID` | the Firebase project your install uses — **required**; the processor rejects every request while it is unset |
| `OWNER_UID` | your user id (the setup summary and `daemonclient processor` both show it) so only your account can use that instance |

Then connect it:

```bash
daemonclient processor
```

and paste the URL.

The handler in `processor/api/convert.js` is a single stateless function, so it
runs unchanged anywhere that speaks the standard `Request`/`Response` interface —
Netlify Functions, Cloudflare Pages Functions, Firebase Functions. Free instances
sleep when idle and take a moment to wake; that is fine, because a conversion that
fails against a sleeping instance is retried a few minutes later, by which point
the failed request has woken it.

---

## Where your data lives

```
  your phone / browser
          │
          ▼
  your Cloudflare Worker  ──── your D1 database (file index, settings, keys)
          │
          ▼
  your Telegram bot  ────────► your private channel (encrypted file chunks)
```

Files are encrypted with AES-256-GCM before they reach Telegram. Drive encrypts
in your browser, so not even your own worker sees plaintext. Photos encrypts on
your worker, which is what allows thumbnails, EXIF and deduplication to work.

**Two things you must not lose:**

- **Your encryption keys**, which live in your **D1 database** as the
  `zke_password` and `zke_salt` rows — and nowhere else. Back them up with
  `daemonclient doctor --show-keys`. Losing them means losing access to every
  file already in Telegram.
- `.daemonclient-selfhost.json` in your clone. It holds your Cloudflare and
  Telegram tokens and your session secret — **not** your encryption keys. It is
  created readable only by you and is gitignored. Worth backing up, but backing
  up only this file does not protect your photos.
- The Telegram channel. Deleting it, or removing the bot, or deleting messages
  in it, destroys the files. The index in D1 will still list them, but the bytes
  will be gone.

If you lose the encryption key, files already stored cannot be recovered. There
is no backdoor, by design.

---

## If you set this up before 27 July 2026

Read this once, then you can forget it.

**What happened.** Setting up an install used to leave it with encryption
switched *on* and no key to encrypt with. The schema created the
`zke_password` and `zke_salt` rows empty and a second step filled them — the
hosted service ran that step, the setup command never did. The worker treated
"no key" and "encryption is off" as the same thing, so it stored your photos
in Telegram **unencrypted, under their original filenames**, while
`/api/assets/zke-status` and the padlock in the web app both reported
encryption as on.

**Are you affected?** Only self-hosted installs, and only photos uploaded
before you update. Run:

```bash
daemonclient doctor
```

If it says *"This install had no encryption keys — uploads were being
refused"*, you were affected and it has just fixed the cause. If it says
*"Encryption keys present"* and you have never seen an upload refused, your
keys were fine.

**What to do about photos already uploaded.** They are in your own Telegram
channel, in the clear. Nobody else has them unless somebody else can read that
channel — check who is in it, and check whether the channel is private. Nothing
can retroactively encrypt them, so there are two honest options:

- **Leave them.** They are in a private channel you control. If that is
  acceptable to you, it is a reasonable answer.
- **Delete and re-upload.** Remove the affected photos from the app so it
  clears the Telegram messages too, confirm `daemonclient doctor` reports keys
  present, then upload them again. They will be encrypted this time.

There is no third option, and anyone telling you the files can be encrypted
where they sit is wrong.

**Two related things changed at the same time:**

- **The worker now refuses an upload it cannot encrypt** rather than quietly
  storing it in the clear. If uploads start failing with *"Encryption is
  enabled for this install but its key material is missing"*, run
  `daemonclient doctor` — that is what generates them.
- **The `STORAGE_KEY` in your config file was never used for anything.** The
  CLI generated it, called it your "File encryption key", warned you that
  losing it would lose your files, and shipped it to the worker under a name
  the worker never read. It is gone. What actually decrypts your photos is
  `zke_password` and `zke_salt` in your D1 database, they exist nowhere else,
  and `daemonclient doctor --show-keys` prints them so you can back them up.

---

## Troubleshooting

**Start here:** `daemonclient doctor`. It checks every part in turn and prints
what to run for each problem it finds. The report it prints has every secret
removed, so it is safe to paste into an issue.

**"Cannot reach the server" in a web app.** The address you are serving the app
from is not in `ALLOWED_ORIGINS`. If `daemonclient web` deployed the app, re-run
it. If you are hosting it yourself, edit `allowedOrigins` in
`.daemonclient-selfhost.json` and run `daemonclient update`, or set the variable
in the Cloudflare dashboard under your worker.

**Uploads fail with 413.** Cloudflare's free plan caps request bodies at 100 MB,
so single files above that cannot be uploaded from mobile. Known limitation.

**HEIC photos have blank thumbnails.** Expected without a processor — see above.
(Other formats, including videos, are thumbnailed by Telegram, so they are
unaffected.)

**Everything worked, then stopped after a while.** Check
[Cloudflare's free tier limits](https://developers.cloudflare.com/workers/platform/limits/):
100,000 worker requests a day, and D1 has its own read/write allowances. A big
library being browsed hard can reach them.

---

## Questions people ask

**Can other people use my server?** No — but not for the reason you might
expect, so it is worth being precise.

Firebase email/password signup is **open by default**, and your web apps ship
their Firebase Web API key in the browser bundle, as every Firebase app does.
So a stranger *can* register an account in your project. What stops them
reaching your files is the worker's **owner gate**: one install belongs to one
account, and every authenticated route is checked against it. An account that
is not the owner gets nothing, however it was created.

If you would rather they could not register at all, turn off self-registration
in the Firebase console under Authentication → Settings → User actions.

So an install belongs to exactly one person. If someone else wants one, they
run their own; that is the whole point of the architecture and it costs them a
free Cloudflare account.

**How do I change my password?** In your Firebase console, under
Authentication → Users. It is your project, so account management happens
there rather than through this CLI.

**Does it phone home?** No. Roughly twice a day the worker makes an anonymous
GET to GitHub's public releases endpoint to ask whether a newer version exists.
It sends nothing about your install — no id, no domain, no usage — and the
result is cached in your own database.

There is currently **no switch to turn it off**: clearing `UPDATE_REPO` falls
back to a default rather than disabling the check. If that matters to you,
block the request at your network edge, or say so in an issue and it will get a
proper opt-out.

**Is this really free?** Yes, within the free tiers of Telegram, Cloudflare and
(if you use it) Vercel. There is no paid version of self-hosting and no key to
buy.

**What if this project disappears?** You keep everything. Your files are in your
Telegram channel, your index is in your D1 database, and the code is in your
clone under an open licence. Nothing here can be switched off remotely.
