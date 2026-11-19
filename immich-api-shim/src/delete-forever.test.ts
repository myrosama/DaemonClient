// Deleting a photo for good removes its Telegram messages. On the free plan a
// request may make only 50 outside calls, and Telegram may refuse a delete, so
// a photo's record of its parts is cleared only once Telegram confirms; until
// then the row stays a tombstone (gone from the library) that still holds its
// parts, and the next Empty Trash finishes the job.
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('./cached-config', () => ({
  getCachedConfig: async () => ({ botToken: 'TESTBOT', channelId: '-100123' }),
}));

import { handleAssets } from './assets';
import { sqliteD1 } from './test-d1';
import { testSessionToken, testAuthEnv } from './test-session';
// Another package, so the type check (rootDir = this package) skips this import.
// @ts-ignore TS6059: outside rootDir on purpose; vitest resolves it fine.
import { MIGRATION_SQL } from '../../schema/schema.mjs';

const parts = (first: number, n: number) =>
  JSON.stringify(Array.from({ length: n }, (_, i) => ({ index: i, message_id: first + i, file_id: `f${first + i}` })));

async function library(rows: Array<Record<string, any>>) {
  const DB = sqliteD1(MIGRATION_SQL);
  // Added by the worker's once-per-isolate schema step, which an earlier test
  // in this file may already have used up on its own database.
  await DB.prepare('ALTER TABLE photos ADD COLUMN telegramPlaybackChunks TEXT').run();
  await DB.prepare('ALTER TABLE photos ADD COLUMN purgedAt TEXT').run();
  for (const r of rows) {
    const row: Record<string, any> = {
      ownerId: 'u1', fileName: 'a.jpg', fileSize: 1, mimeType: 'image/jpeg',
      fileCreatedAt: '2026-01-01T00:00:00.000Z', uploadedAt: '2026-01-01T00:00:00.000Z', ...r,
    };
    const keys = Object.keys(row);
    await DB.prepare(`INSERT INTO photos (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).bind(...Object.values(row)).run();
  }
  return DB;
}

// Telegram's deleteMessages; `answer` decides the reply to the n-th call.
function telegram(answer: (n: number) => object = () => ({ ok: true, result: true })) {
  const calls: number[][] = [];
  vi.stubGlobal('fetch', async (url: any, init: any) => {
    const u = String(url);
    if (u.endsWith('/deleteMessages')) {
      calls.push(JSON.parse(init.body).message_ids);
      return new Response(JSON.stringify(answer(calls.length)));
    }
    if (u.endsWith('/deleteMessage')) throw new Error('one call per message: use deleteMessages');
    return new Response('{}');
  });
  return calls;
}

async function call(DB: any, method: string, path: string, body?: object) {
  const request = new Request(`https://worker.test${path}`, {
    method,
    headers: { Authorization: `Bearer ${await testSessionToken()}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return handleAssets(request, testAuthEnv({ DB, waitUntil: () => {} }) as any, path, new URL(request.url));
}

const row = (DB: any, id: string) => DB.rows('SELECT * FROM photos WHERE id = ?', id)[0];
const refused = { ok: false, error_code: 400, description: "Bad Request: message can't be deleted" };

afterEach(() => vi.unstubAllGlobals());

describe('deleting photos for good', () => {
  it('250 photos at once take three Telegram calls and leave nothing behind', async () => {
    const DB = await library(Array.from({ length: 250 }, (_, i) => ({ id: `p${i}`, telegramChunks: parts(i + 1, 1) })));
    const calls = telegram();
    const res = await call(DB, 'DELETE', '/api/assets', { ids: Array.from({ length: 250 }, (_, i) => `p${i}`) });
    expect(res.status).toBe(200);
    expect(calls.length).toBe(3);
    expect(calls.flat().sort((a, b) => a - b)).toEqual(Array.from({ length: 250 }, (_, i) => i + 1));
    for (const r of DB.rows('SELECT * FROM photos')) {
      expect([r.isTrashed, r.telegramChunks, !!r.purgedAt]).toEqual([1, '[]', true]);
    }
  });

  it('when Telegram refuses, the photo still leaves the library but keeps its parts until Empty Trash succeeds', async () => {
    const DB = await library([{ id: 'p1', telegramChunks: parts(5, 1) }]);
    telegram(() => refused);
    await call(DB, 'DELETE', '/api/assets', { ids: ['p1'] });
    expect([row(DB, 'p1').isTrashed, JSON.parse(row(DB, 'p1').telegramChunks)[0].message_id, row(DB, 'p1').purgedAt]).toEqual([1, 5, null]);

    const calls = telegram();
    const res = await call(DB, 'POST', '/api/trash/empty');
    expect(await res.json()).toEqual({ count: 1 });
    expect(calls).toEqual([[5]]);
    expect([row(DB, 'p1').telegramChunks, !!row(DB, 'p1').purgedAt]).toEqual(['[]', true]);
  });

  it('a video of more than 100 parts, with a playback copy, is cleared only when every call succeeds', async () => {
    const DB = await library([{
      id: 'v1', mimeType: 'video/mp4', telegramChunks: parts(1, 250),
      telegramPlaybackChunks: JSON.stringify({ size: 10, chunks: [{ index: 0, message_id: 900, file_id: 'pb' }] }),
    }]);
    const failed = telegram((n) => (n === 2 ? refused : { ok: true, result: true }));
    await call(DB, 'DELETE', '/api/assets', { ids: ['v1'] });
    expect(failed.length).toBe(2); // stops at the refusal
    expect(JSON.parse(row(DB, 'v1').telegramChunks).length).toBe(250);

    const calls = telegram();
    await call(DB, 'POST', '/api/trash/empty');
    expect(calls.map((c) => c.length)).toEqual([100, 100, 51]);
    expect(calls.flat()).toContain(900);
    expect([row(DB, 'v1').telegramChunks, row(DB, 'v1').telegramPlaybackChunks, !!row(DB, 'v1').purgedAt]).toEqual(['[]', null, true]);
  });

  it('one request stops at 40 Telegram calls; the rest stays for the next Empty Trash', async () => {
    // 45 photos of 101 parts each need two calls apiece: 90 in all.
    const DB = await library(Array.from({ length: 45 }, (_, i) => ({ id: `b${i}`, telegramChunks: parts(i * 1000 + 1, 101) })));
    const calls = telegram();
    await call(DB, 'DELETE', '/api/assets', { ids: Array.from({ length: 45 }, (_, i) => `b${i}`) });
    expect(calls.length).toBe(40);
    const cleared = () => DB.rows("SELECT id FROM photos WHERE telegramChunks = '[]'").length;
    expect(cleared()).toBe(20);
    expect(DB.rows('SELECT id FROM photos WHERE isTrashed = 1').length).toBe(45); // all gone from the library

    const res = await call(DB, 'POST', '/api/trash/empty');
    expect(await res.json()).toEqual({ count: 20 });
    expect(cleared()).toBe(40);
  });

  it('Empty Trash leaves finished tombstones alone, so they still expire on time', async () => {
    const DB = await library([
      { id: 't1', isTrashed: 1, telegramChunks: '[]', purgedAt: '2026-01-01T00:00:00.000Z' },
      // Deleted before this fix: parts already cleared, never stamped.
      { id: 't2', isTrashed: 1, telegramChunks: '[]' },
    ]);
    const calls = telegram();
    await call(DB, 'POST', '/api/trash/empty');
    expect(calls).toEqual([]);
    expect(row(DB, 't1').purgedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(!!row(DB, 't2').purgedAt).toBe(true);
  });
});
