// DaemonClient Drive — WebDAV server (virtual-drive mount).
//
// Strictly additive: a self-contained module that maps the existing per-user
// `files` table + Telegram bytes onto WebDAV, so users can mount their Drive in
// any OS file manager (GNOME/Finder/Windows/iOS) or rclone. It decrypts on the
// fly with the user's own `drive_zke` key (on their own per-user worker), serves
// plaintext over WebDAV, and never touches the working Photos/Drive code paths.
//
// Crypto matches drive/src/crypto.js exactly: AES-256-GCM, PBKDF2 SHA-256 100k,
// 16-byte salt, 12-byte IV PREPENDED to the ciphertext.

import { D1Adapter, ensureDriveSchema } from './d1-adapter';
import { hiddenIds, moveRefusal, isTempFileName } from './drive-tree';

const PBKDF2_ITERATIONS = 100000;
const IV_LENGTH = 12;

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

/** Parse an `Authorization: Basic base64(user:pass)` header. null if absent/invalid. */
export function parseBasicAuth(header: string | null): { user: string; pass: string } | null {
  if (!header) return null;
  const m = /^Basic\s+(.+)$/i.exec(header.trim());
  if (!m) return null;
  let decoded: string;
  try {
    decoded = atob(m[1]);
  } catch {
    return null;
  }
  const idx = decoded.indexOf(':');
  if (idx === -1) return null;
  return { user: decoded.slice(0, idx), pass: decoded.slice(idx + 1) };
}

/** SHA-256 hex digest of a token (for storing/comparing the mount password). */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', utf8(token));
  return bytesToHex(new Uint8Array(digest));
}

/** Derive the AES-256-GCM key from the drive_zke password + base64 salt. */
export async function deriveDriveKey(password: string, saltB64: string): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey('raw', utf8(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: base64ToBytes(saltB64), iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Encrypt a chunk the Drive way: [12-byte IV][AES-GCM ciphertext]. */
export async function encryptChunkAes(data: BufferSource, key: CryptoKey): Promise<ArrayBuffer> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
  const out = new Uint8Array(IV_LENGTH + ct.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ct), IV_LENGTH);
  return out.buffer;
}

/** Reverse encryptChunkAes: first 12 bytes are the IV. */
export async function decryptChunkAes(data: BufferSource, key: CryptoKey): Promise<ArrayBuffer> {
  const bytes = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
  const iv = bytes.slice(0, IV_LENGTH);
  const ct = bytes.slice(IV_LENGTH);
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
}

// ── Path + WebDAV-XML + range (pure) ────────────────────────────────────────

export interface DriveRow {
  id: string;
  ownerId: string;
  parentId: string;
  type: 'file' | 'folder';
  fileName: string;
  fileSize: number;
  fileType: string | null;
  // JSON string in the DB; D1Adapter.listFiles normalizes it to an array.
  messages: string | Array<{ message_id?: number; file_id: string }> | null;
  encryptionMode: string; // 'off' | 'client'
  uploadedAt: string;
  updatedAt: string | null;
  trashedAt?: string | null;
  purgingAt?: string | null;
  thumb?: string | null;
}

/** Strip the leading `/dav`, split on `/`, decode each segment, drop empties. */
export function decodePath(pathname: string): string[] {
  let p = pathname;
  if (p.startsWith('/dav')) p = p.slice(4);
  return p
    .split('/')
    .filter((s) => s.length > 0)
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });
}

const ROOT_FOLDER: DriveRow = {
  id: 'root', ownerId: '', parentId: '', type: 'folder', fileName: '',
  fileSize: 0, fileType: null, messages: null, encryptionMode: 'off',
  uploadedAt: '', updatedAt: null,
};

/**
 * Resolve a path (segments) against the owner's flat file list. Returns the
 * matched node (null if not found) and, for a folder, its immediate children.
 * The empty path is the synthetic root folder.
 */
