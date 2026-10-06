import { describe, it, expect, afterEach, vi } from 'vitest';
import worker, { encryptToken, decryptToken, releasedTo } from './index';

// Auto-update re-deploys a user's worker.
// - A newly minted session secret is recorded as PENDING before the deploy and
//   becomes the live `sessionSecret` only after the worker runs with it: the
//   sign-in path signs with `sessionSecret`, and a worker not yet redeployed
//   still verifies the old way, so promoting it early locks the user out
//   whenever the deploy fails.
// - A rotated (single-use) Cloudflare refresh token is saved before the deploy;
//   after it only if that first save failed (a concurrent sign-in may already
//   have spent and replaced it).

const MASTER = 'm'.repeat(32);
const env = {
  FIREBASE_API_KEY: 'web-key',
  FIREBASE_PROJECT_ID: 'proj',
  ENCRYPTION_MASTER_KEY: MASTER,
  APP_IDENTIFIER: 'app',
  TELEGRAM_PROXY: 'https://proxy.example',
  ALLOWED_ORIGINS: 'https://photos.daemonclient.uz',
} as any;

type Call = { url: string; method: string; body?: string; metadata?: any };
type World = { cfg: Record<string, string>; patchStatus?: number | number[]; deployOk?: boolean; rotate?: boolean; changedSinceRead?: boolean };

async function stubWorld(world: World) {
  const calls: Call[] = [];
  let patches = 0;
  vi.stubGlobal('fetch', async (input: any, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const method = (init.method || 'GET').toUpperCase();
    const call: Call = { url, method, body: typeof init.body === 'string' ? init.body : undefined };
    if (init.body instanceof FormData) {
      const md = init.body.get('metadata');
      call.metadata = JSON.parse(typeof md === 'string' ? md : md ? await (md as Blob).text() : '{}');
    }
    calls.push(call);
    if (url.includes('identitytoolkit.googleapis.com')) {
      return new Response(JSON.stringify({ users: [{ localId: 'uid1', email: 'u@example.com' }] }));
    }
    if (url.includes('firestore.googleapis.com') && method === 'GET') {
      const fields = Object.fromEntries(Object.entries(world.cfg).map(([k, v]) => [k, { stringValue: v }]));
      return new Response(JSON.stringify({ fields, updateTime: '2026-10-05T08:00:00.123456Z' }));
    }
    if (url.includes('firestore.googleapis.com') && method === 'PATCH') {
      // Someone else wrote the document after our read: a conditional write fails.
      if (world.changedSinceRead && url.includes('currentDocument.updateTime=')) {
        patches++;
        return new Response('{"error":{"status":"FAILED_PRECONDITION"}}', { status: 400 });
      }
      const s = world.patchStatus ?? 200;
      const status = Array.isArray(s) ? s[Math.min(patches, s.length - 1)] : s;
      patches++;
      return new Response(status === 200 ? '{}' : 'denied', { status });
    }
    if (url.startsWith('https://dash.cloudflare.com/oauth2/token')) {
      return new Response(JSON.stringify({ access_token: 'cf-access', refresh_token: world.rotate ? 'rotated-refresh' : undefined }));
    }
    if (url.includes('api.cloudflare.com')) {
      return world.deployOk === false
        ? new Response('upstream error', { status: 500 })
        : new Response(JSON.stringify({ success: true, result: {} }));
    }
    return new Response('{}');
  });
  return calls;
}

const fieldsOf = (c: Call) => JSON.parse(c.body || '{}').fields as Record<string, { stringValue: string }>;
const saves = (calls: Call[]) => calls.filter((c) => c.method === 'PATCH');
const deployIndex = (calls: Call[]) => calls.findIndex((c) => c.url.includes('api.cloudflare.com'));
const autoUpdate = () =>
  worker.fetch(new Request('https://deploy.example/auto-update', { method: 'POST', headers: { Authorization: 'Bearer user-id-token' } }), env);
const legacyCfg = async (extra: Record<string, string> = {}) => ({
  accountId: 'acc', workerName: 'dc-x', databaseId: 'db', apiToken: await encryptToken('cf-token', MASTER), ...extra,
});

afterEach(() => vi.unstubAllGlobals());

