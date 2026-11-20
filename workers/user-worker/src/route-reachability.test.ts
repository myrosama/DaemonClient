import { describe, it, expect, vi } from 'vitest';

vi.mock('./cached-config', () => ({
  getCachedConfig: async () => ({}),
  setCachedConfig: async () => {},
}));

import { handleSearch } from './search';
import { handleUser } from './user';
import { testSessionToken, testAuthEnv } from './test-session';

// Routes that a client calls and the worker answers WRONGLY are worse than
// routes that do not exist: the client has no way to tell "unsupported" from
// "broken", and the failure surfaces as a crash on `.length` or `.items`
// against an error body.
//
// Both cases here were found by mapping every route against its callers rather
// than by any test — the gates only ever look at the task in front of them.

const env: any = testAuthEnv({ DB: null, waitUntil: () => {} });
const req = async (path: string, method = 'GET') =>
  new Request(`https://worker.test${path}`, {
    method,
    headers: { Authorization: `Bearer ${await testSessionToken()}` },
  });

describe('search endpoints the clients actually call', () => {
  // handleSearch is dispatched from index.ts BEFORE the catch-all in stubs.ts,
  // so the correctly shaped stubs at stubs.ts:35-40 were unreachable and every
  // one of these 404'd.
  const arrayShaped = ['/api/search/suggestions', '/api/search/explore', '/api/search/places', '/api/search/cities'];

  for (const path of arrayShaped) {
    it(`${path} returns an array, not a 404`, async () => {
      const res = await handleSearch(await req(path), env, path);
      expect(res.status).toBe(200);
      expect(Array.isArray(await res.json())).toBe(true);
    });
  }

  it('/api/search/smart returns the assets envelope the client destructures', async () => {
    const res = await handleSearch(await req('/api/search/smart'), env, '/api/search/smart');
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(Array.isArray(body.assets.items)).toBe(true);
    expect(typeof body.assets.total).toBe('number');
  });

  it('still 404s something genuinely unknown', async () => {
    const res = await handleSearch(await req('/api/search/nonsense'), env, '/api/search/nonsense');
    expect(res.status).toBe(404);
  });
});

describe('onboarding', () => {
  // The generated SDK's setUserOnboarding is PUT. The route was POST-only, so
  // onboarding never persisted and the user was asked again on every login.
  it('accepts PUT, which is what the client sends', async () => {
    const res = await handleUser(await req('/api/users/me/onboarding', 'PUT'), env, '/api/users/me/onboarding');
    expect(res.status).toBe(200);
  });

  it('still accepts POST', async () => {
    const res = await handleUser(await req('/api/users/me/onboarding', 'POST'), env, '/api/users/me/onboarding');
    expect(res.status).toBe(200);
  });
});
