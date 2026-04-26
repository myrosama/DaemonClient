import type { Env } from './index';
import { requireAuth, firestoreGet, firestoreSet, firestoreDelete, json } from './helpers';
import sizeOf from 'image-size';
import { normalizePhotoManifest } from './contracts';
import { getFlagsForUser } from './feature-flags';

// --- ZKE Crypto Implementation ---
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const KEY_LENGTH = 256;
const PBKDF2_ITERATIONS = 100000;
const CHUNK_SIZE = 19 * 1024 * 1024; // 19 MB

async function deriveKey(password: string, saltStr: string): Promise<CryptoKey> {
  const salt = Uint8Array.from(atob(saltStr), c => c.charCodeAt(0));
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits', 'deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: KEY_LENGTH },
    false,
    ['encrypt', 'decrypt']
  );
}

async function encryptChunk(data: ArrayBuffer, key: CryptoKey): Promise<ArrayBuffer> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(encrypted), iv.length);
  return combined.buffer;
}

async function decryptChunk(encryptedChunk: ArrayBuffer, key: CryptoKey): Promise<ArrayBuffer> {
  const data = new Uint8Array(encryptedChunk);
  const iv = data.slice(0, IV_LENGTH);
  const encrypted = data.slice(IV_LENGTH);
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, encrypted.buffer);
}

async function getEncryptionKey(env: Env, uid: string, idToken: string): Promise<CryptoKey | null> {
  const zkeConfig = await firestoreGet(env, uid, 'config/zke', idToken);
  if (zkeConfig && zkeConfig.enabled && zkeConfig.password && zkeConfig.salt) {
    return deriveKey(zkeConfig.password, zkeConfig.salt);
  }
  return null;
}

export async function handleAssets(request: Request, env: Env, path: string, url: URL): Promise<Response> {
  const session = await requireAuth(request, env);
  const uid = session.uid;
  const idToken = session.idToken;

  if (path === '/api/assets/zke-status' && request.method === 'GET') {
    const zkeConfig = await firestoreGet(env, uid, 'config/zke', idToken);
    const mode = zkeConfig?.mode === 'client' ? 'client' : 'server';
    return json({ mode, enabled: mode === 'server' });
  }
  if (path === '/api/assets/zke-toggle' && request.method === 'POST') {
    const body = await request.json() as any;
    const zkeConfig = await firestoreGet(env, uid, 'config/zke', idToken) || {};
    zkeConfig.mode = body.mode === 'client' ? 'client' : 'server';
    zkeConfig.enabled = zkeConfig.mode === 'server'; // Backwards compat
    await firestoreSet(env, uid, 'config/zke', zkeConfig, idToken);
    return json({ mode: zkeConfig.mode, enabled: zkeConfig.enabled });
  }

  const idMatch = path.match(/^\/api\/assets?\/([^/]+)/);
  const resourceId = idMatch ? idMatch[1] : null;

  if (resourceId && path.endsWith('/thumbnail') && request.method === 'GET') {
    return handleThumbnail(request, env, uid, resourceId, idToken);
  }
  if (resourceId && (path.endsWith('/original') || path.includes('/file/')) && request.method === 'GET') {
    return handleOriginal(request, env, uid, resourceId, idToken);
  }
  if (resourceId && path.endsWith('/video/playback') && request.method === 'GET') {
    return handleOriginal(request, env, uid, resourceId, idToken);
  }
  if (resourceId && path.match(/^\/api\/assets?\/([^/]+)$/) && request.method === 'GET') {
    return handleAssetInfo(env, uid, resourceId, idToken);
  }
  if (resourceId && path.match(/^\/api\/assets?\/([^/]+)$/) && request.method === 'PUT') {
    return handleUpdateAsset(request, env, uid, resourceId, idToken);
  }
  if (resourceId && path.endsWith('/view')) {
    return json({ id: resourceId });
  }
  if (path === '/api/assets' && request.method === 'DELETE') {
    return handleDeleteAssets(request, env, uid, idToken);
  }
  if (path === '/api/assets' && request.method === 'PUT') {
    return handleBulkUpdate(request, env, uid, idToken);
  }
  if (path === '/api/assets/bulk-upload-check' && request.method === 'POST') {
    const body = await request.json() as any;
    return json({ results: (body.assets || []).map((a: any) => ({ id: a.id, action: 'accept', assetId: null, isTrashed: false })) });
  }
  if ((path === '/api/assets' || path === '/api/asset/upload') && request.method === 'POST') {
    return handleUpload(request, env, uid, idToken);
  }
  if (path === '/api/assets/upload-plan' && request.method === 'POST') {
    return handleUploadPlan(request, env, uid, idToken);
  }
  if (path === '/api/assets/finalize-client-upload' && request.method === 'POST') {
    return handleFinalizeClientUpload(request, env, uid, idToken);
  }
  if (path.match(/^\/api\/assets\/([^/]+)\/chunk-manifest$/) && request.method === 'GET') {
    return handleChunkManifest(env, uid, path.match(/^\/api\/assets\/([^/]+)\/chunk-manifest$/)![1], idToken);
  }

  if (path === '/api/assets/worker-config' && request.method === 'GET') {
    const workerConfig = await firestoreGet(env, uid, 'config/worker', idToken);
    return json({ url: workerConfig?.url || null });
  }
  
  return json({ message: 'Asset endpoint not found' }, 404);
}