describe('auto-update: a new session secret goes live only once the worker runs with it', () => {
  it('records it as pending before the deploy, and promotes it after', async () => {
    const calls = await stubWorld({ cfg: await legacyCfg() });
    const res = await autoUpdate();
    expect(res.status).toBe(200);
    const [before, after] = saves(calls);
    expect(calls.indexOf(before)).toBeLessThan(deployIndex(calls));
    expect(calls.indexOf(after)).toBeGreaterThan(deployIndex(calls));
    const pending = fieldsOf(before).pendingSessionSecret?.stringValue;
    expect(pending && pending.length >= 32).toBe(true);
    expect(fieldsOf(before).sessionSecret).toBeUndefined();
    expect(fieldsOf(after).sessionSecret?.stringValue).toBe(pending);
    expect(fieldsOf(after).pendingSessionSecret).toBeUndefined();
  });

  it('if the deploy fails, the live secret on record is unchanged (sign-in keeps working)', async () => {
    const calls = await stubWorld({ cfg: await legacyCfg(), deployOk: false });
    const res = await autoUpdate();
    expect(res.status).toBe(500);
    for (const save of saves(calls)) expect(fieldsOf(save).sessionSecret).toBeUndefined();
  });

  it('a pending secret from an earlier failed attempt is reused, not replaced', async () => {
    const earlier = 'p'.repeat(40);
    const calls = await stubWorld({ cfg: await legacyCfg({ pendingSessionSecret: earlier }) });
    const res = await autoUpdate();
    expect(res.status).toBe(200);
    const all = saves(calls);
    expect(all.length).toBe(1); // nothing new to record before the deploy
    expect(calls.indexOf(all[0])).toBeGreaterThan(deployIndex(calls));
    expect(fieldsOf(all[0]).sessionSecret?.stringValue).toBe(earlier);
    expect(fieldsOf(all[0]).pendingSessionSecret).toBeUndefined();
    // …and it is the secret the worker was deployed with.
    const deployed = calls[deployIndex(calls)].metadata?.bindings?.find((b: any) => b.name === 'SESSION_SECRET');
    expect(deployed?.text).toBe(earlier);
  });

  it('if recording a newly minted secret fails, nothing is deployed', async () => {
    const calls = await stubWorld({ cfg: await legacyCfg(), patchStatus: 403 });
    const res = await autoUpdate();
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ updated: false, reason: 'config-save-failed' });
    expect(deployIndex(calls)).toBe(-1);
  });

  it('with a live secret already, it deploys and then records the version — one save', async () => {
    const calls = await stubWorld({ cfg: await legacyCfg({ sessionSecret: 's'.repeat(40) }) });
    const res = await autoUpdate();
    expect(res.status).toBe(200);
    const all = saves(calls);
    expect(all.length).toBe(1);
    expect(calls.indexOf(all[0])).toBeGreaterThan(deployIndex(calls));
  });
});

describe('auto-update: a rotated refresh token', () => {
  const oauthCfg = async () => ({
    accountId: 'acc', workerName: 'dc-x', databaseId: 'db',
    refreshToken: await encryptToken('old-refresh', MASTER), sessionSecret: 's'.repeat(40),
  });

  it('is saved before the deploy', async () => {
    const calls = await stubWorld({ cfg: await oauthCfg(), rotate: true });
    expect((await autoUpdate()).status).toBe(200);
    const first = saves(calls)[0];
    expect(calls.indexOf(first)).toBeLessThan(deployIndex(calls));
    expect(await decryptToken(fieldsOf(first).refreshToken.stringValue, MASTER)).toBe('rotated-refresh');
  });

  it('once saved before the deploy, it is not written again after it (that could restore a spent token)', async () => {
    const calls = await stubWorld({ cfg: await oauthCfg(), rotate: true });
    expect((await autoUpdate()).status).toBe(200);
    const after = saves(calls).at(-1)!;
    expect(calls.indexOf(after)).toBeGreaterThan(deployIndex(calls));
    expect(fieldsOf(after).refreshToken).toBeUndefined();
    expect(new URL(after.url).searchParams.getAll('updateMask.fieldPaths')).not.toContain('refreshToken');
  });

  it('a failed first save does not stop the deploy (it does not depend on it), and it is saved again after', async () => {
    const calls = await stubWorld({ cfg: await oauthCfg(), rotate: true, patchStatus: [403, 200] });
    expect((await autoUpdate()).status).toBe(200);
    expect(deployIndex(calls)).toBeGreaterThan(-1);
    const last = saves(calls).at(-1)!;
    expect(calls.indexOf(last)).toBeGreaterThan(deployIndex(calls));
    expect(await decryptToken(fieldsOf(last).refreshToken.stringValue, MASTER)).toBe('rotated-refresh');
  });

  it('is saved again when the deploy fails after a failed first save', async () => {
    const calls = await stubWorld({ cfg: await oauthCfg(), rotate: true, patchStatus: [403, 200], deployOk: false });
    expect((await autoUpdate()).status).toBe(500);
    const last = saves(calls).at(-1)!;
    expect(calls.indexOf(last)).toBeGreaterThan(deployIndex(calls));
    expect(await decryptToken(fieldsOf(last).refreshToken.stringValue, MASTER)).toBe('rotated-refresh');
  });
});

