import { describe, it, expect, vi } from 'vitest';

// Avoid Firestore/D1 reads for the immich_profile config lookup.
vi.mock('./cached-config', () => ({
  getCachedConfig: async () => null,
  setCachedConfig: async () => {},
}));

import { handleUser } from './user';

function sessionCookie(): string {
  const payload = {
    uid: 'u1',
    email: 'u1@example.com',
    idToken: 'a.' + btoa(JSON.stringify({ exp: 4102444800 })) + '.c',
    refreshToken: 'r',
    exp: 4102444800000,
  };
  return btoa(JSON.stringify(payload));
}

const env: any = { APP_IDENTIFIER: '', FIREBASE_API_KEY: '' };

function req(path: string, method = 'GET'): Request {
  return new Request(`https://worker.test${path}`, {
    method,
    headers: { Cookie: `immich_access_token=${sessionCookie()}` },
  });
}

describe('user directory stubs', () => {
  it('GET /api/users returns an array containing the current user', async () => {
    const res = await handleUser(req('/api/users'), env, '/api/users');
    const body = (await res.json()) as any[];
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(1);
    expect(body[0].id).toBe('u1');
  });

  it('GET /api/users/{self} returns the current user', async () => {
    const res = await handleUser(req('/api/users/u1'), env, '/api/users/u1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.id).toBe('u1');
  });

  it('GET /api/users/{other} returns a shaped 404, never a bare {}', async () => {
    const res = await handleUser(req('/api/users/someone-else'), env, '/api/users/someone-else');
    expect(res.status).toBe(404);
    const body = (await res.json()) as any;
    expect(typeof body.message).toBe('string');
  });

  it('preferences disable tags (cannot work in the isolated model)', async () => {
    const res = await handleUser(req('/api/users/me/preferences'), env, '/api/users/me/preferences');
    const body = (await res.json()) as any;
    expect(body.tags.enabled).toBe(false);
    // sharing is left stubbed-but-disabled (real cross-user sharing is roadmap)
    expect(body.sharedLinks.enabled).toBe(false);
    expect(body.people.enabled).toBe(false);
  });
});
