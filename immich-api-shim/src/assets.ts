import type { Env } from './index';
import { requireAuth, firestoreGet, firestoreSet, firestoreDelete, firestoreQuery, json } from './helpers';

export async function handleAssets(request: Request, env: Env, path: string, url: URL): Promise<Response> {
  const session = await requireAuth(request);
  const uid = session.uid;
  const idToken = session.idToken;

  // GET /api/assets/:id/thumbnail
  const thumbMatch = path.match(/^\/api\/assets\/([^/]+)\/thumbnail$/);
  if (thumbMatch && request.method === 'GET') {
    return handleThumbnail(env, uid, thumbMatch[1], idToken, url);
  }

  // GET /api/assets/:id/original
  const origMatch = path.match(/^\/api\/assets\/([^/]+)\/original$/);
  if (origMatch && request.method === 'GET') {
    return handleOriginal(env, uid, origMatch[1], idToken);
  }

  // GET /api/assets/:id/video/playback
  const videoMatch = path.match(/^\/api\/assets\/([^/]+)\/video\/playback$/);
  if (videoMatch && request.method === 'GET') {
    return handleOriginal(env, uid, videoMatch[1], idToken);
  }

  // GET /api/assets/:id
  const infoMatch = path.match(/^\/api\/assets\/([^/]+)$/);
  if (infoMatch && request.method === 'GET') {
    return handleAssetInfo(env, uid, infoMatch[1], idToken);
  }

  // PUT /api/assets/:id
  if (infoMatch && request.method === 'PUT') {
    return handleUpdateAsset(request, env, uid, infoMatch[1], idToken);
  }

  // POST /api/assets/:id/view
  const viewMatch = path.match(/^\/api\/assets\/([^/]+)\/view$/);
  if (viewMatch) return json({ id: viewMatch[1] });

  // DELETE /api/assets
  if (path === '/api/assets' && request.method === 'DELETE') {
    return handleDeleteAssets(request, env, uid, idToken);
  }

  // PUT /api/assets (bulk update)
  if (path === '/api/assets' && request.method === 'PUT') {
    return handleBulkUpdate(request, env, uid, idToken);
  }

  // POST /api/assets/bulk-upload-check (duplicate detection)
  if (path === '/api/assets/bulk-upload-check' && request.method === 'POST') {
    const body = await request.json() as any;
    const assets = body.assets || [];
    return json({
      results: assets.map((a: any) => ({
        id: a.id,
        action: 'accept',
        assetId: null,
        isTrashed: false,
      })),
    });
  }

  // POST /api/assets (upload)
  if (path === '/api/assets' && request.method === 'POST') {
    return handleUpload(request, env, uid, idToken);
  }

  return json({ message: 'Asset endpoint not found' }, 404);
}

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
  // Get bot config for Telegram deletion
  const config = await firestoreGet(env, uid, 'config/telegram', idToken);
  const botToken = config?.botToken || config?.bot_token;
  const channelId = config?.channelId || config?.channel_id;

  for (const id of ids) {
    const photo = await firestoreGet(env, uid, `photos/${id}`, idToken);
    if (photo && botToken && channelId && photo.telegramChunks) {
      // Delete Telegram messages
      for (const chunk of photo.telegramChunks) {
        try {
          await fetch(`https://api.telegram.org/bot${botToken}/deleteMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
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

async function handleUpload(request: Request, env: Env, uid: string, idToken: string): Promise<Response> {
  // Get bot config
  const config = await firestoreGet(env, uid, 'config/telegram', idToken);
  if (!config) return json({ message: 'Telegram not configured' }, 400);
  const botToken = config.botToken || config.bot_token;
  const channelId = config.channelId || config.channel_id;
  if (!botToken || !channelId) return json({ message: 'Missing bot/channel config' }, 400);

  // Parse multipart form
  const formData = await request.formData();
  const file = formData.get('assetData') as File;
  if (!file) return json({ message: 'No file provided' }, 400);

  const uploadDocument = async (blob: Blob, name: string) => {
    const tgForm = new FormData();
    tgForm.append('chat_id', channelId);
    tgForm.append('document', blob, name);
    const tgRes = await fetch(`https://api.telegram.org/bot${botToken}/sendDocument`, {
      method: 'POST',
      body: tgForm,
    });
    const data = await tgRes.json() as any;
    if (!data.ok) throw new Error(data.description);
    return data.result.document.file_id;
  };

  const uploadPhoto = async (blob: Blob, name: string) => {
    const tgForm = new FormData();
    tgForm.append('chat_id', channelId);
    tgForm.append('photo', blob, name);
    const tgRes = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
      method: 'POST',
      body: tgForm,
    });
    const data = await tgRes.json() as any;
    if (!data.ok) throw new Error(data.description);
    // Telegram returns multiple sizes. Index 0 is the smallest (usually ~90px), index 1 is ~320px
    const photos = data.result.photo;
    const thumbIndex = photos.length > 1 ? 1 : 0;
    return photos[thumbIndex].file_id;
  };

  try {
    const buffer = await file.arrayBuffer();
    const originalFileId = await uploadDocument(new Blob([buffer], { type: file.type }), file.name);

    let thumbFileId = null;
    if (file.type.startsWith('image/')) {
        try {
            thumbFileId = await uploadPhoto(new Blob([buffer], { type: file.type }), 'thumb.jpg');
        } catch (e) {
            console.error("Failed to generate thumb via sendPhoto", e);
        }
    }

    const assetId = crypto.randomUUID();
    const now = new Date().toISOString();

    const metadata: Record<string, any> = {
      originalFileName: file.name,
      type: file.type.startsWith('video') ? 'VIDEO' : 'IMAGE',
      mimeType: file.type,
      fileSize: buffer.byteLength,
      width: 0,
      height: 0,
      ratio: 1,
      fileCreatedAt: now,
      uploadedAt: now,
      localOffsetHours: 0,
      isFavorite: false,
      isTrashed: false,
      visibility: 'timeline',
      encrypted: false,
      telegramOriginalId: originalFileId,
      telegramThumbId: thumbFileId || originalFileId,
      telegramChunks: [],
      albumIds: [],
      tags: [],
    };

    await firestoreSet(env, uid, `photos/${assetId}`, metadata, idToken);

    return json({
      id: assetId,
      status: 'created',
      duplicate: false,
    }, 201);
  } catch (error: any) {
    return json({ message: 'Upload failed: ' + error.message }, 500);
  }
}

