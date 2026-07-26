import { describe, it, expect } from 'vitest';
import { requireAuth } from './helpers';

// Regression tests for two authentication bypasses found in an audit of the
// live code. Both allowed complete takeover of any account with a single
// request and no credentials, so each gets an explicit test that fails loudly
// if the hole is ever reopened.
//
// Bypass 1 — the unsigned-token fallback. requireAuth verified the HMAC only
// when the token contained a "." and otherwise fell through to a plain
// base64 decode. The condition was a property of the attacker's own input, so
// omitting the dot skipped verification entirely.
//
// Bypass 2 — the signing key. Managed sessions were signed with
// APP_IDENTIFIER, a constant committed to this public repository, so anyone
// who read the source could mint a valid signature for any account.

const future = Date.now() + 86_400_000;

function forgedUnsigned(uid = 'victim-uid') {
  return btoa(JSON.stringify({ uid, email: 'x@x', idToken: '', refreshToken: '', exp: future }));
}

async function signWith(scope: string, payload: object) {
  const b64 = btoa(JSON.stringify(payload));
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(`session:${scope}`),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(b64));
  return `${b64}.${btoa(String.fromCharCode(...new Uint8Array(sig)))}`;
}

const req = (token: string) =>
  new Request('https://worker.test/api/assets', { headers: { Authorization: `Bearer ${token}` } });

describe('requireAuth rejects forged sessions', () => {
  it('refuses an unsigned token in managed mode', async () => {
    const env: any = { APP_IDENTIFIER: 'default-daemon-client', SESSION_SECRET: 'x'.repeat(32) };
    await expect(requireAuth(req(forgedUnsigned()), env)).rejects.toThrow();
  });

  it('refuses an unsigned token in self-host mode', async () => {
    const env: any = { SELF_HOST: '1', SESSION_SECRET: 'y'.repeat(32) };
    await expect(requireAuth(req(forgedUnsigned()), env)).rejects.toThrow();
  });

  it('refuses an unsigned token even when no env is supplied at all', async () => {
    await expect(requireAuth(req(forgedUnsigned()))).rejects.toThrow();
    await expect(requireAuth(req(forgedUnsigned()), {} as any)).rejects.toThrow();
  });

  it('refuses a token signed with the public APP_IDENTIFIER once a real secret exists', async () => {
    const env: any = { APP_IDENTIFIER: 'default-daemon-client', SESSION_SECRET: 'z'.repeat(32) };
    const token = await signWith('default-daemon-client', { uid: 'victim', email: 'x@x', idToken: '', refreshToken: '', exp: future });
    await expect(requireAuth(req(token), env)).rejects.toThrow();
  });

  it('refuses a token signed with the wrong secret', async () => {
    const env: any = { APP_IDENTIFIER: 'app', SESSION_SECRET: 'a'.repeat(32) };
    const token = await signWith('b'.repeat(32), { uid: 'victim', email: 'x@x', idToken: '', refreshToken: '', exp: future });
    await expect(requireAuth(req(token), env)).rejects.toThrow();
  });

  it('refuses a tampered payload under a valid-looking signature', async () => {
    const env: any = { APP_IDENTIFIER: 'app', SESSION_SECRET: 'c'.repeat(32) };
    const good = await signWith('c'.repeat(32), { uid: 'owner', email: 'o@x', idToken: '', refreshToken: '', exp: future });
    const [, sig] = good.split('.');
    const swapped = btoa(JSON.stringify({ uid: 'attacker', email: 'a@x', idToken: '', refreshToken: '', exp: future }));
    await expect(requireAuth(req(`${swapped}.${sig}`), env)).rejects.toThrow();
  });

  it('refuses an expired session', async () => {
    const env: any = { APP_IDENTIFIER: 'app', SESSION_SECRET: 'd'.repeat(32) };
    const token = await signWith('d'.repeat(32), { uid: 'u', email: 'x@x', idToken: '', refreshToken: '', exp: Date.now() - 1000 });
    await expect(requireAuth(req(token), env)).rejects.toThrow();
  });

  it('accepts a correctly signed session', async () => {
    const env: any = { APP_IDENTIFIER: 'app', SESSION_SECRET: 'e'.repeat(32) };
    const token = await signWith('e'.repeat(32), { uid: 'real-user', email: 'r@x', idToken: '', refreshToken: '', exp: future });
    const session = await requireAuth(req(token), env);
    expect(session.uid).toBe('real-user');
  });

  it('still accepts APP_IDENTIFIER-signed sessions on workers that have no secret yet', async () => {
    // Migration path: a per-user worker that has not received its generated
    // secret must keep working, or every existing user is locked out mid-roll-out.
    const env: any = { APP_IDENTIFIER: 'default-daemon-client' };
    const token = await signWith('default-daemon-client', { uid: 'legacy', email: 'l@x', idToken: '', refreshToken: '', exp: future });
    const session = await requireAuth(req(token), env);
    expect(session.uid).toBe('legacy');
  });

  it('refuses garbage that is not even base64 JSON', async () => {
    const env: any = { APP_IDENTIFIER: 'app', SESSION_SECRET: 'f'.repeat(32) };
    for (const junk of ['', 'not-a-token', 'a.b', '....', 'null']) {
      await expect(requireAuth(req(junk), env)).rejects.toThrow();
    }
  });
});
