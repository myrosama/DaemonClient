import { describe, it, expect, afterEach, vi } from 'vitest';
import { handleAuth } from './auth';
import { loginFailure } from './auth';

// Password sign-in is the brute-forceable door. On the central worker it is now
// rate limited per address and per account, and every credential failure gets
// the same answer, so it never tells a caller which accounts exist.

const post = (body: object, ip = '203.0.113.7') =>
  new Request('https://api.example/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
    body: JSON.stringify(body),
  });

function limiter(allow: (key: string) => boolean) {
  const keys: string[] = [];
  return { keys, binding: { limit: async ({ key }: { key: string }) => { keys.push(key); return { success: allow(key) }; } } };
}

afterEach(() => vi.unstubAllGlobals());

describe('loginFailure — one answer for every credential failure', () => {
  it('does not reveal whether the account exists', () => {
    const answers = ['EMAIL_NOT_FOUND', 'INVALID_PASSWORD', 'INVALID_LOGIN_CREDENTIALS', 'INVALID_EMAIL', 'USER_DISABLED', 'MISSING_PASSWORD', undefined]
      .map((code) => JSON.stringify(loginFailure(code)));
    expect(new Set(answers).size).toBe(1);
    expect(loginFailure('EMAIL_NOT_FOUND')).toEqual({ status: 401, message: 'Invalid email or password' });
  });
  it("passes Firebase's own throttling on as a 429", () => {
    expect(loginFailure('TOO_MANY_ATTEMPTS_TRY_LATER : Access to this account has been temporarily disabled')).toEqual({
      status: 429, message: 'Too many sign-in attempts. Wait a minute and try again.',
    });
  });
});

describe('POST /api/auth/login on the central worker', () => {
  it('answers a wrong password generically', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: { message: 'EMAIL_NOT_FOUND' } }), { status: 400 }));
    const res = await handleAuth(post({ email: 'nobody@example.com', password: 'x' }), { FIREBASE_API_KEY: 'k' } as any, '/api/auth/login');
    expect(res.status).toBe(401);
    expect(((await res.json()) as any).message).toBe('Invalid email or password');
  });

  it('stops an address that tries too often, before asking Firebase', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchSpy);
    const ip = limiter(() => false);
    const email = limiter(() => true);
    const res = await handleAuth(post({ email: 'a@example.com', password: 'x' }), { FIREBASE_API_KEY: 'k', LOGIN_IP_LIMITER: ip.binding, LOGIN_EMAIL_LIMITER: email.binding } as any, '/api/auth/login');
    expect(res.status).toBe(429);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(ip.keys).toEqual(['203.0.113.7']);
  });

  it('stops repeated tries against one account from many addresses; the key is a hash, not the address', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchSpy);
    const ip = limiter(() => true);
    const email = limiter(() => false);
    const res = await handleAuth(post({ email: '  Victim@Example.com ', password: 'x' }), { FIREBASE_API_KEY: 'k', LOGIN_IP_LIMITER: ip.binding, LOGIN_EMAIL_LIMITER: email.binding } as any, '/api/auth/login');
    expect(res.status).toBe(429);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(email.keys[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(email.keys[0]).not.toContain('victim');
    // the same account however it is typed
    const again = limiter(() => true);
    await handleAuth(post({ email: 'victim@example.com', password: 'x' }), { FIREBASE_API_KEY: 'k', LOGIN_IP_LIMITER: ip.binding, LOGIN_EMAIL_LIMITER: again.binding } as any, '/api/auth/login').catch(() => {});
    expect(again.keys[0]).toBe(email.keys[0]);
  });

  it('without the limiter bindings (a user worker, self-host) sign-in works as before', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: { message: 'INVALID_PASSWORD' } }), { status: 400 }));
    const res = await handleAuth(post({ email: 'a@example.com', password: 'x' }), { FIREBASE_API_KEY: 'k' } as any, '/api/auth/login');
    expect(res.status).toBe(401);
  });
});
