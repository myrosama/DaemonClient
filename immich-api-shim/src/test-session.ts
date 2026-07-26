// Test-only helper: build a session cookie the way the real login does.
//
// Tests used to hand-roll an unsigned base64 cookie, which worked because
// requireAuth had a fallback that accepted unsigned tokens. That fallback was
// a complete authentication bypass and has been removed, so tests now have to
// produce genuinely signed tokens — which is also what makes them a faithful
// exercise of the auth path rather than a way around it.

const TEST_SCOPE = 'test-session-secret-at-least-32-chars';

async function hmac(payloadB64: string, scope: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(`session:${scope}`),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payloadB64));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

/** A signed session token for `uid`, valid far into the future. */
export async function testSessionToken(
  uid = 'u1',
  email = 'u1@example.com',
  scope: string = TEST_SCOPE,
): Promise<string> {
  const payload = btoa(JSON.stringify({
    uid,
    email,
    // A far-future exp keeps requireAuth off the Firebase refresh path.
    idToken: 'a.' + btoa(JSON.stringify({ exp: 4102444800 })) + '.c',
    refreshToken: 'r',
    exp: 4102444800000,
  }));
  return `${payload}.${await hmac(payload, scope)}`;
}

/** The env a test worker needs for that token to verify. */
export function testAuthEnv(extra: Record<string, unknown> = {}) {
  return { APP_IDENTIFIER: 'test-app', SESSION_SECRET: TEST_SCOPE, FIREBASE_API_KEY: '', ...extra };
}

export { TEST_SCOPE };
