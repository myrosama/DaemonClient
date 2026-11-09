// Worker release W1 (docs/drive/W1.md): Trash, thumbnails, part confirmation.
// Runs the real route handlers over an in-memory SQLite database.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { handleDrive, ensureDriveSchema } from './drive';
import { handleWebDav, hashToken } from './webdav';
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
  it('?trashed=1 lists trashed items, their contents and marked items, flagging only expired top-level ones', async () => {
    const old = new Date(Date.now() - 30 * DAY - 1000).toISOString();
    const recent = new Date(Date.now() - 30 * DAY + 60_000).toISOString();
    const { call } = await setup([
      { id: 'live' }, { id: 'f', type: 'folder', trashedAt: old }, { id: 'in', parentId: 'f' },
      { id: 'r', trashedAt: recent }, { id: 'm', purgingAt: T0, trashedAt: old },
    ]);
    const items = (await call('GET', '/api/drive/files?trashed=1')).body.items;
    expect(ids(items)).toEqual(['f', 'in', 'm', 'r']);
    const flag = Object.fromEntries(items.map((i: any) => [i.id, i.expired]));
    expect(flag).toEqual({ f: true, in: false, m: true, r: false });
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
    // Inside a folder being deleted: refused too, though d itself isn't marked.
    expect((await call('POST', '/api/drive/files/d/restore')).status).toBe(409);
    expect(ids((await call('GET', '/api/drive/files')).body.items)).toEqual(['a', 'b', 'c', 'docs']);
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
      { id: 'f', type: 'folder', trashedAt: T0 }, { id: 'g', type: 'folder', parentId: 'f' }, { id: 'x', parentId: 'g' },
      { id: 'cyc1', type: 'folder', parentId: 'cyc2' }, { id: 'cyc2', type: 'folder', parentId: 'g' },
      { id: 'other', parentId: 'g', ownerId: 'someone-else' }, { id: 'live' },
    ]);
    const res = await call('POST', '/api/drive/files/f/purge');
    expect(res.status).toBe(200);
    expect(ids(res.body.items)).toEqual(['cyc1', 'cyc2', 'f', 'g', 'x']);
    expect(res.body.items.find((i: any) => i.id === 'x').messages).toEqual([{ message_id: 1, file_id: 'f' }]);
    for (const id of ['f', 'g', 'x', 'cyc1', 'cyc2']) expect(row(id).purgingAt).not.toBeNull();
    expect(row('other').purgingAt).toBeNull();
    expect(row('live').purgingAt).toBeNull();
    // Marking again returns the same set (a second device resumes the delete).
    expect(ids((await call('POST', '/api/drive/files/f/purge')).body.items)).toEqual(['cyc1', 'cyc2', 'f', 'g', 'x']);
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
  it('rejects a malformed thumb', async () => {
    const { call } = await setup([]);
    for (const thumb of ['x', { message_id: 'x', file_id: 't' }, { message_id: 1 }, { message_id: 1, file_id: 'y'.repeat(600) }])
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
      return handleWebDav(new Request(url, { method, headers: { Authorization: 'Basic ' + btoa('m:mt'), ...headers }, body }), s.env, url);
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
  it('PUT waits as long as a 429 asks, then retries', async () => {
    installTelegram((size, n) => (n === 1 ? { status: 429, body: { ok: false, error_code: 429, parameters: { retry_after: 0 } } } : ok(size, n)));
    const { req } = await dav([]);
    expect((await req('PUT', '/dav/new.txt', {}, 'hello')).status).toBe(201);
    expect(sends).toBe(2);
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
