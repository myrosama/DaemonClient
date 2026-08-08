# This directory is a fork of Immich

Upstream: <https://github.com/immich-app/immich> — AGPL-3.0, copyright the
Immich contributors. `README.md` in this directory is theirs. This file
describes what DaemonClient changed and why.

**If you want a conventional self-hosted photo server on your own hardware, use
Immich itself.** It is excellent, actively developed, and this project would not
exist without it. DaemonClient is a different trade: no server, no hardware, no
Docker, storage in your own Telegram channel.

## What we use, and what we do not

| Path | Status |
|---|---|
| `web/` | **live** — deployed to `photos.daemonclient.uz` |
| `mobile/` | forked, **not released**, not currently worked on |
| `server/`, `machine-learning/`, `docker/`, `e2e/`, `cli/` | upstream code, not deployed by us |

The upstream **server is not used at all**. Everything it does is done by
[`../immich-api-shim`](../immich-api-shim), a Cloudflare Worker that impersonates
the Immich API closely enough that these clients work against it unmodified.
That is the whole trick: we did not rewrite a photo app, we rewrote the server
it talks to.

## What actually changed

Less than you would expect, and that is deliberate — every divergence is a merge
conflict forever.

**Web (`web/`)**

- `src/service-worker/index.ts` — rewrites `/api/*` to the user's own worker,
  and intercepts asset binary requests so the browser fetches chunks straight
  from Telegram and decrypts them locally instead of proxying through the
  worker. This is what keeps the free tier viable.
- `src/service-worker/telegram-media.ts` — chunk arithmetic, including mapping
  an HTTP `Range` onto the specific 19 MB chunks that cover it.
- `src/lib/utils/daemonclient-drive.ts` — client-side chunked upload: slice,
  AES-GCM encrypt, `sendDocument` to Telegram, post the manifest to the worker.
- `src/lib/utils/sso.ts` — the cross-app sign-in handshake.
- Branding, and a build-time worker URL so a self-host build never points at us.

**Mobile (`mobile/`)**

Eight changed files over stock Immich: an app id, a display name, icons, a
default server URL, and one file carrying real logic
(`lib/services/background_upload.service.dart`).

**So "fix the mobile app" almost always means "fix the worker's API".** The app
is not broken; the server tells it something it cannot parse, or 404s a route it
calls. Debug the worker first.

## The constraint this fork imposes on the worker

The mobile client parses the sync stream in a **strict Dart isolate**. One value
of an unexpected type — an integer where a boolean belongs, a string outside an
enum — throws. The batch is then never acked, so the server replays the same
record forever, and backup is gated on sync succeeding at five separate call
sites. A single bad value stops backup permanently, on every trigger.

This is why `immich-api-shim/src/sync.ts` writes `!!photo.isFavorite` rather
than passing the raw column through, and why anything it emits needs a test.

## Keeping up with upstream

There is no automated merge. The fork is pinned and updated deliberately, since
each upstream release can touch the service worker and the API surface at once.
Before pulling upstream changes, read
[`../docs/API.md`](../docs/API.md) — it records which routes our worker actually
implements, and an upstream change that starts calling a new one will get a
shaped empty response rather than data.
