import { describe, it, expect, afterEach, vi } from 'vitest';
import worker, { encryptToken } from './index';

// Auto-update re-deploys a user's worker. Whatever that deploy depends on — a
// rotated single-use Cloudflare refresh token, or a freshly minted session
// secret the new worker will verify sessions with — must be on record BEFORE
// the deploy. If saving it fails, nothing is deployed: a worker running a
// secret nobody has on record would reject every session.

const MASTER = 'm'.repeat(32);
const env = {
  FIREBASE_API_KEY: 'web-key',
  FIREBASE_PROJECT_ID: 'proj',
  ENCRYPTION_MASTER_KEY: MASTER,
  APP_IDENTIFIER: 'app',
  TELEGRAM_PROXY: 'https://proxy.example',
  ALLOWED_ORIGINS: 'https://photos.daemonclient.uz',
} as any;

type Call = { url: string; method: string; body?: string };

async function stubWorld(opts: { cfg: Record<string, string>; patchStatus: number }) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', async (input: any, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const method = (init.method || 'GET').toUpperCase();
    calls.push({ url, method, body: typeof init.body === 'string' ? init.body : undefined });
    if (url.includes('identitytoolkit.googleapis.com')) {
      return new Response(JSON.stringify({ users: [{ localId: 'uid1', email: 'u@example.com' }] }));
    }
    if (url.includes('firestore.googleapis.com') && method === 'GET') {
      const fields = Object.fromEntries(Object.entries(opts.cfg).map(([k, v]) => [k, { stringValue: v }]));
      return new Response(JSON.stringify({ fields }));
    }
    if (url.includes('firestore.googleapis.com') && method === 'PATCH') {
      return new Response(opts.patchStatus === 200 ? '{}' : 'denied', { status: opts.patchStatus });
    }
    if (url.includes('api.cloudflare.com')) {
      return new Response(JSON.stringify({ success: true, result: {} }));
    }
    return new Response('{}');
  });
  return calls;
}

const autoUpdate = () =>
  worker.fetch(new Request('https://deploy.example/auto-update', { method: 'POST', headers: { Authorization: 'Bearer user-id-token' } }), env);

afterEach(() => vi.unstubAllGlobals());

describe('auto-update saves first, deploys second', () => {
  it('a newly minted session secret is on record before the worker is deployed with it', async () => {
    const calls = await stubWorld({
      cfg: { accountId: 'acc', workerName: 'dc-x', databaseId: 'db', apiToken: await encryptToken('cf-token', MASTER) },
      patchStatus: 200,
    });
    const res = await autoUpdate();
    expect(res.status).toBe(200);
    const firstSave = calls.findIndex((c) => c.method === 'PATCH');
    const firstDeploy = calls.findIndex((c) => c.url.includes('api.cloudflare.com'));
    expect(firstSave, 'a save happened').toBeGreaterThanOrEqual(0);
    expect(firstDeploy, 'a deploy happened').toBeGreaterThanOrEqual(0);
    expect(firstSave).toBeLessThan(firstDeploy);
    expect(calls[firstSave].body).toContain('sessionSecret');
  });

  it('if that save fails, nothing is deployed', async () => {
    const calls = await stubWorld({
      cfg: { accountId: 'acc', workerName: 'dc-x', databaseId: 'db', apiToken: await encryptToken('cf-token', MASTER) },
      patchStatus: 403,
    });
    const res = await autoUpdate();
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ updated: false, reason: 'config-save-failed' });
    expect(calls.some((c) => c.url.includes('api.cloudflare.com'))).toBe(false);
  });

  it('with nothing new to record, it deploys and then records the version', async () => {
    const calls = await stubWorld({
      cfg: {
        accountId: 'acc', workerName: 'dc-x', databaseId: 'db',
        apiToken: await encryptToken('cf-token', MASTER),
        sessionSecret: 's'.repeat(40),
      },
      patchStatus: 200,
    });
    const res = await autoUpdate();
    expect(res.status).toBe(200);
    const deploy = calls.findIndex((c) => c.url.includes('api.cloudflare.com'));
    const saves = calls.map((c, i) => (c.method === 'PATCH' ? i : -1)).filter((i) => i >= 0);
    expect(saves.length).toBe(1);
    expect(saves[0]).toBeGreaterThan(deploy);
  });
});