// ── Handlers ────────────────────────────────────────────────────────

async function handleAssetInfo(env: Env, uid: string, assetId: string, idToken: string): Promise<Response> {
  const photo = await firestoreGet(env, uid, `photos/${assetId}`, idToken);
  if (!photo) return json({ message: 'Asset not found' }, 404);
  photo.id = assetId;
  return json(toAssetResponseDto(photo, uid));
}

async function handleUpdateAsset(request: Request, env: Env, uid: string, assetId: string, idToken: string): Promise<Response> {
  const body = await request.json() as any;
  const updates: Record<string, any> = {};
  if (body.updateAssetDto) {
    if (body.updateAssetDto.isFavorite !== undefined) updates.isFavorite = body.updateAssetDto.isFavorite;
    if (body.updateAssetDto.isArchived !== undefined) updates.visibility = body.updateAssetDto.isArchived ? 'archive' : 'timeline';
    if (body.updateAssetDto.description !== undefined) updates.description = body.updateAssetDto.description;
  }
  if (Object.keys(updates).length > 0) {
    await firestoreSet(env, uid, `photos/${assetId}`, updates, idToken);
  }
  const photo = await firestoreGet(env, uid, `photos/${assetId}`, idToken);
  return json(toAssetResponseDto(photo, uid));
}

async function handleDeleteAssets(request: Request, env: Env, uid: string, idToken: string): Promise<Response> {
  const body = await request.json() as any;
  const ids: string[] = body.ids || [];
  const clientDelete = body.clientDelete === true;
  const config = await firestoreGet(env, uid, 'config/telegram', idToken);
  const botToken = config?.botToken || config?.bot_token;
  const channelId = config?.channelId || config?.channel_id;

  for (const id of ids) {
    if (!clientDelete) {
      const photo = await firestoreGet(env, uid, `photos/${id}`, idToken);
      if (photo && botToken && channelId && photo.telegramChunks) {
        for (const chunk of photo.telegramChunks) {
          try {
            await fetch(`https://api.telegram.org/bot${botToken}/deleteMessage`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ chat_id: channelId, message_id: chunk.message_id }),
            });
          } catch { /* best effort */ }
        }
      }
    }
    await firestoreDelete(env, uid, `photos/${id}`, idToken);
  }
  return json({});
}

async function handleBulkUpdate(request: Request, env: Env, uid: string, idToken: string): Promise<Response> {
  const body = await request.json() as any;
  const ids: string[] = body.ids || [];
  const updates: Record<string, any> = {};
  if (body.isFavorite !== undefined) updates.isFavorite = body.isFavorite;
  if (body.visibility !== undefined) updates.visibility = body.visibility;
  if (body.isTrashed !== undefined) updates.isTrashed = body.isTrashed;

  for (const id of ids) {
    if (Object.keys(updates).length > 0) {
      await firestoreSet(env, uid, `photos/${id}`, updates, idToken);
    }
  }
  return json({});
}

