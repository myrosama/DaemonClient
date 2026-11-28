// A worker whose Cloudflare authorization no longer renews can't be updated.
// The update service records why and marks the account, so the dashboard can
// ask the owner to reconnect; reconnecting must use the same Cloudflare account.
import { describe, it, expect, afterEach, vi } from 'vitest';
import worker, { encryptToken, decryptToken } from './index';

const MASTER = 'm'.repeat(32);
const env = {
  FIREBASE_API_KEY: 'web-key', FIREBASE_PROJECT_ID: 'proj', ENCRYPTION_MASTER_KEY: MASTER,
  APP_IDENTIFIER: 'app', TELEGRAM_PROXY: 'https://proxy.example', ALLOWED_ORIGINS: 'https://photos.daemonclient.uz',
} as any;

type Call = { url: string; method: string; body?: string };
const CLAIMED = '2026-11-18T08:00:01.000000Z'; // the version after this run's claim
function stub(cfg: Record<string, string> | null, token: { status: number; body: any }, accounts: string | string[] = 'acc', readStatus = 200, dbExists = false) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', async (input: any, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const method = (init.method || 'GET').toUpperCase();
    calls.push({ url, method, body: typeof init.body === 'string' ? init.body : undefined });
    if (url.includes('identitytoolkit.googleapis.com')) return new Response(JSON.stringify({ users: [{ localId: 'uid1', email: 'u@example.com' }] }));
    if (url.includes('firestore.googleapis.com') && method === 'GET') {
      if (readStatus !== 200) return new Response('{}', { status: readStatus });
      if (!cfg) return new Response('{"error":{"status":"NOT_FOUND"}}', { status: 404 });
      return new Response(JSON.stringify({ fields: Object.fromEntries(Object.entries(cfg).map(([k, v]) => [k, { stringValue: v }])), updateTime: '2026-11-18T08:00:00.000000Z' }));
    }
    if (url.includes('firestore.googleapis.com') && method === 'PATCH') return new Response(JSON.stringify({ updateTime: CLAIMED }));
    if (url.startsWith('https://dash.cloudflare.com/oauth2/token')) return new Response(JSON.stringify(token.body), { status: token.status });
    if (url === 'https://api.cloudflare.com/client/v4/accounts') return new Response(JSON.stringify({ result: [accounts].flat().map((id) => ({ id })) }));
    // The cloud's database already exists: creating it fails, the list has it.
    if (dbExists && url.endsWith('/d1/database') && method === 'POST') return new Response(JSON.stringify({ success: false, errors: [{ message: 'database already exists' }] }), { status: 400 });
    if (url.endsWith('/d1/database') && method === 'GET') return new Response(JSON.stringify({ success: true, result: [{ name: 'dc-photos-uid1', uuid: 'db-existing' }] }));
    if (url.endsWith('/workers/subdomain')) return new Response(JSON.stringify({ success: true, result: { subdomain: 'acme' } }));
    if (url.includes('api.cloudflare.com')) return new Response(JSON.stringify({ success: true, result: {} }));
    return new Response('{}');
  });
  return calls;
}
const patches = (calls: Call[]) => calls.filter((c) => c.method === 'PATCH');
const marks = (calls: Call[]) => patches(calls).filter((c) => fields(c).updateBlocked);
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
    const [save] = marks(calls);
    expect(fields(save).updateBlocked?.stringValue).toBe('reconnect');
    expect(fields(save).updateBlockedReason?.stringValue).toBe('400 invalid_grant');
    expect(mask(save).sort()).toEqual(['updateBlocked', 'updateBlockedAt', 'updateBlockedReason']);
    // Only onto the version this run claimed: a reconnect since then wins.
    expect(new URL(save.url).searchParams.get('currentDocument.updateTime')).toBe(CLAIMED);
    expect(save.body).not.toMatch(/refresh|access/);
    expect(calls.some((c) => c.url.includes('api.cloudflare.com/client/v4/accounts/'))).toBe(false);
  });
  for (const [what, status, body] of [['Cloudflare down', 503, {}], ['rate-limited', 429, { error: 'slow_down' }], ['a challenge page', 403, {}], ['our client broken', 401, { error: 'invalid_client' }]] as const) {
    it(`anything but a refused grant (${what}) marks nothing`, async () => {
      const calls = stub(await oauthCfg(), { status, body });
      const res = await autoUpdate();
      expect(await res.json()).toMatchObject({ updated: false, reason: 'refresh-failed' });
      expect(marks(calls)).toEqual([]);
    });
  }
  it('an account already marked is not written again', async () => {
    const calls = stub(await oauthCfg({ updateBlocked: 'reconnect' }), { status: 400, body: { error: 'invalid_grant' } });
    await autoUpdate();
    expect(marks(calls)).toEqual([]);
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
  const built = (calls: Call[]) => calls.filter((c) => c.url.includes('api.cloudflare.com/client/v4/accounts/'));
  it('when the current setup cannot be read, stops before anything is built or saved', async () => {
    const calls = stub(await oauthCfg(), { status: 200, body: { access_token: 'a', refresh_token: 'r' } }, 'another-account', 500);
    const res = await exchange();
    expect(res.status).toBe(503);
    expect([patches(calls), built(calls)]).toEqual([[], []]);
  });
  it('a first setup (no config yet) goes ahead: schema, then keys, then the owner', async () => {
    const calls = stub(null, { status: 200, body: { access_token: 'a', refresh_token: 'r' } }, 'new-account');
    const res = await exchange();
    expect([409, 503]).not.toContain(res.status);
    expect(built(calls).length).toBeGreaterThan(0);
    const sql = calls.filter((c) => c.url.includes('/query')).map((c) => JSON.parse(c.body!).sql as string);
    expect(sql).toHaveLength(3);
    expect(sql[0]).toMatch(/CREATE TABLE/);
    expect(sql[1]).toMatch(/zke_password/);
    expect(sql[2]).toBe("INSERT OR IGNORE INTO config (key, value) VALUES ('owner_uid', ?)");
  });
  it('with several accounts granted, uses the one that holds the cloud', async () => {
    const calls = stub(await oauthCfg(), { status: 200, body: { access_token: 'a', refresh_token: 'r' } }, ['other', 'acc']);
    const res = await exchange();
    expect(res.status).not.toBe(409);
    expect(built(calls).every((c) => c.url.includes('/accounts/acc/'))).toBe(true);
    expect(built(calls).length).toBeGreaterThan(0);
  });
  it('with the same account keeps the cloud: same database and keys, same sign-in secret, a new token, no mark', async () => {
    const calls = stub(await oauthCfg({ updateBlocked: 'reconnect', updateBlockedReason: '400 invalid_grant', databaseId: 'db-existing', setupTimestamp: '2026-06-01T00:00:00.000Z' }),
      { status: 200, body: { access_token: 'a', refresh_token: 'r-new' } }, 'acc', 200, true);
    const res = await exchange();
    expect(res.status).toBe(200);
    // No migration and no new encryption keys: the database is used as it is.
    // The one query records the owner, and never replaces one.
    const queries = calls.filter((c) => c.url.includes('/query'));
    expect(queries.map((c) => JSON.parse(c.body!))).toEqual([
      { sql: "INSERT OR IGNORE INTO config (key, value) VALUES ('owner_uid', ?)", params: ['uid1'] },
    ]);
    const [save] = patches(calls);
    expect(new URL(save.url).searchParams.getAll('updateMask.fieldPaths')).toEqual([]); // the whole record is replaced…
    const f = fields(save);
    expect([f.databaseId?.stringValue, f.sessionSecret?.stringValue, f.setupTimestamp?.stringValue]).toEqual(['db-existing', 's'.repeat(40), '2026-06-01T00:00:00.000Z']);
    expect(f.updateBlocked).toBeUndefined(); // …so the mark is gone
    expect(await decryptToken(f.refreshToken.stringValue, MASTER)).toBe('r-new');
  });
  it('with a different Cloudflare account is refused before anything is built or saved', async () => {
    const calls = stub(await oauthCfg(), { status: 200, body: { access_token: 'a', refresh_token: 'r' } }, 'another-account');
    const res = await exchange();
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).error).toMatch(/same Cloudflare account/);
    expect(patches(calls)).toEqual([]);
    expect(calls.filter((c) => c.url.includes('api.cloudflare.com/client/v4/accounts/'))).toEqual([]);
  });
});

describe('the owner is recorded in the worker', () => {
  it('on every update, before the deploy, and never replaces one', async () => {
    const calls = stub(await oauthCfg(), { status: 200, body: { access_token: 'a', refresh_token: 'r-new' } });
    const res = await autoUpdate();
    expect(res.status).toBe(200);
    const q = calls.findIndex((c) => c.url.includes('/d1/database/db/query'));
    const deploy = calls.findIndex((c) => /\/workers\/scripts\/dc-x$/.test(c.url) && c.method === 'PUT');
    expect(q).toBeGreaterThan(-1);
    expect(q).toBeLessThan(deploy);
    expect(JSON.parse(calls[q].body!)).toEqual({ sql: "INSERT OR IGNORE INTO config (key, value) VALUES ('owner_uid', ?)", params: ['uid1'] });
  });
});
