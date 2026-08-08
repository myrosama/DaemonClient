# Roadmap

What is being worked on, what is deliberately not, and in what order. Kept short
and honest — if something here stops being true, it gets edited or deleted.

## Now

**The web experience.** Photos and Drive are the product, and they come first.
Everything below waits on the web being genuinely good.

**Consolidating the storage primitive.** Chunk, encrypt, upload, record a
manifest — this is implemented independently in four places
(`immich-api-shim/src/assets.ts`, `webdav.ts`, `drive/src/App.jsx`,
`immich/web/.../daemonclient-drive.ts`), and `19 * 1024 * 1024` appears in five
files. A chunking bug currently has to be fixed four times, correctly, every
time. This is the single biggest obstacle to "fix it once and everyone gets the
fix", and the most valuable work available.

## Next

**Sharing between users.** Cross-user shared albums are built and held pending a
security review. The one-install-one-owner model is a real boundary and opening
it needs care rather than speed.

**Chunked upload from mobile.** Videos over 100 MB cannot be uploaded from the
app because Cloudflare caps request bodies at 100 MB. The web already avoids
this by uploading straight to Telegram; the app needs the same path.

**A curl bootstrap for self-hosting.** `curl … | sh` rather than clone-then-run.

## Later

**Mobile apps.** A fork of the Immich app exists in `immich/mobile/` and is not
released. It is eight changed files over stock Immich, so most of the work is
in the worker's API rather than the app — see
[../immich/FORK.md](../immich/FORK.md). Shipping to the App Store also needs a
paid developer account and a release pipeline.

This is deliberately last. An app that talks to a server still being reshaped
is an app that breaks weekly, and one build in the store has to talk to servers
of many ages.

## Not planned

Saying no is part of the design.

| | |
|---|---|
| **Object storage (R2, S3)** | Unlimited free storage in your own Telegram channel is the entire premise. Object storage would end the project. |
| **Docker, a VPS, anything long-running** | Fully serverless is a hard constraint. Free tiers are the product, not a stopgap. |
| **Multi-user installs** | One install, one owner. Add family accounts if you want them; tenancy is not being built. |
| **Telemetry, analytics, crash reporting** | Nothing phones home. A self-hosted install must work if we disappear. |
| **Face recognition, smart search** | They need ML this architecture has nowhere to run. The routes return correctly-shaped empty results rather than pretending. |
| **A paid tier** | There is nothing to sell. The infrastructure is yours. |

## Done

- **Self-hosting.** `daemonclient setup` builds a complete install on your own
  accounts; `daemonclient web` deploys all three apps to your own Firebase
  Hosting. Nothing in a self-host build points at us, and a test enforces it.
- **Client-direct media.** The browser reads and writes file bytes straight from
  Telegram, so the worker handles metadata only.
- **Single sign-on** across the accounts portal, Photos and Drive.
- **Turnstile** on sign-up, sign-in and session creation.
- **Firebase ID token auth** on the worker, with the owner gate hardened so a
  stranger cannot claim an unowned install.
- **CI** on every component that has tests.
