import { describe, it, expect, beforeAll, vi } from 'vitest';

// Mock the config module BEFORE importing assets.ts so handleOriginal gets a
// bot token without touching Firestore/D1 config tables.
vi.mock('./cached-config', () => ({
  getCachedConfig: async () => ({ botToken: 'TESTBOT', channelId: '-100123' }),
}));

import { handleOriginal } from './assets';

// ── Synthetic 3-chunk video ──────────────────────────────────────────────────
// 45,000,000 bytes split exactly like the upload path does: 19 MiB, 19 MiB,
// remainder. Byte i has a deterministic value so any mis-stitched offset shows
// up as a content mismatch, not just a length mismatch.
const CHUNK = 19 * 1024 * 1024; // must equal CHUNK_SIZE in assets.ts
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

// Minimal D1 stub: only getPhoto's `SELECT * FROM photos WHERE id = ?` is hit.
const fakeDb = {
  prepare: (_sql: string) => ({
    bind: (..._args: any[]) => ({
      first: async () => photoRow,
      all: async () => ({ results: [photoRow] }),
      run: async () => ({}),
    }),
  }),
};

const env: any = { DB: fakeDb, waitUntil: (_p: Promise<any>) => {} };

function makeRequest(range?: string): Request {
  const headers: Record<string, string> = {};
  if (range) headers['Range'] = range;
  return new Request('https://worker.test/api/assets/vid1/original', { headers });
}

beforeAll(() => {
  FULL = new Uint8Array(TOTAL);
  for (let i = 0; i < TOTAL; i++) FULL[i] = (i * 131 + 7) & 0xff;

  // Workers' caches.default doesn't exist under vitest/node — stub a no-op.
  (globalThis as any).caches = {
    default: { match: async () => undefined, put: async () => {} },
  };

  // Telegram API stub: getFile returns a file_path; the file URL returns the
  // chunk's bytes. Everything else is unexpected.
  globalThis.fetch = (async (input: any) => {
    const url = String(input instanceof Request ? input.url : input);
    const getFile = url.match(/\/botTESTBOT\/getFile\?file_id=(c\d)/);
    if (getFile) {
      return new Response(JSON.stringify({ ok: true, result: { file_path: `docs/${getFile[1]}.bin` } }));
    }
    const dl = url.match(/\/file\/botTESTBOT\/docs\/(c\d)\.bin/);
    if (dl) {
      const n = parseInt(dl[1].slice(1), 10);
      return new Response(chunkBytes(n).slice());
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  }) as any;
});

async function bodyBytes(res: Response): Promise<Uint8Array> {
  return new Uint8Array(await res.arrayBuffer());
}

// vitest's toEqual on multi-MB typed arrays is unusably slow (element-wise
// diff + serialization across the worker boundary crashes the fork). Compare
// manually and report only the first mismatching offset.
function firstMismatch(got: Uint8Array, want: Uint8Array): string | null {
  if (got.length !== want.length) return `length ${got.length} != ${want.length}`;
  for (let i = 0; i < got.length; i++) {
    if (got[i] !== want[i]) return `byte ${i}: got ${got[i]}, want ${want[i]}`;
  }
  return null;
}

describe('multi-chunk video range stitching (handleOriginal)', () => {
  it('serves a small range from the first chunk', async () => {
    const res = await handleOriginal(makeRequest('bytes=0-1023'), env, 'u1', 'vid1', 'tok');
    expect(res.status).toBe(206);
    expect(res.headers.get('Content-Range')).toBe(`bytes 0-1023/${TOTAL}`);
    expect(firstMismatch(await bodyBytes(res), FULL.slice(0, 1024))).toBeNull();
  });

  it('serves a range spanning the chunk-0/chunk-1 boundary', async () => {
    const start = CHUNK - 500;
    const end = CHUNK + 499;
    const res = await handleOriginal(makeRequest(`bytes=${start}-${end}`), env, 'u1', 'vid1', 'tok');
    expect(res.status).toBe(206);
    expect(res.headers.get('Content-Range')).toBe(`bytes ${start}-${end}/${TOTAL}`);
    expect(firstMismatch(await bodyBytes(res), FULL.slice(start, end + 1))).toBeNull();
  });

  it('serves a suffix range (moov-at-end probe) from the last chunk', async () => {
    const res = await handleOriginal(makeRequest('bytes=-1000'), env, 'u1', 'vid1', 'tok');
    expect(res.status).toBe(206);
    expect(res.headers.get('Content-Range')).toBe(`bytes ${TOTAL - 1000}-${TOTAL - 1}/${TOTAL}`);
    expect(firstMismatch(await bodyBytes(res), FULL.slice(TOTAL - 1000))).toBeNull();
  });

  it('caps an open-ended bytes=0- request at the serving window', async () => {
    const res = await handleOriginal(makeRequest('bytes=0-'), env, 'u1', 'vid1', 'tok');
    expect(res.status).toBe(206);
    const cr = res.headers.get('Content-Range')!;
    const m = cr.match(/^bytes 0-(\d+)\/(\d+)$/)!;
    expect(parseInt(m[2], 10)).toBe(TOTAL);
    const end = parseInt(m[1], 10);
    const body = await bodyBytes(res);
    expect(body.length).toBe(end + 1);
    expect(firstMismatch(body, FULL.slice(0, end + 1))).toBeNull();
  });

  it('serves a mid-file range entirely inside chunk 2', async () => {
    const res = await handleOriginal(makeRequest('bytes=40000000-40009999'), env, 'u1', 'vid1', 'tok');
    expect(res.status).toBe(206);
    expect(firstMismatch(await bodyBytes(res), FULL.slice(40000000, 40010000))).toBeNull();
  });

  it('streams the complete file byte-identically without a Range header', async () => {
    const res = await handleOriginal(makeRequest(), env, 'u1', 'vid1', 'tok');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Length')).toBe(String(TOTAL));
    const body = await bodyBytes(res);
    expect(body.length).toBe(TOTAL);
    expect(firstMismatch(body, FULL)).toBeNull();
  });

  it('rejects an out-of-bounds range with 416', async () => {
    const res = await handleOriginal(makeRequest(`bytes=${TOTAL}-${TOTAL + 10}`), env, 'u1', 'vid1', 'tok');
    expect(res.status).toBe(416);
  });
});
