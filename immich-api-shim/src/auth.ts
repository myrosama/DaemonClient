import type { Env } from './index';
import { json } from './helpers';

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
    return handleAuthStatus(request);
  }
  return json({ message: 'Not found' }, 404);
}

async function handleLogin(request: Request, env: Env): Promise<Response> {
  const body = await request.json() as any;
  const { email, password } = body.loginCredentialDto || body;

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

  // Create session token
  const sessionToken = await createSignedSessionToken({
    uid: data.localId,
    email: data.email,
    idToken: data.idToken,
    refreshToken: data.refreshToken,
    exp: Date.now() + 7 * 24 * 60 * 60 * 1000,
  }, env.APP_IDENTIFIER || 'default');

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
  };

  const response = json(userResponse, 201);
  
  // Set cookies for subsequent requests
  const newHeaders = new Headers(response.headers);
  newHeaders.append('Set-Cookie', `immich_access_token=${sessionToken}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${7 * 24 * 60 * 60}`);
  newHeaders.append('Set-Cookie',
    `__session=${sessionToken}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${7 * 24 * 60 * 60}`
  );
  newHeaders.append('Set-Cookie',
    `immich_is_authenticated=true; Path=/; SameSite=Lax; Secure; Max-Age=${7 * 24 * 60 * 60}`
  );
  return new Response(response.body, { status: 201, headers: newHeaders });
}

function handleLogout(): Response {
  const response = json({ successful: true, redirectUri: '/auth/login' });
  const newHeaders = new Headers(response.headers);
  newHeaders.append('Set-Cookie', 'immich_access_token=; Path=/; Max-Age=0');
  newHeaders.append('Set-Cookie', '__session=; Path=/; Max-Age=0');
  newHeaders.append('Set-Cookie', 'immich_is_authenticated=; Path=/; Max-Age=0');
  return new Response(response.body, { status: 200, headers: newHeaders });
}

function handleAuthStatus(request: Request): Response {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/(?:immich_access_token|__session)=([^;]+)/);
  let token = match ? match[1] : null;
  if (!token) {
    const auth = request.headers.get('Authorization') || '';
    if (auth.startsWith('Bearer ')) token = auth.slice(7);
  }
  if (!token) return json({ authenticated: false }, 401);
  try {
    const payload = token.includes('.') ? token.split('.')[0] : token;
    const data = JSON.parse(atob(payload));
    if (data.exp && data.exp < Date.now()) return json({ authenticated: false }, 401);
  } catch { return json({ authenticated: false }, 401); }

  return json({
    authenticated: true,
    pinCode: false,
    password: true,
    isElevated: true,
  });
}
