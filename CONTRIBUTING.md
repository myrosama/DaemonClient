# Contributing

Thanks for looking. This project is small and the codebase is opinionated, so
this page is mostly about saving you time: what lives where, what the awkward
constraints are, and which mistakes have already been made so you don't have to
repeat them.

## Getting oriented

Start with the [README](README.md) for what the thing is, then:

| You want to work on | Go to |
|---|---|
| The API — uploads, sync, thumbnails, albums, Drive | `immich-api-shim/` |
| Provisioning and fleet updates for hosted accounts | `deployment-service/` |
| Signup, setup wizard, dashboard | `accounts-portal/` |
| The Photos web app | `immich/web/` (a fork) |
| The mobile app | `immich/mobile/` (a fork) |
| The Drive web app | `drive/` |
| Self-hosting CLI | `selfhost/` |
| HEIC conversion | `processor/` |

`immich-api-shim` is where most of the interesting problems are.

## Running things

```bash
cd immich-api-shim
npm install
npm test          # vitest
npx tsc --noEmit  # types
```

The tests are fast and there are a lot of them. Please run both before opening a
PR — CI runs the same two commands.

To try a change against a real backend you need your own stack. The self-hosting
setup builds one in about ten minutes on free tiers:

```bash
node selfhost/bin/daemonclient.mjs setup
```

Never test against someone else's deployment, including ours.

## The constraints that shape this code

Most of the strange-looking decisions come from four hard limits. If a change
looks unnecessarily convoluted, it is probably one of these:

**A Cloudflare Worker gets ~50 subrequests, 128 MB, and very little CPU per
request.** Background jobs share that budget with the request that spawned them.
Exceeding it does not degrade — Cloudflare kills the whole invocation with error
1102, and the user sees "sync failed". This is why background work is rotated
one job per request rather than run together.

**Telegram caps bot downloads at 20 MB.** Everything is stored in 19 MB chunks
and stitched back on read. Never merge chunks into one larger file: you will not
be able to fetch it again.

**The mobile app parses the sync stream in a strict Dart isolate.** One
unexpected value — an integer where a boolean belongs, a string outside an enum
— throws, and that aborts *all* sync, permanently, because the next attempt
replays the same stream. Anything emitted by `sync.ts` needs a test.

**The free tier is the product.** A change that only works on a paid plan is not
a change we can take. If something needs real CPU it goes in `processor/`, which
each user deploys themselves.

## House style

- **Comments explain why, never what.** If a line is odd, say what breaks
  without it. Ideally name the symptom a user would have reported.
- **Tests describe the failure, not the function.** `deletes the duplicate
  before emitting the survivor that takes over its checksum` beats `test dedup`.
  When you fix a bug, the test name should be recognisable to whoever reported
  it.
- Match the surrounding code. There is no linter argument to have.
- No new dependencies in `selfhost/` — it must run from a fresh clone with
  nothing installed.

## Pull requests

Small and focused. One behaviour change per PR, with the reasoning in the
description: what was wrong, how you know, and what you did about it.

For a bug fix, please include a test that fails before your change. Several
bugs in this codebase have been fixed twice because the first fix had no test.

## Security

**Do not open a public issue for a vulnerability.** See [SECURITY.md](SECURITY.md).

Be especially careful around:

- Anything touching `requireAuth` or session signing. There have been two
  complete authentication bypasses here; both looked innocuous in review.
- Anything that widens what `/proxy` will fetch. It relays to Telegram and
  nothing else, on purpose.
- Query strings built from user input, and per-user data reached without an
  owner filter.

## What is unlikely to be merged

- Storing files anywhere other than the user's own Telegram channel. Unlimited
  free storage is the entire premise; object storage would end the project.
- Anything that makes a self-hosted install depend on infrastructure we run.
  Self-hosting means self-hosting.
- Telemetry, analytics, or crash reporting that phones home.
- Bumping dependencies with no explanation of what it fixes.

## Reporting a bug

Include the version (`daemonclient status`, or `/api/health`), what you did,
what you expected, and what happened instead. For a self-hosted install,
`daemonclient doctor` prints a report with every secret removed — that is the
most useful thing you can attach.
