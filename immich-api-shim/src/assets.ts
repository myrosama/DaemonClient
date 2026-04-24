import type { Env } from './index';
import { requireAuth, firestoreGet, firestoreSet, firestoreDelete, json } from './helpers';

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

  if (path.match(/^\/api\/assets\/([^/]+)\/thumbnail$/) && request.method === 'GET') {
    return handleThumbnail(env, uid, path.match(/^\/api\/assets\/([^/]+)\/thumbnail$/)![1], idToken);
  }
  if (path.match(/^\/api\/assets\/([^/]+)\/original$/) && request.method === 'GET') {
    return handleOriginal(env, uid, path.match(/^\/api\/assets\/([^/]+)\/original$/)![1], idToken);
  }
  if (path.match(/^\/api\/assets\/([^/]+)\/video\/playback$/) && request.method === 'GET') {
    return handleOriginal(env, uid, path.match(/^\/api\/assets\/([^/]+)\/video\/playback$/)![1], idToken);
  }
  if (path.match(/^\/api\/assets\/([^/]+)$/) && request.method === 'GET') {
    return handleAssetInfo(env, uid, path.match(/^\/api\/assets\/([^/]+)$/)![1], idToken);
  }
  if (path.match(/^\/api\/assets\/([^/]+)$/) && request.method === 'PUT') {
    return handleUpdateAsset(request, env, uid, path.match(/^\/api\/assets\/([^/]+)$/)![1], idToken);
  }
  if (path.match(/^\/api\/assets\/([^/]+)\/view$/)) {
    return json({ id: path.match(/^\/api\/assets\/([^/]+)\/view$/)![1] });
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
  if (path === '/api/assets' && request.method === 'POST') {
    return handleUpload(request, env, uid, idToken);
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
  const config = await firestoreGet(env, uid, 'config/telegram', idToken);
  const botToken = config?.botToken || config?.bot_token;
  const channelId = config?.channelId || config?.channel_id;

  for (const id of ids) {
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
  const file = formData.get('assetData') as File;
  if (!file) {
    console.log('Upload failed: No file provided in formData keys:', Array.from(formData.keys()));
    return json({ message: 'No file provided' }, 400);
  }

  try {
    const zkeConfig = await firestoreGet(env, uid, 'config/zke', idToken) || {};
    const isClientZke = zkeConfig.mode === 'client' || request.url.includes('client=true');
    const isServerZke = !isClientZke; // Default to server mode

    const key = isServerZke ? await getEncryptionKey(env, uid, idToken) : null;
    const isEncryptedByServer = key !== null;
    
    const buffer = await file.arrayBuffer();
    const fileBytes = new Uint8Array(buffer);
    const fileSize = fileBytes.byteLength;
    const fileName = file.name;
    const mimeType = file.type;
    const isHeic = /\.(heic|heif)$/i.test(fileName) || mimeType === 'image/heic' || mimeType === 'image/heif';

    const totalChunks = Math.ceil(fileSize / CHUNK_SIZE);
    const telegramChunks: Array<{ index: number; message_id: number; file_id: string }> = [];

    // Chunking and Encryption
    for (let i = 0; i < totalChunks; i++) {
      const start = i * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, fileSize);
      let chunkData = fileBytes.slice(start, end).buffer;

      if (isEncryptedByServer) {
        chunkData = await encryptChunk(chunkData, key);
      }

      const partName = totalChunks === 1 ? fileName : `${fileName}.part${String(i + 1).padStart(3, '0')}`;

      const tgForm = new FormData();
      tgForm.append('chat_id', channelId);
      tgForm.append('document', new Blob([chunkData], { type: 'application/octet-stream' }), partName);

      const tgRes = await fetch(`https://api.telegram.org/bot${botToken}/sendDocument`, { method: 'POST', body: tgForm });
      const data = await tgRes.json() as any;
      if (!data.ok) throw new Error(`Telegram upload chunk ${i}: ${data.description}`);

      telegramChunks.push({ index: i, message_id: data.result.message_id, file_id: data.result.document.file_id });
    }

    // Thumbnail generation (skip if encrypted, to preserve zero-knowledge)
    let thumbFileId: string | null = null;
    if (!isEncryptedByServer && !isClientZke && mimeType.startsWith('image/') && !isHeic) {
      try {
        const tgForm = new FormData();
        tgForm.append('chat_id', channelId);
        tgForm.append('photo', new Blob([fileBytes], { type: mimeType }), 'thumb.jpg');
        const tgRes = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, { method: 'POST', body: tgForm });
        const data = await tgRes.json() as any;
        if (data.ok) {
          const photos = data.result.photo;
          thumbFileId = photos[photos.length > 1 ? 1 : 0].file_id;
        }
      } catch { /* ignore */ }
    }

    const assetId = crypto.randomUUID();
    const now = new Date().toISOString();
    const singleFileId = totalChunks === 1 ? telegramChunks[0].file_id : null;

    const metadata: Record<string, any> = {
      originalFileName: fileName,
      type: mimeType.startsWith('video') ? 'VIDEO' : 'IMAGE',
      mimeType, fileSize, width: 0, height: 0, ratio: 1,
      fileCreatedAt: now, uploadedAt: now, localOffsetHours: 0,
      isFavorite: false, isTrashed: false, visibility: 'timeline',
      encrypted: isServerZke || isClientZke,
      encryptionMode: isClientZke ? 'client' : (isServerZke ? 'server' : 'off'),
      telegramOriginalId: singleFileId,
      telegramThumbId: thumbFileId || singleFileId,
      telegramChunks, totalChunks, isHeic,
      albumIds: [], tags: [],
    };

    await firestoreSet(env, uid, `photos/${assetId}`, metadata, idToken);
    return json({ id: assetId, status: 'created', duplicate: false }, 201);
  } catch (error: any) {
    return json({ message: 'Upload failed: ' + error.message }, 500);
  }
}

