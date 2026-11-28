// Worker fixes the iPhone app needed (release R7): one type per field, the
// visibility a client asks for, edits the worker used to drop, and the Immich
// v3.2 search filter.
import { describe, it, expect, vi } from 'vitest';

vi.mock('./cached-config', () => ({
  getCachedConfig: async () => ({ botToken: 'TESTBOT', channelId: '-100123' }),
}));

import { handleTimeline } from './timeline';
import { handleAssets } from './assets';
import { handleSearch } from './search';
import { handleAlbums } from './albums';
import { durationToMs, msToDurationText, localTimeOf } from './helpers';
import { sqliteD1 } from './test-d1';
import { testSessionToken, testAuthEnv } from './test-session';
// Another package, so the type check (rootDir = this package) skips this import.
// @ts-ignore TS6059: outside rootDir on purpose; vitest resolves it fine.
import { MIGRATION_SQL } from '../../../packages/schema/schema.mjs';

async function library(rows: Array<Record<string, any>>) {
  const DB = sqliteD1(MIGRATION_SQL);
  await DB.prepare('ALTER TABLE photos ADD COLUMN telegramPlaybackChunks TEXT').run();
  await DB.prepare('ALTER TABLE photos ADD COLUMN purgedAt TEXT').run();
  for (const r of rows) {
    const row: Record<string, any> = {
      ownerId: 'u1', fileName: `${r.id}.jpg`, fileSize: 1, mimeType: 'image/jpeg',
      fileCreatedAt: '2026-08-10T10:00:00.000Z', uploadedAt: '2026-08-11T10:00:00.000Z', ...r,
    };
    const keys = Object.keys(row);
    await DB.prepare(`INSERT INTO photos (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).bind(...Object.values(row)).run();
  }
  return DB;
}

const auth = async () => ({ Authorization: `Bearer ${await testSessionToken()}` });
const env = (DB: any) => testAuthEnv({ DB, waitUntil: () => {} }) as any;

async function get(DB: any, path: string) {
  const url = new URL(`https://worker.test${path}`);
  const req = new Request(url, { headers: await auth() });
  return (await handleTimeline(req, env(DB), url.pathname, url)).json() as Promise<any>;
}

async function search(DB: any, body: object) {
  const req = new Request('https://worker.test/api/search/metadata', {
    method: 'POST', headers: { ...(await auth()), 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return ((await (await handleSearch(req, env(DB), '/api/search/metadata')).json()) as any).assets;
}
const ids = (a: any) => a.items.map((i: any) => i.id).sort();

describe('duration', () => {
  it('reads Immich text and bare milliseconds; zero, junk and overflow are null', () => {
    expect(durationToMs('0:00:12.345678')).toBe(12346);
    expect(durationToMs('1:02:03.5')).toBe(3723500);
    expect(durationToMs('12500')).toBe(12500);
    expect([durationToMs('0:00:00.000000'), durationToMs(null), durationToMs('abc'), durationToMs('9999999999999:00:00')]).toEqual([null, null, null, null]);
    expect([msToDurationText(12500), msToDurationText(3723500)]).toEqual(['00:00:12.500000', '01:02:03.500000']);
  });

  it('reads the local time from a date that names its offset', () => {
    expect(localTimeOf('2026-11-12T20:05:22-08:00')).toEqual({ localDateTime: '2026-11-12T20:05:22.000Z', timeZone: 'UTC-8', offsetHours: -8 });
    expect(localTimeOf('2026-11-12T20:05:22+05:30')?.timeZone).toBe('UTC+5:30');
    expect(localTimeOf('2026-11-12T20:05:22')).toBeNull();
  });

  it('a date read from the file (camera time with Z) gets its offset from the real moment', () => {
    // Taken 20:05 local in Tashkent (UTC+5) = 15:05 UTC.
    expect(localTimeOf('2026-11-12T20:05:22Z', '2026-11-12T15:05:22.000Z')).toEqual({ localDateTime: '2026-11-12T20:05:22.000Z', timeZone: 'UTC+5', offsetHours: 5 });
    expect(localTimeOf('2026-11-12T20:05:22Z')).toBeNull();
    expect(localTimeOf('2026-11-12T20:05:22Z', '2026-11-10T00:00:00.000Z')).toBeNull(); // more than 14 h apart: no guess
  });

  it('the month contents carry durationMs as numbers or null, and keep duration as text', async () => {
    const DB = await library([
      { id: 'v1', mimeType: 'video/mp4', duration: '0:00:12.500000' },
      { id: 'p1' },
    ]);
    const m = await get(DB, '/api/timeline/bucket?timeBucket=2026-08-01T00:00:00.000Z');
    const at = (k: string) => m[k][m.id.indexOf('v1')];
    expect([at('durationMs'), at('duration')]).toEqual([12500, '00:00:12.500000']);
    expect(m.durationMs[m.id.indexOf('p1')]).toBeNull();
  });
});

describe('visibility in the timeline', () => {
  const rows = [{ id: 'shown' }, { id: 'archived', visibility: 'archive' }, { id: 'locked', visibility: 'locked' }];
  const month = '2026-08-01T00:00:00.000Z';
  it('the main timeline (visibility=timeline) leaves out archived and locked photos, in the month list and its contents alike', async () => {
    const DB = await library(rows);
    const months = await get(DB, '/api/timeline/buckets?visibility=timeline');
    const m = await get(DB, `/api/timeline/bucket?timeBucket=${month}&visibility=timeline`);
    expect(m.id).toEqual(['shown']);
    expect(months).toEqual([{ timeBucket: month, count: 1 }]);
  });
  it('no visibility (albums, favourites, trash) means timeline and archive, never locked', async () => {
    const DB = await library(rows);
    expect((await get(DB, `/api/timeline/bucket?timeBucket=${month}`)).id.sort()).toEqual(['archived', 'shown']);
    expect(await get(DB, '/api/timeline/buckets')).toEqual([{ timeBucket: month, count: 2 }]);
  });
  it('an album set to oldest first lists its months oldest first', async () => {
    const DB = await library([{ id: 'a', fileCreatedAt: '2026-01-02T00:00:00.000Z' }, { id: 'b', fileCreatedAt: '2026-03-02T00:00:00.000Z' }]);
    const months = (await get(DB, '/api/timeline/buckets?order=asc')).map((m: any) => m.timeBucket.slice(0, 7));
    expect(months).toEqual(['2026-01', '2026-03']);
  });
  it('a view asks for its own visibility and gets only that', async () => {
    const DB = await library(rows);
    expect((await get(DB, '/api/timeline/bucket?timeBucket=2026-08-01T00:00:00.000Z&visibility=archive')).id).toEqual(['archived']);
    expect((await get(DB, '/api/timeline/bucket?timeBucket=2026-08-01T00:00:00.000Z&visibility=locked')).id).toEqual(['locked']);
  });
});

describe('edits the worker used to drop', () => {
  async function upload(DB: any, fields: Record<string, string>) {
    const form = new FormData();
    const base: Record<string, string> = {
      clientUpload: 'true', telegramChunks: JSON.stringify([{ index: 0, message_id: 1, file_id: 'orig' }]),
      telegramOriginalId: 'orig', telegramThumbId: 'thumb', encryptionMode: 'server', thumbEncrypted: 'true',
      fileName: 'IMG_1.JPG', fileSize: '10', mimeType: 'image/jpeg', checksum: 'c2hhMQ==',
      deviceAssetId: 'dev-1', deviceId: 'phone', fileCreatedAt: '2026-08-10T10:00:00.000Z',
    };
    for (const [k, v] of Object.entries({ ...base, ...fields })) form.append(k, v);
    const req = new Request('https://worker.test/api/assets', { method: 'POST', headers: await auth(), body: form });
    return handleAssets(req, env(DB), '/api/assets', new URL(req.url));
  }

  it('an upload keeps the visibility the phone gave it, and ignores an unknown one', async () => {
    const DB = await library([]);
    await upload(DB, { visibility: 'locked' });
    await upload(DB, { visibility: 'secret', deviceAssetId: 'dev-2', checksum: 'c2hhMg==' });
    const vis = DB.rows('SELECT deviceAssetId, visibility FROM photos ORDER BY deviceAssetId');
    expect(vis.map((r: any) => r.visibility)).toEqual(['locked', 'timeline']);
  });

  it('a bare-milliseconds duration from the app is stored as Immich text', async () => {
    const DB = await library([]);
    await upload(DB, { mimeType: 'video/quicktime', fileName: 'IMG_2.MOV', duration: '12500' });
    expect(DB.rows('SELECT duration FROM photos')[0].duration).toBe('00:00:12.500000');
  });

  it('after a dated edit, the asset reports the local time and time zone the app checks for', async () => {
    const DB = await library([{ id: 'p1' }]);
    const put = new Request('https://worker.test/api/assets', {
      method: 'PUT', headers: { ...(await auth()), 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: ['p1'], dateTimeOriginal: '2026-11-12T20:05:22-08:00' }),
    });
    expect((await handleAssets(put, env(DB), '/api/assets', new URL(put.url))).status).toBeLessThan(300);
    const req = new Request('https://worker.test/api/assets/p1', { headers: await auth() });
    const dto = (await (await handleAssets(req, env(DB), '/api/assets/p1', new URL(req.url))).json()) as any;
    expect(dto.localDateTime.startsWith('2026-11-12T20:05:22')).toBe(true);
    expect(dto.exifInfo.timeZone).toBe('UTC-8');
    expect(dto.fileCreatedAt).toBe('2026-11-13T04:05:22.000Z');
    const m = await get(DB, '/api/timeline/bucket?timeBucket=2026-11-01T00:00:00.000Z');
    expect(m.localOffsetHours).toEqual([-8]);
  });

  it('junk dates are ignored', async () => {
    const DB = await library([{ id: 'p1' }]);
    for (const bad of ['hello 2020', '1', '+275760-09-13T00:00:00Z', '1200-01-01T00:00:00Z', `2020-01-01T00:00:00Z${'x'.repeat(100)}`, '2020-02-30T10:00:00+05:00']) {
      const req = new Request('https://worker.test/api/assets/p1', {
        method: 'PUT', headers: { ...(await auth()), 'Content-Type': 'application/json' }, body: JSON.stringify({ dateTimeOriginal: bad }),
      });
      await handleAssets(req, env(DB), '/api/assets/p1', new URL(req.url));
    }
    expect(DB.rows("SELECT fileCreatedAt, dateTimeOriginal FROM photos WHERE id = 'p1'")[0])
      .toEqual({ fileCreatedAt: '2026-08-10T10:00:00.000Z', dateTimeOriginal: null });
  });

  it('PUT dateTimeOriginal moves the photo on the timeline and keeps the time zone text', async () => {
    const DB = await library([{ id: 'p1' }]);
    const req = new Request('https://worker.test/api/assets/p1', {
      method: 'PUT', headers: { ...(await auth()), 'Content-Type': 'application/json' },
      body: JSON.stringify({ dateTimeOriginal: '2025-03-01T09:30:00.000+05:00' }),
    });
    const res = await handleAssets(req, env(DB), '/api/assets/p1', new URL(req.url));
    expect(res.status).toBe(200);
    const [row] = DB.rows("SELECT fileCreatedAt, dateTimeOriginal FROM photos WHERE id = 'p1'");
    expect(row).toEqual({ fileCreatedAt: '2025-03-01T04:30:00.000Z', dateTimeOriginal: '2025-03-01T09:30:00.000+05:00' });
  });

  it("an album's sort order is saved and returned", async () => {
    const DB = await library([]);
    const created = await handleAlbums(new Request('https://worker.test/api/albums', {
      method: 'POST', headers: { ...(await auth()), 'Content-Type': 'application/json' }, body: JSON.stringify({ albumName: 'Trip' }),
    }), env(DB), '/api/albums');
    const { id } = (await created.json()) as any;
    const patch = await handleAlbums(new Request(`https://worker.test/api/albums/${id}`, {
      method: 'PATCH', headers: { ...(await auth()), 'Content-Type': 'application/json' }, body: JSON.stringify({ order: 'asc' }),
    }), env(DB), `/api/albums/${id}`);
    expect(((await patch.json()) as any).order).toBe('asc');
    const again = await handleAlbums(new Request(`https://worker.test/api/albums/${id}`, { headers: await auth() }), env(DB), `/api/albums/${id}`);
    expect(((await again.json()) as any).order).toBe('asc');
  });
});

describe('search with the Immich v3.2 filter', () => {
  const rows = [
    { id: 'photo', fileCreatedAt: '2026-01-05T00:00:00.000Z', make: 'Apple' },
    { id: 'video', mimeType: 'video/mp4', duration: '0:00:03.000000', fileCreatedAt: '2026-02-05T00:00:00.000Z' },
    { id: 'fav', isFavorite: 1, fileCreatedAt: '2026-03-05T00:00:00.000Z' },
    { id: 'archived', visibility: 'archive', fileCreatedAt: '2026-04-05T00:00:00.000Z' },
    { id: 'deleted', isTrashed: 1, fileCreatedAt: '2026-05-05T00:00:00.000Z' },
  ];

  it('applies each field instead of returning the whole library', async () => {
    const DB = await library(rows);
    expect(ids(await search(DB, { filter: { type: { eq: 'VIDEO' } } }))).toEqual(['video']);
    expect(ids(await search(DB, { filter: { isFavorite: { eq: true } } }))).toEqual(['fav']);
    expect(ids(await search(DB, { filter: { visibility: { eq: 'archive' } } }))).toEqual(['archived']);
    expect(ids(await search(DB, { filter: { make: { eq: 'Apple' } } }))).toEqual(['photo']);
    expect(ids(await search(DB, { filter: { takenAt: { gte: '2026-02-01T00:00:00.000Z', lte: '2026-03-31T00:00:00.000Z' } } }))).toEqual(['fav', 'video']);
  });

  it('deleted photos only when the filter asks about trashedAt', async () => {
    const DB = await library(rows);
    expect(ids(await search(DB, { filter: {} }))).not.toContain('deleted');
    expect(ids(await search(DB, { filter: { trashedAt: { ne: null } } }))).toEqual(['deleted']);
  });

  it('albums by membership', async () => {
    const DB = await library(rows);
    await DB.prepare("INSERT INTO albums (id, albumName, createdAt, updatedAt) VALUES ('a1', 'A', 't', 't')").run();
    await DB.prepare("INSERT INTO album_assets (albumId, assetId, addedAt) VALUES ('a1', 'fav', 't')").run();
    expect(ids(await search(DB, { filter: { albumIds: { any: ['a1'] } } }))).toEqual(['fav']);
    expect(ids(await search(DB, { filter: { hasAlbums: { eq: false } } }))).not.toContain('fav');
  });

  it('people, tags, OCR and unknown fields or operators match nothing', async () => {
    const DB = await library(rows);
    for (const filter of [{ personIds: { any: ['p'] } }, { tagIds: { any: ['t'] } }, { ocr: { matches: 'x' } }, { colour: { eq: 'red' } },
      { type: { near: 'VIDEO' } }, { constructor: { eq: null } }, { toString: { eq: null } }]) {
      expect((await search(DB, { filter })).items).toEqual([]);
    }
  });

  it('locked photos and Live Photo video parts stay out unless the filter names a visibility', async () => {
    const DB = await library([
      ...rows,
      { id: 'secret', visibility: 'locked' },
      { id: 'still', livePhotoVideoId: 'motion', fileCreatedAt: '2026-06-05T00:00:00.000Z' },
      { id: 'motion', mimeType: 'video/quicktime', duration: '0:00:02.000000' },
    ]);
    const all = ids(await search(DB, { filter: {} }));
    expect(all).not.toContain('secret');
    expect(all).not.toContain('motion');
    expect(all).toContain('still');
    expect(ids(await search(DB, { filter: { type: { eq: 'VIDEO' } } }))).toEqual(['video']);
    expect(ids(await search(DB, { filter: { visibility: { eq: 'locked' } } }))).toEqual(['secret']);
    expect(ids(await search(DB, { filter: { visibility: { eq: 'hidden' } } }))).toEqual(['motion']);
  });

  it('a still with an old zero-duration string is an image', async () => {
    const DB = await library([{ id: 'oldstill', duration: '0:00:00.000000' }]);
    const [item] = (await search(DB, { filter: {} })).items;
    expect([item.type, item.durationMs]).toEqual(['IMAGE', null]);
  });

  it('a filter that is too large is refused', async () => {
    const DB = await library(rows);
    const req = new Request('https://worker.test/api/search/metadata', {
      method: 'POST', headers: { ...(await auth()), 'Content-Type': 'application/json' },
      body: JSON.stringify({ filter: { albumIds: { any: Array.from({ length: 501 }, (_, i) => `a${i}`) } } }),
    });
    expect((await handleSearch(req, env(DB), '/api/search/metadata')).status).toBe(400);
  });

  it('pages with size and cursor, in the order asked, and carries durationMs', async () => {
    const DB = await library(rows);
    const first = await search(DB, { filter: {}, size: 2, orderBy: { field: 'fileCreatedAt', direction: 'asc' } });
    expect(first.items.map((i: any) => i.id)).toEqual(['photo', 'video']);
    expect(first.items[1].durationMs).toBe(3000);
    const rest = await search(DB, { filter: {}, size: 2, cursor: first.nextCursor, orderBy: { direction: 'asc' } });
    expect(rest.items.map((i: any) => i.id)).toEqual(['fav', 'archived']);
    expect(rest.nextCursor).toBeNull();
  });

  it('the website\'s flat body still works', async () => {
    const DB = await library(rows);
    expect(ids(await search(DB, { type: 'VIDEO' }))).toEqual(['video']);
  });
});