export function resolvePath(rows: DriveRow[], segments: string[]): { node: DriveRow | null; children: DriveRow[] } {
  let parentId = 'root';
  let node: DriveRow | null = ROOT_FOLDER;
  for (const seg of segments) {
    const match = rows.find((r) => r.parentId === parentId && r.fileName === seg) || null;
    if (!match) return { node: null, children: [] };
    node = match;
    parentId = match.id;
  }
  const children = node && node.type === 'folder' ? rows.filter((r) => r.parentId === (node === ROOT_FOLDER ? 'root' : node!.id)) : [];
  return { node, children };
}

export function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function hrefFor(baseHref: string, segments: string[], isFolder: boolean): string {
  const path = segments.map((s) => encodeURIComponent(s)).join('/');
  let href = baseHref + (path ? '/' + path : '');
  if (isFolder && !href.endsWith('/')) href += '/';
  return href;
}

function rfc1123(iso: string | null): string {
  const d = iso ? new Date(iso) : new Date();
  return (isNaN(d.getTime()) ? new Date() : d).toUTCString();
}

function responseXml(href: string, r: DriveRow): string {
  const isFolder = r.type === 'folder';
  const resourcetype = isFolder ? '<d:collection/>' : '';
  const name = xmlEscape(r.fileName);
  const lastmod = rfc1123(r.updatedAt || r.uploadedAt);
  const ctype = isFolder ? '' : `<d:getcontenttype>${xmlEscape(r.fileType || 'application/octet-stream')}</d:getcontenttype>`;
  const clen = isFolder ? '' : `<d:getcontentlength>${r.fileSize || 0}</d:getcontentlength>`;
  return (
    `<d:response><d:href>${href}</d:href><d:propstat><d:prop>` +
    `<d:displayname>${name}</d:displayname>` +
    `<d:resourcetype>${resourcetype}</d:resourcetype>` +
    clen + ctype +
    `<d:getlastmodified>${lastmod}</d:getlastmodified>` +
    `</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`
  );
}

/**
 * Build a 207 multistatus body for `self` (+ its `children` when depth==='1').
 * `baseHref` is the request path WITHOUT trailing slash (e.g. `/dav/Docs`).
 */
export function buildPropfindXml(baseHref: string, self: DriveRow | null, children: DriveRow[], depth: '0' | '1'): string {
  const parts: string[] = [];
  if (self) {
    const isFolder = self.type === 'folder';
    const selfHref = isFolder ? (baseHref.endsWith('/') ? baseHref : baseHref + '/') : baseHref;
    parts.push(responseXml(selfHref, self));
    if (depth === '1' && isFolder) {
      for (const c of children) {
        const childHref = (selfHref.endsWith('/') ? selfHref : selfHref + '/') + encodeURIComponent(c.fileName) + (c.type === 'folder' ? '/' : '');
        parts.push(responseXml(childHref, c));
      }
    }
  }
  return `<?xml version="1.0" encoding="utf-8"?>\n<d:multistatus xmlns:d="DAV:">${parts.join('')}</d:multistatus>`;
}

// ── Auth ─────────────────────────────────────────────────────────────────────

/** Constant-time-ish string compare (both already fixed-length hex). */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Authenticate a WebDAV request via HTTP Basic against the per-user mount token
 * (stored hashed under the `dav` config key). The per-user worker serves exactly
 * one owner, so a valid token yields that owner's uid. Returns null → 401.
 */
export async function authenticateDav(request: Request, env: { DB?: any }): Promise<{ uid: string } | null> {
  if (!env.DB) return null;
  const creds = parseBasicAuth(request.headers.get('Authorization'));
  if (!creds) return null;
  const cfg = await new D1Adapter(env.DB).getJsonConfig<{ tokenHash?: string; uid?: string }>('dav');
  if (!cfg?.tokenHash || !cfg.uid) return null;
  const supplied = await hashToken(creds.pass);
  return timingSafeEqual(supplied, cfg.tokenHash) ? { uid: cfg.uid } : null;
}

