import type { Env } from './index';
import { requireAuth, firestoreGet, firestoreSet, firestoreDelete, firestoreQuery, json } from './helpers';
import sizeOf from 'image-size';
import { normalizePhotoManifest } from './contracts';
import { getFlagsForUser } from './feature-flags';
import { D1Adapter } from './d1-adapter';

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
  if (env.DB) {
    const adapter = new D1Adapter(env.DB);
    const zkeConfig = await adapter.getZkeConfig();
    if (zkeConfig && zkeConfig.enabled && zkeConfig.password && zkeConfig.salt) {
      return deriveKey(zkeConfig.password, zkeConfig.salt);
    }
  } else {
    const zkeConfig = await firestoreGet(env, uid, 'config/zke', idToken);
    if (zkeConfig && zkeConfig.enabled && zkeConfig.password && zkeConfig.salt) {
      return deriveKey(zkeConfig.password, zkeConfig.salt);
    }
  }
  return null;
}

export async function handleAssets(request: Request, env: Env, path: string, url: URL): Promise<Response> {
  const session = await requireAuth(request, env);
  const uid = session.uid;
  const idToken = session.idToken;

  try {
  if (path === '/api/assets/zke-status' && request.method === 'GET') {
    if (env.DB) {
      const adapter = new D1Adapter(env.DB);
      const zkeConfig = await adapter.getZkeConfig();
      return json({ mode: zkeConfig?.mode || 'off', enabled: !!zkeConfig?.enabled });
    } else {
      const zkeConfig = await firestoreGet(env, uid, 'config/zke', idToken) || {};
      return json({ mode: zkeConfig.mode || 'off', enabled: !!zkeConfig.enabled });
    }
  }

  if (path === '/api/assets/zke-toggle' && request.method === 'POST') {
    const body = await request.json() as any;
    const mode = body.mode === 'server' ? 'server' : 'off';
    const enabled = mode === 'server';

    if (env.DB) {
      const adapter = new D1Adapter(env.DB);
      if (enabled) {
        const existing = await adapter.getZkeConfig();
        if (existing?.password && existing?.salt) {
          await adapter.setZkeConfig({ mode, enabled });
        } else {
          const salt = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
          const password = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
          await adapter.setZkeConfig({ mode, enabled, password, salt });
        }
      } else {
        await adapter.setZkeConfig({ mode, enabled });
      }
    } else {
      if (enabled) {
        const existing = await firestoreGet(env, uid, 'config/zke', idToken);
        if (existing?.password && existing?.salt) {
          await firestoreSet(env, uid, 'config/zke', { mode, enabled }, idToken);
        } else {
          const salt = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
          const password = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
          await firestoreSet(env, uid, 'config/zke', { mode, enabled, password, salt }, idToken);
        }
      } else {
        await firestoreSet(env, uid, 'config/zke', { mode, enabled }, idToken);
      }
    }

    return json({ mode, enabled });
  }

  let resourceId: string | null = null;
  const assetsMatch = path.match(/^\/api\/assets\/([^/]+)/);
  const assetMatch = path.match(/^\/api\/asset\/(?:file|thumbnail|video\/playback)\/([^/]+)/);
  
  if (assetsMatch) {
    resourceId = assetsMatch[1];
  } else if (assetMatch) {
    resourceId = assetMatch[1];
  }

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
  const chunkManifestMatch = path.match(/^\/api\/assets\/([^/]+)\/chunk-manifest$/);
  if (chunkManifestMatch && request.method === 'GET') {
    return handleChunkManifest(env, uid, chunkManifestMatch[1], idToken);
  }
  const thumbUploadMatch = path.match(/^\/api\/assets\/([^/]+)\/thumbnail$/);
  if (thumbUploadMatch && request.method === 'POST') {
    return handleThumbnailUpload(request, env, uid, thumbUploadMatch[1], idToken);
  }

  if (path === '/api/assets/worker-config' && request.method === 'GET') {
    const workerConfig = await firestoreGet(env, uid, 'config/worker', idToken);
    return json({ url: workerConfig?.url || null });
  }
  
  return json({ message: 'Asset endpoint not found' }, 404);
} catch (err: any) {
    console.error(`[handleAssets] Error at ${path}:`, err?.message, err?.stack);
    if (err?.message?.includes('authenticated') || err?.message?.includes('expired')) {
      return json({ message: err.message }, 401);
    }
    return json({ message: `Internal error: ${err?.message}` }, 500);
}
}

// ── Handlers ────────────────────────────────────────────────────────

