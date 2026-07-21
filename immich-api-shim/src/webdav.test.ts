import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import {
  parseBasicAuth,
  hashToken,
  deriveDriveKey,
  encryptChunkAes,
  decryptChunkAes,
  decodePath,
  resolvePath,
  buildPropfindXml,
  parseRange,
  authenticateDav,
  handleWebDav,
  type DriveRow,
} from './webdav';

// Minimal D1 mock backing the `config` (key/value) table used by get/setConfig.
function mockDb(config: Record<string, string>) {
  return {
    prepare(sql: string) {
      return {
        bind(...args: any[]) {
          return {
            first: async () => {
              if (sql.includes('SELECT value FROM config')) {
                const v = config[args[0]];
                return v !== undefined ? { value: v } : null;
              }
              return null;
            },
            run: async () => {
              if (sql.includes('INSERT OR REPLACE INTO config')) config[args[0]] = args[1];
              return {};
            },
            all: async () => ({ results: [] }),
          };
        },
      };
    },
  } as any;
}

// Copy a Uint8Array into a fresh ArrayBuffer (TS5.7: `.buffer` is ArrayBufferLike).
function toAB(u8: Uint8Array): ArrayBuffer {
  const b = new ArrayBuffer(u8.byteLength);
  new Uint8Array(b).set(u8);
  return b;
}

function row(p: Partial<DriveRow>): DriveRow {
  return {
    id: p.id || 'x', ownerId: 'u1', parentId: p.parentId || 'root',
    type: p.type || 'file', fileName: p.fileName || 'f', fileSize: p.fileSize ?? 0,
    fileType: p.fileType ?? 'text/plain', messages: p.messages ?? null,
    encryptionMode: p.encryptionMode || 'off', uploadedAt: '2026-06-20T00:00:00Z',
    updatedAt: p.updatedAt ?? '2026-06-20T00:00:00Z',
  };
}
const tree: DriveRow[] = [
  row({ id: 'f1', parentId: 'root', type: 'folder', fileName: 'Docs' }),
  row({ id: 'a', parentId: 'f1', type: 'file', fileName: 'a.txt', fileSize: 5 }),
  row({ id: 'top', parentId: 'root', type: 'file', fileName: 'top.bin', fileSize: 9 }),
];

describe('parseBasicAuth', () => {
  it('parses a valid Basic header', () => {
    const header = 'Basic ' + btoa('alice:s3cret:with:colons');
    expect(parseBasicAuth(header)).toEqual({ user: 'alice', pass: 's3cret:with:colons' });
  });

  it('returns null for missing or non-Basic headers', () => {
    expect(parseBasicAuth(null)).toBeNull();
    expect(parseBasicAuth('Bearer xyz')).toBeNull();
    expect(parseBasicAuth('Basic !!!notbase64')).toBeNull();
  });
});

describe('hashToken', () => {
  it('is a deterministic 64-char hex digest', async () => {
    const a = await hashToken('hunter2');
    const b = await hashToken('hunter2');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashToken('different')).not.toBe(a);
  });
});

describe('deriveDriveKey + encrypt/decryptChunkAes', () => {
  it('round-trips bytes with the Drive AES-GCM scheme (IV prepended)', async () => {
    const saltB64 = btoa('0123456789abcdef'); // 16 bytes, base64 like drive_zke stores
    const key = await deriveDriveKey('pw-correct-horse', saltB64);

    const originalU8 = new TextEncoder().encode('drive bytes 📁 over webdav');
    const original = toAB(originalU8);
    const encrypted = await encryptChunkAes(original, key);

    // First 12 bytes are the IV → ciphertext is longer than plaintext by 12 + GCM tag(16).
    expect(encrypted.byteLength).toBe(original.byteLength + 12 + 16);

    const decrypted = await decryptChunkAes(encrypted, key);
    expect(new Uint8Array(decrypted)).toEqual(originalU8);
  });

  it('decrypts data produced by the drive client scheme (IV first 12 bytes)', async () => {
    const saltB64 = btoa('sixteenbytesalt!');
    const key = await deriveDriveKey('pw', saltB64);
    // Encrypt the way drive/src/crypto.js does: iv = random 12, [iv][AES-GCM ct]
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode('hi'));
    const combined = new Uint8Array(12 + ct.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(ct), 12);

    const out = await decryptChunkAes(toAB(combined), key);
    expect(new TextDecoder().decode(out)).toBe('hi');
  });
});