/** Parse an HTTP Range header against a known size. Returns inclusive {start,end} or null. */
export function parseRange(header: string | null, size: number): { start: number; end: number } | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const startStr = m[1];
  const endStr = m[2];
  let start: number;
  let end: number;
  if (startStr === '') {
    if (endStr === '') return null;
    const suffix = parseInt(endStr, 10);
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = parseInt(startStr, 10);
    end = endStr === '' ? size - 1 : Math.min(parseInt(endStr, 10), size - 1);
  }
  if (isNaN(start) || isNaN(end) || start < 0 || start > end) return null;
  return { start, end };
}

// ── Telegram byte I/O (server-side; the worker reaches api.telegram.org directly) ──

const CHUNK_SIZE = 19 * 1024 * 1024;
const PUT_CAP = 90 * 1024 * 1024;
const DAV_METHODS = 'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, PROPPATCH, MKCOL, MOVE, COPY, LOCK, UNLOCK';

async function tgDownload(botToken: string, fileId: string): Promise<ArrayBuffer> {
  // Cache the (encrypted) Telegram bytes per file_id. gvfs/Finder hammer the same
  // files repeatedly (type sniffing, thumbnails, re-opens) and file_id→bytes is
  // immutable, so this skips the two Telegram round-trips on repeat reads. Only
  // CIPHERTEXT is cached — decryption still happens per request, so the mount
  // never persists plaintext.
  const cache = typeof caches !== 'undefined' ? ((caches as any).default as Cache | undefined) : undefined;
  const cacheKey = `https://tg-cache.local/${encodeURIComponent(fileId)}`;
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit.arrayBuffer();
  }
  const fr = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(fileId)}`);
  const fj = (await fr.json()) as any;
  if (!fj?.ok || !fj.result?.file_path) throw new Error('getFile failed');
  const dl = await fetch(`https://api.telegram.org/file/bot${botToken}/${fj.result.file_path}`);
  if (!dl.ok) throw new Error('download failed ' + dl.status);
  const buf = await dl.arrayBuffer();
  if (cache) {
    try {
      await cache.put(cacheKey, new Response(buf.slice(0), { headers: { 'Cache-Control': 'private, max-age=86400' } }));
    } catch { /* object too big / cache full — non-fatal */ }
  }
  return buf;
}

// A part counts as stored only when Telegram reports the exact size sent (the
// ciphertext when encrypted); a missing size counts as unconfirmed. Up to 4
// sends per part (1 + 3 resends), waiting as long as a 429 asks, 30 s in all.
// Every message id sent is pushed to `sent`; unconfirmed ones are deleted here.
// Worst case per PUT (5 parts): 20 sends + 20 deletes + 5 old parts + 1 old
// thumbnail = 46 subrequests, under the Workers limit of 50.
const PART_SENDS = 4;
const MAX_429_WAIT_S = 30;

async function tgUploadConfirmed(
  botToken: string, channelId: string, data: Uint8Array | ArrayBuffer, name: string, sent: number[],
): Promise<{ message_id: number; file_id: string }> {
  let waited = 0;
  for (let attempt = 0; attempt < PART_SENDS; attempt++) {
    const form = new FormData();
    form.append('chat_id', channelId);
    form.append('document', new Blob([data as any], { type: 'application/octet-stream' }), name);
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendDocument`, { method: 'POST', body: form });
    const j = (await res.json().catch(() => null)) as any;
    const messageId = j?.ok ? j.result?.message_id : undefined;
    if (typeof messageId === 'number') {
      sent.push(messageId);
      const doc = j.result.document;
      if (doc?.file_id && doc.file_size === data.byteLength) return { message_id: messageId, file_id: doc.file_id };
      await tgDelete(botToken, channelId, messageId);
      sent.splice(sent.indexOf(messageId), 1);
      continue;
    }
    const retryAfter = Number(j?.parameters?.retry_after);
    if (res.status === 429 && Number.isFinite(retryAfter) && retryAfter >= 0 && waited + retryAfter <= MAX_429_WAIT_S) {
      waited += retryAfter;
      await new Promise((r) => setTimeout(r, retryAfter * 1000));
    }
  }
  throw new Error('part not confirmed by Telegram');
}

async function tgDelete(botToken: string, channelId: string, messageId: number): Promise<void> {
  await fetch(`https://api.telegram.org/bot${botToken}/deleteMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: channelId, message_id: messageId }),
  }).catch(() => {});
}

