import type { Env } from './index';
import { json, firestoreGet, requireAuth, getSessionToken } from './helpers';
import { looksLikeFirebaseIdToken } from './firebase-token';
import { isSelfHost, sessionScope } from './selfhost-auth';

// Session lifetime. Was 7 days, which silently logged users out after a week
// of inactivity — every request then 401'd, so sync stalled and uploads
// stopped, surfacing as a raw "authentication error". The embedded Firebase
// refresh token keeps the idToken fresh indefinitely (requireAuth refreshes
// it), so the session token itself never needs to age out. Effectively
// non-expiring; a genuinely revoked refresh token still yields a clean 401 →
// the app re-logs in. (Browsers clamp cookie Max-Age to ~400d for security;
// that only affects the web cookie — the mobile app stores the token itself,
// whose `exp` is what this controls.)
const SESSION_TTL_SECONDS = 3650 * 24 * 60 * 60; // ~10 years

async function hmacSign(payload: string, scope: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(`session:${scope}`),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

async function createSignedSessionToken(data: Record<string, unknown>, scope: string): Promise<string> {
  const payload = btoa(JSON.stringify(data));
  const sig = await hmacSign(payload, scope);
  return `${payload}.${sig}`;
}

export async function handleAuth(request: Request, env: Env, path: string): Promise<Response> {
  if (path === '/api/auth/login' && request.method === 'POST') {
    return handleLogin(request, env);
  }
  if (path === '/api/auth/exchange' && request.method === 'POST') {
    return handleExchange(request, env);
  }
  if (path === '/api/auth/logout' && request.method === 'POST') {
    return handleLogout();
  }
  if (path === '/api/auth/status') {
    return handleAuthStatus(request, env);
  }
  return json({ message: 'Not found' }, 404);
}

/**
 * Canonical Turnstile siteverify. Fails CLOSED — a missing secret, missing
 * token, network error, non-2xx or non-JSON body all deny, because a check we
 * cannot complete must never silently admit traffic.
 */
async function verifyTurnstile(token: string, clientIp: string | null, secret?: string): Promise<boolean> {
  if (!secret || !token) return false;
  try {
    const form = new URLSearchParams({ secret, response: token });
    if (clientIp) form.set('remoteip', clientIp);
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
    });
    if (!res.ok) return false;
    const result = await res.json() as { success?: boolean };
    return result.success === true;
  } catch {
    return false;
  }
}