async function handleAssetInfo(env: Env, uid: string, assetId: string, idToken: string): Promise<Response> {
  try {
    let photo;
    if (env.DB) {
      const adapter = new D1Adapter(env.DB);
      photo = await adapter.getPhoto(assetId);
    } else {
      photo = await firestoreGet(env, uid, `photos/${assetId}`, idToken);
    }

    if (!photo) {
      return json({ message: 'Asset not found' }, 404);
    }
    photo.id = assetId;
    return json(toAssetResponseDto(photo, uid));
  } catch (err: any) {
    console.error(`[handleAssetInfo] Error for ${assetId}:`, err?.message);
    return json({ message: `Error fetching asset: ${err?.message}` }, 500);
  }
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
    if (env.DB) {
      const adapter = new D1Adapter(env.DB);
      await adapter.savePhoto({ id: assetId, ...updates });
    } else {
      await firestoreSet(env, uid, `photos/${assetId}`, updates, idToken);
    }
  }

  let photo;
  if (env.DB) {
    const adapter = new D1Adapter(env.DB);
    photo = await adapter.getPhoto(assetId);
  } else {
    photo = await firestoreGet(env, uid, `photos/${assetId}`, idToken);
  }

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
      let photo;
      if (env.DB) {
        const adapter = new D1Adapter(env.DB);
        photo = await adapter.getPhoto(id);
      } else {
        photo = await firestoreGet(env, uid, `photos/${id}`, idToken);
      }

      if (photo && botToken && channelId && photo.telegramChunks) {
        const chunks = typeof photo.telegramChunks === 'string'
          ? JSON.parse(photo.telegramChunks)
          : photo.telegramChunks;

        for (const chunk of chunks) {
          try {
            await fetch(`https://api.telegram.org/bot${botToken}/deleteMessage`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ chat_id: channelId, message_id: chunk.message_id }),
            });
          } catch { /* best effort */ }
        }
      }
    }

    if (env.DB) {
      const adapter = new D1Adapter(env.DB);
      await adapter.deletePhoto(id);
    } else {
      await firestoreDelete(env, uid, `photos/${id}`, idToken);
    }
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

  if (Object.keys(updates).length > 0) {
    if (env.DB) {
      const adapter = new D1Adapter(env.DB);
      for (const id of ids) {
        await adapter.savePhoto({ id, ...updates });
      }
    } else {
      for (const id of ids) {
        await firestoreSet(env, uid, `photos/${id}`, updates, idToken);
      }
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
  const formKeys = Array.from(formData.keys());
  console.log(`[Upload] UID: ${uid}, ClientUpload: ${clientUpload}, Name: ${formData.get('fileName') || formData.get('filename')}, Keys: ${formKeys.join(',')}`);
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
    let mimeType = file ? file.type : (formData.get('mimeType') as string) || 'application/octet-stream';

    // Fix MIME type detection based on file extension if missing or generic
    if (!mimeType || mimeType === 'application/octet-stream' || mimeType === 'video/quicktime') {
      const ext = fileName.toLowerCase().split('.').pop();
      if (ext === 'mp4') mimeType = 'video/mp4';
      else if (ext === 'mov' || ext === 'qt') mimeType = 'video/quicktime';
      else if (ext === 'avi') mimeType = 'video/x-msvideo';
      else if (ext === 'webm') mimeType = 'video/webm';
      else if (ext === 'mkv') mimeType = 'video/x-matroska';
      else if (ext === 'heic' || ext === 'heif') mimeType = 'image/heic';
      else if (ext === 'jpg' || ext === 'jpeg') mimeType = 'image/jpeg';
      else if (ext === 'png') mimeType = 'image/png';
      else if (ext === 'webp') mimeType = 'image/webp';
    }

    const isHeic = /\.(heic|heif)$/i.test(fileName) || mimeType === 'image/heic' || mimeType === 'image/heif';
    const thumbBase64 = formData.get('thumbData_base64') as string | null;

    // CRITICAL DEBUG: Check if mobile sends thumbnail
    if (thumbBase64) {
      console.log(`✅ [Upload] thumbData_base64 PRESENT: ${thumbBase64.length} chars for ${fileName}`);
    } else {
      console.log(`❌ [Upload] thumbData_base64 MISSING for ${fileName}. Keys received: ${formKeys.join(', ')}`);
    }

    let telegramChunks: Array<{ index: number; message_id: number; file_id: string }> = [];
    let telegramOriginalId = '';
    let telegramThumbId: string | null = null;
    let encryptionMode = isEncryptedByServer ? 'server' : 'off';
    let thumbEncrypted = false;
    let pendingThumbGen: any = null;

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

      const tgFormData = new FormData();
      tgFormData.append('chat_id', channelId);
      tgFormData.append('document', new Blob([chunkData], { type: 'application/octet-stream' }), partName);

      const queue = getTgQueue(botToken);
      await queue.acquire(undefined, 1); // Priority 1 for uploads (low)
      let tgRes: Response;
      let tgData: any;
      try {
        tgRes = await fetch(`https://api.telegram.org/bot${botToken}/sendDocument`, {
          method: 'POST', body: tgFormData,
        });
        tgData = await tgRes.json() as any;
      } catch (err: any) {
        queue.release();
        console.error(`[Upload] Telegram API error on chunk ${i}:`, err);

        // Cleanup: delete already-uploaded chunks
        for (const chunk of telegramChunks) {
          try {
            await fetch(`https://api.telegram.org/bot${botToken}/deleteMessage`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ chat_id: channelId, message_id: chunk.message_id }),
            });
          } catch { /* best effort cleanup */ }
        }

        return json({
          message: 'Telegram upload failed',
          error: err.message,
          chunksUploaded: i,
          totalChunks
        }, 500);
      } finally {
        queue.release();
      }

      if (!tgData.ok) {
        console.error('Telegram upload failed:', tgData);

        // Cleanup: delete already-uploaded chunks
        for (const chunk of telegramChunks) {
          try {
            await fetch(`https://api.telegram.org/bot${botToken}/deleteMessage`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ chat_id: channelId, message_id: chunk.message_id }),
            });
          } catch { /* best effort cleanup */ }
        }

        return json({
          message: 'Telegram upload failed',
          details: tgData,
          chunksUploaded: i,
          totalChunks
        }, 500);
      }
      
      const msg = tgData.result;
      const fileId = msg.document.file_id;
      if (totalChunks === 1) {
        telegramOriginalId = fileId;
      } else {
        telegramChunks.push({ index: i, message_id: msg.message_id, file_id: fileId });
      }
      // Grab document thumbnail if available (Telegram auto-generates for image/video docs)
      if (!telegramThumbId && msg.document.thumb?.file_id) {
        telegramThumbId = msg.document.thumb.file_id;
        console.log(`[Upload] Got document thumbnail for ${fileName} from sendDocument`);
      }
      if (!telegramThumbId && msg.document.thumbnail?.file_id) {
        telegramThumbId = msg.document.thumbnail.file_id;
        console.log(`[Upload] Got document thumbnail (v2) for ${fileName} from sendDocument`);
      }
    }

    // --- Thumbnail generation ---
    // For ALL uploads: send raw file via sendPhoto/sendVideo to get Telegram-generated thumb
    // This happens REGARDLESS of encryption — thumbs are always unencrypted small JPEGs on Telegram
    // The original file is encrypted separately via sendDocument above
    const isVideo = mimeType.startsWith('video/') && !isHeic;
    const isImage = mimeType.startsWith('image/') || isHeic;
    const isSingleChunk = totalChunks === 1;

    // Strategy 1: Mobile-provided JPEG thumbnail
    if (!telegramThumbId && thumbBase64) {
      try {
        const thumbBytes = Uint8Array.from(atob(thumbBase64), c => c.charCodeAt(0));
        const thumbForm = new FormData();
        thumbForm.append('chat_id', channelId);
        thumbForm.append('photo', new Blob([thumbBytes], { type: 'image/jpeg' }), 'thumb.jpg');

        const queue = getTgQueue(botToken);
        await queue.acquire(undefined, 5);
        try {
          const thumbRes = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, { method: 'POST', body: thumbForm });
          const thumbJson = await thumbRes.json() as any;
          if (thumbJson.ok && thumbJson.result.photo?.length > 0) {
            telegramThumbId = thumbJson.result.photo[0].file_id;
            console.log(`[Upload] Stored mobile thumbnail for ${fileName}`);
          } else {
            console.log(`[Upload] sendPhoto failed for mobile thumb:`, JSON.stringify(thumbJson).slice(0, 200));
          }
        } finally { queue.release(); }
      } catch (e) {
        console.log('[Upload] Mobile thumbnail upload failed:', e);
      }
    }

    // Strategy 2: sendPhoto/sendVideo — ONLY for unencrypted uploads
    // Encrypted uploads must NOT send raw files to Telegram
    if (!telegramThumbId && !isEncryptedByServer && (isImage || isVideo) && isSingleChunk && file) {
      try {
        const rawSlice = file.slice(0, Math.min(file.size, CHUNK_SIZE));
        const rawData = await rawSlice.arrayBuffer();

        const thumbForm = new FormData();
        thumbForm.append('chat_id', channelId);

        const queue = getTgQueue(botToken);
        await queue.acquire(undefined, 5);
        try {
          if (isVideo) {
            thumbForm.append('video', new Blob([rawData], { type: mimeType }), fileName);
            const res = await fetch(`https://api.telegram.org/bot${botToken}/sendVideo`, { method: 'POST', body: thumbForm });
            const j = await res.json() as any;
            telegramThumbId = j.result?.video?.thumb?.file_id || j.result?.video?.thumbnail?.file_id || null;
            if (telegramThumbId) console.log(`[Upload] Generated video thumbnail for ${fileName}`);
          } else {
            thumbForm.append('photo', new Blob([rawData], { type: mimeType }), fileName);
            const res = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, { method: 'POST', body: thumbForm });
            const j = await res.json() as any;
            if (j.ok && j.result.photo?.length > 0) {
              telegramThumbId = j.result.photo[0].file_id;
              console.log(`[Upload] Generated image thumbnail for ${fileName}`);
            } else {
              console.log(`[Upload] sendPhoto failed for ${fileName}:`, JSON.stringify(j).slice(0, 200));
            }
          }
        } finally { queue.release(); }
      } catch (e) {
        console.log('[Upload] Thumbnail generation failed (non-fatal):', e);
      }
    }

    if (!telegramThumbId) {
      console.log(`[Upload] WARNING: No thumbnail generated for ${fileName} (isVideo=${isVideo}, isImage=${isImage}, chunks=${totalChunks}, encrypted=${isEncryptedByServer}, hasThumbBase64=${!!thumbBase64})`);
    }
    }

    const assetId = crypto.randomUUID();
    const photo = {
      id: assetId,
      ownerId: uid,
      fileName,
      fileSize,
      mimeType,
      width,
      height,
      fileCreatedAt,
      uploadedAt: new Date().toISOString(),
      telegramChunks: typeof telegramChunks === 'string' ? telegramChunks : JSON.stringify(telegramChunks),
      telegramOriginalId,
      telegramThumbId,
      thumbEncrypted: thumbEncrypted ? 1 : 0,
      encryptionMode,
      checksum,
      isHeic: isHeic ? 1 : 0,
      duration: duration || undefined
    };

    if (env.DB) {
      const adapter = new D1Adapter(env.DB);
      await adapter.savePhoto(photo);
    } else {
      await firestoreSet(env, uid, `photos/${assetId}`, photo, idToken);
    }

    if (mimeType.startsWith('video/') || isHeic) {
      env.waitUntil?.(linkLivePhoto(env, uid, assetId, photo, idToken));
    }

    return json(toAssetResponseDto(photo, uid));
  } catch (e: any) {
    console.error('Upload handler error:', e?.message, e?.stack);
    return json({ message: 'Internal upload error', error: e?.message }, 500);
  }
}