// ── Upload ──────────────────────────────────────────────────────────

async function handleUpload(request: Request, env: Env, uid: string, idToken: string): Promise<Response> {
  const flags = await getFlagsForUser(env, uid, idToken);
  if (!flags.directBytePath) {
    return json({ message: 'Direct upload path is disabled by feature flag' }, 503);
  }
  const config = await firestoreGet(env, uid, 'config/telegram', idToken);
  if (!config) {
    console.log('Upload failed: Telegram not configured for uid', uid);
    return json({ message: 'Telegram not configured' }, 400);
  }
  const botToken = config.botToken || config.bot_token;
  const channelId = config.channelId || config.channel_id;
  if (!botToken || !channelId) {
    console.log('Upload failed: Missing bot/channel config for uid', uid);
    return json({ message: 'Missing bot/channel config' }, 400);
  }

    const formData = await request.formData();
    const uploadSessionId = (formData.get('uploadSessionId') as string) || '';
    if (uploadSessionId) {
      const sessionRecord = await firestoreGet(env, uid, `sessions/${uploadSessionId}`, idToken);
      if (!sessionRecord || sessionRecord.status !== 'active') {
        return json({ message: 'Invalid upload session' }, 400);
      }
      if (sessionRecord.expiresAt && Date.parse(sessionRecord.expiresAt) < Date.now()) {
        return json({ message: 'Upload session expired' }, 401);
      }
    }
  const clientUpload = formData.get('clientUpload') === 'true';
  console.log(`[Upload] UID: ${uid}, ClientUpload: ${clientUpload}, Name: ${formData.get('fileName')}`);
  const file = formData.get('assetData') as File | null;
  
  if (!file && !clientUpload) {
    console.log('Upload failed: No file provided in formData keys:', Array.from(formData.keys()));
    return json({ message: 'No file provided' }, 400);
  }

  try {
    const zkeConfig = await firestoreGet(env, uid, 'config/zke', idToken) || {};
    const isClientZke = zkeConfig.mode === 'client' || request.url.includes('client=true') || clientUpload;
    const isServerZke = !isClientZke; // Default to server mode

    const key = isServerZke ? await getEncryptionKey(env, uid, idToken) : null;
    const isEncryptedByServer = key !== null;
    
    const checksumFromHeader = request.headers.get('x-immich-checksum');
    const checksum = (formData.get('checksum') as string) || (formData.get('xImmichChecksum') as string) || checksumFromHeader || '';
    
    // Parse dimensions
    let width = parseInt(formData.get('width') as string) || 0;
    let height = parseInt(formData.get('height') as string) || 0;
    const fileCreatedAt = (formData.get('fileCreatedAt') as string) || new Date().toISOString();
    const fileModifiedAt = (formData.get('fileModifiedAt') as string) || new Date().toISOString();
    const durationRaw = formData.get('duration') ? (formData.get('duration') as string) : null;
    const duration = (!durationRaw || durationRaw === '0' || durationRaw === '0.000' || durationRaw === '0:00:00.00000') ? null : durationRaw;
    
    const fileSize = file ? file.size : parseInt(formData.get('fileSize') as string) || 0;
    const fileName = file ? file.name : (formData.get('fileName') as string) || 'unknown';
    const mimeType = file ? file.type : (formData.get('mimeType') as string) || 'application/octet-stream';
    const isHeic = /\.(heic|heif)$/i.test(fileName) || mimeType === 'image/heic' || mimeType === 'image/heif';

    let telegramChunks: Array<{ index: number; message_id: number; file_id: string }> = [];
    let telegramOriginalId = '';
    let telegramThumbId: string | null = null;
    let thumbFileId: string | null = null;
    let encryptionMode = isEncryptedByServer ? 'server' : 'off';

    if (clientUpload) {
        // Client already uploaded to Telegram
        telegramChunks = JSON.parse((formData.get('telegramChunks') as string) || '[]');
        telegramOriginalId = formData.get('telegramOriginalId') as string;
        telegramThumbId = formData.get('telegramThumbId') as string || null;
        encryptionMode = formData.get('encryptionMode') as string || 'off';
    } else {
        // --- Legacy Server-Side Upload Logic ---
        const totalChunks = Math.ceil(fileSize / CHUNK_SIZE);
    for (let i = 0; i < totalChunks; i++) {
      const start = i * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, fileSize);
      
      // CRITICAL: Slice the file instead of reading the whole thing into memory
      const chunk = file.slice(start, end);
      let chunkData = await chunk.arrayBuffer();

      if (i === 0 && (width === 0 || height === 0)) {
        try {
          const buffer = new Uint8Array(chunkData);
          const dimensions = sizeOf(buffer);
          if (dimensions) {
            width = dimensions.width || 0;
            height = dimensions.height || 0;
          }
        } catch (e) {
          console.log('Failed to extract dimensions:', e);
        }
      }

      if (isEncryptedByServer) {
        chunkData = await encryptChunk(chunkData, key);
      }

      let partName: string;
      if (isEncryptedByServer || isClientZke) {
        partName = totalChunks === 1 ? 'blob.bin' : `blob.bin.part${String(i + 1).padStart(3, '0')}`;
      } else {
        partName = totalChunks === 1 ? fileName : `${fileName}.part${String(i + 1).padStart(3, '0')}`;
      }

      const tgForm = new FormData();
      tgForm.append('chat_id', channelId);
      tgForm.append('document', new Blob([chunkData], { type: 'application/octet-stream' }), partName);

      const tgRes = await fetch(`https://api.telegram.org/bot${botToken}/sendDocument`, { method: 'POST', body: tgForm });
      const data = await tgRes.json() as any;
      if (!data.ok) throw new Error(`Telegram upload chunk ${i}: ${data.description}`);

      telegramChunks.push({ index: i, message_id: data.result.message_id, file_id: data.result.document.file_id });
    }

    // Thumbnail generation (skip if encrypted, to preserve zero-knowledge)
    thumbFileId = null;
    const thumbData = formData.get('thumbData') as File;
    const thumbBase64 = formData.get('thumbData_base64') as string;

    if ((thumbData || thumbBase64) && !isEncryptedByServer && !isClientZke) {
      try {
        let thumbBuffer: ArrayBuffer;
        if (thumbData) {
          thumbBuffer = await thumbData.arrayBuffer();
        } else {
          thumbBuffer = Uint8Array.from(atob(thumbBase64), c => c.charCodeAt(0)).buffer;
        }
        
        const tgForm = new FormData();
        tgForm.append('chat_id', channelId);
        tgForm.append('photo', new Blob([thumbBuffer], { type: 'image/jpeg' }), 'thumb.jpg');
        const tgRes = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, { method: 'POST', body: tgForm });
        const data = await tgRes.json() as any;
        if (data.ok) {
          const photos = data.result.photo;
          thumbFileId = photos[photos.length - 1].file_id;
        }
      } catch { /* ignore */ }
    } else if (!isEncryptedByServer && !isClientZke && mimeType.startsWith('image/') && !isHeic && fileSize < 20 * 1024 * 1024) {
      try {
        const fullFile = await file.arrayBuffer();
        const tgForm = new FormData();
        tgForm.append('chat_id', channelId);
        tgForm.append('photo', new Blob([fullFile], { type: mimeType }), 'thumb.jpg');
        const tgRes = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, { method: 'POST', body: tgForm });
        const data = await tgRes.json() as any;
        if (data.ok) {
          const photos = data.result.photo;
          thumbFileId = photos[photos.length > 1 ? 1 : 0].file_id;
        }
      } catch { /* ignore */ }
    }
    
    } // End of else block for Legacy Server-Side Upload Logic
    
    const assetId = crypto.randomUUID();
    const now = new Date().toISOString();
    const singleFileId = telegramChunks.length === 1 ? telegramChunks[0].file_id : null;

    const metadata: Record<string, any> = {
      originalFileName: fileName,
      type: mimeType.startsWith('video') ? 'VIDEO' : 'IMAGE',
      mimeType,
      checksum,
      fileSize,
      width,
      height,
      ratio: (width && height) ? (width / height) : 1,
      fileCreatedAt,
      fileModifiedAt,
      uploadedAt: now,
      localOffsetHours: 0,
      isFavorite: false,
      isTrashed: false,
      visibility: 'timeline',
      encrypted: encryptionMode !== 'off',
      encryptionMode,
      telegramOriginalId: telegramOriginalId || singleFileId,
      telegramThumbId: telegramThumbId || thumbFileId || singleFileId,
      telegramChunks,
      totalChunks: telegramChunks.length,
      isHeic,
      albumIds: [],
      tags: [],
      duration,
      uploaded: true,
    };
    metadata.id = assetId;
    const normalized = normalizePhotoManifest(uid, assetId, metadata);
    await firestoreSet(env, uid, `photos/${assetId}`, { ...metadata, ...normalized }, idToken);
    return json(toAssetResponseDto({ ...metadata, ...normalized }, uid), 201);
  } catch (error: any) {
    return json({ message: 'Upload failed: ' + error.message }, 500);
  }
}