describe('decodePath', () => {
  it('strips the /dav prefix and decodes segments', () => {
    expect(decodePath('/dav/Docs/a.txt')).toEqual(['Docs', 'a.txt']);
    expect(decodePath('/dav/')).toEqual([]);
    expect(decodePath('/dav')).toEqual([]);
    expect(decodePath('/dav/My%20Folder/x')).toEqual(['My Folder', 'x']);
  });
});

describe('resolvePath', () => {
  it('resolves the root to top-level children', () => {
    const r = resolvePath(tree, []);
    expect(r.node?.type).toBe('folder');
    expect(r.children.map((c) => c.fileName).sort()).toEqual(['Docs', 'top.bin']);
  });
  it('resolves a folder and returns its children', () => {
    const r = resolvePath(tree, ['Docs']);
    expect(r.node?.id).toBe('f1');
    expect(r.children.map((c) => c.id)).toEqual(['a']);
  });
  it('resolves a nested file', () => {
    const r = resolvePath(tree, ['Docs', 'a.txt']);
    expect(r.node?.id).toBe('a');
    expect(r.children).toEqual([]);
  });
  it('returns a null node for an unknown path', () => {
    expect(resolvePath(tree, ['nope']).node).toBeNull();
    expect(resolvePath(tree, ['Docs', 'missing']).node).toBeNull();
  });
});

describe('buildPropfindXml', () => {
  it('renders a folder + its children (Depth 1)', () => {
    const r = resolvePath(tree, ['Docs']);
    const xml = buildPropfindXml('/dav/Docs', r.node, r.children, '1');
    expect(xml).toContain('<d:multistatus');
    expect(xml).toContain('<d:href>/dav/Docs/</d:href>'); // self folder, trailing slash
    expect(xml).toContain('<d:collection/>');
    expect(xml).toContain('<d:href>/dav/Docs/a.txt</d:href>'); // child file
    expect(xml).toContain('<d:getcontentlength>5</d:getcontentlength>');
  });
  it('Depth 0 omits children', () => {
    const r = resolvePath(tree, ['Docs']);
    const xml = buildPropfindXml('/dav/Docs', r.node, r.children, '0');
    expect(xml).toContain('<d:href>/dav/Docs/</d:href>');
    expect(xml).not.toContain('a.txt');
  });
});

describe('parseRange', () => {
  it('parses start-end, open-ended, and rejects junk', () => {
    expect(parseRange('bytes=0-3', 5)).toEqual({ start: 0, end: 3 });
    expect(parseRange('bytes=2-', 5)).toEqual({ start: 2, end: 4 });
    expect(parseRange('bytes=2-100', 5)).toEqual({ start: 2, end: 4 }); // clamp
    expect(parseRange(null, 5)).toBeNull();
    expect(parseRange('nonsense', 5)).toBeNull();
  });
});

describe('authenticateDav', () => {
  async function envWithToken(token: string, uid: string) {
    const config: Record<string, string> = {
      dav: JSON.stringify({ tokenHash: await hashToken(token), uid }),
    };
    return { DB: mockDb(config) } as any;
  }
  function req(authPass?: string) {
    const headers: Record<string, string> = {};
    if (authPass !== undefined) headers['Authorization'] = 'Basic ' + btoa('mount:' + authPass);
    return new Request('https://worker.test/dav/', { headers });
  }

  it('accepts the correct mount token and returns the owner uid', async () => {
    const env = await envWithToken('s3cret', 'u1');
    expect(await authenticateDav(req('s3cret'), env)).toEqual({ uid: 'u1' });
  });
  it('rejects a wrong token', async () => {
    const env = await envWithToken('s3cret', 'u1');
    expect(await authenticateDav(req('wrong'), env)).toBeNull();
  });
  it('rejects when no auth header is present', async () => {
    const env = await envWithToken('s3cret', 'u1');
    expect(await authenticateDav(req(), env)).toBeNull();
  });
  it('rejects when no mount token is configured', async () => {
    const env = { DB: mockDb({}) } as any;
    expect(await authenticateDav(req('anything'), env)).toBeNull();
  });
});