async function handleUploadPlan(request: Request, env: Env, uid: string, idToken: string): Promise<Response> {
  // Simple pass-through for now
  return json({
    uploadSessionId: crypto.randomUUID(),
    status: 'created'
  });
}

async function handleFinalizeClientUpload(request: Request, env: Env, uid: string, idToken: string): Promise<Response> {
    const body = await request.json() as any;
    const assetId = crypto.randomUUID();
    const photo = {
        ...body,
        id: assetId,
        ownerId: uid,
        uploadedAt: new Date().toISOString(),
    };

    if (env.DB) {
      const adapter = new D1Adapter(env.DB);
      await adapter.savePhoto(photo);
    } else {
      await firestoreSet(env, uid, `photos/${assetId}`, photo, idToken);
    }

    return json(toAssetResponseDto(photo, uid));
}

async function handleChunkManifest(env: Env, uid: string, assetId: string, idToken: string): Promise<Response> {
  const photo = await loadPhotoById(env, uid, assetId, idToken);
  if (!photo) return json({ message: 'Asset not found' }, 404);
  return json({ chunks: photo.telegramChunks || [] });
}

// D1-aware single photo loader. Per-user workers (env.DB bound) read from D1;
// the central worker still falls back to Firestore. The D1 row is normalized
// (telegramChunks JSON parsed, _id/originalFileName aliases) so downstream
// consumers don't need to know which source it came from.
async function loadPhotoById(env: Env, uid: string, assetId: string, idToken: string): Promise<any | null> {
  if (env.DB) {
    const row = await new D1Adapter(env.DB).getPhoto(assetId);
    return row ? D1Adapter.normalizeRow(row) : null;
  }
  return firestoreGet(env, uid, `photos/${assetId}`, idToken);
}

