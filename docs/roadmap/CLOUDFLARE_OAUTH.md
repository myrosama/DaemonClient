# One-button Cloudflare provisioning (self-managed OAuth)

Replaces "create token → copy → paste" with a single **Authorize Cloudflare**
button. Cloudflare shipped self-managed OAuth clients 2026-06-03 (free, all
tiers). The OAuth client is **already registered** (created via API 2026-06-13).

## Registered client (live, account 364fb59a…)

| | |
|---|---|
| **client_id** (public, safe in repo) | `ffa260b791c9a72c5020dacaa5c1035f` |
| client type | **public** (`token_endpoint_auth_method: none`) — **no secret**, PKCE S256 |
| scopes | `account-settings.read` `workers-scripts.write` `d1.write` `offline_access` |
| redirect_uri | `https://accounts.daemonclient.uz/setup/cloudflare/callback` |
| grant_types | `authorization_code`, `refresh_token` |
| allowed_cors_origins | `https://accounts.daemonclient.uz`, `https://daemonclient.uz` |
| visibility | **private** → only the owner's CF account can authorize until made public |

**Endpoints (verified via /.well-known/openid-configuration):**
- authorize: `https://dash.cloudflare.com/oauth2/auth`
- token: `https://dash.cloudflare.com/oauth2/token`

Scope discovery note: the strings are dotted-hyphen (`workers-scripts.write`),
NOT Wrangler's colon form (`workers_scripts:write`) — found empirically; the
API rejects the colon form. `account-settings.read` = read account/subdomain;
`workers-scripts.write` = deploy worker (+ workers.dev subdomain, same as the
old token template); `d1.write` = create/manage D1; `offline_access` = refresh.

## To make it usable by REAL users (not just owner): go public

Client is private now (perfect for end-to-end testing with the owner's own CF
account). Before opening to users: add a Privacy Policy + Terms page and flip
visibility to public (PATCH the client / dashboard), which Cloudflare gates on
those URLs + domain verification of `daemonclient.uz` (we own it).

## Flow to build

```
accounts-portal /setup/worker
  │  "Authorize Cloudflare"  → pkce() → store {verifier,state} in sessionStorage
  ▼
dash.cloudflare.com/oauth2/auth?client_id=ffa260…&redirect_uri=…/setup/cloudflare/callback
   &response_type=code&scope=account-settings.read workers-scripts.write d1.write offline_access
   &code_challenge=…&code_challenge_method=S256&state=…
  │  user approves on Cloudflare's consent screen, picks their account
  ▼
/setup/cloudflare/callback?code=…&state=…   (verify state == stored)
  │  POST {code, code_verifier, firebase idToken} → deployment-service /oauth/cloudflare/exchange
  ▼
deployment-service (NEW endpoint):
   POST dash.cloudflare.com/oauth2/token
     grant_type=authorization_code, client_id, code, code_verifier, redirect_uri
   → { access_token, refresh_token, expires_in }
   GET /accounts (with access_token) → accountId
   → reuse existing provisioning: create D1, deploy worker, ensure subdomain
   → store ENCRYPTED refresh_token + accountId in users/{uid}/config/cloudflare
```

The paste flow stays as automatic fallback when `CF_OAUTH_CLIENT_ID` is unset —
zero regression while wiring.

## Token continuity — decided: option B (refresh token)

There is no OAuth scope to mint a long-lived API token, so:
- store the **refresh_token** (encrypted) at onboarding;
- `handleAutoUpdate`/`handleForceUpdate` exchange refresh→access (public-client
  refresh: client_id + refresh_token, no secret) before each redeploy.
- A revoked/expired refresh token → auto-update no-ops and we surface a
  "re-authorize" prompt; manual use is unaffected (rare path).

## PKCE helper (ready to drop in)

```js
async function pkce() {
  const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')
  const verifier = b64(crypto.getRandomValues(new Uint8Array(32)))
  const challenge = b64(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))
  return { verifier, challenge }
}
```

## Managing the client later (API)

`GET|PATCH|DELETE https://api.cloudflare.com/client/v4/accounts/364fb59a…/oauth_clients[/ffa260…]`
with a token that has OAuth-client management permission. (The token used to
create it was pasted in chat once and should be rotated.)

## Status
- [x] OAuth client registered (client_id ffa260b791c9a72c5020dacaa5c1035f)
- [ ] accounts-portal: Authorize button + /setup/cloudflare/callback route
- [ ] deployment-service: /oauth/cloudflare/exchange (exchange + provision + store refresh)
- [ ] auto-update: refresh-token aware (option B)
- [ ] keep paste flow as fallback behind CF_OAUTH_CLIENT_ID
- [ ] go public (privacy/terms pages) before real users
