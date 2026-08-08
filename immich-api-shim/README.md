# immich-api-shim — the per-user API worker

This is the product. Everything else provisions it, deploys it, or talks to it.

One Cloudflare Worker holds the entire API for Photos, Drive, WebDAV and the
mobile app: uploads, chunking, encryption, Telegram I/O, the D1 index, the
timeline, albums, search, the sync stream, and a set of background repair jobs.
It impersonates an Immich server closely enough that a stock Immich client works
against it, while storing every byte in the user's own Telegram channel.

## The same tree is deployed twice

| Deployment | `env.DB` | What it does |
|---|---|---|
| `dc-<id>` — one per user | bound | the complete API for exactly one person |
| `immich-api` — one, shared | **absent** | validates a login against Firebase and returns that user's `workerUrl`. Holds no data. |

`env.DB` is the only switch, and it changes behaviour in roughly forty places.
When you add a code path, decide which deployment it belongs to; a route that
touches user data and does not check for `env.DB` is a bug on the shared worker.

A self-hosted install is this same worker a third time, with `SELF_HOST=1` and
the user's own Firebase project.

## Layout

| File | Responsibility |
|---|---|
| `index.ts` | env interface, routing by path prefix, `/api/health`, `/proxy`, self-host status |
| `helpers.ts` | `requireAuth` — the single authentication chokepoint — plus Firestore reads and caches |
| `owner-gate.ts` | one install, one owner. Enforced inside `requireAuth`, not per route |
| `firebase-token.ts` | RS256 verification of Firebase ID tokens against Google's certs |
| `auth.ts` | login, logout, status, and `/api/auth/exchange` (the cross-app sign-in) |
| `assets.ts` | the big one. Upload, chunking, encryption, thumbnails, EXIF, media serving |
| `asset-manifest.ts` | the tiny JSON the service worker uses to read bytes straight from Telegram |
| `timeline.ts` | month buckets, and the round-robin dispatch of background repair jobs |
| `sync.ts` | the mobile sync stream. The most fragile contract in the product |
| `albums.ts`, `search.ts`, `user.ts` | the Immich surface those clients expect |
| `drive.ts`, `webdav.ts` | Drive's metadata API and its WebDAV mount |
| `stubs.ts` | shaped empty responses for the Immich features this product does not implement |
| `selfhost-auth.ts` | `isSelfHost`, `sessionScope` — the five places behaviour diverges |
| `update-check.ts` | compares the running build against public GitHub releases |

## Running it

```bash
npm install
npm test           # vitest — 294 tests
npx tsc --noEmit   # types
```

Both are what CI runs. Please run both before opening a PR.

## Things that will bite you

**Cloudflare free tier: 10 ms CPU, 128 MB, 50 external subrequests.** Exceeding
any of them does not degrade — the invocation is killed with error 1102 and the
error page carries no CORS headers, so the browser reports a CORS failure.
Background jobs share the budget with the request that spawned them, which is
why `timeline.ts` dispatches exactly one job per request.

**Telegram caps bot downloads at 20 MB.** Files are stored in 19 MB chunks and
stitched on read. Never merge chunks into a larger file — you will not be able
to fetch it back.

**The mobile sync stream is parsed in a strict Dart isolate.** An integer where
a boolean belongs, or a string outside an enum, throws; that aborts *all* sync,
permanently, because the next attempt replays the same batch. Anything `sync.ts`
emits needs a test.

**Module scope survives between requests.** Cloudflare reuses isolates. On a
per-user worker that is useful caching; on the shared `immich-api` worker it
means one user's data can outlive their request.

**Tests run on Node, the worker runs on workerd.** They are not the same
runtime. `importKey('spki')` with trailing bytes passes in Node and fails live —
that shipped once. When you touch WebCrypto or streams, verify against a real
deploy.

## Deploying

Four steps, and missing one ships nothing:

```bash
npx wrangler deploy --dry-run --outdir dist        # build the bundle
node ../deployment-service/scripts/embed-shim.mjs  # embed it for the fleet
cd ../deployment-service && npx wrangler deploy    # ship the provisioner
cd ../immich-api-shim && npx wrangler deploy       # ship the shared worker
```

Then grep the regenerated `deployment-service/src/shim-bundle.ts` to confirm
your change actually reached the artefact users run. Wait ~30 seconds before
checking anything live; deploys propagate, and a too-fast check has produced a
false result more than once.

See [../docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md) for how this fits
together and [../docs/API.md](../docs/API.md) for the route-by-route contract.