async function handleUploadPlan(request: Request, env: Env, uid: string, idToken: string): Promise<Response> {
  const body = await request.json() as any;
  const uploadSessionId = body.uploadSessionId as string;
  if (!uploadSessionId) return json({ message: 'uploadSessionId is required' }, 400);
  const sessionRecord = await firestoreGet(env, uid, `sessions/${uploadSessionId}`, idToken);
  if (!sessionRecord || sessionRecord.status !== 'active') {
    return json({ message: 'Invalid upload session' }, 400);
  }
  if (sessionRecord.expiresAt && Date.parse(sessionRecord.expiresAt) < Date.now()) {
    return json({ message: 'Upload session expired' }, 401);
  }

  const cfg = await firestoreGet(env, uid, 'config/telegram', idToken);
  if (!cfg) return json({ message: 'Telegram not configured' }, 400);
  const botToken = cfg.botToken || cfg.bot_token;
  const channelId = cfg.channelId || cfg.channel_id;
  if (!botToken || !channelId) return json({ message: 'Missing bot/channel config' }, 400);

  return json({
    mode: 'direct_telegram',
    uploadSessionId,
    chatId: channelId,
    sendDocumentEndpoint: `https://api.telegram.org/bot${botToken}/sendDocument`,
    completeEndpoint: `/api/policy/upload-session/${uploadSessionId}/complete`,
    finalizeEndpoint: '/api/assets/finalize-client-upload',
  });
}

