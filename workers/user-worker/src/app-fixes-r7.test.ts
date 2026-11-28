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
import { durationToMs } from './helpers';
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
  it('reads Immich text as whole milliseconds; anything else is null', () => {
    expect(durationToMs('0:00:12.345678')).toBe(12346);
    expect(durationToMs('1:02:03.5')).toBe(3723500);
    expect([durationToMs('0:00:00.000000'), durationToMs('12345'), durationToMs(null), durationToMs('abc')]).toEqual([null, null, null, null]);
  });

  it('the month contents carry durationMs as numbers or null, and keep duration as text', async () => {
    const DB = await library([
      { id: 'v1', mimeType: 'video/mp4', duration: '0:00:12.500000' },
      { id: 'p1' },
    ]);
    const m = await get(DB, '/api/timeline/bucket?timeBucket=2026-08-01T00:00:00.000Z');
    const at = (k: string) => m[k][m.id.indexOf('v1')];
    expect([at('durationMs'), at('duration')]).toEqual([12500, '0:00:12.500000']);
    expect(m.durationMs[m.id.indexOf('p1')]).toBeNull();
  });
});

describe('visibility in the timeline', () => {
  const rows = [{ id: 'shown' }, { id: 'archived', visibility: 'archive' }, { id: 'locked', visibility: 'locked' }];
  it('the main timeline leaves out archived and locked photos, in the month list and its contents alike', async () => {
    const DB = await library(rows);
    const months = await get(DB, '/api/timeline/buckets');
    const m = await get(DB, '/api/timeline/bucket?timeBucket=2026-08-01T00:00:00.000Z');
    expect(m.id).toEqual(['shown']);
    expect(months).toEqual([{ timeBucket: '2026-08-01T00:00:00.000Z', count: 1 }]);
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
    for (const filter of [{ personIds: { any: ['p'] } }, { tagIds: { any: ['t'] } }, { ocr: { matches: 'x' } }, { colour: { eq: 'red' } }, { type: { near: 'VIDEO' } }]) {
      expect((await search(DB, { filter })).items).toEqual([]);
    }
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
