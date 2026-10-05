import { describe, it, expect, afterEach, vi } from 'vitest';
import { saveWorkerConfig } from './index';

// config/cloudflare holds the address of a user's worker and the secret that
// signs their sessions. The user may read it; only this service writes it, with
// its own service account — firestore.rules refuses the owner's writes. These
// pin that the write never goes out under the user's own token.

async function testPem(): Promise<string> {
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const der = new Uint8Array((await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer);
  let bin = '';
  der.forEach((b) => (bin += String.fromCharCode(b)));
  return `-----BEGIN PRIVATE KEY-----\n${btoa(bin)}\n-----END PRIVATE KEY-----\n`;
}

const env = (pem?: string) =>
  ({
    FIREBASE_PROJECT_ID: 'proj',
    FIREBASE_SA_CLIENT_EMAIL: pem ? 'svc@proj.iam.gserviceaccount.com' : undefined,
    FIREBASE_SA_PRIVATE_KEY: pem,
  }) as any;

afterEach(() => vi.unstubAllGlobals());

describe('saveWorkerConfig', () => {
  it('writes with the service account, never the user token', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url.startsWith('https://oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({ access_token: 'sa-access-token' }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });

    await saveWorkerConfig('uid-1', { workerUrl: 'https://dc-x.sub.workers.dev', sessionSecret: 's'.repeat(40) }, env(await testPem()));

    const write = calls.find((c) => c.url.includes('firestore.googleapis.com'));
    expect(write, 'a Firestore write happened').toBeTruthy();
    expect(write!.url).toContain('/documents/artifacts/default-daemon-client/users/uid-1/config/cloudflare');
    expect(write!.init.method).toBe('PATCH');
    expect((write!.init.headers as Record<string, string>).Authorization).toBe('Bearer sa-access-token');
  });

  it('without service-account credentials, falls back to the user token (which the rules then judge)', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response('{}', { status: 200 });
    });
    await saveWorkerConfig('uid-1', { workerUrl: 'x' }, env(), 'user-id-token');
    expect(calls).toHaveLength(1);
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer user-id-token');
  });

  it('with no service account and no user token, it fails loudly', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchSpy);
    await expect(saveWorkerConfig('uid-1', { workerUrl: 'x' }, env())).rejects.toThrow(/service-account/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('the user token is used only when the service-account write fails', async () => {
    const auths: string[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      if (url.startsWith('https://oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({ access_token: 'sa' }), { status: 200 });
      }
      auths.push((init.headers as Record<string, string>).Authorization);
      return new Response('{}', { status: 200 });
    });
    await saveWorkerConfig('uid-1', { workerUrl: 'x' }, env(await testPem()), 'user-id-token');
    expect(auths).toEqual(['Bearer sa']);
  });

  it('surfaces a rejected write (the caller must not believe the config was saved)', async () => {
    vi.stubGlobal('fetch', async (url: string) =>
      url.startsWith('https://oauth2.googleapis.com/token')
        ? new Response(JSON.stringify({ access_token: 't' }), { status: 200 })
        : new Response('denied', { status: 403 }),
    );
    await expect(saveWorkerConfig('uid-1', { workerUrl: 'x' }, env(await testPem()))).rejects.toThrow(/403/);
    // …and when the fallback is refused too (the locked rules), that surfaces as well.
    await expect(saveWorkerConfig('uid-1', { workerUrl: 'x' }, env(await testPem()), 'user-id-token')).rejects.toThrow(/403/);
  });

  it('refuses a uid that could address another document path', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchSpy);
    const pem = await testPem();
    for (const bad of ['', 'a/b', '../u2', 'u1/config/telegram', 'x'.repeat(129), 'u 1', 'u%2F1']) {
      await expect(saveWorkerConfig(bad, { workerUrl: 'x' }, env(pem)), JSON.stringify(bad)).rejects.toThrow(/malformed uid/);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