async function handleFinalizeClientUpload(request: Request, env: Env, uid: string, idToken: string): Promise<Response> {
  const body = await request.json() as any;
  const uploadSessionId = String(body.uploadSessionId || '');
  const assetId = String(body.assetId || crypto.randomUUID());
  const telegramChunks = Array.isArray(body.telegramChunks) ? body.telegramChunks : [];
  if (!uploadSessionId) return json({ message: 'uploadSessionId is required' }, 400);
  if (telegramChunks.length === 0) return json({ message: 'telegramChunks is required' }, 400);

  const sessionRecord = await firestoreGet(env, uid, `sessions/${uploadSessionId}`, idToken);
  if (!sessionRecord || sessionRecord.status !== 'active') return json({ message: 'Invalid upload session' }, 400);
  if (sessionRecord.assetId && body.assetId && sessionRecord.assetId !== body.assetId) {
    return json({ message: 'assetId mismatch for upload session' }, 409);
  }

  const now = new Date().toISOString();
  const normalized = normalizePhotoManifest(uid, assetId, {
    originalFileName: body.fileName || 'unknown',
    type: (body.mimeType || '').startsWith('video') ? 'VIDEO' : 'IMAGE',
    mimeType: body.mimeType || 'application/octet-stream',
    checksum: body.checksum || '',
    fileSize: Number(body.fileSize || 0),
    width: Number(body.width || 0),
    height: Number(body.height || 0),
    fileCreatedAt: body.fileCreatedAt || now,
    fileModifiedAt: body.fileModifiedAt || now,
    uploadedAt: now,
    isFavorite: false,
    isTrashed: false,
    visibility: 'timeline',
    encrypted: body.encryptionMode !== 'off',
    encryptionMode: body.encryptionMode || 'off',
    telegramOriginalId: body.telegramOriginalId || telegramChunks[0]?.file_id || null,
    telegramThumbId: body.telegramThumbId || telegramChunks[0]?.file_id || null,
    telegramChunks,
    totalChunks: telegramChunks.length,
    isHeic: Boolean(body.isHeic),
    albumIds: body.albumIds || [],
    tags: body.tags || [],
    duration: body.duration || null,
    uploaded: true,
    state: 'finalized',
    previewManifest: Array.isArray(body.previewManifest) ? body.previewManifest : [],
  });

  await firestoreSet(env, uid, `photos/${assetId}`, { ...normalized, id: assetId }, idToken);
  await firestoreSet(env, uid, `sessions/${uploadSessionId}`, { status: 'completed', completedAt: now }, idToken);
  return json(toAssetResponseDto({ ...normalized, id: assetId }, uid), 201);
}