/**
 * Why an upload over WebDAV must be refused, or null. With a custom encryption
 * password the worker holds no key (the password never leaves the user's
 * device), and storing the file unencrypted would quietly break the promise
 * that every new file is encrypted — so it is refused instead.
 */
export function webdavUploadRefusal(zke: any): string | null {
  if (zke?.enabled && !zke.password) {
    return 'Your files are encrypted with your own password, which this drive mount does not have. Upload from the web app instead.';
  }
  return null;
}

async function getDriveKey(adapter: D1Adapter): Promise<CryptoKey | null> {
  const zke = await adapter.getJsonConfig<any>('drive_zke');
  if (zke?.enabled && zke.password && zke.salt) return deriveDriveKey(zke.password, zke.salt);
  return null;
}

function chunksOf(node: DriveRow): Array<{ message_id?: number; file_id: string }> {
  const m = node.messages;
  if (Array.isArray(m)) return m;
  if (typeof m === 'string') {
    try { return JSON.parse(m) || []; } catch { return []; }
  }
  return [];
}

function thumbOf(node: DriveRow): number | null {
  try {
    const t = typeof node.thumb === 'string' ? JSON.parse(node.thumb) : null;
    return Number.isSafeInteger(t?.message_id) ? t.message_id : null;
  } catch { return null; }
}

function davText(status: number, msg: string): Response {
  return new Response(msg, { status, headers: { 'DAV': '1, 2' } });
}

// ── The WebDAV server ───────────────────────────────────────────────────────

