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
function telegram(answer: (n: number, ids: number[]) => object = () => ({ ok: true, result: true })) {
  const calls: number[][] = [];
  vi.stubGlobal('fetch', async (url: any, init: any) => {
    const u = String(url);
    if (u.endsWith('/deleteMessages')) {
      calls.push(JSON.parse(init.body).message_ids);
      return new Response(JSON.stringify(answer(calls.length, calls[calls.length - 1])));
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
// A refusal that stops the request (retry later), and one about the messages.
const busy = { ok: false, error_code: 429, description: 'Too Many Requests: retry after 5' };
const undeletable = { ok: false, error_code: 400, description: "Bad Request: message can't be deleted" };

afterEach(() => vi.unstubAllGlobals());

describe('deleting photos for good', () => {
  it('250 photos at once take three Telegram calls, and every one finishes', async () => {
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

  it('when Telegram refuses for now, the photo still leaves the library but keeps its parts until Empty Trash succeeds', async () => {
    const DB = await library([{ id: 'p1', telegramChunks: parts(5, 1) }]);
    telegram(() => busy);
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
    const failed = telegram((n) => (n === 2 ? busy : { ok: true, result: true }));
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

  it("another owner's row is never deleted, even when named directly or as a live-photo pair", async () => {
    const DB = await library([
      { id: 'mine', telegramChunks: parts(1, 1), livePhotoVideoId: 'theirs-pair' },
      { id: 'theirs', ownerId: 'u2', telegramChunks: parts(50, 1) },
      { id: 'theirs-pair', ownerId: 'u2', telegramChunks: parts(60, 1) },
    ]);
    const calls = telegram();
    await call(DB, 'DELETE', '/api/assets', { ids: ['mine', 'theirs'] });
    expect(calls.flat()).toEqual([1]);
    expect([row(DB, 'theirs').isTrashed, row(DB, 'theirs-pair').isTrashed]).toEqual([0, 0]);
  });

  it('a refusal only one photo can cause does not hold back the others sharing its call', async () => {
    const DB = await library([1, 2, 3].map((i) => ({ id: `s${i}`, telegramChunks: parts(i, 1) })));
    const calls = telegram((_, ids) => (ids.includes(2) ? undeletable : { ok: true, result: true }));
    await call(DB, 'DELETE', '/api/assets', { ids: ['s1', 's2', 's3'] });
    expect(calls).toEqual([[1, 2, 3], [1], [2], [3]]);
    // s1 and s3 finish; s2 keeps its parts for a retry (the bot's rights or the
    // message's age may change), and is logged.
    expect(DB.rows("SELECT id FROM photos WHERE purgedAt IS NOT NULL ORDER BY id").map((r: any) => r.id)).toEqual(['s1', 's3']);
    expect([row(DB, 's2').isTrashed, JSON.parse(row(DB, 's2').telegramChunks).length]).toEqual([1, 1]);
  });

  it("a message Telegram no longer has (not found, invalid id) counts as deleted", async () => {
    const DB = await library([{ id: 'nf', telegramChunks: parts(8, 1) }]);
    telegram(() => ({ ok: false, error_code: 400, description: 'Bad Request: message to delete not found' }));
    await call(DB, 'DELETE', '/api/assets', { ids: ['nf'] });
    expect([row(DB, 'nf').telegramChunks, !!row(DB, 'nf').purgedAt]).toEqual(['[]', true]);
  });

  it('a refusal about the channel itself (a wrong chat, no rights) keeps every photo for a retry', async () => {
    const DB = await library([1, 2].map((i) => ({ id: `c${i}`, telegramChunks: parts(i, 1) })));
    const calls = telegram(() => ({ ok: false, error_code: 400, description: 'Bad Request: chat not found' }));
    await call(DB, 'DELETE', '/api/assets', { ids: ['c1', 'c2'] });
    expect(calls.length).toBe(1);
    expect(DB.rows("SELECT id FROM photos WHERE isTrashed = 1 AND purgedAt IS NULL AND telegramChunks != '[]'").length).toBe(2);
  });

  it('with Telegram unreachable the photos still leave the library first, keeping their parts', async () => {
    const DB = await library([{ id: 'u1p', telegramChunks: parts(7, 1) }]);
    vi.stubGlobal('fetch', async () => { throw new Error('network'); });
    expect((await call(DB, 'DELETE', '/api/assets', { ids: ['u1p'] })).status).toBe(200);
    expect([row(DB, 'u1p').isTrashed, row(DB, 'u1p').purgedAt, JSON.parse(row(DB, 'u1p').telegramChunks).length]).toEqual([1, null, 1]);
  });

  it('deleting a finished tombstone again changes nothing, so it still expires on time', async () => {
    const DB = await library([{ id: 'done', isTrashed: 1, telegramChunks: '[]', purgedAt: '2026-01-01T00:00:00.000Z' }]);
    const calls = telegram();
    await call(DB, 'DELETE', '/api/assets', { ids: ['done'] });
    expect([calls, row(DB, 'done').purgedAt]).toEqual([[], '2026-01-01T00:00:00.000Z']);
  });

  it("a still's pair is deleted with it only when the pair is a video", async () => {
    const DB = await library([
      { id: 'still', telegramChunks: parts(1, 1), livePhotoVideoId: 'other-photo' },
      { id: 'other-photo', telegramChunks: parts(2, 1) },
    ]);
    const calls = telegram();
    await call(DB, 'DELETE', '/api/assets', { ids: ['still'] });
    expect(calls.flat()).toEqual([1]);
    expect(row(DB, 'other-photo').isTrashed).toBe(0);
  });

  it('message ids that cannot exist (0, negative, past 32 bits) are never sent', async () => {
    const DB = await library([{ id: 'z', telegramChunks: JSON.stringify([{ index: 0, message_id: 0, file_id: 'f' }, { index: 1, message_id: -3, file_id: 'g' }, { index: 2, message_id: 2 ** 31, file_id: 'h' }]) }]);
    const calls = telegram();
    await call(DB, 'DELETE', '/api/assets', { ids: ['z'] });
    expect(calls).toEqual([]);
    expect(!!row(DB, 'z').purgedAt).toBe(true);
  });

  it('a new delete also finishes an earlier one Telegram had not confirmed', async () => {
    const DB = await library([
      { id: 'pending', isTrashed: 1, telegramChunks: parts(3, 1) },
      { id: 'fresh', telegramChunks: parts(9, 1) },
    ]);
    const calls = telegram();
    await call(DB, 'DELETE', '/api/assets', { ids: ['fresh'] });
    expect(calls.flat().sort()).toEqual([3, 9]);
    expect([!!row(DB, 'pending').purgedAt, !!row(DB, 'fresh').purgedAt]).toEqual([true, true]);
  });

  it('nothing can be restored: a deleted photo stays deleted', async () => {
    const DB = await library([{ id: 'gone1', isTrashed: 1, telegramChunks: '[]', purgedAt: '2026-01-01T00:00:00.000Z' }]);
    for (const [path, body] of [['/api/trash/restore', undefined], ['/api/trash/restore/assets', { ids: ['gone1'] }]] as const) {
      expect((await call(DB, 'POST', path, body)).status).toBe(400); // the website then says it couldn't restore
    }
    expect(row(DB, 'gone1').isTrashed).toBe(1);
  });

  it('a deleted photo is never served, even while its Telegram parts linger', async () => {
    const DB = await library([{ id: 'linger', isTrashed: 1, telegramChunks: parts(4, 1) }]);
    vi.stubGlobal('fetch', async () => { throw new Error('no outside calls expected'); });
    for (const path of ['/api/assets/linger/original', '/api/assets/linger/dc-manifest', '/api/assets/linger/video/playback']) {
      expect([path, (await call(DB, 'GET', path)).status]).toEqual([path, 404]);
    }
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