async function handleChunkManifest(env: Env, uid: string, assetId: string, idToken: string): Promise<Response> {
  const photo = await firestoreGet(env, uid, `photos/${assetId}`, idToken);
  if (!photo) return json({ message: 'Asset not found' }, 404);
  return json({
    assetId,
    totalChunks: Array.isArray(photo.telegramChunks) ? photo.telegramChunks.length : 0,
    telegramChunks: Array.isArray(photo.telegramChunks) ? photo.telegramChunks : [],
    encryptionMode: photo.encryptionMode || 'off',
    checksum: photo.checksum || null,
    fileSize: photo.fileSize || 0,
  });
}

// ── Request Queue for Telegram API Rate Limits ─────────
class RequestQueue {
  private active = 0;
  private queue: ((value: void) => void)[] = [];

  async acquire(signal?: AbortSignal) {
    if (this.active >= 15) {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          this.queue = this.queue.filter(cb => cb !== resolve);
          reject(new Error('Aborted'));
        };
        if (signal) {
          if (signal.aborted) return cleanup();
          signal.addEventListener('abort', cleanup, { once: true });
        }
        this.queue.push(() => {
          if (signal) signal.removeEventListener('abort', cleanup);
          resolve();
        });
      });
    }
    this.active++;
  }

  release() {
    this.active--;
    if (this.queue.length > 0) {
      const next = this.queue.shift();
      next?.();
    }
  }
}
const tgQueues = new Map<string, RequestQueue>();
function getTgQueue(botToken: string): RequestQueue {
  if (!tgQueues.has(botToken)) {
    tgQueues.set(botToken, new RequestQueue());
  }
  return tgQueues.get(botToken)!;
}

// ── Streaming Download ──────────────────────────────────────────────

