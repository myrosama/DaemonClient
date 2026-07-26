# DaemonClient processor

A single serverless function that turns HEIC into JPEG. No container, no server,
nothing running when nobody is using it.

## Why it exists

Cloudflare Workers cannot decode HEIC — libheif needs far more CPU than a Worker
invocation is allowed. Everything else in DaemonClient is serverless and free,
so this is too: one stateless function on a free tier, per user.

Without it, iPhone photos still upload and download perfectly; their grid
thumbnails just stay blank until you add one.

## Privacy

Every user runs their own instance. A worker only ever calls the URL stored in
its own config, and each request is verified against that user's own Firebase
project. Nothing is written to disk: bytes arrive in a request, are converted in
memory, and leave in the response.

Set **`OWNER_UID`** and the instance serves exactly one account — a leaked URL is
useless to anyone else.

## Deploy it

**Vercel** (free hobby tier):

```bash
cd processor
npx vercel deploy --prod
```

Then set two environment variables in the Vercel dashboard, or pass them inline:

| Variable | Value |
|---|---|
| `FIREBASE_PROJECT_ID` | the Firebase project your DaemonClient uses |
| `OWNER_UID` | your user id — `daemonclient processor` prints it |

Anywhere else that runs a standard `Request`/`Response` handler works too:
Netlify Functions, Cloudflare Pages Functions, Firebase Functions. The handler
in `api/convert.js` is the whole thing.

## Connect it

```bash
daemonclient processor
```

Paste the deployment URL. The CLI checks it, warns if `OWNER_UID` is unset, and
saves it to your worker's config. Missing thumbnails fill in over the next few
minutes as the app is used.

## Endpoints

| | |
|---|---|
| `POST /convertHeicThumbnail` | HEIC bytes in, downscaled JPEG out. Requires a Firebase ID token. |
| `GET /health` | Unauthenticated readiness and capability check. Exposes no user data. |
