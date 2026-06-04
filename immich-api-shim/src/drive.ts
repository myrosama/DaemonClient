import type { Env } from './index';
import type { D1Database } from '@cloudflare/workers-types';
import { json, requireAuth } from './helpers';
import { D1Adapter } from './d1-adapter';
import { getCachedConfig } from './cached-config';

// Self-healing schema: per-user workers provisioned before the `files` table
// existed (1.2.0) would otherwise need an operator force-update to run the
// migration. Instead the Drive handler creates its own table on first use —
// idempotent (IF NOT EXISTS) and guarded to once per isolate so it's effectively
// free. This is why code-only auto-update (which never runs migrations) is enough
// to bring Drive online for existing users.
let driveSchemaReady = false;
async function ensureDriveSchema(db: D1Database): Promise<void> {
  if (driveSchemaReady) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY, ownerId TEXT NOT NULL, parentId TEXT NOT NULL DEFAULT 'root',
      type TEXT NOT NULL DEFAULT 'file', fileName TEXT NOT NULL, fileSize INTEGER DEFAULT 0,
      fileType TEXT, messages TEXT, encrypted INTEGER DEFAULT 0,
      encryptionMode TEXT DEFAULT 'off', uploadedAt TEXT NOT NULL, updatedAt TEXT
    )`),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_files_owner_parent ON files(ownerId, parentId)'),
  ]);
  driveSchemaReady = true;
}

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
  await ensureDriveSchema(env.DB);
  const db = new D1Adapter(env.DB);

  // GET /api/drive/config — bot token + channel + proxy URL, so the client can
  // upload/download chunks directly to Telegram. The user owns this bot; this is
  // the same trust boundary as the old Drive (which kept the token client-side in
  // Firestore). Server already exposes the same via /api/server/storage.
  if (path === '/api/drive/config' && request.method === 'GET') {
    const config = await getCachedConfig<any>(env, uid, session.idToken, 'telegram');
    const botToken = config?.botToken || config?.bot_token || null;
    const channelId = config?.channelId || config?.channel_id || null;
    return json({
      botToken,
      channelId,
      proxyUrl: env.TELEGRAM_PROXY || null,
      configured: !!(botToken && channelId),
    });
  }

  // POST /api/drive/config — update the bot token / channel (Settings). Merges
  // into the existing telegram config in the user's own D1 so other fields
  // (botUsername, ownership flags) are preserved. The user's bot is shared with
  // Photos; this is the one config for it.
  if (path === '/api/drive/config' && request.method === 'POST') {
    const body = (await request.json().catch(() => ({}))) as any;
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
      const body = (await request.json().catch(() => ({}))) as any;
      const cfg = {
        enabled: !!body.enabled,
        mode: body.mode === 'custom' ? 'custom' : 'auto',
        // Only persist the password for auto mode; custom passwords stay in the
        // user's head and are never sent.
        password: body.enabled && body.mode !== 'custom' ? (body.password || '') : '',
        salt: body.salt || '',
        updatedAt: new Date().toISOString(),
      };
      await db.setJsonConfig('drive_zke', cfg);
      return json(cfg);
    }
  }

  // GET /api/drive/files[?parentId=] — list this owner's files/folders. With no
  // parentId, returns the whole tree (the client filters per folder locally,
  // matching the old local-first sync model).
  if (path === '/api/drive/files' && request.method === 'GET') {
    const parentId = url.searchParams.get('parentId');
    const items = await db.listFiles(uid, parentId === null ? undefined : parentId);
    return json({ items });
  }

  // POST /api/drive/files — create a file (metadata for client-uploaded Telegram
  // chunks) or a folder ({type:'folder'}). Returns the created item.
  if (path === '/api/drive/files' && request.method === 'POST') {
    const body = (await request.json().catch(() => ({}))) as any;
    if (!body || typeof body.fileName !== 'string' || !body.fileName.trim()) {
      return json({ message: 'fileName is required' }, 400);
    }
    const type = body.type === 'folder' ? 'folder' : 'file';
    const now = new Date().toISOString();
    const record = {
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
    await db.saveFile(record);
    return json({ item: D1Adapter.normalizeFile(record) }, 201);
  }

  // /api/drive/files/:id — rename/move (PATCH/PUT) or delete (DELETE). Ownership
  // is enforced: a row owned by someone else reads as 404.
  const idMatch = path.match(/^\/api\/drive\/files\/([^/]+)$/);
  if (idMatch) {
    const fid = decodeURIComponent(idMatch[1]);
    const existing = await db.getFile(fid);
    if (!existing || existing.ownerId !== uid) return json({ message: 'Not found' }, 404);

    if (request.method === 'PATCH' || request.method === 'PUT') {
      const body = (await request.json().catch(() => ({}))) as any;
      const fields: Record<string, any> = { updatedAt: new Date().toISOString() };
      if (typeof body.fileName === 'string' && body.fileName.trim()) fields.fileName = body.fileName.trim();
      if (typeof body.parentId === 'string' && body.parentId) fields.parentId = body.parentId;
      await db.updateFile(fid, fields);
      return json({ item: D1Adapter.normalizeFile({ ...existing, ...fields }) });
    }

    if (request.method === 'DELETE') {
      // Telegram message deletion stays client-side (the client holds the bot
      // token + the `messages` array). We only drop the metadata row here.
      await db.deleteFile(fid);
      return json({ success: true });
    }
  }

  return json({ message: 'Not found' }, 404);
}