async function handleThumbnail(request: Request, env: Env, uid: string, assetId: string, idToken: string): Promise<Response> {
  // Check Cloudflare Cache API first
  const cache = caches.default;
  const cachedResponse = await cache.match(request);
  if (cachedResponse) {
    return cachedResponse;
  }

  const photo = await firestoreGet(env, uid, `photos/${assetId}`, idToken);
  if (!photo) return json({ message: 'Not found' }, 404);

  const config = await firestoreGet(env, uid, 'config/telegram', idToken);
  if (!config) return json({ message: 'No config' }, 500);
  const botToken = config.botToken || config.bot_token;

  let fileId = photo.telegramThumbId;
  if (!fileId) {
    fileId = photo.telegramOriginalId || (photo.telegramChunks && photo.telegramChunks.length > 0 ? photo.telegramChunks[0].file_id : null);
  }
  if (!fileId) return json({ message: 'No file data' }, 404);

  const isServerZke = photo.encryptionMode === 'server' || (photo.encrypted === true && !photo.encryptionMode);
  const isClientZke = photo.encryptionMode === 'client';

  const key = isServerZke ? await getEncryptionKey(env, uid, idToken) : null;
  let mimeType = photo.mimeType;
  if (photo.isHeic) mimeType = 'image/heic';
  if (photo.telegramThumbId && !isServerZke && !isClientZke) mimeType = 'image/jpeg';

  const queue = getTgQueue(botToken);
  try {
    await queue.acquire(request.signal);
  } catch (e) {
    return new Response('Aborted', { status: 499 });
  }

  try {
    const fileRes = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`);
    const fileData = await fileRes.json() as any;
    if (!fileData.ok) return json({ message: 'Failed to get file' }, 500);

    const downloadUrl = `https://api.telegram.org/file/bot${botToken}/${fileData.result.file_path}`;
    const imgRes = await fetch(downloadUrl);
    if (!imgRes.ok) return json({ message: 'Download failed' }, 500);

    let finalResponse: Response;

    if (isServerZke && key) {
      try {
        let data = await imgRes.arrayBuffer();
        data = await decryptChunk(data, key);
        finalResponse = new Response(data, {
          headers: {
            'Content-Type': mimeType || 'application/octet-stream',
            'Cache-Control': 'public, max-age=31536000, immutable',
          }
        });
      } catch (e) {
        return json({ message: 'Decryption failed' }, 500);
      }
    } else {
      finalResponse = new Response(imgRes.body, {
        headers: {
          'Content-Type': mimeType || 'application/octet-stream',
          'Cache-Control': 'public, max-age=31536000, immutable',
        },
      });
    }

    if (finalResponse.status === 200) {
      env.waitUntil?.(cache.put(request, finalResponse.clone()));
    }
    return finalResponse;
  } finally {
    queue.release();
  }
}

