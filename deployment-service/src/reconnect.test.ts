// A worker whose Cloudflare authorization no longer renews can't be updated.
// The update service records why and marks the account, so the dashboard can
// ask the owner to reconnect; reconnecting must use the same Cloudflare account.
import { describe, it, expect, afterEach, vi } from 'vitest';
import worker, { encryptToken } from './index';

const MASTER = 'm'.repeat(32);
const env = {
  FIREBASE_API_KEY: 'web-key', FIREBASE_PROJECT_ID: 'proj', ENCRYPTION_MASTER_KEY: MASTER,
  APP_IDENTIFIER: 'app', TELEGRAM_PROXY: 'https://proxy.example', ALLOWED_ORIGINS: 'https://photos.daemonclient.uz',
} as any;

type Call = { url: string; method: string; body?: string };
function stub(cfg: Record<string, string>, token: { status: number; body: any }, account = 'acc') {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', async (input: any, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const method = (init.method || 'GET').toUpperCase();
    calls.push({ url, method, body: typeof init.body === 'string' ? init.body : undefined });
    if (url.includes('identitytoolkit.googleapis.com')) return new Response(JSON.stringify({ users: [{ localId: 'uid1', email: 'u@example.com' }] }));
    if (url.includes('firestore.googleapis.com') && method === 'GET') {
      return new Response(JSON.stringify({ fields: Object.fromEntries(Object.entries(cfg).map(([k, v]) => [k, { stringValue: v }])), updateTime: '2026-11-18T08:00:00.000000Z' }));
    }
    if (url.includes('firestore.googleapis.com') && method === 'PATCH') return new Response('{}');
    if (url.startsWith('https://dash.cloudflare.com/oauth2/token')) return new Response(JSON.stringify(token.body), { status: token.status });
    if (url === 'https://api.cloudflare.com/client/v4/accounts') return new Response(JSON.stringify({ result: [{ id: account }] }));
    if (url.includes('api.cloudflare.com')) return new Response(JSON.stringify({ success: true, result: {} }));
    return new Response('{}');
  });
  return calls;
}
const patches = (calls: Call[]) => calls.filter((c) => c.method === 'PATCH');
const fields = (c: Call) => JSON.parse(c.body || '{}').fields || {};
const mask = (c: Call) => new URL(c.url).searchParams.getAll('updateMask.fieldPaths');
const autoUpdate = () => worker.fetch(new Request('https://deploy.example/auto-update', { method: 'POST', headers: { Authorization: 'Bearer user-id-token' } }), env);
const oauthCfg = async (extra: Record<string, string> = {}) => ({
  accountId: 'acc', workerName: 'dc-x', databaseId: 'db', sessionSecret: 's'.repeat(40),
  refreshToken: await encryptToken('old-refresh', MASTER), ...extra,
});
afterEach(() => vi.unstubAllGlobals());

describe('a renewal Cloudflare refuses', () => {
  it("marks the account for a reconnect, with Cloudflare's reason and no token", async () => {
    const calls = stub(await oauthCfg(), { status: 400, body: { error: 'invalid_grant', error_description: 'expired' } });
    const res = await autoUpdate();
    expect(await res.json()).toMatchObject({ updated: false, reason: 'refresh-failed', detail: '400 invalid_grant' });
    const [save] = patches(calls);
    expect(fields(save).updateBlocked?.stringValue).toBe('reconnect');
    expect(fields(save).updateBlockedReason?.stringValue).toBe('400 invalid_grant');
    expect(mask(save).sort()).toEqual(['updateBlocked', 'updateBlockedAt', 'updateBlockedReason']);
    expect(save.body).not.toMatch(/refresh|access/);
    expect(calls.some((c) => c.url.includes('api.cloudflare.com/client/v4/accounts/'))).toBe(false);
  });
  it('a temporary failure (Cloudflare down) marks nothing', async () => {
    const calls = stub(await oauthCfg(), { status: 503, body: {} });
    const res = await autoUpdate();
    expect(await res.json()).toMatchObject({ updated: false, reason: 'refresh-failed' });
    expect(patches(calls)).toEqual([]);
  });
});

describe('a successful update', () => {
  it('clears an earlier reconnect mark', async () => {
    const calls = stub(await oauthCfg({ updateBlocked: 'reconnect', updateBlockedReason: '400 invalid_grant' }), { status: 200, body: { access_token: 'a' } });
    const res = await autoUpdate();
    expect(await res.json()).toMatchObject({ updated: true });
    const last = patches(calls).at(-1)!;
    expect(mask(last)).toEqual(expect.arrayContaining(['updateBlocked', 'updateBlockedReason', 'updateBlockedAt']));
    expect(fields(last).updateBlocked).toBeUndefined();
  });
});

describe('reconnecting', () => {
  const exchange = () => worker.fetch(new Request('https://deploy.example/oauth/cloudflare/exchange', {
    method: 'POST', headers: { Authorization: 'Bearer user-id-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: 'c', codeVerifier: 'v', redirectUri: 'https://accounts.daemonclient.uz/setup/cloudflare/callback' }),
  }), env);
  it('with a different Cloudflare account is refused before anything is built or saved', async () => {
    const calls = stub(await oauthCfg(), { status: 200, body: { access_token: 'a', refresh_token: 'r' } }, 'another-account');
    const res = await exchange();
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).error).toMatch(/same Cloudflare account/);
    expect(patches(calls)).toEqual([]);
    expect(calls.filter((c) => c.url.includes('api.cloudflare.com/client/v4/accounts/'))).toEqual([]);
  });
});
