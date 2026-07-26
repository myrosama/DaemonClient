# Security

## Reporting a vulnerability

Please report privately, not in a public issue:

- GitHub → **Security** → **Report a vulnerability** (preferred), or
- email the maintainer via the address on the GitHub profile.

Include what you found, how to reproduce it, and what an attacker gains. A
proof of concept helps enormously. If you are unsure whether something counts,
report it — a wrong guess costs nothing.

Please do not test against anyone else's deployment, including the hosted
service at daemonclient.uz. Self-hosting builds you a full stack in about ten
minutes on free tiers; test there.

**What to expect:** an acknowledgement within a few days, and an honest
assessment of severity and timeline. This is a small project — there is no SLA,
but reports are taken seriously and fixed in the open with credit unless you
prefer otherwise.

## What is in scope

The API worker (`immich-api-shim`), the provisioning service
(`deployment-service`), the accounts portal, the self-hosting CLI (`selfhost`),
and the media processor (`processor`).

Particularly interesting: authentication and session handling, anything that
crosses a user boundary, the Telegram relay endpoint, credential handling in the
CLI, and token verification in the processor.

Out of scope: findings against Immich upstream (report those to
[Immich](https://github.com/immich-app/immich/security)), missing hardening
headers with no demonstrated impact, and reports produced by a scanner with no
evidence the issue is reachable.

## The security model, briefly

Each user gets their own Cloudflare Worker, their own D1 database, and their own
Telegram bot and channel. There is no shared file store and no shared database,
so a compromise of one account's stack does not reach another's.

Files are encrypted with AES-256-GCM before reaching Telegram. Drive encrypts in
the browser, so the worker only ever holds ciphertext. Photos encrypts on the
user's own worker, which is what makes thumbnails, EXIF and deduplication
possible — a deliberate trade, confined to infrastructure serving one person.

Sessions are HMAC-signed with a per-install secret. A worker with no secret
configured refuses to issue sessions rather than falling back to anything
guessable.

Self-hosted installs depend on nothing we run: their own Cloudflare, their own
Firebase, their own Telegram, their own processor. The single outbound call to a
resource of ours is an anonymous check of the public GitHub releases feed, which
sends nothing about the install and can be turned off.

## Past issues

Fixed, listed because they are the shape of thing worth looking for:

| | |
|---|---|
| Session verification was skipped for tokens containing no `.`, so a base64 blob was accepted as a valid session for any account | fixed 2026-07-26 |
| Sessions were signed with a constant published in this repository, making them forgeable by anyone who read the source | fixed 2026-07-26 |
| `/proxy` forwarded any URL for any caller — an open proxy on every deployed worker | fixed 2026-07-26 |
| Setup endpoints took the user id from the request body without authentication, allowing an attacker to attach their own bot to a victim's storage channel | fixed 2026-07-21 |
| Upload deduplication matched soft-deleted rows, so a re-uploaded photo was discarded while the client was told it had been stored | fixed 2026-07-26 |

## If you run this yourself

- Keep `.daemonclient-selfhost.json` safe. It holds your tokens and your
  encryption key, it is created readable only by you, and it is gitignored.
- Set `OWNER_UID` on your media processor so only your account can use it.
- `daemonclient doctor` redacts every secret; use it when asking for help
  rather than pasting configuration.
- Losing your encryption key means losing access to files already stored. There
  is no recovery path, by design.