async function handleLogin(request: Request, env: Env): Promise<Response> {
  const body = await request.json() as any;
  const { email, password } = body.loginCredentialDto || body;

  // Password login is the one brute-forceable surface here, so gate it on
  // Turnstile before spending a Firebase Identity Toolkit call. Only enforced
  // when TURNSTILE_SECRET is bound: the mobile app and existing integrations
  // post no token, and silently locking them out would be worse than the risk
  // this removes. Once every client sends one, drop the conditional.
  if (env.TURNSTILE_SECRET) {
    const human = await verifyTurnstile(
      body['cf-turnstile-response'] || '',
      request.headers.get('CF-Connecting-IP'),
      env.TURNSTILE_SECRET,
    );
    if (!human) return json({ message: 'Verification failed' }, 403);
  }

  // A self-hosted install reaches this exact code: its worker just points
  // FIREBASE_API_KEY / FIREBASE_PROJECT_ID at the operator's own Firebase
  // project, so there is no second login implementation to keep in step.
  // Validate against Firebase Auth REST API
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${env.FIREBASE_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    }
  );

  const data = await res.json() as any;
  if (data.error) {
    return json({ message: data.error.message || 'Invalid credentials' }, 401);
  }

  // Look up the user's per-user worker URL up front so we can BAKE it into
  // the session token. Embedding it lets the central worker proxy every
  // subsequent /api/* request to the user's worker without any extra
  // Firestore read — pure JWT-decode + fetch.
  let workerUrl: string | null = null;
  let userSessionSecret: string | null = null;
  try {
    const cfConfig = await firestoreGet(env, data.localId, 'config/cloudflare', data.idToken);
    if (cfConfig?.workerUrl) workerUrl = cfConfig.workerUrl;
    // Each provisioned worker gets its own signing secret. Signing with it
    // here means a session is only valid against the one worker it was issued
    // for — previously everything was signed with APP_IDENTIFIER, a constant
    // published in this repository, so any reader could forge sessions for any
    // account. Workers provisioned before that change have no secret yet and
    // still verify with APP_IDENTIFIER; they roll over on their next deploy.
    if (typeof cfConfig?.sessionSecret === 'string' && cfConfig.sessionSecret.length >= 32) {
      userSessionSecret = cfConfig.sessionSecret;
    }
  } catch {}

  const sessionToken = await createSignedSessionToken({
    uid: data.localId,
    email: data.email,
    idToken: data.idToken,
    refreshToken: data.refreshToken,
    workerUrl,
    exp: Date.now() + SESSION_TTL_SECONDS * 1000,
  }, userSessionSecret || env.APP_IDENTIFIER || 'default');

  const userResponse = {
    accessToken: sessionToken,
    userId: data.localId,
    userEmail: data.email,
    name: data.displayName || email.split('@')[0],
    isAdmin: true,
    shouldChangePassword: false,
    isOnboarded: true,
    profileImagePath: '',
    quotaSizeInBytes: null,
    quotaUsageInBytes: null,
    workerUrl,
  };

  // Fire-and-forget auto-update of the user's per-user worker. The deployment
  // service compares the embedded shim version against the user's worker and
  // silently redeploys if they've drifted, so shim fixes reach existing users
  // without them touching anything. Login response isn't blocked on this.
  if (env.DEPLOYMENT_SERVICE_URL && env.waitUntil && workerUrl) {
    env.waitUntil(
      fetch(env.DEPLOYMENT_SERVICE_URL.replace(/\/$/, '') + '/auto-update', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${data.idToken}`, 'Content-Type': 'application/json' },
        body: '{}',
      }).catch(err => console.error('[auto-update] dispatch failed:', err))
    );
  }

  const response = json(userResponse, 201);
  
  // Set cookies for subsequent requests
  const newHeaders = new Headers(response.headers);
  newHeaders.append('Set-Cookie', `immich_access_token=${sessionToken}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${SESSION_TTL_SECONDS}`);
  newHeaders.append('Set-Cookie',
    `__session=${sessionToken}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${SESSION_TTL_SECONDS}`
  );
  newHeaders.append('Set-Cookie',
    `immich_is_authenticated=true; Path=/; SameSite=Lax; Secure; Max-Age=${SESSION_TTL_SECONDS}`
  );
  return new Response(response.body, { status: 201, headers: newHeaders });
}

// Turn a Firebase ID token into this worker's own session token.
//
// This is what makes one sign-in serve all three apps. Signing in at the
// accounts dashboard leaves a Firebase session on THAT origin only — browsers
// scope Firebase's persistence per origin, so Photos and Drive saw a signed-out
// user and asked again. They now hand their (already authenticated) Firebase ID
// token here and receive the same session token `/api/auth/login` issues, so the
// rest of the app is unchanged.
//
// It grants nothing a password login would not: the caller already holds a
// verified credential for this account, and `requireAuth` puts the ID token
// through the same RS256/aud/iss/exp checks. `mayClaim` stays false there, so
// this can never take ownership of an install that has no owner yet.
async function handleExchange(request: Request, env: Env): Promise<Response> {
  let session;
  try {
    session = await requireAuth(request, env);
  } catch {
    return json({ message: 'Invalid credentials' }, 401);
  }

  // Only a Firebase ID token may be exchanged. Re-exchanging a session token
  // would let an old session mint an endlessly renewed one, outliving any
  // revocation.
  if (!looksLikeFirebaseIdToken(getSessionToken(request) || '')) {
    return json({ message: 'Expected a Firebase ID token' }, 400);
  }

  let workerUrl: string | null = null;
  let userSessionSecret: string | null = null;
  try {
    const cfConfig = await firestoreGet(env, session.uid, 'config/cloudflare', session.idToken);
    if (cfConfig?.workerUrl) workerUrl = cfConfig.workerUrl;
    if (typeof cfConfig?.sessionSecret === 'string' && cfConfig.sessionSecret.length >= 32) {
      userSessionSecret = cfConfig.sessionSecret;
    }
  } catch { /* self-host reads nothing from Firestore; fall through */ }

  // The exchanged session carries no refreshToken: the caller can always come
  // back with a fresh ID token, and minting one here would hand out a stronger
  // credential than the one presented.
  const sessionToken = await createSignedSessionToken({
    uid: session.uid,
    email: session.email,
    idToken: session.idToken,
    refreshToken: '',
    workerUrl,
    exp: Date.now() + SESSION_TTL_SECONDS * 1000,
  }, userSessionSecret || env.APP_IDENTIFIER || 'default');

  const body = {
    accessToken: sessionToken,
    userId: session.uid,
    userEmail: session.email,
    name: session.email.split('@')[0],
    isAdmin: true,
    shouldChangePassword: false,
    isOnboarded: true,
    profileImagePath: '',
    quotaSizeInBytes: null,
    quotaUsageInBytes: null,
    workerUrl,
  };
  return new Response(JSON.stringify(body), { status: 200, headers: sessionCookieHeaders(sessionToken) });
}

// Shared cookie set for both auth modes.
function sessionCookieHeaders(sessionToken: string): Headers {
  const h = new Headers({ 'Content-Type': 'application/json' });
  h.append('Set-Cookie', `immich_access_token=${sessionToken}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${SESSION_TTL_SECONDS}`);
  h.append('Set-Cookie', `__session=${sessionToken}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${SESSION_TTL_SECONDS}`);
  h.append('Set-Cookie', `immich_is_authenticated=true; Path=/; SameSite=Lax; Secure; Max-Age=${SESSION_TTL_SECONDS}`);
  return h;
}

function handleLogout(): Response {
  const response = json({ successful: true, redirectUri: '/auth/login' });
  const newHeaders = new Headers(response.headers);
  newHeaders.append('Set-Cookie', 'immich_access_token=; Path=/; Max-Age=0');
  newHeaders.append('Set-Cookie', '__session=; Path=/; Max-Age=0');
  newHeaders.append('Set-Cookie', 'immich_is_authenticated=; Path=/; Max-Age=0');
  return new Response(response.body, { status: 200, headers: newHeaders });
}

// Verifies the signature like every other authenticated route. It used to
// base64-decode the token and report "authenticated, elevated" for any blob
// that parsed as JSON with a future exp, which told a client (and an attacker
// probing it) that a forged token was good.
async function handleAuthStatus(request: Request, env: Env): Promise<Response> {
  try {
    const { requireAuth } = await import('./helpers');
    await requireAuth(request, env);
  } catch {
    return json({ authenticated: false }, 401);
  }
  return json({
    authenticated: true,
    pinCode: false,
    password: true,
    isElevated: true,
  });
}
