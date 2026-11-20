# deployment-service — the managed-service provisioner

Deployed as the `daemonclient-deployment` Cloudflare Worker.

When someone signs up for the hosted service, this creates their stack: a
Cloudflare Worker running the API, a D1 database with the schema applied, the
bindings and secrets to connect the two, and the encryption keys the worker
needs. It also ships them updates afterwards.

**Not part of self-hosting.** A self-hoster runs [`selfhost/`](../selfhost)
instead, which does the same job from their own machine. The two exist
separately because of one asymmetry that cannot be removed: we hold a managed
user's Cloudflare token and can push to them; we do not hold a self-hoster's,
and an install we *could* push to would not be self-hosted.

## The fact that shapes everything here

`provisionWorker()` deploys using the **user's own** `accountId` and `apiToken`.
Every hosted user's worker lives in **their own Cloudflare account**, not ours.

Two consequences worth internalising:

- **There is no fleet to deploy to.** Listing our Cloudflare account shows one
  worker — the operator's own. The only channel for getting a fix to a hosted
  user is this service redeploying their worker with their stored credentials.
- **So this service is the delivery path.** However clean the worker code is,
  if auto-update is broken then nothing we fix reaches anybody.

## Routes

| Method | Path | Auth |
|---|---|---|
| POST | `/deploy-worker` | Firebase ID token |
| POST | `/oauth/cloudflare/exchange` | Firebase ID token |
| POST | `/auto-update` | Firebase ID token |
| POST | `/validate-cf-token` | Firebase ID token |
| POST | `/admin/force-update` | `X-Admin-Secret` |
| POST/DELETE | `/admin/announce` | `X-Admin-Secret` |

`/auto-update` is called fire-and-forget on every login. It compares the
embedded shim version against what the user's worker is running and redeploys
if they have drifted, so fixes land without the user doing anything.

## The embedded bundle

`src/shim-bundle.ts` is generated, not written — it is the built
`immich-api-shim` worker as a string, so this service can deploy it via the
Cloudflare API without a build step at runtime. It is gitignored. Regenerate it
with `scripts/embed-shim.mjs` as part of the four-step deploy documented in
[../immich-api-shim/README.md](../immich-api-shim/README.md).

If you change the worker and skip the embed step, you have shipped nothing.

## Schema

Imported from [`../schema/schema.mjs`](../schema) — the same module the
self-host CLI uses. Do not add a second copy here. There used to be three
definitions of the schema, and that is precisely how managed and self-hosted
installs came to disagree about whether encryption keys had been seeded.

## Running it

```bash
npm install
npm run typecheck
npm test
```
