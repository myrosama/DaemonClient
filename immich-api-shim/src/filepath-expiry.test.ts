import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';

vi.mock('./cached-config', () => ({
  getCachedConfig: async () => ({ botToken: 'TESTBOT', channelId: '-100123' }),
}));

import { filePathCache, handleOriginal } from './assets';

// Telegram file paths are valid for about an hour. Two caches hold them: an
// in-memory map (L1, 55 min) and the edge cache (L2, 55 min). An L2 hit used to
// re-stamp L1 with a FULL 55 minutes no matter how old the L2 entry already
// was, so a path could live ~110 minutes against a ~60-minute validity. Past
// that, every download 404s and the media simply stops loading — with both
// layers still confidently serving the dead path until their own TTLs ran out.

const BODY = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
const photoRow = {
  id: 'img1',
  ownerId: 'u1',
  fileName: 'p.jpg',
  fileSize: BODY.length,
  mimeType: 'image/jpeg',
  fileCreatedAt: '2026-06-01T00:00:00Z',
  uploadedAt: '2026-06-01T00:00:01Z',
  encryptionMode: 'off',
  telegramOriginalId: 'c0',
  telegramChunks: JSON.stringify([{ index: 0, message_id: 1, file_id: 'c0' }]),
};
const fakeDb: any = {
  prepare: () => ({
    bind: () => ({ first: async () => photoRow, all: async () => ({ results: [photoRow] }), run: async () => ({}) }),
  }),
};

let edge: Map<string, string>;
let getFileCalls = 0;
let deadPaths: Set<string>;

beforeAll(() => {
  (globalThis as any).caches = {
    default: {
      match: async (k: any) => {
        const key = String(k instanceof Request ? k.url : k);
        const v = edge.get(key);
        return v === undefined ? undefined : new Response(v);
      },
      put: async (k: any, res: Response) => {
        const key = String(k instanceof Request ? k.url : k);
        if (key.includes('/chunk-cache/')) return;
        edge.set(key, await res.text());
      },
      delete: async (k: any) => edge.delete(String(k instanceof Request ? k.url : k)),
    },
  };

  globalThis.fetch = (async (input: any) => {
    const url = String(input instanceof Request ? input.url : input);
    const getFile = url.match(/\/botTESTBOT\/getFile\?file_id=(\w+)/);
    if (getFile) {
      getFileCalls++;
      return new Response(JSON.stringify({ ok: true, result: { file_path: `docs/fresh-${getFileCalls}.bin` } }));
    }
    const dl = url.match(/\/file\/botTESTBOT\/(.+)$/);
    if (dl) {
      if (deadPaths.has(dl[1])) return new Response('gone', { status: 404 });
      return new Response(BODY.slice());
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as any;
});

beforeEach(() => {
  edge = new Map();
  deadPaths = new Set();
  getFileCalls = 0;
  filePathCache.clear();
});

const fetchOriginal = async () => {
  const pending: Promise<any>[] = [];
  const env: any = { DB: fakeDb, waitUntil: (p: Promise<any>) => pending.push(p) };
  const res = await handleOriginal(
    new Request('https://worker.test/api/assets/img1/original'), env, 'u1', 'img1', 'tok',
  );
  // A chunk that cannot be fetched at all throws mid-stream — the response has
  // already begun, so there is nowhere left to put a status code. Swallow it
  // here; these tests are about how many times the path was re-resolved.
  await res.arrayBuffer().catch(() => {});
  await Promise.allSettled(pending);
  return res;
};

describe('a cached Telegram path cannot outlive its validity', () => {
  it('an L2 hit does NOT reset L1 to a full fresh TTL', async () => {
    // An L2 entry with only 4 minutes of life left.
    const nearlyDead = Date.now() + 4 * 60 * 1000;
    edge.set('https://dc-tg-path/c0', JSON.stringify({ path: 'docs/old.bin', exp: nearlyDead }));

    await fetchOriginal();

    const entry = filePathCache.get('c0');
    expect(entry).toBeDefined();
    // It must inherit the original expiry, not be granted another 55 minutes.
    expect(entry!.expiresAt).toBe(nearlyDead);
    expect(getFileCalls).toBe(0); // still a cache hit, just an honest one
  });

  it('an L2 entry past its expiry is not served — it re-resolves from Telegram', async () => {
    edge.set('https://dc-tg-path/c0', JSON.stringify({ path: 'docs/dead.bin', exp: Date.now() - 1000 }));
    await fetchOriginal();
    expect(getFileCalls).toBe(1);
    expect(filePathCache.get('c0')!.path).toBe('docs/fresh-1.bin');
  });

  it('a legacy plain-string entry is treated as half-spent, not as fresh', async () => {
    // Entries written before this change carry no expiry. Trusting them for a
    // full TTL is what produced the ~110-minute lifetime.
    edge.set('https://dc-tg-path/c0', 'docs/legacy.bin');
    const before = Date.now();
    await fetchOriginal();
    const entry = filePathCache.get('c0')!;
    expect(entry.path).toBe('docs/legacy.bin');
    expect(entry.expiresAt - before).toBeLessThanOrEqual(28 * 60 * 1000);
  });
});

describe('a path that has died on Telegram recovers by itself', () => {
  it('evicts both layers and retries once with a fresh path', async () => {
    // L1 and L2 both hold a path Telegram no longer honours.
    const exp = Date.now() + 50 * 60 * 1000;
    filePathCache.set('c0', { path: 'docs/dead.bin', expiresAt: exp });
    edge.set('https://dc-tg-path/c0', JSON.stringify({ path: 'docs/dead.bin', exp }));
    deadPaths.add('docs/dead.bin');

    const res = await fetchOriginal();

    expect(res.status).toBeLessThan(400);
    expect(getFileCalls).toBe(1);            // re-resolved exactly once
    expect(filePathCache.get('c0')!.path).toBe('docs/fresh-1.bin');
  });

  it('does not retry forever when the file is genuinely gone', async () => {
    const exp = Date.now() + 50 * 60 * 1000;
    filePathCache.set('c0', { path: 'docs/dead.bin', expiresAt: exp });
    edge.set('https://dc-tg-path/c0', JSON.stringify({ path: 'docs/dead.bin', exp }));
    deadPaths.add('docs/dead.bin');
    deadPaths.add('docs/fresh-1.bin'); // the refreshed one is dead too

    await fetchOriginal();

    // One refresh, then it gives up rather than looping against Telegram.
    expect(getFileCalls).toBe(1);
  });
});