// ── Integration: handleWebDav over a mock D1 + mock Telegram ─────────────────
// Backs the `config` and `files` tables, mirroring D1Adapter's exact SQL.
function mockDbFull(config: Record<string, string>, files: any[]) {
  return {
    prepare(sql: string) {
      return {
        bind(...args: any[]) {
          return {
            first: async () => {
              if (sql.includes('SELECT value FROM config')) {
                const v = config[args[0]];
                return v !== undefined ? { value: v } : null;
              }
              if (sql.includes('SELECT * FROM files WHERE id')) {
                return files.find((f) => f.id === args[0]) || null;
              }
              return null;
            },
            run: async () => {
              if (sql.includes('INSERT OR REPLACE INTO config')) config[args[0]] = args[1];
              else if (sql.startsWith('INSERT INTO files')) {
                // saveFile: args are the column values in declared order — reconstruct.
                const cols = sql.slice(sql.indexOf('(') + 1, sql.indexOf(')')).split(',').map((s) => s.trim());
                const rowObj: any = {};
                cols.forEach((c, i) => (rowObj[c] = args[i]));
                const existing = files.findIndex((f) => f.id === rowObj.id);
                if (existing >= 0) files[existing] = { ...files[existing], ...rowObj };
                else files.push(rowObj);
              } else if (sql.startsWith('UPDATE files SET')) {
                const id = args[args.length - 1];
                const setPart = sql.slice('UPDATE files SET '.length, sql.indexOf(' WHERE'));
                const cols = setPart.split(',').map((s) => s.trim().replace(' = ?', ''));
                const f = files.find((x) => x.id === id);
                if (f) cols.forEach((c, i) => (f[c] = args[i]));
              } else if (sql.startsWith('DELETE FROM files')) {
                const idx = files.findIndex((f) => f.id === args[0]);
                if (idx >= 0) files.splice(idx, 1);
              }
              return {};
            },
            all: async () => {
              if (sql.includes('SELECT * FROM files WHERE ownerId')) {
                return { results: files.filter((f) => f.ownerId === args[0]) };
              }
              return { results: [] };
            },
          };
        },
      };
    },
  } as any;
}

