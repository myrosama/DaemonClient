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

Then set two environment variables in the Vercel dashboard **and redeploy** (the
first deploy has neither, so it rejects every request until they are set):

| Variable | Value |
|---|---|
| `FIREBASE_PROJECT_ID` | the Firebase project your DaemonClient uses — **required**; without it every request is rejected |
| `OWNER_UID` | your user id — `daemonclient processor` prints it |

Vercel runs this on its **Node.js runtime, not Edge**: decoding HEIC through
libheif's WASM is computationally intense, which is the workload Vercel documents
its Node.js runtime for (more CPU, memory and bundle headroom than an Edge
Function on the free plan). `api/convert.js` exports the `{ fetch }` form that
runtime serves — do not switch it to the edge runtime.

The core is the exported Web-standard `handler(request)` in `api/convert.js`.
Hosts that speak the Web `Request`/`Response` interface — Netlify Functions,
Cloudflare Workers — can import and re-export it directly. Firebase Functions and
Cloudflare Pages Functions use Node `(req, res)` / `onRequest` signatures, so they
need a small `Request`↔`(req, res)` adapter around it.

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
