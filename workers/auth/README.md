# auth-worker — cross-subdomain session broker

Deployed as `daemonclient-auth` at `auth.daemonclient.uz`.
**Managed service only** — a self-hosted install does not run this.

## The problem it solves

Firebase persists its session per origin. Signing in at
`accounts.daemonclient.uz` leaves `photos.daemonclient.uz` and
`drive.daemonclient.uz` looking signed-out, so users were asked for their
password three times.

This worker holds one cookie on `.daemonclient.uz` — the parent domain — and
hands each app a fresh credential when it asks.

## Routes

| Path | Method | What it does |
|---|---|---|
| `/create-session` | POST | Turnstile check, verify the Firebase ID token, set the shared `__session` cookie |
| `/check-session` | GET | is this browser signed in? Returns the email and nothing else |
| `/session-token` | GET | mint a **fresh** Firebase ID token for an allowlisted origin |
| `/logout` | GET | clear the cookie and redirect |

## Two things not to change without understanding them

**The refresh token never crosses into JavaScript.** It lives in the HttpOnly
cookie. `/session-token` returns only the short-lived (one hour) ID token —
exactly what the Firebase SDK would hold anyway. An app then trades that for its
own session at its per-user worker via `POST /api/auth/exchange`.

**`/session-token` mints a new token rather than returning the stored one.** The
ID token captured at sign-in expires after an hour while the shared session is
long-lived, so returning the stored copy works for an hour and then silently
stops — which is a very confusing bug to be handed.

CORS echoes an exact origin from a fixed allowlist. It must never reflect an
arbitrary `Origin` with `credentials: true`; that would let any website read a
visitor's sign-in state and CSRF the logout.

## Configuration

Secrets, set with `wrangler secret put`:

| Name | Why |
|---|---|
| `SESSION_SECRET` | signs the shared session cookie |
| `FIREBASE_API_KEY` | token verification and refresh |
| `TURNSTILE_SECRET` | `/create-session` fails **closed** without it |

`FIREBASE_PROJECT_ID` is a plain variable in `wrangler.toml`.

If `SESSION_SECRET` or `FIREBASE_API_KEY` is unset, every `/create-session`
returns 401 and single sign-on silently stops working across all three apps.
That has happened; check `wrangler secret list` first when SSO breaks.

```bash
npx wrangler deploy
```