async function handleThumbnailUpload(request: Request, env: Env, uid: string, assetId: string, idToken: string): Promise<Response> {
  const photo = await loadPhotoById(env, uid, assetId, idToken);
  if (!photo) return json({ message: 'Asset not found' }, 404);

  const config = await firestoreGet(env, uid, 'config/telegram', idToken);
  if (!config) return json({ message: 'No config' }, 500);
  const botToken = config.botToken || config.bot_token;
  const channelId = config.channelId || config.channel_id;

  try {
    const formData = await request.formData();
    const thumbFile = formData.get('thumbnail') as File | null;
    const thumbBase64 = formData.get('thumbData_base64') as string | null;

    if (!thumbFile && !thumbBase64) {
      return json({ message: 'No thumbnail data provided' }, 400);
    }

    let thumbBytes: ArrayBuffer;
    if (thumbBase64) {
      thumbBytes = Uint8Array.from(atob(thumbBase64), c => c.charCodeAt(0)).buffer;
    } else {
      thumbBytes = await thumbFile!.arrayBuffer();
    }

    const thumbForm = new FormData();
    thumbForm.append('chat_id', channelId);
    thumbForm.append('photo', new Blob([thumbBytes], { type: 'image/jpeg' }), 'thumb.jpg');

    const queue = getTgQueue(botToken);
    await queue.acquire(undefined, 5);
    let telegramThumbId: string | null = null;
    try {
      const res = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, { method: 'POST', body: thumbForm });
      const data = await res.json() as any;
      if (data.ok && data.result.photo?.length > 0) {
        telegramThumbId = data.result.photo[0].file_id;
      }
    } finally {
      queue.release();
    }

    if (!telegramThumbId) {
      return json({ message: 'Telegram sendPhoto failed' }, 500);
    }

    if (env.DB) {
      await new D1Adapter(env.DB).savePhoto({ id: assetId, telegramThumbId });
    } else {
      await firestoreSet(env, uid, `photos/${assetId}`, { telegramThumbId }, idToken);
    }
    console.log(`[ThumbnailUpload] Successfully stored thumbnail for ${assetId}`);

    return json({ success: true, telegramThumbId });
  } catch (err: any) {
    console.error(`[ThumbnailUpload] Error for ${assetId}:`, err);
    return json({ message: err.message }, 500);
  }
}

