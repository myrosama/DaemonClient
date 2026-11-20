import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';

vi.mock('./cached-config', () => ({
  getCachedConfig: async () => ({ botToken: 'TESTBOT', channelId: '-100123' }),
}));

import { filePathCache, pruneFilePathCache, FILE_PATH_CACHE_MAX, handleOriginal } from './assets';

// Cloudflare reuses an isolate across requests, so anything at module scope
// lives until the isolate dies. Two things here grew without bound, and the
// symptom was the operator's: "after it gets this problem I reopen the app and
// it's good again for some time, then again problem" — a new connection lands
// on a fresh isolate and the clock restarts. Exceeding the 128 MB cap is error
// 1102, which the app surfaces as sync or backup failure.

describe('filePathCache stays bounded', () => {
  beforeEach(() => filePathCache.clear());

  it('drops entries that have expired', () => {
    const now = Date.now();
    filePathCache.set('stale', { path: 'a', expiresAt: now - 1 });
    filePathCache.set('fresh', { path: 'b', expiresAt: now + 60_000 });

    pruneFilePathCache(now);

    expect(filePathCache.has('stale')).toBe(false);
    expect(filePathCache.has('fresh')).toBe(true);
  });

  it('never exceeds the cap, however many entries are added', () => {
    const now = Date.now();
    for (let i = 0; i < FILE_PATH_CACHE_MAX + 500; i++) {
      filePathCache.set(`f${i}`, { path: `p${i}`, expiresAt: now + 60_000 });
    }
    pruneFilePathCache(now);
    expect(filePathCache.size).toBeLessThanOrEqual(FILE_PATH_CACHE_MAX);
  });

  it('evicts oldest first, so the most recent lookups survive', () => {
    const now = Date.now();
    for (let i = 0; i < FILE_PATH_CACHE_MAX + 10; i++) {
      filePathCache.set(`f${i}`, { path: `p${i}`, expiresAt: now + 60_000 });
    }
    pruneFilePathCache(now);
    expect(filePathCache.has('f0')).toBe(false);
    expect(filePathCache.has(`f${FILE_PATH_CACHE_MAX + 9}`)).toBe(true);
  });

  it('an all-expired cache prunes to empty rather than to the cap', () => {
    const now = Date.now();
    for (let i = 0; i < 50; i++) filePathCache.set(`f${i}`, { path: 'p', expiresAt: now - 1 });
    pruneFilePathCache(now);
    expect(filePathCache.size).toBe(0);
  });
});

// ── The 19 MB copies ────────────────────────────────────────────────────────
// getChunk copies each decrypted chunk with `data.slice(0)` and hands the copy
// to waitUntil, which keeps it alive after the response is returned. A
// multi-chunk video fetched chunks concurrently, so several 19 MB copies were
// retained at once, on top of the chunks themselves.

const CHUNK = 19 * 1024 * 1024;
const TOTAL = 45_000_000;
let FULL: Uint8Array;
const chunkBytes = (n: number) => FULL.subarray(n * CHUNK, Math.min((n + 1) * CHUNK, TOTAL));

const photoRow = {
  id: 'vid1',
  ownerId: 'u1',
  fileName: 'movie.mp4',
  fileSize: TOTAL,
  mimeType: 'video/mp4',
  fileCreatedAt: '2026-06-01T00:00:00Z',
  uploadedAt: '2026-06-01T00:00:01Z',
  encryptionMode: 'off',
  telegramChunks: JSON.stringify([
    { index: 0, message_id: 1, file_id: 'c0' },
    { index: 1, message_id: 2, file_id: 'c1' },
    { index: 2, message_id: 3, file_id: 'c2' },
  ]),
};

const fakeDb: any = {
  prepare: () => ({
    bind: () => ({ first: async () => photoRow, all: async () => ({ results: [photoRow] }), run: async () => ({}) }),
  }),
};

let concurrentPuts = 0;
let peakConcurrentPuts = 0;
let releaseWrites: Array<() => void> = [];

beforeAll(() => {
  FULL = new Uint8Array(TOTAL);
  for (let i = 0; i < TOTAL; i++) FULL[i] = (i * 131 + 7) & 0xff;

  (globalThis as any).caches = {
    default: {
      match: async () => undefined,
      // Hold each write open until the test releases it, so overlap is
      // observable rather than a race we happen to lose.
      put: async (key: any) => {
        // Only the CHUNK writes matter — those are the 19 MB ones. tgGetFileUrl
        // also caches the Telegram file path here, but that is a short string.
        const url = String(key instanceof Request ? key.url : key);
        if (!url.includes('/chunk-cache/')) return;
        concurrentPuts++;
        peakConcurrentPuts = Math.max(peakConcurrentPuts, concurrentPuts);
        await new Promise<void>((r) => releaseWrites.push(r));
        concurrentPuts--;
      },
    },
  };

  globalThis.fetch = (async (input: any) => {
    const url = String(input instanceof Request ? input.url : input);
    const getFile = url.match(/\/botTESTBOT\/getFile\?file_id=(c\d)/);
    if (getFile) return new Response(JSON.stringify({ ok: true, result: { file_path: `docs/${getFile[1]}.bin` } }));
    const dl = url.match(/\/file\/botTESTBOT\/docs\/(c\d)\.bin/);
    if (dl) return new Response(chunkBytes(parseInt(dl[1].slice(1), 10)).slice());
    throw new Error(`unexpected fetch: ${url}`);
  }) as any;
});

describe('the prune is actually WIRED IN, not merely correct', () => {
  // The four tests above call pruneFilePathCache directly, so they would pass
  // against a build that never calls it — which is how a fix ships and does
  // nothing. This drives the real path instead.
  it('a real media fetch prunes the cache it inserts into', async () => {
    filePathCache.clear();
    const now = Date.now();
    // Well over the cap, all long expired.
    for (let i = 0; i < FILE_PATH_CACHE_MAX + 200; i++) {
      filePathCache.set(`junk${i}`, { path: 'p', expiresAt: now - 60_000 });
    }
    expect(filePathCache.size).toBeGreaterThan(FILE_PATH_CACHE_MAX);

    const pending: Promise<any>[] = [];
    const env: any = { DB: fakeDb, waitUntil: (p: Promise<any>) => pending.push(p) };
    const res = await handleOriginal(
      new Request('https://worker.test/api/assets/vid1/original', { headers: { Range: 'bytes=0-1023' } }),
      env, 'u1', 'vid1', 'tok',
    );
    await res.arrayBuffer();

    // tgGetFileUrl inserted this fetch's path and pruned on the way through.
    expect(filePathCache.size).toBeLessThanOrEqual(FILE_PATH_CACHE_MAX);
    releaseWrites.forEach((r) => r());
    await Promise.all(pending);
  }, 60000);
});

describe('chunk cache writes do not pile up', () => {
  it('holds at most one 19 MB copy open at a time across a whole video', async () => {
    concurrentPuts = 0;
    peakConcurrentPuts = 0;
    releaseWrites = [];

    const pending: Promise<any>[] = [];
    const env: any = { DB: fakeDb, waitUntil: (p: Promise<any>) => pending.push(p) };
    const req = new Request('https://worker.test/api/assets/vid1/original');

    const res = await handleOriginal(req, env, 'u1', 'vid1', 'tok');
    await res.arrayBuffer();

    // Every chunk has been fetched by now. Without the bound, one write per
    // chunk is outstanding; with it, one.
    expect(peakConcurrentPuts).toBeLessThanOrEqual(1);

    releaseWrites.forEach((r) => r());
    await Promise.all(pending);
  }, 60000);
});