describe('auto-update: two runs at once (login and first sync both trigger one)', () => {
  it('the pending-secret save only succeeds if nobody wrote the config since it was read', async () => {
    const calls = await stubWorld({ cfg: await legacyCfg() });
    expect((await autoUpdate()).status).toBe(200);
    const pendingSave = saves(calls)[0];
    expect(pendingSave.url).toContain('currentDocument.updateTime=' + encodeURIComponent('2026-10-05T08:00:00.123456Z'));
  });

  it('the run that loses the race deploys nothing, so the record and the worker cannot disagree', async () => {
    const calls = await stubWorld({ cfg: await legacyCfg(), changedSinceRead: true });
    const res = await autoUpdate();
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ updated: false, reason: 'raced' });
    expect(deployIndex(calls)).toBe(-1);
  });

  it('only the pending-secret save is conditional; the save after the deploy is not', async () => {
    const calls = await stubWorld({ cfg: await legacyCfg() });
    expect((await autoUpdate()).status).toBe(200);
    const [, after] = saves(calls);
    // No version match required (it can't lose a race) — only that the record exists.
    expect(after.url).not.toContain('currentDocument.updateTime');
    expect(new URL(after.url).searchParams.get('currentDocument.exists')).toBe('true');
  });

  it('a worker with a live secret updates even if the config changed since it was read', async () => {
    const calls = await stubWorld({ cfg: await legacyCfg({ sessionSecret: 's'.repeat(40) }), changedSinceRead: true });
    expect((await autoUpdate()).status).toBe(200);
    expect(deployIndex(calls)).toBeGreaterThan(-1);
  });

  it('a rotated refresh token plus a lost race: no deploy, and no write over the newer record', async () => {
    // A newly minted secret's save loses only to a rewrite of the record (a
    // re-provision with a newer grant's token); putting this run's token back
    // would undo it.
    const cfg = { accountId: 'acc', workerName: 'dc-x', databaseId: 'db', refreshToken: await encryptToken('old-refresh', MASTER) };
    const calls = await stubWorld({ cfg, rotate: true, changedSinceRead: true });
    expect((await autoUpdate()).status).toBe(409);
    expect(deployIndex(calls)).toBe(-1);
    expect(saves(calls).length).toBe(1);
    expect(saves(calls)[0].url).toContain('currentDocument.updateTime=');
  });

  it('the second of two runs at once (sign-in + first sync) keeps its rotated token even though the record changed', async () => {
    // Run A recorded the pending secret and its rotated token; run B read that,
    // spent A's token, and must keep the one it got — whatever A writes next.
    const cfg = {
      accountId: 'acc', workerName: 'dc-x', databaseId: 'db',
      refreshToken: await encryptToken('token-from-run-a', MASTER), pendingSessionSecret: 'p'.repeat(64),
    };
    const calls = await stubWorld({ cfg, rotate: true, changedSinceRead: true });
    expect((await autoUpdate()).status).toBe(200);
    expect(deployIndex(calls)).toBeGreaterThan(-1);
    const tokenSave = saves(calls).find((c) => fieldsOf(c).refreshToken)!;
    expect(calls.indexOf(tokenSave)).toBeLessThan(deployIndex(calls));
    expect(tokenSave.url).not.toContain('currentDocument.updateTime=');
    expect(await decryptToken(fieldsOf(tokenSave).refreshToken.stringValue, MASTER)).toBe('rotated-refresh');
    // …and the reused pending secret is the one deployed and promoted.
    expect(fieldsOf(saves(calls).at(-1)!).sessionSecret.stringValue).toBe('p'.repeat(64));
  });

  it('a save after a successful deploy is retried once', async () => {
    const calls = await stubWorld({ cfg: await legacyCfg({ sessionSecret: 's'.repeat(40) }), patchStatus: [500, 200] });
    expect((await autoUpdate()).status).toBe(200);
    expect(saves(calls).length).toBe(2);
    expect(saves(calls).every((c) => calls.indexOf(c) > deployIndex(calls))).toBe(true);
  });

  it('when recording a new secret fails, a rotated refresh token is still saved on its own', async () => {
    const cfg = { accountId: 'acc', workerName: 'dc-x', databaseId: 'db', refreshToken: await encryptToken('old-refresh', MASTER) };
    const calls = await stubWorld({ cfg, rotate: true, patchStatus: [503, 200] });
    expect((await autoUpdate()).status).toBe(500);
    expect(deployIndex(calls)).toBe(-1);
    const last = saves(calls).at(-1)!;
    expect(await decryptToken(fieldsOf(last).refreshToken.stringValue, MASTER)).toBe('rotated-refresh');
    expect(fieldsOf(last).pendingSessionSecret).toBeUndefined();
  });
});

