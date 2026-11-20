// One-button Cloudflare provisioning — public PKCE OAuth client.
// client_id is PUBLIC (it travels in the browser URL); there is no secret.
// The authorization code is exchanged server-side in the deployment-service so
// the refresh token never lives in the browser.
export const CF_OAUTH_CLIENT_ID = 'ffa260b791c9a72c5020dacaa5c1035f'
export const CF_OAUTH_REDIRECT_URI = 'https://accounts.daemonclient.uz/setup/cloudflare/callback'
export const CF_OAUTH_AUTHORIZE_URL = 'https://dash.cloudflare.com/oauth2/auth'
export const CF_OAUTH_SCOPES = 'account-settings.read workers-scripts.write d1.write offline_access'
export const DEPLOYMENT_WORKER = 'https://daemonclient-deployment.sadrikov49.workers.dev'

const STATE_KEY = 'cf_oauth_state'
const VERIFIER_KEY = 'cf_oauth_verifier'

// base64url of a byte buffer (no padding) — the encoding PKCE + state require.
function b64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// PKCE: a high-entropy verifier kept in the browser, and its SHA-256 challenge
// sent to Cloudflare. Proves the same browser that started the flow finishes it.
export async function pkce() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)))
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))
  return { verifier, challenge }
}

// Kick off the OAuth flow: store {verifier,state} for the callback to verify,
// then full-page-redirect to Cloudflare's own consent screen.
export async function startCloudflareOAuth() {
  const { verifier, challenge } = await pkce()
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)))
  sessionStorage.setItem(VERIFIER_KEY, verifier)
  sessionStorage.setItem(STATE_KEY, state)
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CF_OAUTH_CLIENT_ID,
    redirect_uri: CF_OAUTH_REDIRECT_URI,
    scope: CF_OAUTH_SCOPES,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  })
  window.location.href = `${CF_OAUTH_AUTHORIZE_URL}?${params.toString()}`
}

// Read + clear the stored PKCE/state (single-use). Returns null if missing.
export function consumeOAuthState() {
  const verifier = sessionStorage.getItem(VERIFIER_KEY)
  const state = sessionStorage.getItem(STATE_KEY)
  sessionStorage.removeItem(VERIFIER_KEY)
  sessionStorage.removeItem(STATE_KEY)
  return { verifier, state }
}
