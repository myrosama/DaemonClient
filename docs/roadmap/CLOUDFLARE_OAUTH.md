# One-button Cloudflare provisioning (self-managed OAuth)

Goal: replace the "create token → copy → paste" step with a single **Authorize
DaemonClient** button. Cloudflare shipped self-managed OAuth clients on
2026-06-03 — this is the official, free mechanism (all plan tiers).

## Why this needs YOU first (the one blocker)

The `client_id`, `client_secret`, the exact authorize/token endpoint URLs, and
the precise scope strings only exist once the OAuth app is registered **in our
own Cloudflare dashboard** — I can't do that from here. Once you register it and
hand me the three values below, I build + test the flow against the real thing
(guessing endpoints would ship untestable code).

## Your registration steps (~5 min, once)

1. Sign in at **dash.cloudflare.com** → top-right profile → **OAuth** (or
   Manage Account → API Tokens → the new **OAuth applications** tab).
2. **Create application**. Name: `DaemonClient`.
3. **Redirect URI**: `https://accounts.daemonclient.uz/setup/cloudflare/callback`
4. **Scopes** — pick the same three the current token template already uses:
   - Workers Scripts **Edit**
   - D1 **Edit**
   - Account Settings **Read**
   (If an "API Tokens / create token" scope is offered, tick it too — it lets us
   keep the simple auto-update model; see "Token continuity" below.)
5. Form values: Response Type **Code**, Grant type **Authorization Code**,
   Token Authentication Method **None (PKCE)** → this is a **public client, NO
   client_secret**. PKCE (mandatory) + the locked redirect URI secure it; the
   token still gets exchanged server-side in deployment-service (browser hands
   it {code, verifier}), so the access token never lives in the browser.
6. Client URL `https://daemonclient.uz` + any Privacy/Terms URL the form
   requires to go **public** (apps start private; public = any user can
   authorize, not just the owner).
7. Send me: **client_id** only (no secret with PKCE) + confirm the redirect URI.
   Store `CF_OAUTH_CLIENT_ID` in the accounts-portal env; the exchange in
   deployment-service needs only client_id + code + code_verifier.

## The flow I'll build once I have those

```
accounts-portal /setup/worker
  │  user clicks "Authorize Cloudflare"
  ▼
dash.cloudflare.com/oauth2/auth?client_id=…&redirect_uri=…
     &response_type=code&scope=workers_scripts:edit d1:edit account:read
     &code_challenge=…&code_challenge_method=S256&state=…   (PKCE, required)
  │  user approves on Cloudflare's OWN consent screen, picks the account
  ▼
/setup/cloudflare/callback?code=…&state=…   (verify state)
  │  POST {code, code_verifier} → deployment-service /oauth/cloudflare/exchange
  ▼
deployment-service: client_id + code + code_verifier   (public client, no secret)
     → POST dash.cloudflare.com/oauth2/token  → { access_token, refresh_token }
  │
  ▼
deployment-service /deploy-worker (UNCHANGED): provisions D1 + Worker +
     subdomain using the access token, exactly as it does with a pasted token.
```

The current paste flow stays as an automatic fallback when
`CF_OAUTH_CLIENT_ID` isn't configured — zero regression risk while we wire it.

## Token continuity (the one design choice)

Auto-update (`handleAutoUpdate`/`handleForceUpdate`) silently redeploys each
user's worker when the shim version drifts — it needs durable access to the
account. OAuth access tokens are short-lived (~15 min, like Cloudflare Access).
Two options, prefer the first:

- **A — mint a long-lived API token** at onboarding using the OAuth access
  token (if the token-create scope is available): store that encrypted exactly
  like today, discard the OAuth tokens. Auto-update code is unchanged. Cleanest.
- **B — store the refresh token** (encrypted) and exchange it for a fresh access
  token inside handleAutoUpdate before each redeploy. Works without the
  token-create scope; adds a refresh step and a revocation failure mode.

The scope picker in step 4 tells us which path is available; I'll implement
whichever and keep the encrypted-secret storage shape the deployment-service
already uses.

## PKCE helper (ready to drop in)

```js
async function pkce() {
  const verifier = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')
  return { verifier, challenge } // store verifier in sessionStorage, send challenge
}
```

## Status
- [ ] You register the OAuth app (public/PKCE) + send client_id (no secret)
- [ ] I wire authorize redirect + /setup/cloudflare/callback + exchange endpoint
- [ ] Token continuity (A or B) per available scope
- [ ] Keep paste flow as fallback; ship behind CF_OAUTH_CLIENT_ID
