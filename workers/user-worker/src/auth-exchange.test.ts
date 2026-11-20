import { describe, expect, it } from 'vitest';
import { handleAuth } from './auth';
import { testSessionToken, testAuthEnv } from './test-session';

// The exchange turns a Firebase ID token into this worker's session token, so
// one sign-in serves all three apps. These pin the refusals — the ways it could
// become a credential-upgrade instead of a credential-translation.
const post = (headers: Record<string, string> = {}) =>
  new Request('https://w.example/api/auth/exchange', { method: 'POST', headers });

describe('POST /api/auth/exchange', () => {
  it('refuses an unauthenticated request', async () => {
    const res = await handleAuth(post(), testAuthEnv() as any, '/api/auth/exchange');
    expect(res.status).toBe(401);
  });

  it('refuses to re-exchange an existing SESSION token', async () => {
    // Otherwise an old session could mint an endlessly renewed one and outlive
    // any revocation. Only a freshly verified Firebase ID token qualifies.
    const env = testAuthEnv();
    const token = await testSessionToken('u1', 'u1@example.com');
    const res = await handleAuth(
      post({ Authorization: `Bearer ${token}` }),
      env as any,
      '/api/auth/exchange',
    );
    expect(res.status).toBe(400);
    expect((await res.json() as any).message).toMatch(/Firebase ID token/);
  });

  it('is not reachable by GET', async () => {
    const res = await handleAuth(
      new Request('https://w.example/api/auth/exchange'),
      testAuthEnv() as any,
      '/api/auth/exchange',
    );
    expect(res.status).toBe(404);
  });
});