// ── Streaming Download ──────────────────────────────────────────────

async function handleThumbnail(env: Env, uid: string, assetId: string, idToken: string): Promise<Response> {
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
  const mimeType = photo.telegramThumbId && !isServerZke && !isClientZke ? 'image/jpeg' : photo.mimeType;

  const fileRes = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`);
  const fileData = await fileRes.json() as any;
  if (!fileData.ok) return json({ message: 'Failed to get file' }, 500);

  const downloadUrl = `https://api.telegram.org/file/bot${botToken}/${fileData.result.file_path}`;
  const imgRes = await fetch(downloadUrl);
  if (!imgRes.ok) return json({ message: 'Download failed' }, 500);

  if (isServerZke && key) {
    try {
      let data = await imgRes.arrayBuffer();
      data = await decryptChunk(data, key);
      return new Response(data, {
        headers: {
          'Content-Type': mimeType || 'application/octet-stream',
          'Cache-Control': 'public, max-age=86400, immutable',
        }
      });
    } catch (e) {
      return json({ message: 'Decryption failed' }, 500);
    }
  }

  return new Response(imgRes.body, {
    headers: {
      'Content-Type': mimeType || 'application/octet-stream',
      'Cache-Control': 'public, max-age=86400, immutable',
    },
  });
}

async function handleOriginal(env: Env, uid: string, assetId: string, idToken: string): Promise<Response> {
  const photo = await firestoreGet(env, uid, `photos/${assetId}`, idToken);
  if (!photo) return json({ message: 'Not found' }, 404);

  const config = await firestoreGet(env, uid, 'config/telegram', idToken);
  if (!config) return json({ message: 'No config' }, 500);
  const botToken = config.botToken || config.bot_token;

  const isServerZke = photo.encryptionMode === 'server' || (photo.encrypted === true && !photo.encryptionMode);
  const isClientZke = photo.encryptionMode === 'client';
  const key = isServerZke ? await getEncryptionKey(env, uid, idToken) : null;

  if (photo.telegramChunks && photo.telegramChunks.length > 0) {
    const chunks = [...photo.telegramChunks].sort((a, b) => a.index - b.index);
    
    const stream = new ReadableStream({
      async start(controller) {
        for (const chunk of chunks) {
          try {
            const fileRes = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${chunk.file_id}`);
            const fileData = await fileRes.json() as any;
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

    return new Response(stream, {
      headers: {
        'Content-Type': photo.mimeType || 'application/octet-stream',
        'Content-Length': photo.fileSize?.toString() || '',
        'Cache-Control': 'public, max-age=86400, immutable',
      }
    });
  }

  // Fallback for missing chunks but existing originalId
  let fileId = photo.telegramOriginalId;
  if (!fileId) return json({ message: 'No file data' }, 404);
  
  const fileRes = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`);
  const fileData = await fileRes.json() as any;
  if (!fileData.ok) return json({ message: 'Failed to get file' }, 500);
  
  const downloadUrl = `https://api.telegram.org/file/bot${botToken}/${fileData.result.file_path}`;
  const imgRes = await fetch(downloadUrl);
  
  if (isServerZke && key) {
      let data = await imgRes.arrayBuffer();
      data = await decryptChunk(data, key);
      return new Response(data, {
          headers: { 'Content-Type': photo.mimeType || 'application/octet-stream' }
      });
  }

  return new Response(imgRes.body, {
    headers: {
      'Content-Type': photo.mimeType || 'application/octet-stream',
      'Cache-Control': 'public, max-age=86400, immutable',
    },
  });
}

function toAssetResponseDto(photo: any, ownerId: string): any {
  const id = photo._id;
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
    duration: photo.duration || '0:00:00.00000',
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
  };
}