// ── Thumbnails & Originals ──────────────────────────────────────────

async function handleThumbnail(request: Request, env: Env, uid: string, assetId: string, idToken: string): Promise<Response> {
  const photo = await loadPhotoById(env, uid, assetId, idToken);
  if (!photo) return json({ message: 'Not found' }, 404);

  const url = new URL(request.url);
  const sizeParam = (url.searchParams.get('size') || '').toLowerCase();
  const wantsHighQuality = sizeParam === 'preview' || sizeParam === 'fullsize';

  const isMultiChunk = photo.telegramChunks && photo.telegramChunks.length > 1;
  let fileId: string;

  if (wantsHighQuality && !isMultiChunk) {
    fileId = photo.telegramOriginalId || photo.telegramThumbId;
  } else {
    fileId = photo.telegramThumbId || photo.telegramOriginalId;
  }

  if (!fileId) {
    return json({ message: 'No file data' }, 404);
  }
  if (isMultiChunk && !photo.telegramThumbId && !wantsHighQuality) {
    return json({ message: 'Thumbnail not available for multi-chunk asset' }, 404);
  }

  const config = await firestoreGet(env, uid, 'config/telegram', idToken);
  if (!config) return json({ message: 'No config' }, 500);
  const botToken = config.botToken || config.bot_token;

  const cache = (caches as any).default;
  const cacheKey = `${request.url}`;
  const cachedRes = await cache.match(cacheKey);
  if (cachedRes) return cachedRes;

  const isServerZke = photo.encryptionMode === 'server' || (photo.encrypted === true && !photo.encryptionMode);
  const isClientZke = photo.encryptionMode === 'client';

  const key = isServerZke ? await getEncryptionKey(env, uid, idToken) : null;
  let mimeType = photo.mimeType;
  if (photo.isHeic) mimeType = 'image/heic';
  const servingThumb = !wantsHighQuality && fileId === photo.telegramThumbId;
  if (servingThumb) {
    // Thumbnails are always JPEG (either Telegram-generated or mobile-provided)
    mimeType = 'image/jpeg';
  } else if (photo.isHeic) {
    mimeType = 'image/heic';
  }

  const queue = getTgQueue(botToken);
  try {
    await queue.acquire(request.signal, 10); // Priority 10 for thumbnail downloads (high)
  } catch (e) {
    return new Response('Aborted', { status: 499 });
  }

  try {
    const result = await tgDownloadFile(botToken, fileId);
    if (!result.ok) return json({ message: result.error }, 502);

    let responseData = result.data!;
    console.log(`[Thumbnail] Downloaded ${responseData.byteLength} bytes for ${assetId}, isServerZke=${isServerZke}, hasKey=${!!key}, encMode=${photo.encryptionMode}, servingThumb=${servingThumb}`);
    if (isServerZke && key) {
      try {
        responseData = await decryptChunk(responseData, key);
        console.log(`[Thumbnail] Decrypted to ${responseData.byteLength} bytes`);
      } catch (e: any) {
        console.error(`[Thumbnail] Decryption failed for ${assetId}:`, e?.message);
        return json({ message: 'Decryption failed', error: e?.message }, 500);
      }
    }

    const finalResponse = new Response(responseData, {
      headers: {
        'Content-Type': mimeType || 'application/octet-stream',
        'Cache-Control': 'public, max-age=31536000, immutable',
        'CDN-Cache-Control': 'public, max-age=31536000',
        'Cloudflare-CDN-Cache-Control': 'public, max-age=31536000'
      }
    });

    if (finalResponse.status === 200) {
      env.waitUntil?.(cache.put(cacheKey, finalResponse.clone()));
    }
    return finalResponse;
  } finally {
    queue.release();
  }
}