async function fetchTelegramFile(botToken: string, fileId: string, mimeType: string) {
  const fileRes = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`);
  const fileData = await fileRes.json() as any;
  if (!fileData.ok) return json({ message: 'Failed to get file' }, 500);

  const filePath = fileData.result.file_path;
  const downloadUrl = `https://api.telegram.org/file/bot${botToken}/${filePath}`;

  const imgRes = await fetch(downloadUrl);
  if (!imgRes.ok) return json({ message: 'Download failed' }, 500);

  return new Response(imgRes.body, {
    headers: {
      'Content-Type': mimeType || 'application/octet-stream',
      'Cache-Control': 'public, max-age=86400, immutable',
    },
  });
}

async function handleThumbnail(env: Env, uid: string, assetId: string, idToken: string, _url: URL): Promise<Response> {
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

  const mimeType = photo.telegramThumbId ? 'image/jpeg' : photo.mimeType;
  return fetchTelegramFile(botToken, fileId, mimeType);
}

async function handleOriginal(env: Env, uid: string, assetId: string, idToken: string): Promise<Response> {
  const photo = await firestoreGet(env, uid, `photos/${assetId}`, idToken);
  if (!photo) return json({ message: 'Not found' }, 404);

  const config = await firestoreGet(env, uid, 'config/telegram', idToken);
  if (!config) return json({ message: 'No config' }, 500);
  const botToken = config.botToken || config.bot_token;

  let fileId = photo.telegramOriginalId;
  if (!fileId) {
    fileId = photo.telegramChunks && photo.telegramChunks.length > 0 ? photo.telegramChunks[0].file_id : null;
  }
  if (!fileId) return json({ message: 'No file data' }, 404);

  return fetchTelegramFile(botToken, fileId, photo.mimeType);
}

function toAssetResponseDto(photo: any, ownerId: string): any {
  const id = photo._id;
  return {
    id,
    type: photo.type || 'IMAGE',
    originalFileName: photo.originalFileName || 'unknown',
    originalMimeType: photo.mimeType || 'image/jpeg',
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
    people: [],
    tags: [],
    stack: null,
    livePhotoVideoId: null,
    unassignedFaces: [],
    duplicateId: null,
    checksum: '',
    libraryId: null,
    profileImagePath: '',
  };
}