describe('handleWebDav (integration)', () => {
  const PLAIN = 'hello drive over webdav!';
  const SALT = btoa('sixteenbytesalt!');
  let key: CryptoKey;
  let encChunk: ArrayBuffer;
  let realFetch: typeof globalThis.fetch;

  beforeAll(async () => {
    key = await deriveDriveKey('pw', SALT);
    encChunk = await encryptChunkAes(toAB(new TextEncoder().encode(PLAIN)), key);
  });
  afterEach(() => {
    if (realFetch) globalThis.fetch = realFetch;
  });

  function baseFiles(): any[] {
    return [
      { id: 'f1', ownerId: 'u1', parentId: 'root', type: 'folder', fileName: 'Docs', fileSize: 0, fileType: null, messages: null, encrypted: 0, encryptionMode: 'off', uploadedAt: '2026-06-20T00:00:00Z', updatedAt: '2026-06-20T00:00:00Z' },
      { id: 'a', ownerId: 'u1', parentId: 'f1', type: 'file', fileName: 'a.txt', fileSize: PLAIN.length, fileType: 'text/plain', messages: JSON.stringify([{ message_id: 1, file_id: 'c0' }]), encrypted: 1, encryptionMode: 'client', uploadedAt: '2026-06-20T00:00:00Z', updatedAt: '2026-06-20T00:00:00Z' },
    ];
  }
  async function env(files = baseFiles()) {
    const config: Record<string, string> = {
      dav: JSON.stringify({ tokenHash: await hashToken('mt'), uid: 'u1' }),
      telegram: JSON.stringify({ botToken: 'BOT', channelId: '-100' }),
      drive_zke: JSON.stringify({ enabled: true, mode: 'auto', password: 'pw', salt: SALT }),
    };
    return { DB: mockDbFull(config, files), files } as any;
  }
  function installFetch(sendDocCapture?: (blob: ArrayBuffer) => void) {
    realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes('/getFile?file_id=c0')) return new Response(JSON.stringify({ ok: true, result: { file_path: 'docs/c0.bin' } }));
      if (url.includes('/file/botBOT/docs/c0.bin')) return new Response(encChunk.slice(0));
      if (url.includes('/sendDocument')) {
        if (sendDocCapture && init?.body instanceof FormData) {
          const doc = (init.body as FormData).get('document') as unknown as Blob;
          sendDocCapture(await doc.arrayBuffer());
        }
        return new Response(JSON.stringify({ ok: true, result: { message_id: 99, document: { file_id: 'newc' } } }));
      }
      if (url.includes('/deleteMessage')) return new Response(JSON.stringify({ ok: true }));
      throw new Error('unexpected fetch ' + url);
    }) as any;
  }
  function req(method: string, path: string, headers: Record<string, string> = {}, body?: BodyInit) {
    return new Request('https://worker.test' + path, { method, headers: { Authorization: 'Basic ' + btoa('m:mt'), ...headers }, body });
  }

  it('OPTIONS advertises DAV capabilities', async () => {
    const e = await env();
    const res = await handleWebDav(req('OPTIONS', '/dav/'), e, new URL('https://worker.test/dav/'));
    expect(res.status).toBe(200);
    expect(res.headers.get('DAV')).toContain('1');
    expect(res.headers.get('Allow') || '').toContain('PROPFIND');
    expect(res.headers.get('Allow') || '').toContain('PUT');
  });

  it('rejects unauthenticated requests with 401', async () => {
    const e = await env();
    const res = await handleWebDav(
      new Request('https://worker.test/dav/', { method: 'PROPFIND' }),
      e, new URL('https://worker.test/dav/'),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toContain('Basic');
  });

  it('PROPFIND lists a folder’s children', async () => {
    const e = await env();
    const res = await handleWebDav(req('PROPFIND', '/dav/Docs', { Depth: '1' }), e, new URL('https://worker.test/dav/Docs'));
    expect(res.status).toBe(207);
    const xml = await res.text();
    expect(xml).toContain('<d:href>/dav/Docs/</d:href>');
    expect(xml).toContain('a.txt');
  });

  it('GET decrypts and serves the file bytes', async () => {
    const e = await env();
    installFetch();
    const res = await handleWebDav(req('GET', '/dav/Docs/a.txt'), e, new URL('https://worker.test/dav/Docs/a.txt'));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(PLAIN);
  });

  it('PUT stores a small file (encrypted) and records the chunk', async () => {
    const files = baseFiles();
    const e = await env(files);
    let uploaded: ArrayBuffer | null = null;
    installFetch((blob) => { uploaded = blob; });
    const res = await handleWebDav(
      req('PUT', '/dav/new.txt', { 'Content-Type': 'text/plain', 'Content-Length': '4' }, new Uint8Array([1, 2, 3, 4])),
      e, new URL('https://worker.test/dav/new.txt'),
    );
    expect(res.status).toBe(201);
    const saved = files.find((f) => f.fileName === 'new.txt');
    expect(saved).toBeTruthy();
    expect(saved.fileSize).toBe(4);
    expect(JSON.parse(saved.messages)).toHaveLength(1);
    expect(saved.encryptionMode).toBe('client');
    expect(uploaded).toBeTruthy(); // encrypted [IV(12)][ct] is longer than the 4-byte plaintext
    expect(uploaded!.byteLength).toBeGreaterThan(4 + 12);
  });

  it('PUT over the 90MB cap returns 507', async () => {
    const e = await env();
    const res = await handleWebDav(
      req('PUT', '/dav/big.bin', { 'Content-Length': String(100 * 1024 * 1024) }, new Uint8Array(1)),
      e, new URL('https://worker.test/dav/big.bin'),
    );
    expect(res.status).toBe(507);
  });

  it('MKCOL creates a folder', async () => {
    const files = baseFiles();
    const e = await env(files);
    const res = await handleWebDav(req('MKCOL', '/dav/NewFolder'), e, new URL('https://worker.test/dav/NewFolder'));
    expect(res.status).toBe(201);
    expect(files.find((f) => f.fileName === 'NewFolder' && f.type === 'folder')).toBeTruthy();
  });

  it('MOVE renames a file', async () => {
    const files = baseFiles();
    const e = await env(files);
    const res = await handleWebDav(
      req('MOVE', '/dav/Docs/a.txt', { Destination: 'https://worker.test/dav/Docs/renamed.txt' }),
      e, new URL('https://worker.test/dav/Docs/a.txt'),
    );
    expect([201, 204]).toContain(res.status);
    expect(files.find((f) => f.id === 'a').fileName).toBe('renamed.txt');
  });

  it('DELETE removes a file', async () => {
    const files = baseFiles();
    const e = await env(files);
    installFetch();
    const res = await handleWebDav(req('DELETE', '/dav/Docs/a.txt'), e, new URL('https://worker.test/dav/Docs/a.txt'));
    expect(res.status).toBe(204);
    expect(files.find((f) => f.id === 'a')).toBeUndefined();
  });

  it('LOCK returns a fake lock token', async () => {
    const e = await env();
    const res = await handleWebDav(req('LOCK', '/dav/Docs/a.txt'), e, new URL('https://worker.test/dav/Docs/a.txt'));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('opaquelocktoken');
    expect(res.headers.get('Lock-Token') || '').toContain('opaquelocktoken');
  });

  it('GET sets cache validators (ETag, Last-Modified, Cache-Control)', async () => {
    const e = await env();
    installFetch();
    const res = await handleWebDav(req('GET', '/dav/Docs/a.txt'), e, new URL('https://worker.test/dav/Docs/a.txt'));
    expect(res.status).toBe(200);
    expect(res.headers.get('ETag')).toBe('"a-2026-06-20T00:00:00Z-' + PLAIN.length + '"');
    expect(res.headers.get('Cache-Control')).toContain('max-age');
    expect(res.headers.get('Last-Modified')).toBeTruthy();
  });

  it('conditional GET with matching If-None-Match returns 304 without hitting Telegram', async () => {
    const e = await env();
    realFetch = globalThis.fetch;
    globalThis.fetch = (async () => { throw new Error('must not fetch on a 304'); }) as any;
    const etag = '"a-2026-06-20T00:00:00Z-' + PLAIN.length + '"';
    const res = await handleWebDav(req('GET', '/dav/Docs/a.txt', { 'If-None-Match': etag }), e, new URL('https://worker.test/dav/Docs/a.txt'));
    expect(res.status).toBe(304);
  });

  it('a start-of-file Range probe on a multi-chunk file fetches only the first chunk', async () => {
    const files = [
      { id: 'f1', ownerId: 'u1', parentId: 'root', type: 'folder', fileName: 'Docs', fileSize: 0, fileType: null, messages: null, encrypted: 0, encryptionMode: 'off', uploadedAt: '2026-06-20T00:00:00Z', updatedAt: '2026-06-20T00:00:00Z' },
      { id: 'b', ownerId: 'u1', parentId: 'f1', type: 'file', fileName: 'b.bin', fileSize: PLAIN.length * 2, fileType: 'application/octet-stream', messages: JSON.stringify([{ message_id: 1, file_id: 'c0' }, { message_id: 2, file_id: 'c1' }]), encrypted: 1, encryptionMode: 'client', uploadedAt: '2026-06-20T00:00:00Z', updatedAt: '2026-06-20T00:00:00Z' },
    ];
    const e = await env(files);
    realFetch = globalThis.fetch;
    let c1Fetched = false;
    globalThis.fetch = (async (input: any) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes('/getFile?file_id=c0')) return new Response(JSON.stringify({ ok: true, result: { file_path: 'd/c0.bin' } }));
      if (url.includes('/file/botBOT/d/c0.bin')) return new Response(encChunk.slice(0));
      if (url.includes('c1')) { c1Fetched = true; throw new Error('should not fetch the 2nd chunk for a start-of-file probe'); }
      throw new Error('unexpected fetch ' + url);
    }) as any;
    const res = await handleWebDav(req('GET', '/dav/Docs/b.bin', { Range: 'bytes=0-3' }), e, new URL('https://worker.test/dav/Docs/b.bin'));
    expect(res.status).toBe(206);
    expect(await res.text()).toBe(PLAIN.slice(0, 4));
    expect(res.headers.get('Content-Range')).toBe('bytes 0-3/' + (PLAIN.length * 2));
    expect(c1Fetched).toBe(false);
  });

  it('an auth-infrastructure error returns a retryable 503, not a 401', async () => {
    const throwingDb = {
      prepare() { return { bind() { return { first: async () => { throw new Error('D1 down'); }, run: async () => ({}), all: async () => ({ results: [] }) }; } }; },
    } as any;
    const res = await handleWebDav(
      req('PROPFIND', '/dav/', { Depth: '0' }),
      { DB: throwingDb } as any,
      new URL('https://worker.test/dav/'),
    );
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBeTruthy();
  });
});