async function handleOriginal(request: Request, env: Env, uid: string, assetId: string, idToken: string): Promise<Response> {
  console.log(`[handleOriginal] AssetID: ${assetId}, Path: ${new URL(request.url).pathname}`);
  const photo = await loadPhotoById(env, uid, assetId, idToken);
  if (!photo) return json({ message: 'Not found' }, 404);

  const config = await firestoreGet(env, uid, 'config/telegram', idToken);
  if (!config) return json({ message: 'No config' }, 500);
  const botToken = config.botToken || config.bot_token;

  const isServerZke = photo.encryptionMode === 'server' || (photo.encrypted === true && !photo.encryptionMode);
  const isClientZke = photo.encryptionMode === 'client';
  const key = isServerZke ? await getEncryptionKey(env, uid, idToken) : null;

  const rangeHeader = request.headers.get('Range');
  const totalSize = photo.fileSize || 0;
  const url = new URL(request.url);
  
  if (photo.telegramChunks && photo.telegramChunks?.length > 0) {
    const chunks = [...photo.telegramChunks].sort((a, b) => a.index - b.index);
    // For range requests: calculate decrypted chunk sizes
    // Each chunk is ~19MB raw. For encrypted files, the stored size differs but decrypted is consistent.
    const chunkSize = CHUNK_SIZE;
    const cache = (caches as any).default;

    // Helper: download + decrypt + cache a single chunk
    const getChunk = async (chunk: any): Promise<ArrayBuffer> => {
      const ck = new Request(`${url.origin}/chunk-cache/${chunk.file_id}`, { method: 'GET' });
      const cached = await cache.match(ck);
      if (cached) return cached.arrayBuffer();

      const queue = getTgQueue(botToken);
      await queue.acquire(undefined, 10);
      let result;
      try { result = await tgDownloadFile(botToken, chunk.file_id); }
      finally { queue.release(); }
      if (!result.ok) throw new Error(result.error);

      let data = result.data!;
      if (isServerZke && key) data = await decryptChunk(data, key);

      env.waitUntil?.(cache.put(ck, new Response(data.slice(0), {
        headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'public, max-age=86400' }
      })));
      return data;
    };

    const headers: Record<string, string> = {
      'Content-Type': photo.mimeType || 'application/octet-stream',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=86400, immutable',
    };

    if (rangeHeader && totalSize > 0) {
      const parts = rangeHeader.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10) || 0;
      const end = parts[1] ? parseInt(parts[1], 10) : totalSize - 1;

      if (isNaN(start) || isNaN(end) || start < 0 || end >= totalSize || start > end) {
        return json({ message: 'Invalid range', requested: `${start}-${end}`, totalSize }, 416);
      }

      // Calculate which chunks we need for this byte range
      const firstChunkIdx = Math.floor(start / chunkSize);
      const lastChunkIdx = Math.min(Math.floor(end / chunkSize), chunks.length - 1);

      // Download only the required chunks and extract the requested bytes
      const parts2: Uint8Array[] = [];
      let bytesCollected = 0;
      const neededBytes = end - start + 1;

      for (let i = firstChunkIdx; i <= lastChunkIdx && bytesCollected < neededBytes; i++) {
        const chunkData = await getChunk(chunks[i]);
        const chunkStart = i * chunkSize;
        const sliceStart = Math.max(start - chunkStart, 0);
        const sliceEnd = Math.min(end - chunkStart + 1, chunkData.byteLength);
        parts2.push(new Uint8Array(chunkData, sliceStart, sliceEnd - sliceStart));
        bytesCollected += sliceEnd - sliceStart;
      }

      const body = new Uint8Array(neededBytes);
      let offset = 0;
      for (const part of parts2) {
        body.set(part, offset);
        offset += part.length;
      }

      headers['Content-Range'] = `bytes ${start}-${end}/${totalSize}`;
      headers['Content-Length'] = neededBytes.toString();
      return new Response(body, { status: 206, headers });
    } else {
      // No range — stream all chunks
      const stream = new ReadableStream({
        async start(controller) {
          for (const chunk of chunks) {
            try {
              const data = await getChunk(chunk);
              controller.enqueue(new Uint8Array(data));
            } catch (e) {
              controller.error(e);
              return;
            }
          }
          controller.close();
        }
      });
      headers['Content-Length'] = (totalSize || '').toString();
      return new Response(stream, { status: 200, headers });
    }
  }

  let fileId = photo.telegramOriginalId;
  if (!fileId) return json({ message: 'No file data' }, 404);
  
  const cache = (caches as any).default;
  const cacheKey = new Request(`${url.origin}/file-cache/${fileId}`, { method: 'GET' });
  let cachedRes = await cache.match(cacheKey);

  let data: ArrayBuffer | null = null;
  if (cachedRes) {
      data = await cachedRes.arrayBuffer();
  } else {
      const queue = getTgQueue(botToken);
      await queue.acquire(undefined, 10); // Priority 10 for original downloads (high)
      let result;
      try {
        result = await tgDownloadFile(botToken, fileId);
      } finally {
        queue.release();
      }
      if (!result.ok) return json({ message: result.error }, 502);
      data = result.data!;

      if (isServerZke && key) {
          data = await decryptChunk(data, key);
      }
      
      const cacheRes = new Response(data, { 
          headers: { 'Content-Type': photo.mimeType || 'application/octet-stream', 'Cache-Control': 'public, max-age=86400' } 
      });
      await cache.put(cacheKey, cacheRes.clone());
  }

  const headers: Record<string, string> = {
    'Content-Type': photo.mimeType || 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=86400, immutable',
  };

  if (rangeHeader && totalSize > 0 && data) {
      const parts = rangeHeader.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10) || 0;
      const end = parts[1] ? parseInt(parts[1], 10) : totalSize - 1;

      // Validate range header
      if (isNaN(start) || isNaN(end) || start < 0 || end >= totalSize || start > end) {
        return json({
          message: 'Invalid range',
          requested: `${start}-${end}`,
          totalSize
        }, 416);
      }

      headers['Content-Range'] = `bytes ${start}-${end}/${totalSize}`;
      headers['Content-Length'] = (end - start + 1).toString();
      const sliced = data.slice(start, end + 1);
      return new Response(sliced, { status: 206, headers });
  } else if (data) {
      headers['Content-Length'] = (totalSize || data.byteLength).toString();
      return new Response(data, { headers });
  }
  
  return json({ message: 'Error processing file' }, 500);
}

