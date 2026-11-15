import type { Env } from './index';
import { json, requireAuth } from './helpers';
import { D1Adapter, ensureDriveSchema } from './d1-adapter';
import { hiddenIds, moveRefusal, parseThumb, rowMessageIds, sameMessages, TRASH_EXPIRY_MS } from './drive-tree';
import { getCachedConfig } from './cached-config';

/**
 * The key-check value stored with the Drive encryption settings: base64 of the
 * 12-byte IV followed by the AES-GCM ciphertext of a fixed constant. Only a
 * plain, bounded base64 string is kept; anything else is dropped.
 */
export function driveKeyCheck(raw: unknown): string {
  return typeof raw === 'string' && raw.length >= 40 && raw.length <= 512 && /^[A-Za-z0-9+/]+={0,2}$/.test(raw) ? raw : '';
}
import { hashToken } from './webdav';

// The schema step (the table, and W1's columns on older workers) lives in
// d1-adapter.ts so WebDAV runs it too.
export { ensureDriveSchema } from './d1-adapter';

// Drive runs on the SAME per-user worker + D1 as Photos. Unlike Photos, Drive
// bytes never pass through the worker: the browser chunks + client-encrypts
// (AES-GCM, reusing the old Drive crypto) and uploads straight to Telegram via
// the proxy, then POSTs only the chunk metadata here. So this handler is pure
// metadata CRUD over the `files` table — it never sees plaintext, keys, or file
// bytes. Server-ZKE is deliberately NOT used here (it can't be: the worker never
// holds the bytes to encrypt). Field names mirror the old Firestore docs
// (fileName/fileSize/fileType/messages/parentId/encrypted/type) so the frontend
// migration is a near 1:1 swap of Firestore reads/writes for these calls.
export async function handleDrive(request: Request, env: Env, path: string, url: URL): Promise<Response> {
  if (!env.DB) return json({ message: 'Drive requires a per-user database' }, 503);

  const session = await requireAuth(request, env);
  const uid = session.uid;
  try {
    await ensureDriveSchema(env.DB);
  } catch (error: any) {
    console.error('[drive] schema step failed:', error?.message);
    return json({ message: 'Temporarily unavailable' }, 503);
  }
  const db = new D1Adapter(env.DB);

  // GET /api/drive/config — bot token + channel + proxy URL, so the client can
  // upload/download chunks directly to Telegram. The user owns this bot; this is
  // the same trust boundary as the old Drive (which kept the token client-side in
  // Firestore). Server already exposes the same via /api/server/storage.
  if (path === '/api/drive/config' && request.method === 'GET') {
    // The relay checks the bot token against the local copy, so it must exist.
    let config: any;
    try {
      config = await getCachedConfig<any>(env, uid, session.idToken, 'telegram', { requireLocalCopy: true });
    } catch (error: any) {
      console.error('[drive/config] could not keep the local copy:', error?.message);
      return json({ message: 'Temporarily unavailable' }, 503);
    }
    const botToken = config?.botToken || config?.bot_token || null;
    const channelId = config?.channelId || config?.channel_id || null;
    return json({
      botToken,
      channelId,
      proxyUrl: env.TELEGRAM_PROXY || null,
      configured: !!(botToken && channelId),
      // The Drive API level: 1 = release W1 (Trash, thumbnails). Absent on older
      // workers; the new app makes no writes until it sees this.
      driveApi: 1,
    });
  }

  // POST /api/drive/config — update the bot token / channel (Settings). Merges
  // into the existing telegram config in the user's own D1 so other fields
  // (botUsername, ownership flags) are preserved. The user's bot is shared with
  // Photos; this is the one config for it.
  if (path === '/api/drive/config' && request.method === 'POST') {
    const body = ((await request.json().catch(() => null)) || {}) as any;
    const existing = (await db.getJsonConfig<any>('telegram')) || {};
    const merged = { ...existing };
    if (typeof body.botToken === 'string' && body.botToken.trim()) merged.botToken = body.botToken.trim();
    if (typeof body.channelId === 'string' && body.channelId.trim()) merged.channelId = body.channelId.trim();
    await db.setJsonConfig('telegram', merged);
    return json({ botToken: merged.botToken || null, channelId: merged.channelId || null, configured: !!(merged.botToken && merged.channelId) });
  }

  // GET /api/drive/usage — total bytes stored (folders excluded).
  if (path === '/api/drive/usage' && request.method === 'GET') {
    const used = await db.sumFileSizes(uid);
    return json({ used });
  }

  // Drive client-side encryption config (the user's own AES password/salt). Kept
  // under a dedicated `drive_zke` config key — deliberately NOT the photos
  // zke_* keys, which Photos uses for its own server-side encryption and must not
  // be clobbered. Stored on the user's OWN worker (not Firestore) so it syncs
  // across the user's devices without ever touching shared infra. The worker only
  // stores it; encryption/decryption happens entirely in the browser.
  if (path === '/api/drive/zke') {
    if (request.method === 'GET') {
      const cfg = await db.getJsonConfig<any>('drive_zke');
      return json(cfg || { enabled: false });
    }
    if (request.method === 'POST' || request.method === 'PUT') {
      const body = ((await request.json().catch(() => null)) || {}) as any;
      // A conditional save (the app adding a key-check value to existing
      // settings) lands only on the salt it was made for — never over a
      // password another device set in the meantime.
      if (typeof body.ifSalt === 'string') {
        if (body.salt !== body.ifSalt) return json({ message: 'ifSalt must equal salt' }, 400);
        const current = await db.getJsonConfig<any>('drive_zke');
        if ((current?.salt || '') !== body.ifSalt) return json({ message: 'Encryption settings changed' }, 409);
      }
      const cfg = {
        enabled: !!body.enabled,
        mode: body.mode === 'custom' ? 'custom' : 'auto',
        // Only persist the password for auto mode; custom passwords stay in the
        // user's head and are never sent.
        password: body.enabled && body.mode !== 'custom' ? (body.password || '') : '',
        salt: body.salt || '',
        // A known constant encrypted under the key (see driveKeyCheck): lets
        // the app tell a right password from a wrong one without trying files.
        check: driveKeyCheck(body.check),
        updatedAt: new Date().toISOString(),
      };
      await db.setJsonConfig('drive_zke', cfg);
      return json(cfg);
    }
  }

  // GET /api/drive/files[?parentId=] — list this owner's files/folders. With no
  // parentId, returns the whole tree (the client filters per folder locally,
  // matching the old local-first sync model).
  // Trashed items, their contents and marked items are hidden (W1); with
  // ?trashed=1 only those are listed, each with its own trashedAt flagged
  // `expired` after 30 days by this worker's clock.
  if (path === '/api/drive/files' && request.method === 'GET') {
    const rows = await db.listFiles(uid);
    const hidden = hiddenIds(rows);
    if (url.searchParams.get('trashed') === '1') {
      const cutoff = Date.now() - TRASH_EXPIRY_MS;
      const items = rows.filter((r) => hidden.has(r.id)).map((r) => ({
        ...r,
        expired: !!r.trashedAt && Date.parse(r.trashedAt) <= cutoff,
      }));
      return json({ items });
    }
    const parentId = url.searchParams.get('parentId');
    const items = rows.filter((r) => !hidden.has(r.id) && (parentId === null || r.parentId === parentId));
    return json({ items });
  }

  // POST /api/drive/files — create a file (metadata for client-uploaded Telegram
  // chunks) or a folder ({type:'folder'}). Returns the created item.
  if (path === '/api/drive/files' && request.method === 'POST') {
    const body = (await request.json().catch(() => ({}))) as any;
    if (!body || typeof body.fileName !== 'string' || !body.fileName.trim()) {
      return json({ message: 'fileName is required' }, 400);
    }
    // 'root' is the top level's marker in parentId, never a row.
    if (body.id === 'root') return json({ message: 'Invalid id' }, 400);
    if (Array.isArray(body.messages) && body.messages.some((m: unknown) => !m || typeof m !== 'object')) {
      return json({ message: 'messages must be objects' }, 400);
    }
    const type = body.type === 'folder' ? 'folder' : 'file';
    let thumb: string | null | undefined;
    try { thumb = parseThumb(body.thumb); } catch (error: any) { return json({ message: error.message }, 400); }
    const now = new Date().toISOString();
    const record: Record<string, any> = {
      id: typeof body.id === 'string' && body.id ? body.id : crypto.randomUUID(),
      ownerId: uid,
      parentId: typeof body.parentId === 'string' && body.parentId ? body.parentId : 'root',
      type,
      fileName: body.fileName.trim(),
      fileSize: type === 'folder' ? 0 : (Number(body.fileSize) || 0),
      fileType: type === 'folder' ? null : (body.fileType || 'application/octet-stream'),
      messages: type === 'folder' ? null : JSON.stringify(Array.isArray(body.messages) ? body.messages : []),
      encrypted: body.encrypted ? 1 : 0,
      encryptionMode: body.encrypted ? (body.encryptionMode === 'server' ? 'client' : (body.encryptionMode || 'client')) : 'off',
      uploadedAt: typeof body.uploadedAt === 'string' ? body.uploadedAt : now,
      updatedAt: now,
    };
    // A save never sets trashedAt or purgingAt: the upsert leaves columns it
    // isn't given alone, so neither the classic app nor WebDAV can un-trash.
    const existing = await db.getFile(record.id);
    if (existing) {
      if (existing.ownerId !== uid) return json({ message: 'Not found' }, 404);
      if (existing.purgingAt) return json({ message: 'This item is being deleted' }, 409);
      if (record.parentId !== existing.parentId) {
        const refusal = moveRefusal(await db.listFiles(uid), record.id, record.parentId);
        if (refusal) return json({ message: refusal }, 409);
      }
    }
    // New parts mean the old thumbnail no longer matches, unless one is supplied.
    if (thumb !== undefined) record.thumb = thumb;
    else if (existing && !sameMessages(existing.messages, record.messages)) record.thumb = null;
    if (!(await db.saveFile(record as any))) return json({ message: 'This item or its folder is being deleted' }, 409);
    return json({ item: D1Adapter.normalizeFile({ ...(existing || {}), ...record }) }, 201);
  }

  // /api/drive/files/:id — rename/move (PATCH/PUT) or delete (DELETE). Ownership
  // is enforced: a row owned by someone else reads as 404.
  const idMatch = path.match(/^\/api\/drive\/files\/([^/]+)(?:\/(trash|restore|purge))?$/);
  if (idMatch) {
    let fid: string;
    try { fid = decodeURIComponent(idMatch[1]); } catch { return json({ message: 'Invalid id' }, 400); }
    const action = idMatch[2];
    if (action && fid === 'root') return json({ message: 'Invalid id' }, 400);
    const existing = await db.getFile(fid);
    if (!existing || existing.ownerId !== uid) return json({ message: 'Not found' }, 404);
    const now = new Date().toISOString();
    const beingDeleted = { message: 'This item is being deleted' };

    if (action && request.method === 'POST') {
      if (action === 'trash') {
        if (existing.purgingAt) return json(beingDeleted, 409);
        const fields = { trashedAt: existing.trashedAt || now, updatedAt: now };
        if (!(await db.updateFile(fid, fields))) return json(beingDeleted, 409);
        return json({ item: D1Adapter.normalizeFile({ ...existing, ...fields }) });
      }
      const rows = await db.listFiles(uid);
      if (action === 'restore') {
        if (existing.purgingAt) return json(beingDeleted, 409);
        // Back into its folder, or the top level if that folder is gone, trashed
        // or being deleted (owner decision D2).
        const hidden = hiddenIds(rows);
        const parentOk = existing.parentId === 'root'
          || (rows.some((r) => r.id === existing.parentId) && !hidden.has(existing.parentId));
        const fields = { trashedAt: null, updatedAt: now, ...(parentOk ? {} : { parentId: 'root' }) };
        if (!(await db.updateFile(fid, fields))) return json(beingDeleted, 409);
        return json({ item: D1Adapter.normalizeFile({ ...existing, ...fields }) });
      }
      // purge: only from Trash (owner decision D1), then the whole subtree.
      if (!hiddenIds(rows).has(fid)) return json({ message: 'Move it to Trash first' }, 409);
      const items = await db.markPurging(uid, fid, now);
      // The client deletes what this lists, so leave out any message a row
      // outside the deletion still uses.
      const marked = new Set(items.map((i) => i.id));
      const keep = new Set(rows.filter((r) => !marked.has(r.id)).flatMap(rowMessageIds));
      return json({
        items: items.map((i) => ({
          ...i,
          messages: Array.isArray(i.messages) ? i.messages.filter((m: any) => !keep.has(m?.message_id)) : [],
          thumb: i.thumb && keep.has(i.thumb.message_id) ? null : i.thumb,
        })),
      });
    }

    if (!action && (request.method === 'PATCH' || request.method === 'PUT')) {
      if (existing.purgingAt) return json(beingDeleted, 409);
      const body = ((await request.json().catch(() => null)) || {}) as any;
      const fields: Record<string, any> = { updatedAt: now };
      if (typeof body.fileName === 'string' && body.fileName.trim()) fields.fileName = body.fileName.trim();
      try { fields.thumb = parseThumb(body.thumb); } catch (error: any) { return json({ message: error.message }, 400); }
      if (typeof body.parentId === 'string' && body.parentId && body.parentId !== existing.parentId) {
        const refusal = moveRefusal(await db.listFiles(uid), fid, body.parentId);
        if (refusal) return json({ message: refusal }, 409);
        fields.parentId = body.parentId;
      }
      if (!(await db.updateFile(fid, fields))) return json(beingDeleted, 409);
      return json({ item: D1Adapter.normalizeFile({ ...existing, ...fields }) });
    }

    if (!action && request.method === 'DELETE') {
      // Telegram message deletion stays client-side (the client holds the bot
      // token + the `messages` array). We only drop the metadata row here.
      // An unmarked item is still accepted, as the classic app deletes that way
      // (until release W2); a marked folder must be emptied first.
      if (existing.purgingAt && existing.type === 'folder' && await db.hasChildren(uid, fid)) {
        return json({ message: 'Delete the items inside this folder first' }, 409);
      }
      await db.deleteFile(fid);
      return json({ success: true });
    }
  }

  // /api/drive/dav — manage the WebDAV mount token (the "password" a user pastes
  // into Finder/GNOME/iOS to mount their Drive). GET status, POST generate
  // (token shown ONCE), DELETE revoke. The token is stored hashed under config
  // key `dav`; webdav.ts authenticates Basic-auth requests against it.
  if (path === '/api/drive/dav') {
    const mountUrl = `${new URL(request.url).origin}/dav/`;
    if (request.method === 'GET') {
      const cfg = await db.getJsonConfig<any>('dav');
      return json({ enabled: !!cfg?.tokenHash, url: mountUrl, username: uid });
    }
    if (request.method === 'POST') {
      const raw = crypto.getRandomValues(new Uint8Array(24));
      const token = btoa(String.fromCharCode(...raw)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      await db.setJsonConfig('dav', { tokenHash: await hashToken(token), uid, createdAt: new Date().toISOString() });
      return json({ token, username: uid, url: mountUrl });
    }
    if (request.method === 'DELETE') {
      await db.setJsonConfig('dav', {}); // clears tokenHash → mount disabled
      return json({ enabled: false });
    }
  }

  return json({ message: 'Not found' }, 404);
}
