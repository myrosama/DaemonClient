import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { testSessionToken, testAuthEnv } from './test-session';

// Attaching a processor must WAKE the lazy HEIC backfill.
//
// The backfill's completion flag is module-scope, so it lives for the isolate's
// whole life. The first run for a user with NO processor stamps the flag
// "complete" and the job goes dormant forever on that isolate — correct, because
// without a per-user processor the plaintext bytes have nowhere safe to go. The
// trap: if that same user LATER attaches a processor, the flag is still stuck
// true, so their existing thumb-less HEIC rows never heal until a fresh isolate
// happens to serve them. `handleProcessor` now calls `resetHeicThumbBackfill()`
// on a successful save to close exactly that gap. These tests fail if the reset
// is removed — the backfill stays dormant and its config read never fires again.

// A mutable config the mock returns, plus a call counter. The counter only moves
// when the backfill body actually executes (i.e. it was NOT suppressed by the
// completion flag or the throttle) — it is read AFTER both guards.
const h = vi.hoisted(() => ({ state: { url: undefined as string | undefined, calls: 0 } }));
vi.mock('./cached-config', () => ({
  getCachedConfig: async () => {
    h.state.calls++;
    return { botToken: 'T', channelId: '-100', heicConvertUrl: h.state.url };
  },
}));

import { backfillHeicThumbBatch, resetHeicThumbBackfill } from './assets';
import { handleServer } from './server';

// One DB mock that serves both the processor attach (config get/set) and the
// backfill (an empty photos SELECT, so the run settles without touching Telegram).
function db() {
  const stmt = (sql: string) => ({
    bind: (..._a: any[]) => ({
      first: async () => null,
      all: async () => ({ results: [] }),
      run: async () => ({}),
    }),
    first: async () => null,
    all: async () => ({ results: [] }),
    run: async () => ({}),
  });
  return { prepare: (sql: string) => stmt(sql) };
}

const HEALTHY = { service: 'daemonclient-processor', version: '2.0.0', ownerPinned: true, ok: true, problems: [] };
let fetchSpy: any;
function stubProcessorFetch(probeStatus = 400) {
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith('/health')) return new Response(JSON.stringify(HEALTHY), { headers: { 'Content-Type': 'application/json' } });
    if (url.endsWith('/convertHeicThumbnail')) return new Response('{}', { status: probeStatus });
    throw new Error(`unexpected fetch ${url}`);
  });
}

beforeEach(() => {
  resetHeicThumbBackfill();
  h.state.url = undefined;
  h.state.calls = 0;
});
afterEach(() => fetchSpy?.mockRestore());

describe('a processor attach re-arms the HEIC backfill', () => {
  it('reset() wakes a backfill that had gone permanently dormant', async () => {
    const env: any = { DB: db() };

    // 1. No processor yet → the backfill runs once, then stamps itself complete.
    await backfillHeicThumbBatch(env, 'u1', 'tok');
    expect(h.state.calls).toBe(1);

    // 2. A processor now exists, but the flag is still stuck "complete", so the
    //    backfill refuses to run — its config read never fires. This IS the bug.
    h.state.url = 'https://p.example.com/convertHeicThumbnail';
    await backfillHeicThumbBatch(env, 'u1', 'tok');
    expect(h.state.calls).toBe(1);

    // 3. The nudge re-arms it → the very next dispatch runs and reads the config,
    //    so the existing thumb-less HEIC rows get a healing pass.
    resetHeicThumbBackfill();
    await backfillHeicThumbBatch(env, 'u1', 'tok');
    expect(h.state.calls).toBe(2);
  });

  it('a successful POST /api/server/processor wakes it end-to-end', async () => {
    const backfillEnv: any = { DB: db() };

    // Make the backfill dormant first (the "already been running without a
    // processor" state a real user is in when they add one later).
    await backfillHeicThumbBatch(backfillEnv, 'u1', 'tok');
    expect(h.state.calls).toBe(1);

    // Attach a verified processor through the real endpoint.
    stubProcessorFetch(400); // 400 on the probe = authorised, complaining about the fake image
    const req = new Request('https://worker.test/api/server/processor', {
      method: 'POST',
      headers: { Authorization: `Bearer ${await testSessionToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://my-processor.vercel.app' }),
    });
    const res = await handleServer(req, testAuthEnv({ DB: db(), waitUntil: () => {} }) as any, '/api/server/processor');
    expect(res.status).toBe(200);

    // The attach reset the flag, so the next backfill dispatch runs again.
    h.state.url = 'https://my-processor.vercel.app/convertHeicThumbnail';
    await backfillHeicThumbBatch(backfillEnv, 'u1', 'tok');
    expect(h.state.calls).toBe(2);
  });
});
