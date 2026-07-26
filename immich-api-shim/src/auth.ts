import type { Env } from './index';
import { json, firestoreGet } from './helpers';
import {
  isSelfHost,
  sessionScope,
  verifyLocalCredentials,
  getLocalUserById,
  changeLocalPassword,
} from './selfhost-auth';

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
  if (path === '/api/auth/logout' && request.method === 'POST') {
    return handleLogout();
  }
  if (path === '/api/auth/status') {
    return handleAuthStatus(request, env);
  }
  if (path === '/api/auth/change-password' && request.method === 'POST') {
    return handleChangePassword(request, env);
  }
  return json({ message: 'Not found' }, 404);
}

// Self-hosted password change. Requires a valid session AND the current
// password, so a stolen session cookie alone cannot lock the owner out.
async function handleChangePassword(request: Request, env: Env): Promise<Response> {
  if (!isSelfHost(env)) return json({ message: 'Not available on managed accounts' }, 404);
  if (!env.DB) return json({ message: 'No database bound' }, 500);

  let session;
  try {
    const { requireAuth } = await import('./helpers');
    session = await requireAuth(request, env);
  } catch {
    return json({ message: 'Not authenticated' }, 401);
  }

  const body = await request.json().catch(() => ({})) as any;
  const result = await changeLocalPassword(
    env.DB, session.uid, body.currentPassword || body.password || '', body.newPassword || '',
  );
  if (!result.ok) return json({ message: result.error }, 400);

  const user = await getLocalUserById(env.DB, session.uid);
  console.log(`[auth] password changed for ${user?.email || session.uid}`);
  return json({ success: true });
}

async function handleLogin(request: Request, env: Env): Promise<Response> {
  const body = await request.json() as any;
  const { email, password } = body.loginCredentialDto || body;

  // Self-hosted: accounts live in this worker's own D1, there is no Firebase.
  // The response shape is identical to the managed path, so the web apps and
  // the mobile app authenticate against a self-hosted server unchanged.
  if (isSelfHost(env)) {
    return handleSelfHostLogin(env, email, password);
  }

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

// Shared cookie set for both auth modes.
function sessionCookieHeaders(sessionToken: string): Headers {
  const h = new Headers({ 'Content-Type': 'application/json' });
  h.append('Set-Cookie', `immich_access_token=${sessionToken}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${SESSION_TTL_SECONDS}`);
  h.append('Set-Cookie', `__session=${sessionToken}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${SESSION_TTL_SECONDS}`);
  h.append('Set-Cookie', `immich_is_authenticated=true; Path=/; SameSite=Lax; Secure; Max-Age=${SESSION_TTL_SECONDS}`);
  return h;
}

async function handleSelfHostLogin(env: Env, email: string, password: string): Promise<Response> {
  if (!env.DB) {
    return json({ message: 'This server has no database bound — setup did not finish.' }, 500);
  }
  if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
    return json({ message: 'Email and password are required' }, 400);
  }

  const user = await verifyLocalCredentials(env.DB, email, password);
  if (!user) {
    // One message for both "no such account" and "wrong password" — anything
    // more specific turns the login form into an account-enumeration oracle.
    return json({ message: 'Incorrect email or password' }, 401);
  }

  let scope: string;
  try {
    scope = sessionScope(env);
  } catch (e: any) {
    console.error('[auth] refusing to issue a session:', e?.message);
    return json({ message: 'Server misconfigured: session secret missing' }, 500);
  }

  const sessionToken = await createSignedSessionToken({
    uid: user.id,
    email: user.email,
    // No Firebase tokens in this mode; requireAuth skips the refresh path
    // entirely for self-hosted installs.
    idToken: '',
    refreshToken: '',
    selfHost: true,
    exp: Date.now() + SESSION_TTL_SECONDS * 1000,
  }, scope);

  return new Response(JSON.stringify({
    accessToken: sessionToken,
    userId: user.id,
    userEmail: user.email,
    name: user.name,
    isAdmin: user.isAdmin,
    shouldChangePassword: false,
    isOnboarded: true,
    profileImagePath: '',
    quotaSizeInBytes: null,
    quotaUsageInBytes: null,
    workerUrl: null,
  }), { status: 201, headers: sessionCookieHeaders(sessionToken) });
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
