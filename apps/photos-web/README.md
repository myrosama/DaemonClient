# DaemonClient Photos — website

The website at `photos.daemonclient.uz`: a fork of
[Immich](https://github.com/immich-app/immich)'s web client (AGPL-3.0), talking
to a DaemonClient worker and reading from Telegram. What was kept and changed:
[FORK.md](FORK.md).

Build: `pnpm install`, `pnpm --filter @immich/sdk build`, then
`cd web && npm run build` (output: `web/build`).