function toAssetResponseDto(photo: any, ownerId: string): any {
  const id = photo.id;
  const mimeType = photo.mimeType || 'image/jpeg';
  const isHeic = photo.isHeic || mimeType === 'image/heic' || mimeType === 'image/heif';
  // Report HEIC as HEIC so frontend can handle conversion
  const reportedMime = mimeType;

  // Detect video type — live photos (images with livePhotoVideoId) are always IMAGE
  const isVideo = !photo.livePhotoVideoId && (
    mimeType.startsWith('video/') ||
    photo.type === 'VIDEO'
  );

  // Live photos should not expose duration (prevents GIF treatment in gallery)
  const effectiveDuration = photo.livePhotoVideoId ? null :
    (!photo.duration || photo.duration === '0' || photo.duration === '0.000' || photo.duration === '0:00:00.00000') ? null : photo.duration;

  return {
    id,
    type: isVideo ? 'VIDEO' : 'IMAGE',
    originalFileName: photo.originalFileName || photo.fileName || 'unknown',
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
    duration: effectiveDuration,
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
    people: [], tags: [], stack: null, livePhotoVideoId: photo.livePhotoVideoId || null,
    unassignedFaces: [], duplicateId: null, checksum: '', libraryId: null, profileImagePath: '',
    // --- DaemonClient Drive Metadata ---
    telegramFileId: photo.telegramThumbId || photo.telegramOriginalId,
    telegramOriginalId: photo.telegramOriginalId,
    encryptionMode: photo.encryptionMode || 'off'
  };
}

// --- Telegram Fetch with Retry ---
async function tgFetchWithRetry(url: string, options?: RequestInit, maxRetries = 4): Promise<Response> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(url, options);
    if (res.status === 429 || res.status === 420) {
      const body = await res.json().catch(() => ({})) as any;
      const retryAfter = body?.parameters?.retry_after || 5;
      console.warn(`[tgFetch] 429 on ${url.substring(0, 80)}..., waiting ${retryAfter}s (attempt ${attempt + 1})`);
      await new Promise(r => setTimeout(r, (retryAfter + 1) * 1000));
      continue;
    }
    return res;
  }
  return new Response(JSON.stringify({ ok: false, description: 'Rate limit retries exhausted' }), {
    status: 429, headers: { 'Content-Type': 'application/json' }
  });
}

async function tgGetFileUrl(botToken: string, fileId: string): Promise<{ ok: boolean; url?: string; error?: string }> {
  const res = await tgFetchWithRetry(`https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`);
  const data = await res.json() as any;
  if (!data.ok) return { ok: false, error: data.description || 'getFile failed' };
  return { ok: true, url: `https://api.telegram.org/file/bot${botToken}/${data.result.file_path}` };
}

async function tgDownloadFile(botToken: string, fileId: string): Promise<{ ok: boolean; data?: ArrayBuffer; error?: string }> {
  const fileResult = await tgGetFileUrl(botToken, fileId);
  if (!fileResult.ok) return { ok: false, error: fileResult.error };
  const imgRes = await tgFetchWithRetry(fileResult.url!);
  if (!imgRes.ok) return { ok: false, error: `Download failed: ${imgRes.status}` };
  return { ok: true, data: await imgRes.arrayBuffer() };
}

// --- Request Queue Helper with Priority ---
type QueueItem = { resolve: () => void; reject: (err: Error) => void; priority: number; signal?: AbortSignal };

class RequestQueue {
  private queue: QueueItem[] = [];
  private running = 0;
  constructor(private limit: number) {}

  async acquire(signal?: AbortSignal, priority: number = 0) {
    if (this.running >= this.limit) {
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          const idx = this.queue.findIndex(item => item.resolve === resolve);
          if (idx > -1) this.queue.splice(idx, 1);
          reject(new Error('Aborted'));
        };
        signal?.addEventListener('abort', onAbort, { once: true });

        const item: QueueItem = {
          resolve: () => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
          },
          reject,
          priority,
          signal
        };

