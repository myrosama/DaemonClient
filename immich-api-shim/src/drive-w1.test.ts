// Worker release W1 (docs/drive/W1.md): Trash, thumbnails, part confirmation.
// Runs the real route handlers over an in-memory SQLite database.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { handleDrive, ensureDriveSchema } from './drive';
import { handleWebDav, hashToken, webdavUploadRefusal } from './webdav';
import { D1Adapter } from './d1-adapter';
import { handleDashboardSummary } from './assets';
// Another package, so the type check (rootDir = this package) skips this import.
// @ts-ignore TS6059: outside rootDir on purpose; vitest resolves it fine.
import { DRIVE_MIGRATION_SQL } from '../../schema/schema.mjs';
import { hiddenIds, isTempFileName } from './drive-tree';
import { sqliteD1, PRE_W1_FILES_SQL } from './test-d1';
import { testSessionToken, testAuthEnv } from './test-session';

const DAY = 24 * 60 * 60 * 1000;
const T0 = '2026-11-01T00:00:00.000Z';

type Row = { id: string; parentId?: string; type?: string; fileName?: string; trashedAt?: string | null; purgingAt?: string | null; thumb?: string | null; messages?: any[] | null; ownerId?: string };

async function setup(rows: Row[] = [], opts: { preW1?: boolean } = {}) {
  const DB = sqliteD1(PRE_W1_FILES_SQL);
  if (!opts.preW1) await ensureDriveSchema(DB);
  for (const r of rows) {
    const cols: Record<string, any> = {
      id: r.id, ownerId: r.ownerId ?? 'u1', parentId: r.parentId ?? 'root', type: r.type ?? 'file',
      fileName: r.fileName ?? r.id, fileSize: 1, fileType: 'text/plain',
      messages: r.type === 'folder' ? null : JSON.stringify(r.messages ?? [{ message_id: 1, file_id: 'f' }]),
      encrypted: 0, encryptionMode: 'off', uploadedAt: T0, updatedAt: T0,
    };
    if (!opts.preW1) Object.assign(cols, { trashedAt: r.trashedAt ?? null, purgingAt: r.purgingAt ?? null, thumb: r.thumb ?? null });
    const keys = Object.keys(cols);
    await DB.prepare(`INSERT INTO files (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).bind(...keys.map((k) => cols[k])).run();
  }
  const token = await testSessionToken('u1');
  const env = { DB, ...testAuthEnv() } as any;
  const call = async (method: string, path: string, body?: any) => {
    const url = new URL('https://worker.test' + path);
    const res = await handleDrive(new Request(url, {
      method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }), env, url.pathname, url);
    return { status: res.status, body: await res.json().catch(() => null) as any };
  };
  const row = (id: string) => DB.rows('SELECT * FROM files WHERE id = ?', id)[0];
  return { DB, env, call, row };
}
const ids = (items: any[]) => items.map((i) => i.id).sort();

describe('which items are hidden (trashed, being deleted, or inside one)', () => {
  const r = (id: string, parentId = 'root', extra: Partial<Row> = {}) => ({ id, parentId, ...extra }) as any;
  it('hides a trashed or marked item and everything below it', () => {
    const rows = [r('A', 'root', { trashedAt: T0 }), r('B', 'A'), r('C', 'B'), r('D'), r('E', 'D', { purgingAt: T0 }), r('F', 'E')];
    expect([...hiddenIds(rows)].sort()).toEqual(['A', 'B', 'C', 'E', 'F']);
  });
  it('terminates on a cycle in old data and leaves an orphan visible', () => {
    const rows = [r('X', 'Y'), r('Y', 'X'), r('O', 'gone'), r('Z', 'W'), r('W', 'Z', { trashedAt: T0 })];
    expect([...hiddenIds(rows)].sort()).toEqual(['W', 'Z']);
  });
  it('handles a deep chain', () => {
    const rows = [r('n0', 'root', { trashedAt: T0 })];
    for (let i = 1; i < 5000; i++) rows.push(r(`n${i}`, `n${i - 1}`));
    expect(hiddenIds(rows).size).toBe(5000);
  });
});

describe('listings leave Trash out', () => {
  it('the full list and a folder list skip trashed items and their contents', async () => {
    const { call } = await setup([
      { id: 'docs', type: 'folder' }, { id: 'a', parentId: 'docs' },
      { id: 'old', type: 'folder', trashedAt: T0 }, { id: 'sub', type: 'folder', parentId: 'old' }, { id: 'b', parentId: 'sub' },
      { id: 'gone', trashedAt: T0 },
    ]);
    expect(ids((await call('GET', '/api/drive/files')).body.items)).toEqual(['a', 'docs']);
    expect((await call('GET', '/api/drive/files?parentId=sub')).body.items).toEqual([]);
    expect(ids((await call('GET', '/api/drive/files?parentId=docs')).body.items)).toEqual(['a']);
  });
  it('?trashed=1 lists trashed items, their contents and marked items, and flags expiry by the worker clock', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-12-01T00:00:00.000Z') });
    try {
      const at = (ms: number) => new Date(Date.now() - ms).toISOString();
      const { call } = await setup([
        { id: 'live' }, { id: 'f', type: 'folder', trashedAt: at(30 * DAY + 1000) }, { id: 'in', parentId: 'f' },
        { id: 'edge', trashedAt: at(30 * DAY) }, { id: 'r', trashedAt: at(30 * DAY - 1000) }, { id: 'm', purgingAt: T0, trashedAt: at(31 * DAY) },
      ]);
      const items = (await call('GET', '/api/drive/files?trashed=1')).body.items;
      expect(ids(items)).toEqual(['edge', 'f', 'in', 'm', 'r']);
      const flag = Object.fromEntries(items.map((i: any) => [i.id, i.expired]));
      expect(flag).toEqual({ edge: true, f: true, in: false, m: true, r: false });
    } finally {
      vi.useRealTimers();
    }
  });
  it('the portal dashboard counts only files that are not in Trash', async () => {
    const { env } = await setup([
      { id: 'a', fileName: 'a.txt' }, { id: 'gone', fileName: 'gone.txt', trashedAt: T0 },
      { id: 'bin', type: 'folder', trashedAt: T0 }, { id: 'in', parentId: 'bin', fileName: 'in.txt' },
    ]);
    await env.DB.prepare('CREATE TABLE photos (id TEXT, ownerId TEXT, isTrashed INTEGER)').run();
    const token = await testSessionToken('u1');
    const res = await handleDashboardSummary(new Request('https://worker.test/api/dashboard/summary', { headers: { Authorization: `Bearer ${token}` } }), env);
    const body = await res.json() as any;
    expect(body.drive.count).toBe(1);
    expect(body.drive.recent.map((r: any) => r.fileName)).toEqual(['a.txt']);
  });
});

describe('Trash, restore, delete forever', () => {
  it('trash sets the time once by the worker clock, and is idempotent', async () => {
    const { call, row } = await setup([{ id: 'a' }]);
    expect((await call('POST', '/api/drive/files/a/trash')).status).toBe(200);
    const first = row('a').trashedAt;
    expect(Date.now() - Date.parse(first)).toBeLessThan(5000);
    expect((await call('POST', '/api/drive/files/a/trash')).status).toBe(200);
    expect(row('a').trashedAt).toBe(first);
  });
  it('restore puts an item back in its folder, or at the top level when the folder is gone, trashed or marked', async () => {
    const { call, row } = await setup([
      { id: 'docs', type: 'folder' }, { id: 'a', parentId: 'docs', trashedAt: T0 },
      { id: 'b', parentId: 'nowhere', trashedAt: T0 },
      { id: 'bin', type: 'folder', trashedAt: T0 }, { id: 'c', parentId: 'bin' },
      { id: 'mk', type: 'folder', trashedAt: T0, purgingAt: T0 }, { id: 'd', parentId: 'mk', trashedAt: T0 },
    ]);
    for (const id of ['a', 'b', 'c']) expect((await call('POST', `/api/drive/files/${id}/restore`)).status).toBe(200);
    expect([row('a').parentId, row('a').trashedAt]).toEqual(['docs', null]);
    expect(row('b').parentId).toBe('root');
    expect(row('c').parentId).toBe('root');
    // Its folder is being deleted, but d itself isn't: to the top level (D2).
    expect((await call('POST', '/api/drive/files/d/restore')).status).toBe(200);
    expect(row('d').parentId).toBe('root');
    expect(ids((await call('GET', '/api/drive/files')).body.items)).toEqual(['a', 'b', 'c', 'd', 'docs']);
  });
  it('a marked item can be neither restored, trashed again, renamed nor saved over', async () => {
    const { call } = await setup([{ id: 'm', trashedAt: T0, purgingAt: T0 }]);
    expect((await call('POST', '/api/drive/files/m/restore')).status).toBe(409);
    expect((await call('POST', '/api/drive/files/m/trash')).status).toBe(409);
    expect((await call('PATCH', '/api/drive/files/m', { fileName: 'x' })).status).toBe(409);
    expect((await call('POST', '/api/drive/files', { id: 'm', fileName: 'm', messages: [] })).status).toBe(409);
  });
  it('delete forever refuses an item that is not in Trash (nothing skips Trash)', async () => {
    const { call, row } = await setup([{ id: 'live' }]);
    expect((await call('POST', '/api/drive/files/live/purge')).status).toBe(409);
    expect(row('live').purgingAt).toBeNull();
  });
  it('delete forever marks the item and everything inside it, owner-scoped and cycle-safe, and returns them', async () => {
    const { call, row } = await setup([
      { id: 'f', type: 'folder', trashedAt: T0 }, { id: 'g', type: 'folder', parentId: 'f' }, { id: 'x', parentId: 'g', messages: [{ message_id: 42, file_id: 'x' }] },
      { id: 'cyc1', type: 'folder', parentId: 'cyc2' }, { id: 'cyc2', type: 'folder', parentId: 'g' },
      { id: 'other', parentId: 'g', ownerId: 'someone-else' }, { id: 'live' },
    ]);
    const res = await call('POST', '/api/drive/files/f/purge');
    expect(res.status).toBe(200);
    expect(ids(res.body.items)).toEqual(['cyc1', 'cyc2', 'f', 'g', 'x']);
    expect(res.body.items.find((i: any) => i.id === 'x').messages).toEqual([{ message_id: 42, file_id: 'x' }]);
    for (const id of ['f', 'g', 'x', 'cyc1', 'cyc2']) expect(row(id).purgingAt).not.toBeNull();
    expect(row('other').purgingAt).toBeNull();
    expect(row('live').purgingAt).toBeNull();
    // Marking again returns the same set (a second device resumes the delete).
    expect(ids((await call('POST', '/api/drive/files/f/purge')).body.items)).toEqual(['cyc1', 'cyc2', 'f', 'g', 'x']);
  });
  it('delete forever terminates on a real cycle in old data and marks exactly that cycle', async () => {
    const { call, row } = await setup([
      { id: 'A', type: 'folder', parentId: 'B', trashedAt: T0 }, { id: 'B', type: 'folder', parentId: 'A' }, { id: 'live' },
    ]);
    const res = await call('POST', '/api/drive/files/A/purge');
    expect(res.status).toBe(200);
    expect(ids(res.body.items)).toEqual(['A', 'B']);
    expect(row('live').purgingAt).toBeNull();
  });
  it("the walk does not pass through another owner's row", async () => {
    const { call, row } = await setup([
      { id: 'f', type: 'folder', trashedAt: T0 }, { id: 'other', type: 'folder', parentId: 'f', ownerId: 'someone-else' }, { id: 'below', parentId: 'other' },
    ]);
    await call('POST', '/api/drive/files/f/purge');
    expect(row('below').purgingAt).toBeNull();
  });
  it("a row named 'root' can neither be created nor act on the whole drive", async () => {
    const { call, row, DB } = await setup([{ id: 'root', type: 'folder', trashedAt: T0 }, { id: 'docs' }]);
    expect((await call('POST', '/api/drive/files', { id: 'root', type: 'folder', fileName: 'x' })).status).toBe(400);
    for (const a of ['trash', 'restore', 'purge']) expect((await call('POST', `/api/drive/files/root/${a}`)).status).toBe(400);
    expect(row('docs').purgingAt).toBeNull();
    // Even under a purged folder, the walk stops at it.
    await DB.prepare("UPDATE files SET parentId = 'f' WHERE id = 'root'").run();
    await DB.prepare("INSERT INTO files (id, ownerId, parentId, type, fileName, uploadedAt, trashedAt) VALUES ('f', 'u1', 'root', 'folder', 'f', ?, ?)").bind(T0, T0).run();
    await call('POST', '/api/drive/files/f/purge');
    expect(row('docs').purgingAt).toBeNull();
    expect(row('root').purgingAt).toBeNull();
    expect((await call('POST', '/api/drive/files', { fileName: 'still-works', messages: [] })).status).toBe(201);
  });
  it('delete forever leaves out any message a file outside the deletion still uses', async () => {
    const { call } = await setup([
      { id: 'bin', trashedAt: T0, messages: [{ message_id: 5, file_id: 'shared' }, { message_id: 6, file_id: 'mine' }], thumb: JSON.stringify({ message_id: 8, file_id: 'th' }) },
      { id: 'live', messages: [{ message_id: 5, file_id: 'shared' }, { message_id: 8, file_id: 'part' }] },
    ]);
    const item = (await call('POST', '/api/drive/files/bin/purge')).body.items[0];
    expect(item.messages).toEqual([{ message_id: 6, file_id: 'mine' }]);
    expect(item.thumb).toBeNull();
  });
  it('nothing new can land in a folder being deleted; a missing folder is still allowed', async () => {
    const { call, row } = await setup([
      { id: 'mk', type: 'folder', trashedAt: T0, purgingAt: T0 }, { id: 'bin', type: 'folder', trashedAt: T0 },
    ]);
    expect((await call('POST', '/api/drive/files', { id: 'late', fileName: 'late', parentId: 'mk', messages: [] })).status).toBe(409);
    expect(row('late')).toBeUndefined();
    // As before W1: a missing parent is not refused.
    expect((await call('POST', '/api/drive/files', { id: 'early', fileName: 'e', parentId: 'not-yet', messages: [] })).status).toBe(201);
    expect((await call('POST', '/api/drive/files', { id: 'inbin', fileName: 'i', parentId: 'bin', messages: [] })).status).toBe(201);
  });
  it('writes refuse at the database when the mark lands first (no check-then-write gap)', async () => {
    const { DB, row } = await setup([{ id: 'mk', type: 'folder', purgingAt: T0 }, { id: 'm', purgingAt: T0 }, { id: 'ok' }]);
    const db = new D1Adapter(DB);
    const f = { ownerId: 'u1', type: 'file', fileName: 'n', uploadedAt: T0 };
    expect(await db.saveFile({ ...f, id: 'new', parentId: 'mk' })).toBe(false);
    expect(row('new')).toBeUndefined();
    expect(await db.saveFile({ ...f, id: 'm', parentId: 'root' })).toBe(false);
    expect(await db.saveFile({ ...f, id: 'fine', parentId: 'root' })).toBe(true);
    expect(await db.updateFile('m', { fileName: 'x' })).toBe(false);
    expect(row('m').fileName).toBe('m');
    expect(await db.updateFile('ok', { parentId: 'mk' })).toBe(false);
    expect(row('ok').parentId).toBe('root');
    expect(await db.updateFile('ok', { fileName: 'y' })).toBe(true);
  });
  it('an item inside a trashed folder can be deleted forever on its own', async () => {
    const { call, row } = await setup([{ id: 'f', type: 'folder', trashedAt: T0 }, { id: 'x', parentId: 'f' }]);
    expect((await call('POST', '/api/drive/files/x/purge')).status).toBe(200);
    expect(row('x').purgingAt).not.toBeNull();
    expect(row('f').purgingAt).toBeNull();
  });
  it('DELETE refuses a marked folder that still has children, then accepts it once empty', async () => {
    const { call, row } = await setup([{ id: 'f', type: 'folder', trashedAt: T0, purgingAt: T0 }, { id: 'x', parentId: 'f', purgingAt: T0 }]);
    expect((await call('DELETE', '/api/drive/files/f')).status).toBe(409);
    expect((await call('DELETE', '/api/drive/files/x')).status).toBe(200);
    expect((await call('DELETE', '/api/drive/files/f')).status).toBe(200);
    expect(row('f')).toBeUndefined();
  });
  it("DELETE of an unmarked item still works as the classic app expects, a folder's included", async () => {
    const { call, row } = await setup([{ id: 'f', type: 'folder' }, { id: 'x', parentId: 'f' }]);
    expect((await call('DELETE', '/api/drive/files/f')).status).toBe(200);
    expect(row('f')).toBeUndefined();
  });
  it('hostile input gets a 4xx or is ignored, never a crash', async () => {
    const { call } = await setup([{ id: 'a' }]);
    expect((await call('POST', '/api/drive/files/%E0%A4%A/purge')).status).toBe(400);
    expect((await call('PATCH', '/api/drive/files/a', null)).status).toBe(200);
    expect((await call('POST', '/api/drive/zke', null)).status).toBe(200);
    expect((await call('POST', '/api/drive/config', null)).status).toBe(200);
  });
  it("another owner's row reads as not found on every new route", async () => {
    const { call } = await setup([{ id: 'o', ownerId: 'someone-else', trashedAt: T0 }]);
    for (const a of ['trash', 'restore', 'purge']) expect((await call('POST', `/api/drive/files/o/${a}`)).status).toBe(404);
  });
});

describe('saves keep Trash state and thumbnails right', () => {
  const save = (extra: any = {}) => ({ id: 'a', fileName: 'a.txt', fileSize: 3, messages: [{ message_id: 1, file_id: 'f' }], ...extra });
  it('a save that leaves trashedAt out keeps it, and cannot set trashedAt or purgingAt', async () => {
    const { call, row } = await setup([{ id: 'a', trashedAt: T0 }]);
    expect((await call('POST', '/api/drive/files', save({ trashedAt: null, purgingAt: T0 }))).status).toBe(201);
    expect([row('a').trashedAt, row('a').purgingAt]).toEqual([T0, null]);
  });
  it('keeps thumb when messages are unchanged, clears it when they changed, and a supplied thumb wins', async () => {
    const thumb = JSON.stringify({ message_id: 7, file_id: 't' });
    const { call, row } = await setup([{ id: 'a', thumb }]);
    await call('POST', '/api/drive/files', save());
    expect(row('a').thumb).toBe(thumb);
    await call('POST', '/api/drive/files', save({ messages: [{ message_id: 2, file_id: 'g' }] }));
    expect(row('a').thumb).toBeNull();
    await call('POST', '/api/drive/files', save({ thumb: { message_id: 9, file_id: 'n' } }));
    expect(JSON.parse(row('a').thumb)).toEqual({ message_id: 9, file_id: 'n' });
  });
  it('thumb goes in and comes back as an object', async () => {
    const { call } = await setup([]);
    const thumb = { message_id: 9, file_id: 'n-_1' };
    expect((await call('POST', '/api/drive/files', save({ thumb }))).body.item.thumb).toEqual(thumb);
    expect((await call('GET', '/api/drive/files')).body.items[0].thumb).toEqual(thumb);
  });
  it('PATCH can set and clear a thumbnail without touching the rest of the row', async () => {
    const { call, row } = await setup([{ id: 'a', fileName: 'a.txt' }]);
    const thumb = { message_id: 9, file_id: 'n' };
    expect((await call('PATCH', '/api/drive/files/a', { thumb })).body.item.thumb).toEqual(thumb);
    expect([JSON.parse(row('a').thumb), row('a').fileName]).toEqual([thumb, 'a.txt']);
    expect((await call('PATCH', '/api/drive/files/a', { thumb: 'junk' })).status).toBe(400);
    await call('PATCH', '/api/drive/files/a', { thumb: null });
    expect(row('a').thumb).toBeNull();
  });
  it('refuses parts that are not objects', async () => {
    const { call } = await setup([]);
    expect((await call('POST', '/api/drive/files', save({ messages: [null] }))).status).toBe(400);
  });
  it('rejects a malformed thumb', async () => {
    const { call } = await setup([]);
    for (const thumb of ['x', { message_id: 'x', file_id: 't' }, { message_id: 1 }, { message_id: 1, file_id: 'y'.repeat(300) }, { message_id: 1, file_id: 'bad id"' }])
      expect((await call('POST', '/api/drive/files', save({ thumb }))).status).toBe(400);
  });
  it('a save that moves an existing folder into its own descendant is refused', async () => {
    const { call } = await setup([{ id: 'f', type: 'folder' }, { id: 'g', type: 'folder', parentId: 'f' }]);
    expect((await call('POST', '/api/drive/files', { id: 'f', type: 'folder', fileName: 'f', parentId: 'g' })).status).toBe(409);
  });
});

describe('moves', () => {
  it('refuses a folder into itself, into a descendant, into a missing, hidden or non-folder parent', async () => {
    const { call, row } = await setup([
      { id: 'f', type: 'folder' }, { id: 'g', type: 'folder', parentId: 'f' }, { id: 'bin', type: 'folder', trashedAt: T0 }, { id: 'file' },
    ]);
    for (const parentId of ['f', 'g', 'missing', 'bin', 'file'])
      expect((await call('PATCH', '/api/drive/files/f', { parentId })).status).toBe(409);
    expect(row('f').parentId).toBe('root');
    expect((await call('PATCH', '/api/drive/files/file', { parentId: 'g' })).status).toBe(200);
    expect(row('file').parentId).toBe('g');
  });
});

describe('schema and capability', () => {
  it('/config says the worker has W1', async () => {
    const { call, DB } = await setup([]);
    await DB.prepare('INSERT INTO config (key, value) VALUES (?, ?)').bind('telegram', JSON.stringify({ botToken: 'B', channelId: '-1' })).run();
    expect((await call('GET', '/api/drive/config')).body.driveApi).toBe(1);
  });
  it('an old database gains the columns, even when the first request is WebDAV', async () => {
    const { env, DB } = await setup([{ id: 'a', fileName: 'a.txt' }], { preW1: true });
    await DB.prepare('INSERT INTO config (key, value) VALUES (?, ?)').bind('dav', JSON.stringify({ tokenHash: await hashToken('mt'), uid: 'u1' })).run();
    const res = await handleWebDav(new Request('https://worker.test/dav/', { method: 'PROPFIND', headers: { Authorization: 'Basic ' + btoa('m:mt'), Depth: '1' } }), env, new URL('https://worker.test/dav/'));
    expect(res.status).toBe(207);
    const cols = DB.rows('PRAGMA table_info(files)').map((c: any) => c.name);
    expect(cols).toEqual(expect.arrayContaining(['trashedAt', 'purgingAt', 'thumb']));
  });
  it('an up-to-date database needs no ALTER at all', async () => {
    const DB = sqliteD1(PRE_W1_FILES_SQL);
    await ensureDriveSchema(DB);
    const seen: string[] = [];
    await ensureDriveSchema({ ...DB, prepare: (sql: string) => { seen.push(sql); return DB.prepare(sql); } });
    expect(seen.filter((s) => s.startsWith('ALTER'))).toEqual([]);
    expect(seen).toHaveLength(1);
  });
  it('another isolate adding the column first is fine, whatever the error says', async () => {
    const DB = sqliteD1(PRE_W1_FILES_SQL);
    let once = true;
    await ensureDriveSchema({ ...DB, prepare: (sql: string) => {
      if (once && sql.includes('ADD COLUMN trashedAt')) {
        once = false;
        return { run: async () => { await DB.prepare(sql).run(); throw new Error('some other wording'); } };
      }
      return DB.prepare(sql);
    } });
    expect(DB.rows('PRAGMA table_info(files)').map((c: any) => c.name)).toContain('thumb');
  });
  it('a fresh database and an upgraded one end with the same columns as the install schema', async () => {
    const names = (d: any) => d.rows('PRAGMA table_info(files)').map((c: any) => c.name).sort();
    const fresh = sqliteD1();
    await ensureDriveSchema(fresh);
    const upgraded = sqliteD1(PRE_W1_FILES_SQL);
    await ensureDriveSchema(upgraded);
    const installed = sqliteD1(DRIVE_MIGRATION_SQL);
    expect(names(fresh)).toEqual(names(installed));
    expect(names(upgraded)).toEqual(names(installed));
  });
  it('both entry points answer 503 while the schema step fails, then recover', async () => {
    const { DB } = await setup([], { preW1: true });
    await DB.prepare('INSERT INTO config (key, value) VALUES (?, ?)').bind('dav', JSON.stringify({ tokenHash: await hashToken('mt'), uid: 'u1' })).run();
    let fail = true;
    const flaky = { ...DB, prepare: (sql: string) => {
      if (fail && sql.startsWith('ALTER TABLE')) return { run: async () => { throw new Error('network'); } };
      return DB.prepare(sql);
    } };
    const env = { DB: flaky, ...testAuthEnv() } as any;
    const token = await testSessionToken('u1');
    const api = () => { const u = new URL('https://worker.test/api/drive/files'); return handleDrive(new Request(u, { headers: { Authorization: `Bearer ${token}` } }), env, u.pathname, u); };
    const dav = () => handleWebDav(new Request('https://worker.test/dav/', { method: 'PROPFIND', headers: { Authorization: 'Basic ' + btoa('m:mt') } }), env, new URL('https://worker.test/dav/'));
    expect((await api()).status).toBe(503);
    expect((await dav()).status).toBe(503);
    fail = false;
    expect((await api()).status).toBe(200);
    expect((await dav()).status).toBe(207);
  });
  it('a schema step failing for any other reason is not remembered as done', async () => {
    const DB = sqliteD1(PRE_W1_FILES_SQL);
    let fail = true;
    const flaky = { ...DB, prepare: (sql: string) => {
      if (fail && sql.startsWith('ALTER TABLE')) return { run: async () => { throw new Error('D1_ERROR: network connection lost'); } };
      return DB.prepare(sql);
    } };
    await expect(ensureDriveSchema(flaky)).rejects.toThrow(/network/);
    fail = false;
    await ensureDriveSchema(flaky);
    expect(DB.rows('PRAGMA table_info(files)').map((c: any) => c.name)).toContain('thumb');
  });
});

describe('WebDAV under W1', () => {
  let realFetch: typeof globalThis.fetch;
  let sends: number; let deleted: number[];
  afterEach(() => { globalThis.fetch = realFetch; });
  beforeEach(() => { realFetch = globalThis.fetch; sends = 0; deleted = []; });

  // reply(size) decides Telegram's answer to each sendDocument.
  function installTelegram(reply: (sentBytes: number, n: number) => any) {
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes('/sendDocument')) {
        const doc = (init.body as FormData).get('document') as unknown as Blob;
        const n = ++sends;
        const r = reply((await doc.arrayBuffer()).byteLength, n);
        return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
      }
      if (url.includes('/deleteMessage')) { deleted.push(JSON.parse(init.body).message_id); return new Response('{"ok":true}'); }
      throw new Error('unexpected fetch ' + url);
    }) as any;
  }
  const ok = (size: number, n: number) => ({ body: { ok: true, result: { message_id: 100 + n, document: { file_id: `c${n}`, file_size: size } } } });

  async function dav(rows: Row[]) {
    const s = await setup(rows);
    await s.DB.prepare('INSERT INTO config (key, value) VALUES (?, ?), (?, ?)').bind(
      'dav', JSON.stringify({ tokenHash: await hashToken('mt'), uid: 'u1' }),
      'telegram', JSON.stringify({ botToken: 'BOT', channelId: '-100' }),
    ).run();
    const req = (method: string, path: string, headers: Record<string, string> = {}, body?: BodyInit) => {
      const url = new URL('https://worker.test' + path);
      return handleWebDav(new Request(url, { method, headers: { Authorization: 'Basic ' + btoa('m:mt'), ...headers }, body, duplex: 'half' } as any), s.env, url);
    };
    return { ...s, req };
  }

  it('path lookups skip trashed items and their contents', async () => {
    const { req } = await dav([{ id: 'bin', type: 'folder', fileName: 'Old', trashedAt: T0 }, { id: 'x', parentId: 'bin', fileName: 'x.txt' }, { id: 't', fileName: 't.txt', trashedAt: T0 }]);
    expect((await req('PROPFIND', '/dav/Old', { Depth: '1' })).status).toBe(404);
    expect((await req('GET', '/dav/t.txt')).status).toBe(404);
    const root = await (await req('PROPFIND', '/dav/', { Depth: '1' })).text();
    expect(root).not.toContain('Old');
    expect(root).not.toContain('t.txt');
  });
  it('DELETE moves to Trash and deletes nothing from Telegram', async () => {
    installTelegram(ok);
    const { req, row } = await dav([{ id: 'a', fileName: 'a.txt' }]);
    expect((await req('DELETE', '/dav/a.txt')).status).toBe(204);
    expect(row('a').trashedAt).not.toBeNull();
    expect(deleted).toEqual([]);
  });
  it('DELETE of a file manager temp file removes it for good', async () => {
    installTelegram(ok);
    const { req, row } = await dav([{ id: 'tmp', fileName: '.goutputstream-ABC123', messages: [{ message_id: 5, file_id: 'q' }] }]);
    expect((await req('DELETE', '/dav/.goutputstream-ABC123')).status).toBe(204);
    expect(row('tmp')).toBeUndefined();
    expect(deleted).toEqual([5]);
  });
  it('MOVE over an existing file sends the replaced file to Trash', async () => {
    const { req, row, call } = await dav([{ id: 'doc', fileName: 'doc.txt' }, { id: 'tmp', fileName: '.goutputstream-1' }]);
    expect((await req('MOVE', '/dav/.goutputstream-1', { Destination: 'https://worker.test/dav/doc.txt' })).status).toBe(204);
    expect([row('tmp').fileName, row('tmp').trashedAt]).toEqual(['doc.txt', null]);
    expect(row('doc').trashedAt).not.toBeNull();
    expect(ids((await call('GET', '/api/drive/files')).body.items)).toEqual(['tmp']);
  });
  it('MOVE refuses a folder into its own descendant', async () => {
    const { req, row } = await dav([{ id: 'f', type: 'folder', fileName: 'F' }, { id: 'g', type: 'folder', parentId: 'f', fileName: 'G' }]);
    expect((await req('MOVE', '/dav/F', { Destination: 'https://worker.test/dav/F/G/F' })).status).toBe(409);
    expect(row('f').parentId).toBe('root');
  });
  it('PUT resends a part whose stored size does not match, and saves once every part is confirmed', async () => {
    installTelegram((size, n) => (n === 1 ? { body: { ok: true, result: { message_id: 101, document: { file_id: 'bad', file_size: size - 1 } } } } : ok(size, n)));
    const { req, DB } = await dav([]);
    expect((await req('PUT', '/dav/new.txt', {}, 'hello')).status).toBe(201);
    expect(deleted).toEqual([101]);
    const saved = DB.rows("SELECT * FROM files WHERE fileName = 'new.txt'")[0];
    expect(JSON.parse(saved.messages)).toEqual([{ message_id: 102, file_id: 'c2' }]);
  });
  it('PUT gives up after three resends, saves nothing and deletes every message it sent', async () => {
    installTelegram((_size, n) => ({ body: { ok: true, result: { message_id: 100 + n, document: { file_id: `c${n}` } } } }));
    const { req, DB } = await dav([]);
    expect((await req('PUT', '/dav/new.txt', {}, 'hello')).status).toBe(502);
    expect(sends).toBe(4);
    expect(deleted.sort()).toEqual([101, 102, 103, 104]);
    expect(DB.rows("SELECT * FROM files WHERE fileName = 'new.txt'")).toEqual([]);
  });
  // Runs a request whose handler sleeps on setTimeout, on a fake clock.
  async function settle<T>(p: Promise<T>): Promise<T> {
    let done = false;
    p.finally(() => { done = true; }).catch(() => {});
    while (!done) {
      await vi.advanceTimersByTimeAsync(1000);
      await new Promise((r) => setImmediate(r));
    }
    return p;
  }
  const tooMany = (retry_after: number) => ({ status: 429, body: { ok: false, error_code: 429, parameters: { retry_after } } });
  const PART = 19 * 1024 * 1024;

  it('PUT waits as long as a 429 asks, then retries', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      installTelegram((size, n) => (n === 1 ? tooMany(5) : ok(size, n)));
      const { req } = await dav([]);
      const pending = req('PUT', '/dav/new.txt', {}, 'hello');
      let status = 0;
      try {
        // On a busy machine the first send takes many ticks; wait for it, not a fixed count.
        for (let i = 0; i < 5000 && sends === 0; i++) await new Promise((r) => setImmediate(r));
        expect(sends).toBe(1);
        await vi.advanceTimersByTimeAsync(4000);
        for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
        expect(sends).toBe(1); // still waiting after 4 of the 5 seconds
      } finally {
        // Always finish the upload, so it can't leak into the next test.
        status = (await settle(pending)).status;
      }
      expect(status).toBe(201);
      expect(sends).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
  it('the 30-second wait limit covers the whole upload, not each part', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      // Part 1 spends 20 s; part 2 asks for 20 s more and is out of budget.
      installTelegram((size, n) => (n === 1 || n === 3 ? tooMany(20) : ok(size, n)));
      const { req, DB } = await dav([]);
      const res = await settle(req('PUT', '/dav/big.bin', {}, new Uint8Array(PART + 1)));
      expect(res.status).toBe(502);
      expect(sends).toBe(3);
      expect(deleted).toEqual([102]);
      expect(DB.rows("SELECT * FROM files WHERE fileName = 'big.bin'")).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
  it('a dropped connection counts as one unconfirmed send, not a failed upload', async () => {
    installTelegram((size, n) => { if (n === 1) throw new Error('connection reset'); return ok(size, n); });
    const { req } = await dav([]);
    expect((await req('PUT', '/dav/new.txt', {}, 'hello')).status).toBe(201);
    expect(sends).toBe(2);
  });
  it('a multi-part PUT whose later part never confirms deletes the earlier parts and saves nothing', async () => {
    installTelegram((size, n) => (n === 1 ? ok(size, n) : { body: { ok: true, result: { message_id: 100 + n, document: { file_id: `c${n}` } } } }));
    const { req, DB } = await dav([]);
    expect((await req('PUT', '/dav/big.bin', {}, new Uint8Array(PART + 1))).status).toBe(502);
    expect(deleted).toContain(101);
    expect(DB.rows("SELECT * FROM files WHERE fileName = 'big.bin'")).toEqual([]);
  });
  it('a database failure after every part is stored removes the parts and asks the client to retry', async () => {
    installTelegram(ok);
    const { req, env, DB } = await dav([]);
    env.DB = { ...DB, prepare: (sql: string) => {
      if (sql.startsWith('INSERT INTO files')) return { bind: () => ({ run: async () => { throw new Error('D1 down'); } }) };
      return DB.prepare(sql);
    } };
    expect((await req('PUT', '/dav/new.txt', {}, 'hello')).status).toBe(503);
    expect(deleted).toEqual([101]);
  });
  it('a database error after the save committed keeps the parts the row now uses', async () => {
    installTelegram(ok);
    const { req, env, DB } = await dav([]);
    env.DB = { ...DB, prepare: (sql: string) => {
      if (!sql.startsWith('INSERT INTO files')) return DB.prepare(sql);
      return { bind: (...a: any[]) => ({ run: async () => { await DB.prepare(sql).bind(...a).run(); throw new Error('reported after commit'); } }) };
    } };
    expect((await req('PUT', '/dav/new.txt', {}, 'hello')).status).toBe(503);
    expect(deleted).toEqual([]);
    expect(DB.rows("SELECT * FROM files WHERE fileName = 'new.txt'")).toHaveLength(1);
  });
  it('keeps the parts when the database can be neither written nor read', async () => {
    installTelegram(ok);
    const { req, env, DB } = await dav([]);
    let reads = 0;
    env.DB = { ...DB, prepare: (sql: string) => {
      if (sql.startsWith('INSERT INTO files')) return { bind: () => ({ run: async () => { throw new Error('down'); } }) };
      if (sql === 'SELECT * FROM files WHERE id = ?') { reads++; return { bind: () => ({ first: async () => { throw new Error('down'); } }) }; }
      return DB.prepare(sql);
    } };
    expect((await req('PUT', '/dav/new.txt', {}, 'hello')).status).toBe(503);
    expect(reads).toBe(1);
    expect(deleted).toEqual([]);
  });
  it('a folder marked for deletion mid-upload gets a 409 and the new parts are removed', async () => {
    installTelegram(ok);
    const { req, env, DB } = await dav([{ id: 'F', type: 'folder', fileName: 'F' }]);
    env.DB = { ...DB, prepare: (sql: string) => {
      if (sql.startsWith('INSERT INTO files')) DB.prepare("UPDATE files SET purgingAt = 'now' WHERE id = 'F'").run();
      return DB.prepare(sql);
    } };
    expect((await req('PUT', '/dav/F/new.txt', {}, 'hello')).status).toBe(409);
    expect(deleted).toEqual([101]);
    expect(DB.rows("SELECT * FROM files WHERE fileName = 'new.txt'")).toEqual([]);
  });
  it('one malformed row in the drive breaks nothing else', async () => {
    installTelegram(ok);
    const { req, DB, row } = await dav([{ id: 'a', fileName: 'a.txt', messages: [{ message_id: 5, file_id: 'x' }] }, { id: 'tmp', fileName: '.~lock.a#', messages: [{ message_id: 6, file_id: 'y' }] }]);
    await DB.prepare("INSERT INTO files (id, ownerId, type, fileName, uploadedAt, messages) VALUES ('bad', 'u1', 'file', 'bad', ?, '[null, 3]')").bind(T0).run();
    expect((await req('PUT', '/dav/a.txt', {}, 'new')).status).toBe(204);
    expect((await req('DELETE', '/dav/.~lock.a%23')).status).toBe(204);
    expect(row('tmp')).toBeUndefined();
    expect(deleted.sort()).toEqual([5, 6]);
  });
  it('a message used by a trashed file or as another file\u2019s thumbnail is kept too', async () => {
    installTelegram(ok);
    const { req } = await dav([
      { id: 'a', fileName: 'a.txt', messages: [{ message_id: 5, file_id: 'one' }, { message_id: 7, file_id: 'two' }, { message_id: 9, file_id: 'three' }] },
      { id: 't', fileName: 't.txt', trashedAt: T0, messages: [{ message_id: 5, file_id: 'one' }] },
      { id: 'b', fileName: 'b.txt', thumb: JSON.stringify({ message_id: 7, file_id: 'two' }) },
    ]);
    expect((await req('PUT', '/dav/a.txt', {}, 'x')).status).toBe(204);
    expect(deleted).toEqual([9]);
  });
  it('MOVE with Overwrite: F leaves an existing destination alone', async () => {
    const { req, row } = await dav([{ id: 'a', fileName: 'a.txt' }, { id: 'b', fileName: 'b.txt' }]);
    expect((await req('MOVE', '/dav/a.txt', { Destination: 'https://worker.test/dav/b.txt', Overwrite: 'F' })).status).toBe(412);
    expect([row('a').fileName, row('b').trashedAt]).toEqual(['a.txt', null]);
  });
  it('MOVE over a folder puts that folder in Trash', async () => {
    const { req, row } = await dav([{ id: 'a', type: 'folder', fileName: 'A' }, { id: 'b', type: 'folder', fileName: 'B' }]);
    expect((await req('MOVE', '/dav/A', { Destination: 'https://worker.test/dav/B' })).status).toBe(204);
    expect(row('b').trashedAt).not.toBeNull();
    expect(row('a').fileName).toBe('B');
  });
  it('a file with a size but no parts is not found, unlike an empty one', async () => {
    const { req, DB } = await dav([]);
    await DB.prepare("INSERT INTO files (id, ownerId, type, fileName, fileSize, uploadedAt, messages) VALUES ('g', 'u1', 'file', 'g.txt', 10, ?, '[]')").bind(T0).run();
    expect((await req('GET', '/dav/g.txt')).status).toBe(404);
  });
  it('an empty encrypted file is still sent, since it holds the IV and tag', async () => {
    installTelegram(ok);
    const { req, DB } = await dav([]);
    await DB.prepare('INSERT INTO config (key, value) VALUES (?, ?)').bind('drive_zke', JSON.stringify({ enabled: true, mode: 'auto', password: 'pw', salt: btoa('sixteenbytesalt!') })).run();
    expect((await req('PUT', '/dav/empty.txt', {}, new Uint8Array(0))).status).toBe(201);
    expect(sends).toBe(1);
  });
  it('encryption settings changed during an upload apply to it', async () => {
    installTelegram(ok);
    const { req, DB } = await dav([]);
    await DB.prepare('INSERT INTO config (key, value) VALUES (?, ?)').bind('drive_zke', JSON.stringify({ enabled: false })).run();
    // highWaterMark 0: pull() runs only when the handler reads the body.
    const body = new ReadableStream({ async pull(c) {
      await DB.prepare("UPDATE config SET value = ? WHERE key = 'drive_zke'").bind(JSON.stringify({ enabled: true, mode: 'custom', password: '', salt: 's' })).run();
      c.enqueue(new Uint8Array([1])); c.close();
    } }, { highWaterMark: 0 });
    const res = await req('PUT', '/dav/late.txt', {}, body as any);
    expect(res.status).toBe(403);
    expect(sends).toBe(0);
  });
  it('asks Telegram to store a part exactly as sent', async () => {
    let flag: unknown;
    realFetch = globalThis.fetch;
    globalThis.fetch = (async (_i: any, init?: any) => {
      flag = (init.body as FormData).get('disable_content_type_detection');
      const doc = (init.body as FormData).get('document') as unknown as Blob;
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1, document: { file_id: 'c', file_size: doc.size } } }));
    }) as any;
    const { req } = await dav([]);
    await req('PUT', '/dav/a.gif', {}, 'gif');
    expect(flag).toBe('true');
  });
  it('PUT to the name of a trashed file makes a new file and leaves the trashed one and its parts alone', async () => {
    installTelegram(ok);
    const { req, row, DB } = await dav([{ id: 't', fileName: 't.txt', trashedAt: T0, messages: [{ message_id: 5, file_id: 'old' }] }]);
    expect((await req('PUT', '/dav/t.txt', {}, 'new')).status).toBe(201);
    expect(row('t').trashedAt).toBe(T0);
    expect(deleted).toEqual([]);
    expect(DB.rows("SELECT id FROM files WHERE fileName = 't.txt'")).toHaveLength(2);
  });
  it('never deletes a Telegram message another file still uses', async () => {
    installTelegram(ok);
    const { req } = await dav([
      { id: 'a', fileName: 'a.txt', messages: [{ message_id: 5, file_id: 'shared' }, { message_id: 7, file_id: 'mine' }], thumb: JSON.stringify({ message_id: 8, file_id: 'th' }) },
      { id: 'b', fileName: 'b.txt', messages: [{ message_id: 5, file_id: 'shared' }, { message_id: 8, file_id: 'part-of-b' }] },
    ]);
    expect((await req('PUT', '/dav/a.txt', {}, 'x')).status).toBe(204);
    expect(deleted).toEqual([7]);
  });
  it('an empty file is stored without a Telegram message and reads back empty', async () => {
    installTelegram(ok);
    const { req, DB } = await dav([]);
    expect((await req('PUT', '/dav/empty.txt', {}, new Uint8Array(0))).status).toBe(201);
    expect(sends).toBe(0);
    expect(DB.rows("SELECT messages FROM files WHERE fileName = 'empty.txt'")[0].messages).toBe('[]');
    const got = await req('GET', '/dav/empty.txt');
    expect([got.status, (await got.arrayBuffer()).byteLength]).toEqual([200, 0]);
  });
  it('refuses an upload unless it has both the password and the salt to encrypt with', () => {
    expect(webdavUploadRefusal({ enabled: true, mode: 'auto', password: 'p', salt: '' })).toMatch(/.+/);
    expect(webdavUploadRefusal({ enabled: true, mode: 'auto', password: 'p', salt: 's' })).toBeNull();
  });
  it('PUT over a file clears its thumb and deletes the old thumbnail with the old parts', async () => {
    installTelegram(ok);
    const { req, row } = await dav([{ id: 'a', fileName: 'a.txt', messages: [{ message_id: 5, file_id: 'old' }], thumb: JSON.stringify({ message_id: 6, file_id: 'th' }) }]);
    expect((await req('PUT', '/dav/a.txt', {}, 'new bytes')).status).toBe(204);
    expect(row('a').thumb).toBeNull();
    expect(deleted.sort()).toEqual([5, 6]);
  });
});

describe('temp file names (D5)', () => {
  it('recognises the file managers’ temp files and nothing else', () => {
    for (const n of ['._report.pdf', '.goutputstream-XYZ', '~$Budget.xlsx', '.~lock.notes.odt#']) expect(isTempFileName(n)).toBe(true);
    for (const n of ['report.pdf', '.bashrc', 'goutputstream', 'a~$b']) expect(isTempFileName(n)).toBe(false);
  });
});
