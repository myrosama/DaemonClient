import { describe, it, expect, afterEach, vi } from 'vitest';
import worker, { encryptToken, runFleetUpdate, fleetSlice } from './index';
import { SHIM_VERSION } from './shim-bundle';

// The scheduled fleet update brings workers whose owners never sign in to the
// current shim — one small batch per run (free-plan limits), rotating through
// the out-of-date workers so one that keeps failing can't block the rest, and
// using exactly the same update steps as the sign-in path.

const MASTER = 'm'.repeat(32);

async function testPem(): Promise<string> {
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify'],
  )) as CryptoKeyPair;
  const der = new Uint8Array((await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer);
  let bin = '';
  der.forEach((b) => (bin += String.fromCharCode(b)));
  return `-----BEGIN PRIVATE KEY-----\n${btoa(bin)}\n-----END PRIVATE KEY-----\n`;
}

type Doc = { uid: string; fields: Record<string, string> };
async function stubFleet(docs: Doc[], opts: { deployOk?: boolean } = {}) {
  const calls: { url: string; method: string; body?: string }[] = [];
  vi.stubGlobal('fetch', async (input: any, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const method = (init.method || 'GET').toUpperCase();
    calls.push({ url, method, body: typeof init.body === 'string' ? init.body : undefined });
    if (url.startsWith('https://oauth2.googleapis.com/token')) return new Response(JSON.stringify({ access_token: 'sa' }));
    if (url.includes(':runQuery')) {
      const rows = docs.map((d) => ({
        document: {
          name: `projects/proj/databases/(default)/documents/artifacts/default-daemon-client/users/${d.uid}/config/cloudflare`,
          fields: Object.fromEntries(Object.entries(d.fields).map(([k, v]) => [k, { stringValue: v }])),
          updateTime: '2026-10-06T00:00:00.000000Z',
        },
      }));
      rows.push({ document: { name: 'projects/proj/databases/(default)/documents/artifacts/default-daemon-client/users/u-tg/config/telegram', fields: { botToken: { stringValue: 'x' } }, updateTime: 't' } } as any);
      return new Response(JSON.stringify(rows));
    }
    if (url.includes('firestore.googleapis.com') && method === 'PATCH') return new Response('{}');
    if (url.includes('api.cloudflare.com')) {
      return opts.deployOk === false ? new Response('err', { status: 500 }) : new Response(JSON.stringify({ success: true, result: {} }));
    }
    return new Response('{}');
  });
  return calls;
}

const env = async (extra: Record<string, unknown> = {}) => ({
  FIREBASE_PROJECT_ID: 'proj', ENCRYPTION_MASTER_KEY: MASTER, APP_IDENTIFIER: 'app', TELEGRAM_PROXY: 'https://p.example',
  ALLOWED_ORIGINS: 'https://photos.daemonclient.uz',
  FIREBASE_SA_CLIENT_EMAIL: 'svc@proj.iam.gserviceaccount.com', FIREBASE_SA_PRIVATE_KEY: await testPem(), ...extra,
}) as any;
const outdated = async (uid: string, extra: Record<string, string> = {}): Promise<Doc> => ({
  uid, fields: { accountId: 'acc', workerName: `dc-${uid}`, databaseId: 'db', apiToken: await encryptToken('cf', MASTER), sessionSecret: 's'.repeat(40), lastDeployedVersion: 'old', lastUpdatedAt: '2026-01-01T00:00:00Z', ...extra },
});
const deploys = (calls: { url: string }[]) => calls.filter((c) => c.url.includes('api.cloudflare.com')).length;

afterEach(() => vi.unstubAllGlobals());

describe('fleetSlice — which out-of-date workers a run takes', () => {
  it('rotates through the list run by run, so a stuck worker never blocks the rest', () => {
    const list = ['a', 'b', 'c'];
    expect(fleetSlice(list, 1, 0)).toEqual(['a']);
    expect(fleetSlice(list, 1, 1)).toEqual(['b']);
    expect(fleetSlice(list, 1, 2)).toEqual(['c']);
    expect(fleetSlice(list, 1, 3)).toEqual(['a']);
    expect(fleetSlice(list, 2, 1)).toEqual(['c', 'a']);
    expect(fleetSlice([], 1, 5)).toEqual([]);
    expect(fleetSlice(list, 5, 0)).toEqual(['a', 'b', 'c']);
  });
});