export async function handleWebDav(request: Request, env: { DB?: any }, url: URL): Promise<Response> {
  const method = request.method.toUpperCase();

  // OPTIONS is unauthenticated so clients can probe capabilities.
  if (method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: { 'DAV': '1, 2', 'MS-Author-Via': 'DAV', 'Allow': DAV_METHODS, 'Content-Length': '0' } });
  }

  let auth: { uid: string } | null;
  try {
    auth = await authenticateDav(request, env);
  } catch {
    // Token lookup hit an infrastructure error (e.g. D1 momentarily overloaded
    // under gvfs's request storm). Returning 401 here would make the file manager
    // wrongly re-prompt for login — return a retryable 503 instead.
    return new Response('Auth check temporarily unavailable', { status: 503, headers: { 'Retry-After': '2', 'DAV': '1, 2' } });
  }
  if (!auth) {
    return new Response('Unauthorized', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="DaemonClient Drive"', 'DAV': '1, 2' } });
  }
  const uid = auth.uid;
  try {
    await ensureDriveSchema(env.DB);
  } catch {
    return new Response('Temporarily unavailable', { status: 503, headers: { 'Retry-After': '2', 'DAV': '1, 2' } });
  }
  const adapter = new D1Adapter(env.DB);
  // Every path lookup sees only visible items: Trash and its contents are not
  // part of the mounted drive (W1).
  const allRows = (await adapter.listFiles(uid)) as DriveRow[];
  const hidden = hiddenIds(allRows);
  const rows = allRows.filter((r) => !hidden.has(r.id));
  const segments = decodePath(url.pathname);
  const basePath = '/dav' + (segments.length ? '/' + segments.map(encodeURIComponent).join('/') : '');

  if (method === 'PROPFIND') {
    const { node, children } = resolvePath(rows, segments);
    if (!node) return davText(404, 'Not Found');
    const depth = (request.headers.get('Depth') || '1').trim() === '0' ? '0' : '1';
    const xml = buildPropfindXml(basePath, node, children, depth);
    return new Response(xml, { status: 207, headers: { 'Content-Type': 'application/xml; charset=utf-8', 'DAV': '1, 2' } });
  }

  if (method === 'GET' || method === 'HEAD') {
    const { node } = resolvePath(rows, segments);
    if (!node || node.type === 'folder') return davText(404, 'Not Found');
    const ctype = node.fileType || 'application/octet-stream';
    // Cache validators so file managers can revalidate cheaply (304) and cache
    // locally instead of re-downloading. This is the main cure for "slow opening
    // files": gvfs/Finder stop re-pulling unchanged files from Telegram.
    const etag = `"${node.id}-${node.updatedAt || node.uploadedAt || ''}-${node.fileSize || 0}"`;
    const cacheHeaders: Record<string, string> = {
      'Content-Type': ctype,
      'Accept-Ranges': 'bytes',
      'ETag': etag,
      'Last-Modified': rfc1123(node.updatedAt || node.uploadedAt),
      'Cache-Control': 'private, max-age=3600',
    };
    // Conditional GET — if the client already holds this exact version, skip the
    // (expensive) Telegram fetch entirely.
    const inm = request.headers.get('If-None-Match');
    if (inm && inm.split(',').map((s) => s.trim()).includes(etag)) {
      return new Response(null, { status: 304, headers: cacheHeaders });
    }
    if (method === 'HEAD') {
      return new Response(null, { status: 200, headers: { ...cacheHeaders, 'Content-Length': String(node.fileSize || 0) } });
    }
    const telegram = await adapter.getJsonConfig<any>('telegram');
    const botToken = telegram?.botToken || telegram?.bot_token;
    if (!botToken) return davText(500, 'Telegram not configured');
    const encrypted = !!node.encryptionMode && node.encryptionMode !== 'off';
    const key = encrypted ? await getDriveKey(adapter) : null;
    if (encrypted && !key) return davText(423, 'Encrypted with a custom password not available to the mount');
    const chunks = chunksOf(node);
    if (chunks.length === 0) return davText(404, 'No file data');

    const fileSize = node.fileSize || 0;
    const range = parseRange(request.headers.get('Range'), fileSize);
    // Fetch + decrypt chunks lazily, in order, stopping as soon as we've covered
    // the requested range. A small Range probe at the start of the file (gvfs's
    // type-sniffing) thus pulls only the first chunk instead of the whole file.
    const need = range ? range.end : Infinity;
    const parts: Uint8Array[] = [];
    let have = 0;
    try {
      for (const ch of chunks) {
        if (have > need) break;
        let data = await tgDownload(botToken, ch.file_id);
        if (key) data = await decryptChunkAes(data, key);
        parts.push(new Uint8Array(data));
        have += data.byteLength;
      }
    } catch {
      // Transient Telegram/decrypt failure — tell the client to retry rather than
      // surfacing a hard error (which makes file managers give up on the file).
      return new Response('Upstream temporarily unavailable', { status: 503, headers: { 'Retry-After': '2', 'DAV': '1, 2' } });
    }
    const assembled = new Uint8Array(have);
    let off = 0;
    for (const p of parts) { assembled.set(p, off); off += p.byteLength; }

    if (range) {
      const end = Math.min(range.end, assembled.byteLength - 1);
      const slice = assembled.slice(range.start, end + 1);
      return new Response(slice, { status: 206, headers: { ...cacheHeaders, 'Content-Range': `bytes ${range.start}-${end}/${fileSize || assembled.byteLength}`, 'Content-Length': String(slice.byteLength) } });
    }
    return new Response(assembled, { status: 200, headers: { ...cacheHeaders, 'Content-Length': String(assembled.byteLength) } });
  }

  if (method === 'PUT') {
    if (segments.length === 0) return davText(400, 'Bad path');
    const declaredLen = parseInt(request.headers.get('Content-Length') || '0', 10);
    if (declaredLen > PUT_CAP) return davText(507, 'Too large for the mounted drive — use the web app');
    const fileName = segments[segments.length - 1];
    const parent = resolvePath(rows, segments.slice(0, -1)).node;
    if (!parent) return davText(409, 'Parent folder not found');
    const parentId = parent.id === 'root' ? 'root' : parent.id;
    const refusal = webdavUploadRefusal(await adapter.getJsonConfig<any>('drive_zke'));
    if (refusal) return davText(403, refusal);
    const telegram = await adapter.getJsonConfig<any>('telegram');
    const botToken = telegram?.botToken || telegram?.bot_token;
    const channelId = telegram?.channelId || telegram?.channel_id;
    if (!botToken || !channelId) return davText(500, 'Telegram not configured');
    const body = new Uint8Array(await request.arrayBuffer());
    if (body.byteLength > PUT_CAP) return davText(507, 'Too large for the mounted drive — use the web app');
    const key = await getDriveKey(adapter);
    const totalChunks = Math.max(1, Math.ceil(body.byteLength / CHUNK_SIZE));
    const messages: Array<{ message_id: number; file_id: string }> = [];
    const sent: number[] = [];
    try {
      for (let i = 0; i < totalChunks; i++) {
        const view = body.subarray(i * CHUNK_SIZE, Math.min((i + 1) * CHUNK_SIZE, body.byteLength));
        const payload = key ? new Uint8Array(await encryptChunkAes(view, key)) : view;
        const partName = key
          ? (totalChunks === 1 ? 'blob.bin' : `blob.bin.part${String(i + 1).padStart(3, '0')}`)
          : (totalChunks === 1 ? fileName : `${fileName}.part${String(i + 1).padStart(3, '0')}`);
        messages.push(await tgUploadConfirmed(botToken, channelId, payload, partName, sent));
      }
    } catch {
      // Nothing is saved; remove every part this upload stored.
      for (const id of sent) await tgDelete(botToken, channelId, id);
      return davText(502, 'Telegram did not confirm every part; nothing was saved. Try again.');
    }
    const existing = resolvePath(rows, segments).node;
    const replacing = existing && existing.type === 'file' ? existing : null;
    const now = new Date().toISOString();
    await adapter.saveFile({
      id: replacing ? replacing.id : crypto.randomUUID(), ownerId: uid, parentId, type: 'file', fileName,
      fileSize: body.byteLength, fileType: request.headers.get('Content-Type') || 'application/octet-stream',
      messages: JSON.stringify(messages), encrypted: key ? 1 : 0, encryptionMode: key ? 'client' : 'off',
      uploadedAt: now, updatedAt: now,
      // New contents: the old thumbnail no longer matches.
      ...(replacing ? { thumb: null } : {}),
    });
    // Overwrite: best-effort delete the old parts and thumbnail now that the new ones are committed.
    if (replacing) {
      for (const m of chunksOf(replacing)) if (m.message_id) await tgDelete(botToken, channelId, m.message_id);
      const oldThumb = thumbOf(replacing);
      if (oldThumb) await tgDelete(botToken, channelId, oldThumb);
    }
    return new Response(null, { status: existing ? 204 : 201 });
  }

  if (method === 'MKCOL') {
    if (segments.length === 0) return davText(405, 'Cannot MKCOL root');
    if (resolvePath(rows, segments).node) return davText(405, 'Already exists');
    const parent = resolvePath(rows, segments.slice(0, -1)).node;
    if (!parent) return davText(409, 'Parent folder not found');
    const now = new Date().toISOString();
    await adapter.saveFile({
      id: crypto.randomUUID(), ownerId: uid, parentId: parent.id === 'root' ? 'root' : parent.id,
      type: 'folder', fileName: segments[segments.length - 1], fileSize: 0, fileType: null,
      messages: null, encrypted: 0, encryptionMode: 'off', uploadedAt: now, updatedAt: now,
    });
    return new Response(null, { status: 201 });
  }

  if (method === 'DELETE') {
    const { node } = resolvePath(rows, segments);
    if (!node || node.id === 'root') return davText(404, 'Not Found');
    // A file manager's own temp file goes for good (owner decision D5);
    // everything else goes to Trash, where its contents follow it.
    if (node.type === 'file' && isTempFileName(node.fileName)) {
      const telegram = await adapter.getJsonConfig<any>('telegram');
      const botToken = telegram?.botToken || telegram?.bot_token;
      const channelId = telegram?.channelId || telegram?.channel_id;
      if (botToken && channelId) {
        for (const m of chunksOf(node)) if (m.message_id) await tgDelete(botToken, channelId, m.message_id);
        const oldThumb = thumbOf(node);
        if (oldThumb) await tgDelete(botToken, channelId, oldThumb);
      }
      await adapter.deleteFile(node.id);
    } else {
      const now = new Date().toISOString();
      await adapter.updateFile(node.id, { trashedAt: now, updatedAt: now });
    }
    return new Response(null, { status: 204 });
  }

  if (method === 'MOVE') {
    const { node } = resolvePath(rows, segments);
    if (!node || node.id === 'root') return davText(404, 'Not Found');
    const dest = request.headers.get('Destination');
    if (!dest) return davText(400, 'Missing Destination');
    let destSegs: string[];
    try { destSegs = decodePath(new URL(dest, url).pathname); } catch { return davText(400, 'Bad Destination'); }
    if (destSegs.length === 0) return davText(400, 'Bad Destination');
    const newParent = resolvePath(rows, destSegs.slice(0, -1)).node;
    if (!newParent) return davText(409, 'Destination parent not found');
    const newParentId = newParent.id === 'root' ? 'root' : newParent.id;
    const refusal = moveRefusal(allRows, node.id, newParentId, hidden);
    if (refusal) return davText(409, refusal);
    const target = resolvePath(rows, destSegs).node;
    const overwrite = target && target.id !== node.id ? target : null;
    if (overwrite) {
      if ((request.headers.get('Overwrite') || 'T').toUpperCase() === 'F') return davText(412, 'Destination exists');
      // Saving over a file (how Finder and GNOME save): the old one goes to
      // Trash rather than staying beside the new one (owner decision D4).
      const now = new Date().toISOString();
      await adapter.updateFile(overwrite.id, { trashedAt: now, updatedAt: now });
    }
    await adapter.updateFile(node.id, {
      fileName: destSegs[destSegs.length - 1],
      parentId: newParent.id === 'root' ? 'root' : newParent.id,
      updatedAt: new Date().toISOString(),
    });
    return new Response(null, { status: overwrite ? 204 : 201 });
  }

  if (method === 'LOCK') {
    const token = `opaquelocktoken:${crypto.randomUUID()}`;
    const xml = `<?xml version="1.0" encoding="utf-8"?>\n<d:prop xmlns:d="DAV:"><d:lockdiscovery><d:activelock><d:locktype><d:write/></d:locktype><d:lockscope><d:exclusive/></d:lockscope><d:depth>infinity</d:depth><d:timeout>Second-3600</d:timeout><d:locktoken><d:href>${token}</d:href></d:locktoken></d:activelock></d:lockdiscovery></d:prop>`;
    return new Response(xml, { status: 200, headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Lock-Token': `<${token}>`, 'DAV': '1, 2' } });
  }
  if (method === 'UNLOCK') return new Response(null, { status: 204, headers: { 'DAV': '1, 2' } });
  if (method === 'PROPPATCH') {
    const xml = `<?xml version="1.0" encoding="utf-8"?>\n<d:multistatus xmlns:d="DAV:"><d:response><d:href>${basePath}</d:href><d:propstat><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`;
    return new Response(xml, { status: 207, headers: { 'Content-Type': 'application/xml; charset=utf-8', 'DAV': '1, 2' } });
  }
  if (method === 'COPY') return davText(501, 'COPY not implemented');

  return new Response('Method Not Allowed', { status: 405, headers: { 'Allow': DAV_METHODS, 'DAV': '1, 2' } });
}
