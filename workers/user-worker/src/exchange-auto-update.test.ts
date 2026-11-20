import { describe, it, expect, afterEach, vi } from 'vitest';

// The shared sign-in path (POST /api/auth/exchange, used by Photos web) must
// start the user's worker update just like a password sign-in does — including
// finishing an update whose final save failed — or someone who only ever signs
// in this way could never recover.

vi.mock('./firebase-token', async (orig) => ({
  ...(await orig<typeof import('./firebase-token')>()),
  verifyFirebaseIdToken: async () => ({ uid: 'u-exchange', email: 'u@example.com', exp: Math.floor(Date.now() / 1000) + 3600 }),
}));

afterEach(() => vi.unstubAllGlobals());

describe('POST /api/auth/exchange', () => {
  it('dispatches the worker auto-update with the caller\'s ID token', async () => {
    const { handleAuth } = await import('./auth');
    const idToken = `${btoa('{"alg":"RS256","kid":"k"}')}.${btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, sub: 'u-exchange' }))}.sig`;
    const fetched: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      fetched.push(String(url));
      if (String(url).includes('firestore.googleapis.com')) {
        return new Response(JSON.stringify({ fields: { workerUrl: { stringValue: 'https://dc-u.sub.workers.dev' }, sessionSecret: { stringValue: 's'.repeat(40) } } }));
      }
      return new Response('{}');
    });
    const pending: Promise<unknown>[] = [];
    const env: any = {
      FIREBASE_PROJECT_ID: 'p', FIREBASE_API_KEY: 'k', APP_IDENTIFIER: 'default-daemon-client',
      DEPLOYMENT_SERVICE_URL: 'https://deploy.example/', waitUntil: (p: Promise<unknown>) => pending.push(p),
    };
    const res = await handleAuth(
      new Request('https://api.example/api/auth/exchange', { method: 'POST', headers: { Authorization: `Bearer ${idToken}` } }),
      env, '/api/auth/exchange',
    );
    expect(res.status).toBe(200);
    await Promise.all(pending);
    expect(fetched).toContain('https://deploy.example/auto-update');
  });
});
