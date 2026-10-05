import { describe, it, expect, afterEach, vi } from 'vitest';
import { requireAuth } from './helpers';

// The central worker refreshes expired Firebase ID tokens and caches the result.
// The cache must never hand one session's fresh token to another session that
// merely names the same uid.

async function sign(scope: string, payload: object) {
  const b64 = btoa(JSON.stringify(payload));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(`session:${scope}`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(b64));
  return `${b64}.${btoa(String.fromCharCode(...new Uint8Array(sig)))}`;
}
const expiredIdToken = `x.${btoa(JSON.stringify({ exp: 1 }))}.y`;
const central: any = { APP_IDENTIFIER: 'default-daemon-client', FIREBASE_API_KEY: 'k' };
const req = (token: string) => new Request('https://api.example/api/server/telegram-config', { headers: { Authorization: `Bearer ${token}` } });

afterEach(() => vi.unstubAllGlobals());

describe('the refreshed-token cache', () => {
  it("a forged session naming the victim's uid does not get the victim's fresh token", async () => {
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      const refresh = new URLSearchParams(String(init.body)).get('refresh_token');
      return refresh === 'victim-refresh'
        ? new Response(JSON.stringify({ id_token: 'VICTIM-FRESH-ID-TOKEN' }))
        : new Response('{"error":"INVALID_REFRESH_TOKEN"}', { status: 400 });
    });
    const exp = Date.now() + 86_400_000;
    const victim = await sign('default-daemon-client', { uid: 'u-victim-cache', email: 'v@x', idToken: expiredIdToken, refreshToken: 'victim-refresh', exp });
    const real = await requireAuth(req(victim), central);
    expect(real.idToken).toBe('VICTIM-FRESH-ID-TOKEN');

    const forged = await sign('default-daemon-client', { uid: 'u-victim-cache', email: 'a@x', idToken: expiredIdToken, refreshToken: 'attacker-junk', exp });
    const attempt = await requireAuth(req(forged), central).then((s) => s.idToken, () => 'refused');
    expect(attempt).not.toBe('VICTIM-FRESH-ID-TOKEN');
  });
});