async function handleOriginal(request: Request, env: Env, uid: string, assetId: string, idToken: string): Promise<Response> {
  const photo = await firestoreGet(env, uid, `photos/${assetId}`, idToken);
  if (!photo) return json({ message: 'Not found' }, 404);

  const config = await firestoreGet(env, uid, 'config/telegram', idToken);
  if (!config) return json({ message: 'No config' }, 500);
  const botToken = config.botToken || config.bot_token;

  const isServerZke = photo.encryptionMode === 'server' || (photo.encrypted === true && !photo.encryptionMode);
  const isClientZke = photo.encryptionMode === 'client';
  const key = isServerZke ? await getEncryptionKey(env, uid, idToken) : null;

  const rangeHeader = request.headers.get('Range');
  const totalSize = photo.fileSize || 0;
  
  if (photo.telegramChunks && photo.telegramChunks.length > 0) {
    const chunks = [...photo.telegramChunks].sort((a, b) => a.index - b.index);
    
    const stream = new ReadableStream({
      async start(controller) {
        for (const chunk of chunks) {
          try {
            const queue = getTgQueue(botToken);
            await queue.acquire();
            let fileData: any;
            try {
              const fileRes = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${chunk.file_id}`);
              fileData = await fileRes.json() as any;
            } finally {
              queue.release();
            }
            if (!fileData.ok) throw new Error('Failed to get file path');
            
            const downloadUrl = `https://api.telegram.org/file/bot${botToken}/${fileData.result.file_path}`;
            const imgRes = await fetch(downloadUrl);
            if (!imgRes.ok) throw new Error('Download failed');
            
            let chunkData = await imgRes.arrayBuffer();
            if (isServerZke && key) {
               chunkData = await decryptChunk(chunkData, key);
            }
            controller.enqueue(new Uint8Array(chunkData));
          } catch (e) {
            console.error('Error fetching chunk', e);
            controller.error(e);
            return;
          }
        }
        controller.close();
      }
    });

    const headers: Record<string, string> = {
      'Content-Type': photo.mimeType || 'application/octet-stream',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=86400, immutable',
    };

    if (rangeHeader && totalSize > 0) {
        const parts = rangeHeader.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : totalSize - 1;
        headers['Content-Range'] = `bytes ${start}-${end}/${totalSize}`;
        headers['Content-Length'] = (end - start + 1).toString();
        return new Response(stream, { status: 206, headers });
    } else {
        headers['Content-Length'] = totalSize.toString() || '';
        return new Response(stream, { status: 200, headers });
    }
  }

  let fileId = photo.telegramOriginalId;
  if (!fileId) return json({ message: 'No file data' }, 404);
  
  const queue = getTgQueue(botToken);
  await queue.acquire();
  let fileData: any;
  try {
    const fileRes = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`);
    fileData = await fileRes.json() as any;
  } finally {
    queue.release();
  }
  if (!fileData.ok) return json({ message: 'Failed to get file' }, 500);
  
  const downloadUrl = `https://api.telegram.org/file/bot${botToken}/${fileData.result.file_path}`;
  const imgRes = await fetch(downloadUrl);
  
  const headers: Record<string, string> = {
    'Content-Type': photo.mimeType || 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=86400, immutable',
  };

  if (rangeHeader && totalSize > 0) {
      const parts = rangeHeader.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : totalSize - 1;
      headers['Content-Range'] = `bytes ${start}-${end}/${totalSize}`;
      headers['Content-Length'] = (end - start + 1).toString();
  } else {
      headers['Content-Length'] = totalSize.toString() || '';
  }
  
  if (isServerZke && key) {
      let data = await imgRes.arrayBuffer();
      data = await decryptChunk(data, key);
      
      if (rangeHeader && totalSize > 0) {
          const parts = rangeHeader.replace(/bytes=/, "").split("-");
          const start = parseInt(parts[0], 10);
          const end = parts[1] ? parseInt(parts[1], 10) : totalSize - 1;
          const sliced = data.slice(start, end + 1);
          return new Response(sliced, { status: 206, headers });
      }
      return new Response(data, { headers });
  }

  if (rangeHeader && totalSize > 0) {
      return new Response(imgRes.body, { status: 206, headers });
  }
  return new Response(imgRes.body, { status: 200, headers });
}

function toAssetResponseDto(photo: any, ownerId: string): any {
  const id = photo.id;
  const mimeType = photo.mimeType || 'image/jpeg';
  const isHeic = photo.isHeic || mimeType === 'image/heic' || mimeType === 'image/heif';
  const reportedMime = isHeic ? 'image/jpeg' : mimeType;

  return {
    id,
    type: photo.type || 'IMAGE',
    originalFileName: photo.originalFileName || 'unknown',
    originalMimeType: reportedMime,
    originalPath: `/upload/${id}`,
    fileCreatedAt: photo.fileCreatedAt || photo.uploadedAt || new Date().toISOString(),
    fileModifiedAt: photo.uploadedAt || new Date().toISOString(),
    localDateTime: photo.fileCreatedAt || new Date().toISOString(),
    updatedAt: photo.uploadedAt || new Date().toISOString(),
    isFavorite: photo.isFavorite || false,
    isArchived: photo.visibility === 'archive',
    isTrashed: photo.isTrashed || false,
    isOffline: false,
    isEdited: false,
    hasMetadata: true,
    duration: (!photo.duration || photo.duration === '0' || photo.duration === '0.000' || photo.duration === '0:00:00.00000') ? null : photo.duration,
    ownerId,
    thumbhash: photo.thumbhash || null,
    visibility: photo.visibility || 'timeline',
    exifInfo: {
      make: null, model: null, exifImageWidth: photo.width || 0, exifImageHeight: photo.height || 0,
      fileSizeInByte: photo.fileSize || 0, orientation: null, dateTimeOriginal: photo.fileCreatedAt || null,
      modifyDate: null, timeZone: null, lensModel: null, fNumber: null, focalLength: null,
      iso: null, exposureTime: null, latitude: null, longitude: null, city: photo.city || null,
      state: null, country: photo.country || null, description: photo.description || null,
      projectionType: null, rating: null,
    },
    people: [], tags: [], stack: null, livePhotoVideoId: null,
    unassignedFaces: [], duplicateId: null, checksum: '', libraryId: null, profileImagePath: '',
    // --- DaemonClient Drive Metadata ---
    telegramFileId: photo.telegramThumbId || photo.telegramOriginalId,
    telegramOriginalId: photo.telegramOriginalId,
    telegramChunks: photo.telegramChunks,
    encryptionMode: photo.encryptionMode || (photo.encrypted ? 'server' : 'off'),
    isHeic: photo.isHeic,
  };
}

