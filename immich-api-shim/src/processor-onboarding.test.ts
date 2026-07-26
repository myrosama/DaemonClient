import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('./cached-config', () => ({
  getCachedConfig: async () => ({ botToken: 'T', channelId: '-1' }),
}));

import { handleServer } from './server';
import { testSessionToken, testAuthEnv } from './test-session';

// Attaching a HEIC processor is the most dangerous input in the product: what
// is stored here receives the user's PLAINTEXT photo bytes. Storing whatever
// the user pastes would mean a typo, or a URL from a forum post, quietly
// forwarding their photographs to a stranger.
//
// Three things are proved before the URL is saved, and the third is the one
// that matters — health output is identical for everybody, so only an
// authenticated round-trip can establish that an instance belongs to THIS user.

let saved: any = {};
function db() {
  saved = {};
  return {
    prepare: (sql: string) => ({
      bind: (...args: any[]) => ({
        first: async () => (sql.includes('SELECT') ? null : null),
        all: async () => ({ results: [] }),
        run: async () => { if (sql.startsWith('INSERT') || sql.startsWith('UPDATE')) saved.args = args; return {}; },
      }),
      first: async () => null,
      all: async () => ({ results: [] }),
      run: async () => ({}),
    }),
  };
}

const HEALTHY = { service: 'daemonclient-processor', version: '2.0.0', ownerPinned: true, ok: true, problems: [] };

let fetchSpy: any;
function stub(health: any, probeStatus = 400) {
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init: any) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith('/health')) {
      if (health === 'unreachable') throw new Error('boom');
      if (health === 'notfound') return new Response('no', { status: 404 });
      return new Response(JSON.stringify(health), { headers: { 'Content-Type': 'application/json' } });
    }
    if (url.endsWith('/convertHeicThumbnail')) return new Response('{}', { status: probeStatus });
    throw new Error(`unexpected fetch ${url}`);
  });
}
afterEach(() => fetchSpy?.mockRestore());

async function attach(url: string) {
  const req = new Request('https://worker.test/api/server/processor', {
    method: 'POST',
    headers: { Authorization: `Bearer ${await testSessionToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  const env: any = testAuthEnv({ DB: db(), waitUntil: () => {} });
  const res = await handleServer(req, env, '/api/server/processor');
  return { status: res.status, body: (await res.json()) as any };
}

describe('attaching a HEIC processor', () => {
  it('accepts the user’s own, verified instance', async () => {
    stub(HEALTHY, 400); // 400 = authorised, and complaining about the fake image
    const r = await attach('https://my-processor.vercel.app');
    expect(r.status).toBe(200);
    expect(r.body.url).toBe('https://my-processor.vercel.app/convertHeicThumbnail');
  });

  it('accepts a URL pasted with the convert path already on it', async () => {
    stub(HEALTHY, 400);
    const r = await attach('https://my-processor.vercel.app/convertHeicThumbnail');
    expect(r.status).toBe(200);
    expect(r.body.url).toBe('https://my-processor.vercel.app/convertHeicThumbnail');
  });

  it('REFUSES an instance belonging to someone else', async () => {
    // Health looks perfect — it is the same for every deployment. Only the
    // authenticated probe can tell these apart, and it 401s.
    stub(HEALTHY, 401);
    const r = await attach('https://someone-elses.vercel.app');
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/different account/i);
  });

  it('REFUSES an unpinned instance anyone could use', async () => {
    stub({ ...HEALTHY, ownerPinned: false, problems: ['OWNER_UID is not set'] }, 400);
    const r = await attach('https://open.vercel.app');
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/OWNER_UID/);
  });

  it('REFUSES a URL that is not a processor at all', async () => {
    stub({ service: 'some-other-app' }, 400);
    const r = await attach('https://example.com');
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/not a DaemonClient processor/i);
  });

  it('REFUSES plaintext http — the photos are the payload', async () => {
    stub(HEALTHY, 400);
    const r = await attach('http://my-processor.vercel.app');
    expect(r.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  const internal = [
    'https://localhost/x',
    'https://127.0.0.1/x',
    'https://10.1.2.3/x',
    'https://192.168.0.5/x',
    'https://172.16.0.9/x',
    'https://169.254.169.254/latest/meta-data/',
    'https://something.internal/x',
  ];
  for (const url of internal) {
    it(`REFUSES the internal address ${url}`, async () => {
      stub(HEALTHY, 400);
      const r = await attach(url);
      expect(r.status).toBe(400);
      // Must be rejected before any request leaves the worker.
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  }

  it('REFUSES something unreachable rather than storing it hopefully', async () => {
    stub('unreachable');
    const r = await attach('https://typo.vercel.app');
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/could not reach/i);
  });

  it('REFUSES a half-finished deploy', async () => {
    stub('notfound');
    const r = await attach('https://still-building.vercel.app');
    expect(r.status).toBe(400);
  });

  it('rejects nonsense that is not a URL', async () => {
    stub(HEALTHY, 400);
    const r = await attach('not a url');
    expect(r.status).toBe(400);
  });
});