describe('canary: a new shim release reaches only the listed workers first', () => {
  it('releasedTo: everyone when no list is set; only the listed workers when it is', () => {
    expect(releasedTo('dc-a', undefined)).toBe(true);
    expect(releasedTo('dc-a', '')).toBe(true);
    expect(releasedTo('dc-a', ' dc-a , dc-b ')).toBe(true);
    expect(releasedTo('dc-c', 'dc-a,dc-b')).toBe(false);
    expect(releasedTo('dc-a2', 'dc-a')).toBe(false);
  });

  it('a held worker is not touched at all — no save, no deploy', async () => {
    const calls = await stubWorld({ cfg: await legacyCfg({ sessionSecret: 's'.repeat(40) }) });
    const res = await worker.fetch(
      new Request('https://deploy.example/auto-update', { method: 'POST', headers: { Authorization: 'Bearer user-id-token' } }),
      { ...env, SHIM_CANARY_WORKERS: 'dc-someone-else' },
    );
    expect(await res.json()).toMatchObject({ updated: false, reason: 'held' });
    expect(deployIndex(calls)).toBe(-1);
    expect(saves(calls).length).toBe(0);
  });

  it('a listed worker updates as usual', async () => {
    const calls = await stubWorld({ cfg: await legacyCfg({ sessionSecret: 's'.repeat(40) }) });
    const res = await worker.fetch(
      new Request('https://deploy.example/auto-update', { method: 'POST', headers: { Authorization: 'Bearer user-id-token' } }),
      { ...env, SHIM_CANARY_WORKERS: 'dc-x' },
    );
    expect(res.status).toBe(200);
    expect(deployIndex(calls)).toBeGreaterThan(-1);
  });
});

describe('force-update never deploys a worker without its own session secret', () => {
  const force = (body: object) =>
    worker.fetch(
      new Request('https://deploy.example/admin/force-update', { method: 'POST', headers: { 'X-Admin-Secret': 'admin-secret-value', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      { ...env, ADMIN_SECRET: 'admin-secret-value' },
    );
  it('refuses without sessionSecret, before any deploy', async () => {
    const calls = await stubWorld({ cfg: {} });
    const base = { accountId: 'acc', workerName: 'dc-x', databaseId: 'db', apiToken: await encryptToken('cf-token', MASTER) };
    for (const sessionSecret of [undefined, '', 'short']) {
      const res = await force({ ...base, sessionSecret });
      expect(res.status).toBe(400);
    }
    expect(deployIndex(calls)).toBe(-1);
  });
});

describe('auto-update saves change only their own fields', () => {
  it('the post-deploy save carries an update mask and never rewrites fields it did not change', async () => {
    const calls = await stubWorld({ cfg: await legacyCfg({ refreshTokenNote: 'x' }) });
    expect((await autoUpdate()).status).toBe(200);
    const after = saves(calls).at(-1)!;
    const url = new URL(after.url);
    const mask = url.searchParams.getAll('updateMask.fieldPaths');
    expect(mask).toEqual(expect.arrayContaining(['sessionSecret', 'lastDeployedVersion', 'lastUpdatedAt', 'pendingSessionSecret']));
    expect(mask).not.toContain('apiToken');
    expect(Object.keys(fieldsOf(after))).not.toContain('apiToken');
    expect(Object.keys(fieldsOf(after))).not.toContain('refreshTokenNote');
    // An edit, never a create: a missing record is not recreated as a stub.
    expect(url.searchParams.get('currentDocument.exists')).toBe('true');
  });

  it('the pending save is masked and conditional', async () => {
    const calls = await stubWorld({ cfg: await legacyCfg() });
    await autoUpdate();
    const url = new URL(saves(calls)[0].url);
    expect(url.searchParams.getAll('updateMask.fieldPaths')).toEqual(expect.arrayContaining(['pendingSessionSecret', 'lastUpdatedAt']));
    expect(url.searchParams.get('currentDocument.updateTime')).toBeTruthy();
  });
});