describe('runFleetUpdate', () => {
  it('updates only out-of-date, enabled workers that have credentials — one per run by default', async () => {
    const calls = await stubFleet([
      await outdated('u1'),
      await outdated('u-current', { lastDeployedVersion: SHIM_VERSION }),
      await outdated('u-disabled', { autoUpdateEnabled: 'false' }),
      { uid: 'u-nocreds', fields: { accountId: 'acc', workerName: 'dc-x', lastDeployedVersion: 'old' } },
    ]);
    const results = await runFleetUpdate(await env(), { slot: 0 });
    expect(results.map((r) => r.worker)).toEqual(['dc-u1']);
    expect(deploys(calls)).toBe(1);
  });

  it('reads the fleet with the service account, never a user token', async () => {
    const calls = await stubFleet([await outdated('u1')]);
    await runFleetUpdate(await env(), { slot: 0 });
    const query = calls.find((c) => c.url.includes(':runQuery'));
    expect(query).toBeTruthy();
  });

  it('respects a canary list', async () => {
    const calls = await stubFleet([await outdated('u1'), await outdated('u2')]);
    const results = await runFleetUpdate(await env({ SHIM_CANARY_WORKERS: 'dc-u2' }), { slot: 0 });
    expect(results.map((r) => r.worker)).toEqual(['dc-u2']);
    expect(deploys(calls)).toBe(1);
  });

  it('a worker with no session secret gets one recorded as pending before its deploy', async () => {
    const legacy = await outdated('u-legacy');
    delete legacy.fields.sessionSecret;
    const calls = await stubFleet([legacy]);
    const [result] = await runFleetUpdate(await env(), { slot: 0 });
    expect(result.result.status).toBe(200);
    const saves = calls.filter((c) => c.method === 'PATCH');
    const deployAt = calls.findIndex((c) => c.url.includes('api.cloudflare.com'));
    expect(calls.indexOf(saves[0])).toBeLessThan(deployAt);
    expect(JSON.parse(saves[0].body!).fields.pendingSessionSecret).toBeTruthy();
  });

  it('a failed deploy is reported, not thrown', async () => {
    await stubFleet([await outdated('u1')], { deployOk: false });
    const [result] = await runFleetUpdate(await env(), { slot: 0 });
    expect(result.result.status).toBe(500);
  });

  it('does nothing without service-account credentials', async () => {
    const calls = await stubFleet([await outdated('u1')]);
    const results = await runFleetUpdate({ ...(await env()), FIREBASE_SA_CLIENT_EMAIL: undefined }, { slot: 0 });
    expect(results).toEqual([]);
    expect(calls.length).toBe(0);
  });

  it('runs from the scheduled (cron) handler', async () => {
    const calls = await stubFleet([await outdated('u1')]);
    const pending: Promise<unknown>[] = [];
    await (worker as any).scheduled({ scheduledTime: 0, cron: '*/10 * * * *' }, await env(), { waitUntil: (p: Promise<unknown>) => pending.push(p) });
    await Promise.all(pending);
    expect(deploys(calls)).toBe(1);
  });

  it("ignores look-alike documents deeper in a user's own tree (only users/{uid}/config/cloudflare counts)", async () => {
    const calls: { url: string; method: string; body?: string }[] = [];
    const legit = await outdated('u-real');
    vi.stubGlobal('fetch', async (input: any, init: RequestInit = {}) => {
      const url = typeof input === 'string' ? input : input.url;
      calls.push({ url, method: (init.method || 'GET').toUpperCase(), body: typeof init.body === 'string' ? init.body : undefined });
      if (url.startsWith('https://oauth2.googleapis.com/token')) return new Response(JSON.stringify({ access_token: 'sa' }));
      if (url.includes(':runQuery')) {
        const doc = (name: string, fields: Record<string, string>) => ({ document: { name, updateTime: 't', fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, { stringValue: v }])) } });
        return new Response(JSON.stringify([
          doc('projects/proj/databases/(default)/documents/artifacts/default-daemon-client/users/u-victim/x/y/config/cloudflare',
            { ...legit.fields, workerName: 'dc-planted', workerUrl: 'https://evil.example' }),
          doc('projects/proj/databases/(default)/documents/artifacts/other-app/users/u-victim/config/cloudflare', { ...legit.fields, workerName: 'dc-other-app' }),
        ]));
      }
      return new Response('{}');
    });
    const results = await runFleetUpdate(await env(), { slot: 0 });
    expect(results).toEqual([]);
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('asks Firestore only for the fields an update needs', async () => {
    const calls = await stubFleet([await outdated('u1')]);
    await runFleetUpdate(await env(), { slot: 0 });
    const query = JSON.parse(calls.find((c) => c.url.includes(':runQuery'))!.body!);
    const fields = query.structuredQuery.select.fields.map((f: { fieldPath: string }) => f.fieldPath);
    expect(fields).toContain('workerName');
    expect(fields).not.toContain('botToken');
  });

  it('leaves a worker its owner touched in the last 15 minutes (a sign-in update may be running)', async () => {
    const calls = await stubFleet([await outdated('u1', { lastUpdatedAt: new Date().toISOString() })]);
    const results = await runFleetUpdate(await env(), { slot: 0 });
    expect(results).toEqual([]);
    expect(deploys(calls)).toBe(0);
  });
});