        // Insert based on priority (higher priority = front of queue)
        const insertIdx = this.queue.findIndex(q => q.priority < priority);
        if (insertIdx === -1) {
          this.queue.push(item);
        } else {
          this.queue.splice(insertIdx, 0, item);
        }
      });
    }
    this.running++;
  }

  release() {
    this.running--;
    if (this.queue.length > 0) {
      // Always take from front (highest priority)
      const next = this.queue.shift()!;
      next.resolve();
    }
  }
}

const tgQueues: Record<string, RequestQueue> = {};
function getTgQueue(botToken: string): RequestQueue {
  if (!tgQueues[botToken]) tgQueues[botToken] = new RequestQueue(10);
  return tgQueues[botToken];
}

// --- Live Photo Linking ---
async function linkLivePhoto(env: Env, uid: string, assetId: string, photo: any, idToken: string) {
  try {
    const isVideo = photo.mimeType.startsWith('video/');
    const isHeic = photo.isHeic || photo.mimeType === 'image/heic';

    console.log(`[LivePhoto] Processing ${assetId}: isVideo=${isVideo}, isHeic=${isHeic}, mimeType=${photo.mimeType}, fileName=${photo.fileName}`);

    // CRITICAL FIX: Query ONLY recent uploads (within last 5 seconds) using Firestore filter
    // This prevents O(n) query that loads ALL photos
    const fiveSecondsAgo = new Date(Date.now() - 5000).toISOString();
    const recentUploads = await firestoreQuery(
      env, uid, 'photos', idToken,
      'uploadedAt', 'DESCENDING', 20, // Only get last 20 uploads
      [{ field: 'uploadedAt', op: 'GREATER_THAN_OR_EQUAL', value: fiveSecondsAgo }]
    );

    console.log(`[LivePhoto] Found ${recentUploads.length} recent uploads in last 5 seconds`);

    // Filter out current asset
    const candidatesForLinking = recentUploads.filter((p: any) => p._id !== assetId);
    console.log(`[LivePhoto] ${candidatesForLinking.length} candidates after filtering current asset`);

    if (isVideo) {
      // Look for matching HEIC image
      console.log(`[LivePhoto] Looking for HEIC pair for video ${assetId}`);
      const matchingImage = candidatesForLinking.find((p: any) => {
        const isHeicCandidate = p.isHeic || p.mimeType === 'image/heic';
        if (!isHeicCandidate) return false;
        // Check if timestamps are within 2 seconds
        const timeDiff = Math.abs(
          new Date(p.fileCreatedAt).getTime() - new Date(photo.fileCreatedAt).getTime()
        );
        const withinTime = timeDiff < 2000;
        console.log(`[LivePhoto] Checking ${p._id}: isHeic=${isHeicCandidate}, timeDiff=${timeDiff}ms, withinTime=${withinTime}`);
        return withinTime;
      });

      if (matchingImage) {
        // Update the image to point to this video
        await firestoreSet(env, uid, `photos/${matchingImage._id}`, {
          livePhotoVideoId: assetId
        }, idToken);
        console.log(`[LivePhoto] ✅ Linked image ${matchingImage._id} to video ${assetId}`);
      } else {
        console.log(`[LivePhoto] ❌ No matching HEIC found for video ${assetId}`);
      }
    } else if (isHeic) {
      // Look for matching MOV video
      console.log(`[LivePhoto] Looking for MOV pair for HEIC ${assetId}`);
      const matchingVideo = candidatesForLinking.find((p: any) => {
        const isVideoCandidate = p.mimeType?.startsWith('video/');
        if (!isVideoCandidate) return false;

        // Live photos are typically 1-3 seconds, must have duration
        const durationSecs = p.duration ? parseFloat(p.duration) : 0;
        const isLivePhotoLength = durationSecs > 0.5 && durationSecs <= 4;
        if (!isLivePhotoLength) {
          console.log(`[LivePhoto] Skipping ${p._id}: duration out of range (${durationSecs}s, need 0.5-4s)`);
          return false;
        }

        // Timestamps must be VERY close (within 2 seconds)
        const timeDiff = Math.abs(
          new Date(p.fileCreatedAt).getTime() - new Date(photo.fileCreatedAt).getTime()
        );
        const withinTime = timeDiff < 2000;
        console.log(`[LivePhoto] Checking ${p._id}: isVideo=${isVideoCandidate}, duration=${durationSecs}s, timeDiff=${timeDiff}ms, withinTime=${withinTime}`);
        return withinTime;
      });

      if (matchingVideo) {
        // Update this image to point to the video
        await firestoreSet(env, uid, `photos/${assetId}`, {
          livePhotoVideoId: matchingVideo._id
        }, idToken);
        console.log(`[LivePhoto] ✅ Linked image ${assetId} to video ${matchingVideo._id}`);
      } else {
        console.log(`[LivePhoto] ❌ No matching MOV found for HEIC ${assetId}`);
      }
    }
  } catch (e) {
    console.error('[LivePhoto] Link failed:', e);
  }
}
