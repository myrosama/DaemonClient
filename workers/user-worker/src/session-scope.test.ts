import { describe, it, expect } from 'vitest';
import { sessionScope } from './selfhost-auth';
import { requireAuth } from './helpers';

// A user's worker (it has a database) is always deployed with its own
// SESSION_SECRET. It must never fall back to APP_IDENTIFIER, a constant in this
// public repository: a session signed with it would be forgeable by anyone.

const future = Date.now() + 86_400_000;
async function signWith(scope: string, payload: object) {
  const b64 = btoa(JSON.stringify(payload));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(`session:${scope}`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(b64));
  return `${b64}.${btoa(String.fromCharCode(...new Uint8Array(sig)))}`;
}
const fakeDb: any = { prepare: () => ({ bind: () => ({ first: async () => null, run: async () => ({}), all: async () => ({ results: [] }) }) }) };

describe('sessionScope', () => {
  it("a user's worker uses its own secret", () => {
    expect(sessionScope({ DB: fakeDb, SESSION_SECRET: 's'.repeat(40), APP_IDENTIFIER: 'default-daemon-client' } as any)).toBe('s'.repeat(40));
  });
  it("a user's worker without a secret refuses rather than fall back to the public constant", () => {
    expect(() => sessionScope({ DB: fakeDb, APP_IDENTIFIER: 'default-daemon-client' } as any)).toThrow(/SESSION_SECRET/);
    expect(() => sessionScope({ DB: fakeDb, SESSION_SECRET: 'short', APP_IDENTIFIER: 'default-daemon-client' } as any)).toThrow(/SESSION_SECRET/);
  });
  it('the central worker (no database, no user data) keeps the transitional fallback for now', () => {
    expect(sessionScope({ APP_IDENTIFIER: 'default-daemon-client' } as any)).toBe('default-daemon-client');
  });
});

describe("requireAuth on a user's worker without a secret", () => {
  it('refuses a session signed with the public constant', async () => {
    const token = await signWith('default-daemon-client', { uid: 'victim', email: 'v@x', idToken: '', refreshToken: '', exp: future });
    const req = new Request('https://dc-x.sub.workers.dev/api/assets', { headers: { Authorization: `Bearer ${token}` } });
    await expect(requireAuth(req, { DB: fakeDb, APP_IDENTIFIER: 'default-daemon-client' } as any)).rejects.toThrow();
  });
});
