import type { Env } from './index';
import { requireAuth, firestoreGet, firestoreSet, firestoreDelete, firestoreQuery, json } from './helpers';
import sizeOf from 'image-size';
import { normalizePhotoManifest } from './contracts';
import { getFlagsForUser } from './feature-flags';
import { D1Adapter } from './d1-adapter';
import { getCachedConfig } from './cached-config';
import { computeThumbHashFromJpeg } from './thumbhash-util';
import { sha1Base64OfFile } from './sha1';
import { extractExif, type PhotoExif } from './exif';
import { StoreZipWriter } from './zip';

// --- ZKE Crypto Implementation ---
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const KEY_LENGTH = 256;
const PBKDF2_ITERATIONS = 100000;
const CHUNK_SIZE = 19 * 1024 * 1024; // 19 MB

// Module-level file_path cache. Telegram file paths are valid for ~1 hour;
// caching them avoids the getFile round-trip on every thumbnail request.
// Shared across all requests within the same CF isolate instance.
const filePathCache = new Map<string, { path: string; expiresAt: number }>();
const FILE_PATH_TTL_MS = 55 * 60 * 1000; // 55 min — safely under Telegram's 1-hour validity

// Minimal JPEG EXIF GPS extractor — scans APP1 segment for GPS IFD tags.
// Returns decimal lat/lon or null. Best-effort; silently ignores corrupt EXIF.
function extractJpegGps(buf: Uint8Array): { latitude: number; longitude: number } | null {
  try {
    if (buf[0] !== 0xFF || buf[1] !== 0xD8) return null; // not JPEG
    let i = 2;
    while (i < buf.length - 4) {
      if (buf[i] !== 0xFF) break;
      const marker = (buf[i] << 8) | buf[i + 1];
      const segLen = (buf[i + 2] << 8) | buf[i + 3];
      if (marker === 0xFFE1) {
        const exif = buf.slice(i + 4, i + 2 + segLen);
        if (String.fromCharCode(exif[0], exif[1], exif[2], exif[3]) !== 'Exif') { i += 2 + segLen; continue; }
        const tiff = exif.slice(6);
        const le = tiff[0] === 0x49;
        const r16 = (o: number) => le ? tiff[o] | (tiff[o+1] << 8) : (tiff[o] << 8) | tiff[o+1];
        const r32 = (o: number) => le
          ? tiff[o] | (tiff[o+1]<<8) | (tiff[o+2]<<16) | (tiff[o+3]<<24)
          : (tiff[o]<<24)|(tiff[o+1]<<16)|(tiff[o+2]<<8)|tiff[o+3];
        const ifd0Off = r32(4);
        if (ifd0Off + 2 > tiff.length) break;
        const numEntries = r16(ifd0Off);
        let gpsIfdOff = 0;
        for (let e = 0; e < numEntries; e++) {
          const eOff = ifd0Off + 2 + e * 12;
          if (eOff + 12 > tiff.length) break;
          if (r16(eOff) === 0x8825) { gpsIfdOff = r32(eOff + 8); break; }
        }
        if (!gpsIfdOff || gpsIfdOff + 2 > tiff.length) break;
        const gpsNum = r16(gpsIfdOff);
        const gps: Record<number, any> = {};
        for (let e = 0; e < gpsNum; e++) {
          const eOff = gpsIfdOff + 2 + e * 12;
          if (eOff + 12 > tiff.length) break;
          const tag = r16(eOff);
          const cnt = r32(eOff + 4);
          const vOff = cnt <= 1 ? eOff + 8 : r32(eOff + 8);
          if (tag === 0x0001 || tag === 0x0003) {
            gps[tag] = String.fromCharCode(tiff[vOff]);
          } else if ((tag === 0x0002 || tag === 0x0004) && vOff + 23 < tiff.length) {
            const dms = [];
            for (let j = 0; j < 3; j++) {
              const num = r32(vOff + j * 8); const den = r32(vOff + j * 8 + 4);
              dms.push(den ? num / den : 0);
            }
            gps[tag] = dms[0] + dms[1] / 60 + dms[2] / 3600;
          }
        }
        if (gps[0x0002] !== undefined && gps[0x0004] !== undefined) {
          return {
            latitude: gps[0x0001] === 'S' ? -gps[0x0002] : gps[0x0002],
            longitude: gps[0x0003] === 'W' ? -gps[0x0004] : gps[0x0004],
          };
        }
        break;
      }
      if (marker === 0xFFD9) break; // EOI
      i += 2 + segLen;
    }
  } catch { /* corrupt EXIF — ignore */ }
  return null;
}

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
  // Asset IDs that still need the client-side Fix-HEIC tool: HEIC images with
  // no JPEG preview yet, plus any image missing a thumbhash. Lets the tool
  // target exactly what's left (incl. HEICs that already got a thumbnail but
  // not yet a preview), instead of rescanning the whole timeline.
  if (path === '/api/assets/pending-thumbnail-fix' && request.method === 'GET') {
    if (!env.DB) return json({ ids: [] });
    const qp = new URL(request.url).searchParams;
    // ?type=video — returns video assets that have no thumbnail yet (used by the
    // "Fix video thumbnails" utility). Kept separate from the default (images) so
    // existing HEIC tooling is unaffected and the candidate lists never mix.
    if (qp.get('type') === 'video') {
      // Exclude live-photo partners — they're paired MOVs, not standalone videos
      const rows = await env.DB.prepare(
        `SELECT id FROM photos
           WHERE ownerId = ? AND (isTrashed = 0 OR isTrashed IS NULL)
             AND mimeType LIKE 'video/%'
             AND (telegramThumbId IS NULL OR telegramThumbId = '')
             AND id NOT IN (SELECT livePhotoVideoId FROM photos WHERE livePhotoVideoId IS NOT NULL AND ownerId = ?)
           LIMIT 5000`
      ).bind(uid, uid).all();
      return json({ ids: (rows.results || []).map((r: any) => r.id) });
    }
    // ?all=1 re-processes EVERY HEIC (even ones already fixed) — used to upgrade
    // older low-quality previews to the current quality. Default only returns
    // what's actually missing (HEIC without preview, or image without thumbhash).
    const all = qp.get('all') === '1';
    const where = all
      ? `(isHeic = 1 OR mimeType LIKE '%hei%') OR thumbhash IS NULL OR thumbhash = ''`
      : `((isHeic = 1 OR mimeType LIKE '%hei%') AND (telegramPreviewId IS NULL OR telegramPreviewId = '')) OR thumbhash IS NULL OR thumbhash = ''`;
    const rows = await env.DB.prepare(
      `SELECT id FROM photos
         WHERE ownerId = ? AND (isTrashed = 0 OR isTrashed IS NULL) AND mimeType LIKE 'image/%'
           AND ( ${where} )
         LIMIT 5000`
    ).bind(uid).all();
    return json({ ids: (rows.results || []).map((r: any) => r.id) });
  }

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

  // Native mobile video players (AVPlayer/ExoPlayer) send a HEAD probe before
  // streaming to read Content-Length / Content-Type / Accept-Ranges. We only
  // routed GET, so HEAD fell through to a 404 JSON — the player treated the
  // video as missing and the app crashed (browsers skip HEAD, which is why web
  // worked). Answer HEAD with the headers GET would send, no body.
  if (resourceId && request.method === 'HEAD' &&
      (path.endsWith('/video/playback') || path.endsWith('/original') || path.includes('/file/') || path.endsWith('/thumbnail'))) {
    return handleMediaHead(env, uid, resourceId, idToken, path);
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
  if (resourceId && path.match(/^\/api\/assets?\/([^/]+)$/) && (request.method === 'PUT' || request.method === 'PATCH')) {
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
    const assets: Array<{ id: string; checksum: string }> = body.assets || [];
    if (!env.DB || assets.length === 0) {
      return json({ results: assets.map(a => ({ id: a.id, action: 'accept', assetId: null, isTrashed: false })) });
    }
    await ensureDeduplicationSchema(env.DB);
    const checksums = assets.map(a => a.checksum).filter(Boolean);
    const existing = await new D1Adapter(env.DB).getPhotosByChecksums(uid, checksums);
    const checksumMap = new Map(existing.map(p => [p.checksum, p.id]));
    return json({
      results: assets.map(a => {
        const serverId = a.checksum ? checksumMap.get(a.checksum) : undefined;
        return serverId
          ? { id: a.id, action: 'reject', assetId: serverId, isTrashed: false }
          : { id: a.id, action: 'accept', assetId: null, isTrashed: false };
      }),
    });
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

  // Replace an asset's stored video with a client-processed (faststart + AAC)
  // version so iOS can stream it. Re-encrypts/chunks like the upload path and
  // atomically swaps the telegram refs, leaving all metadata/timestamps intact.
  const replaceVideoMatch = path.match(/^\/api\/assets\/([^/]+)\/replace-video$/);
  if (replaceVideoMatch && request.method === 'POST') {
    return handleReplaceVideo(request, env, uid, replaceVideoMatch[1], idToken);
  }

  if (path === '/api/assets/worker-config' && request.method === 'GET') {
    const workerConfig = await getCachedConfig<{ url?: string }>(env, uid, idToken, 'worker');
    return json({ url: workerConfig?.url || null });
  }

  if (path.match(/^\/api\/assets\/[^/]+\/ocr$/) && request.method === 'GET') {
    return json({ ocr: null });
  }

  // Trash — restore selected assets
  if (path === '/api/trash/restore/assets' && request.method === 'POST') {
    const body = await request.json() as any;
    const ids: string[] = body.ids || [];
    if (env.DB) {
      const adapter = new D1Adapter(env.DB);
      for (const id of ids) await adapter.updatePhoto(id, { isTrashed: 0 });
    }
    return json({});
  }
  // Trash — restore all
  if (path === '/api/trash/restore' && request.method === 'POST') {
    if (env.DB) {
      await env.DB.prepare(`UPDATE photos SET isTrashed = 0 WHERE ownerId = ? AND isTrashed = 1`).bind(uid).run();
    }
    return json({});
  }
  // Trash — empty (permanently delete all trashed photos). Immich app uses
  // POST; accept DELETE too for robustness.
  if (path === '/api/trash/empty' && (request.method === 'POST' || request.method === 'DELETE')) {
    if (env.DB) {
      const adapter = new D1Adapter(env.DB);
      const rows = await adapter.queryPhotos({ ownerId: uid, isTrashed: 1 });
      const ids = rows.map(r => r.id);
      if (ids.length > 0) {
        // Delegate to handleDeleteAssets logic with force=true — call inline
        const config = await getCachedConfig<any>(env, uid, idToken, 'telegram');
        const botToken = config?.botToken || config?.bot_token;
        const channelId = config?.channelId || config?.channel_id;
        for (const id of ids) {
          const photo = await adapter.getPhoto(id);
          if (photo && botToken && channelId) {
            const chunks = typeof photo.telegramChunks === 'string'
              ? JSON.parse(photo.telegramChunks || '[]')
              : (photo.telegramChunks || []);
            for (const chunk of chunks) {
              try {
                await fetch(`https://api.telegram.org/bot${botToken}/deleteMessage`, {
                  method: 'POST', headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ chat_id: channelId, message_id: chunk.message_id }),
                });
              } catch { /* best effort */ }
            }
          }
          await adapter.deletePhoto(id);
        }
      }
    }
    return json({});
  }

  // Notifications — real count of assets needing the HEIC/thumbnail fix,
  // plus any operator broadcast announcement stored in Firestore global/announcement.
  if (path === '/api/notifications' && request.method === 'GET') {
    const notifications: any[] = [];

    // Per-user media-fix counts (requires D1).
    if (env.DB) {
      // Use exactly the same WHERE as pending-thumbnail-fix default so the count
      // matches what the HEIC fixer and video fixer actually process.
      const [heicRow, videoRow] = await Promise.all([
        env.DB.prepare(
          `SELECT COUNT(*) as c FROM photos WHERE ownerId = ? AND (isTrashed = 0 OR isTrashed IS NULL)
           AND mimeType LIKE 'image/%'
           AND ((isHeic = 1 OR mimeType LIKE '%hei%') AND (telegramPreviewId IS NULL OR telegramPreviewId = ''))`
        ).bind(uid).first<{ c: number }>(),
        // Exclude live-photo partner MOVs — those are paired stills, not standalone videos.
        // A video is a live-photo partner when another photo's livePhotoVideoId points to it.
        env.DB.prepare(
          `SELECT COUNT(*) as c FROM photos WHERE ownerId = ? AND (isTrashed = 0 OR isTrashed IS NULL)
           AND mimeType LIKE 'video/%' AND (telegramThumbId IS NULL OR telegramThumbId = '')
           AND id NOT IN (SELECT livePhotoVideoId FROM photos WHERE livePhotoVideoId IS NOT NULL AND ownerId = ?)`
        ).bind(uid, uid).first<{ c: number }>(),
      ]);
      const heicCount = heicRow?.c || 0;
      const videoCount = videoRow?.c || 0;
      const total = heicCount + videoCount;
      if (total > 0) {
        const parts: string[] = [];
        if (heicCount > 0) parts.push(`${heicCount} HEIC photo${heicCount > 1 ? 's' : ''}`);
        if (videoCount > 0) parts.push(`${videoCount} video${videoCount > 1 ? 's' : ''}`);
        // Honest explainer: this app can't display HEIC/video directly; the web
        // viewer can. Tell the user exactly how to make them work — and that the
        // fixer runs from a phone browser too (iPhone Safari decodes HEIC/HEVC
        // natively, so it works great on the phone). Mention the optional
        // self-hosted backend for instant viewing with no fix step.
        notifications.push({
          id: 'heic-fix',
          type: 'system',
          level: 'warning',
          title: `${parts.join(' and ')} can't be shown in the app`,
          message:
            `HEIC photos and videos don't display directly in this app — but they're safe and they work on the web. ` +
            `To fix them: open photos.daemonclient.uz in any browser (your phone works too) → Utilities → tap "Fix HEIC", then "Fix Videos". ` +
            `After that they show everywhere. Advanced: connect your own backend server (e.g. Render) to view them instantly with no fixing — guide on the website.`,
          read: false,
          createdAt: new Date().toISOString(),
          readAt: null,
        });
      }
    }

    // Operator broadcast announcement — stored in Firestore global/announcement.
    // Any authenticated user can read this document (Firestore rule: allow read if request.auth != null).
    try {
      const announcementRes = await fetch(
        `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/global/announcement`,
        { headers: { 'Authorization': `Bearer ${idToken}` } }
      );
      if (announcementRes.ok) {
        const doc = await announcementRes.json() as any;
        const f = doc?.fields;
        if (f?.active?.booleanValue === true) {
          notifications.push({
            id: 'global-announcement',
            type: 'system',
            level: 'info',
            title: f.title?.stringValue || 'Announcement',
            message: f.message?.stringValue || '',
            read: false,
            createdAt: f.createdAt?.stringValue || new Date().toISOString(),
            readAt: null,
          });
        }
      }
    } catch {
      // Firestore unreachable — skip silently so per-user notifications still show.
    }

    return json(notifications);
  }

  // Map markers — photos with GPS coordinates
  if (path === '/api/map/markers' && request.method === 'GET') {
    if (!env.DB) return json([]);
    const rows = await env.DB.prepare(
      `SELECT id, latitude, longitude, city, country, mimeType FROM photos
       WHERE ownerId = ? AND latitude IS NOT NULL AND longitude IS NOT NULL
       AND (isTrashed = 0 OR isTrashed IS NULL) LIMIT 5000`
    ).bind(uid).all<{ id: string; latitude: number; longitude: number; city: string | null; country: string | null }>();
    return json((rows.results || []).map(r => ({
      id: r.id, lat: r.latitude, lon: r.longitude,
      city: r.city || null, state: null, country: r.country || null,
    })));
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
  // Immich web wraps fields in updateAssetDto; native app sends them directly
  const dto = body.updateAssetDto || body;

  // isTrashed=true → delete from Telegram + soft-delete D1 row as sync tombstone
  if (dto.isTrashed === true) {
    const syntheticReq = new Request('http://x/api/assets', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [assetId] }),
    });
    return handleDeleteAssets(syntheticReq, env, uid, idToken);
  }

  const updates: Record<string, any> = {};
  if (dto.isFavorite !== undefined) updates.isFavorite = dto.isFavorite ? 1 : 0;
  if (dto.isArchived !== undefined) updates.visibility = dto.isArchived ? 'archive' : 'timeline';
  if (dto.isTrashed !== undefined) updates.isTrashed = dto.isTrashed ? 1 : 0;
  if (dto.description !== undefined) updates.description = dto.description;
  if (dto.latitude !== undefined) updates.latitude = dto.latitude;
  if (dto.longitude !== undefined) updates.longitude = dto.longitude;

  if (Object.keys(updates).length > 0) {
    if (env.DB) {
      await new D1Adapter(env.DB).updatePhoto(assetId, updates);
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

  // Always permanently delete — no trash needed.
  const config = await getCachedConfig<any>(env, uid, idToken, 'telegram');
  const botToken = config?.botToken || config?.bot_token;
  const channelId = config?.channelId || config?.channel_id;

  // Expand the delete set to include live-photo companions. When a still is
  // deleted its paired MOV must go too (and vice versa), otherwise the orphaned
  // video shows up as a standalone clip after the next sync.
  const expandedIds = new Set<string>(ids);
  if (env.DB) {
    for (const id of ids) {
      const photo = await new D1Adapter(env.DB).getPhoto(id);
      if (photo?.livePhotoVideoId) expandedIds.add(photo.livePhotoVideoId);
    }
  }

  for (const id of expandedIds) {
    let photo: any;
    if (env.DB) {
      photo = await new D1Adapter(env.DB).getPhoto(id);
    } else {
      photo = await firestoreGet(env, uid, `photos/${id}`, idToken);
    }

    if (photo && botToken && channelId) {
      const chunks = typeof photo.telegramChunks === 'string'
        ? JSON.parse(photo.telegramChunks || '[]')
        : (photo.telegramChunks || []);
      for (const chunk of chunks) {
        try {
          await fetch(`https://api.telegram.org/bot${botToken}/deleteMessage`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: channelId, message_id: chunk.message_id }),
          });
        } catch { /* best effort */ }
      }
    }

    if (env.DB) {
      // Soft-delete: keep the D1 row as a sync tombstone. The Telegram data is
      // already gone above. Sync stream will emit AssetDeleteV1 for isTrashed=1
      // rows so the mobile removes them from its local DB on the next sync.
      await new D1Adapter(env.DB).updatePhoto(id, { isTrashed: 1, telegramChunks: '[]' });
    } else {
      await firestoreDelete(env, uid, `photos/${id}`, idToken);
    }
  }
  return json({});
}

async function handleBulkUpdate(request: Request, env: Env, uid: string, idToken: string): Promise<Response> {
  const body = await request.json() as any;
  const ids: string[] = body.ids || [];

  // isTrashed=true → permanent delete (no trash, same as DELETE /api/assets)
  if (body.isTrashed === true) {
    const syntheticReq = new Request('http://x/api/assets', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
    return handleDeleteAssets(syntheticReq, env, uid, idToken);
  }

  const updates: Record<string, any> = {};
  if (body.isFavorite !== undefined) updates.isFavorite = body.isFavorite ? 1 : 0;
  if (body.visibility !== undefined) updates.visibility = body.visibility;

  if (Object.keys(updates).length > 0) {
    if (env.DB) {
      const adapter = new D1Adapter(env.DB);
      // updatePhoto (partial UPDATE), NOT savePhoto: these rows already exist and
      // the patch omits NOT NULL columns (ownerId, fileName). savePhoto's
      // INSERT…ON CONFLICT attempts the INSERT first and throws NOT NULL before
      // the conflict-update runs → bulk favourite/archive 500s. See updatePhoto.
      for (const id of ids) {
        await adapter.updatePhoto(id, updates);
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

// Briefly send the plaintext bytes to Telegram as a document so Telegram
// auto-generates a small thumbnail, then return its bytes + the temp message id
// (caller deletes it). This is the original approach; the only thing it lacked
// was rate-limit resilience — a burst of uploads (each doing this extra send)
// would 429 the last few. So every Telegram call here retries with exponential
// backoff, honouring Telegram's `retry_after`, which is what was actually
// dropping thumbnails for the tail of a batch.
async function fetchTelegramThumb(
  botToken: string,
  channelId: string,
  rawData: ArrayBuffer,
  fileName: string,
  mimeType: string,
): Promise<{ thumbBytes: ArrayBuffer | null; tmpMsgId: number | null }> {
  const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
  let tmpMsgId: number | null = null;

  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await sleep(Math.min(500 * Math.pow(2, attempt), 6000)); // 1s, 2s, 4s
    try {
      const form = new FormData();
      form.append('chat_id', channelId);
      form.append('document', new Blob([rawData], { type: mimeType || 'application/octet-stream' }), fileName);
      await paceSend(botToken); // rate-limit sends per bot
      const res = await fetch(`https://api.telegram.org/bot${botToken}/sendDocument`, { method: 'POST', body: form });
      const j = await res.json() as any;

      if (res.status === 429 || j?.error_code === 429) {
        await sleep(Math.min(((j?.parameters?.retry_after || 1) * 1000), 8000));
        continue; // rate-limited — back off and retry
      }
      if (!j?.ok) {
        console.log(`[Thumb] sendDocument failed for ${fileName}: ${JSON.stringify(j).slice(0, 160)}`);
        return { thumbBytes: null, tmpMsgId };
      }

      tmpMsgId = j.result?.message_id ?? null;
      const thumbFileId = j.result?.document?.thumb?.file_id || j.result?.document?.thumbnail?.file_id || null;
      if (!thumbFileId) {
        console.log(`[Thumb] Telegram generated no thumb for ${fileName} (mime=${mimeType})`);
        return { thumbBytes: null, tmpMsgId };
      }

      // Download the generated thumb, also retrying on 429.
      for (let dlAttempt = 0; dlAttempt < 3; dlAttempt++) {
        if (dlAttempt > 0) await sleep(800 * dlAttempt);
        const dl = await tgDownloadFile(botToken, thumbFileId);
        if (dl.ok && dl.data) return { thumbBytes: dl.data, tmpMsgId };
      }
      return { thumbBytes: null, tmpMsgId };
    } catch (e: any) {
      console.log(`[Thumb] attempt ${attempt} error for ${fileName}: ${e?.message}`);
    }
  }
  return { thumbBytes: null, tmpMsgId };
}

// HEIC can't be thumbnailed by Telegram, nor decoded in-Worker (libheif is far
// too heavy for the 10ms free CPU limit). The Python backend (Render, real CPU)
// decodes it via pillow-heif. We POST the raw HEIC and get back a downscaled
// JPEG, which the caller encrypts + stores like any other thumb. Auth reuses
// the user's Firebase idToken (the backend verifies it). Returns null on any
// failure → caller falls back to serving the original.
const HEIC_CONVERT_URL = 'https://daemonclient-elnj.onrender.com/convertHeicThumbnail';
async function convertHeicThumbViaBackend(heicBytes: ArrayBuffer, idToken: string): Promise<ArrayBuffer | null> {
  try {
    const res = await fetch(HEIC_CONVERT_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${idToken}`, 'Content-Type': 'application/octet-stream' },
      body: heicBytes,
    });
    if (!res.ok) {
      console.log(`[HEIC] backend convert failed: ${res.status}`);
      return null;
    }
    const buf = await res.arrayBuffer();
    return buf.byteLength > 0 ? buf : null;
  } catch (e: any) {
    console.log(`[HEIC] backend convert error: ${e?.message}`);
    return null;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Self-healing deduplication schema
// Adding columns to the photos table for per-user workers deployed BEFORE this
// code existed. The migration system (migrations.ts) is never run during
// auto-update (code-only), so we replicate the drive.ts pattern: a module-level
// bool guard ensures the ALTER runs at most once per isolate lifecycle.
// SQLite has no "ALTER TABLE … ADD COLUMN IF NOT EXISTS", so we try/catch each
// ALTER and swallow the "duplicate column name" error silently.
// ────────────────────────────────────────────────────────────────────────────
let dedupSchemaReady = false;
async function ensureDeduplicationSchema(db: any): Promise<void> {
  if (dedupSchemaReady) return;
  const addColumn = async (sql: string) => {
    try { await db.prepare(sql).run(); } catch { /* column already exists */ }
  };
  await addColumn('ALTER TABLE photos ADD COLUMN deviceAssetId TEXT');
  await addColumn('ALTER TABLE photos ADD COLUMN deviceId TEXT');
  // GPS columns: migration 1.1.0 added these, but the deployment-service's
  // fresh-provision MIGRATION_SQL predates them — a worker provisioned from
  // that schema would fail EVERY INSERT that carries latitude/longitude and
  // 500 on /api/map/markers. Heal here so both old and new workers converge.
  await addColumn('ALTER TABLE photos ADD COLUMN latitude REAL');
  await addColumn('ALTER TABLE photos ADD COLUMN longitude REAL');
  // EXIF metadata columns (camera, lens, exposure). orientation is TEXT because
  // the Immich mobile contract (SyncAssetExifV1 / ExifResponseDto) types it as
  // String — Dart's strict parse drops/throws on a number.
  await addColumn('ALTER TABLE photos ADD COLUMN make TEXT');
  await addColumn('ALTER TABLE photos ADD COLUMN model TEXT');
  await addColumn('ALTER TABLE photos ADD COLUMN lensModel TEXT');
  await addColumn('ALTER TABLE photos ADD COLUMN fNumber REAL');
  await addColumn('ALTER TABLE photos ADD COLUMN focalLength REAL');
  await addColumn('ALTER TABLE photos ADD COLUMN iso INTEGER');
  await addColumn('ALTER TABLE photos ADD COLUMN exposureTime TEXT');
  await addColumn('ALTER TABLE photos ADD COLUMN orientation TEXT');
  await addColumn('ALTER TABLE photos ADD COLUMN dateTimeOriginal TEXT');
  // 1 = this row's bytes were already inspected for EXIF (at upload or by the
  // lazy backfill); stops backfillExifBatch re-downloading EXIF-less photos.
  await addColumn('ALTER TABLE photos ADD COLUMN exifChecked INTEGER DEFAULT 0');
  try {
    await db.prepare(
      'CREATE INDEX IF NOT EXISTS idx_photos_dedup ON photos(ownerId, deviceAssetId, deviceId)'
    ).run();
  } catch { /* index already exists */ }
  try {
    await db.prepare(
      'CREATE INDEX IF NOT EXISTS idx_photos_checksum ON photos(ownerId, checksum)'
    ).run();
  } catch { /* index already exists */ }
  dedupSchemaReady = true;
}

// Upload concurrency control. `request.formData()` buffers the ENTIRE body into
// memory before the handler can touch it, so several big bodies at once can
// cross Cloudflare's 128 MB isolate cap and kill EVERY in-flight request. The
// old design shed the excess with a 503 — but the mobile app backs up dozens of
// photos at once and treats 503 as a hard failure, so the WHOLE backup failed.
//
// Instead we QUEUE by BYTES: gate on the total in-flight upload size (from
// Content-Length) and WAIT for budget rather than rejecting. Small HEICs
// (~3 MB) run ~13-at-a-time; big videos serialize; a file larger than the whole
// budget runs alone when the worker is otherwise idle (so it's never stuck).
// Nothing fails under normal load. Module-level state is per-isolate; the
// budget check + increment have no await between them, so they're atomic; the
// finally always releases (no leak). Shedding only happens after a long wait
// under sustained overload — rare — and the app simply retries next cycle.
let inFlightUploadBytes = 0;
const UPLOAD_BYTE_BUDGET = 40 * 1024 * 1024; // ~40 MB of concurrent bodies
const UPLOAD_MAX_WAIT_MS = 55_000;           // wait up to ~55s for a slot, then shed

async function handleUpload(request: Request, env: Env, uid: string, idToken: string): Promise<Response> {
  const size = parseInt(request.headers.get('Content-Length') || '0', 10) || 8 * 1024 * 1024;
  const start = Date.now();
  // Wait for budget. First clause lets an over-budget file through when nothing
  // else is in flight, so huge files never wedge permanently.
  while (inFlightUploadBytes > 0 && inFlightUploadBytes + size > UPLOAD_BYTE_BUDGET) {
    if (Date.now() - start > UPLOAD_MAX_WAIT_MS) {
      return new Response(
        JSON.stringify({ message: 'Worker busy — retry shortly' }),
        { status: 503, headers: { 'Content-Type': 'application/json', 'Retry-After': '5' } },
      );
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  inFlightUploadBytes += size;
  try {
    return await handleUploadImpl(request, env, uid, idToken);
  } finally {
    inFlightUploadBytes -= size;
  }
}

async function handleUploadImpl(request: Request, env: Env, uid: string, idToken: string): Promise<Response> {
  const flags = await getFlagsForUser(env, uid, idToken);
  if (!flags.directBytePath) {
    return json({ message: 'Direct upload path is disabled by feature flag' }, 503);
  }
  const config = await getCachedConfig<any>(env, uid, idToken, 'telegram');
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
      let sessionRecord: any = null;
      if (env.DB) {
        sessionRecord = await new D1Adapter(env.DB).getJsonConfig<any>(`session:${uploadSessionId}`);
      }
      if (!sessionRecord) {
        sessionRecord = await firestoreGet(env, uid, `sessions/${uploadSessionId}`, idToken);
      }
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

  // Device-local identity for deduplication (Immich mobile sends these fields).
  const deviceAssetId = (formData.get('deviceAssetId') as string) || '';
  const deviceId = (formData.get('deviceId') as string) || '';

  const file = formData.get('assetData') as File | null;
  
  if (!file && !clientUpload) {
    console.log('Upload failed: No file provided in formData keys:', Array.from(formData.keys()));
    return json({ message: 'No file provided' }, 400);
  }

  try {
    let zkeConfig: any = {};
    if (env.DB) {
      const adapter = new D1Adapter(env.DB);
      zkeConfig = (await adapter.getZkeConfig()) || {};
    } else {
      zkeConfig = (await firestoreGet(env, uid, 'config/zke', idToken)) || {};
    }
    const isClientZke = zkeConfig.mode === 'client' || request.url.includes('client=true') || clientUpload;
    const isServerZke = !isClientZke; // Default to server mode

    const key = isServerZke ? await getEncryptionKey(env, uid, idToken) : null;
    const isEncryptedByServer = key !== null;
    
    const checksumFromHeader = request.headers.get('x-immich-checksum');
    let checksum = (formData.get('checksum') as string) || (formData.get('xImmichChecksum') as string) || checksumFromHeader || '';

    // The Immich mobile app NEVER sends a checksum at upload time — its server is
    // expected to compute base64(SHA-1(fileBytes)) itself. Without it: (a)
    // /api/assets/bulk-upload-check can never match → the app re-uploads the
    // whole library on every restart (the "upload storm"), and (b) sync emits a
    // non-matching checksum → the app shows the phone-local copy AND the server
    // copy side by side ("every photo twice"). Compute it from the plaintext we
    // hold here. Streamed in slices so a large video never blows the memory cap.
    if (!checksum && file) {
      try {
        checksum = await sha1Base64OfFile(file);
      } catch (e: any) {
        console.warn(`[Upload] checksum compute failed for ${file?.name}: ${e?.message}`);
      }
    }

    // Parse dimensions
    let width = parseInt(formData.get('width') as string) || 0;
    let height = parseInt(formData.get('height') as string) || 0;
    // GPS coordinates — client may supply these; server-side path also extracts from JPEG EXIF below
    const parseCoord = (s: string | null) => { const n = parseFloat(s || ''); return isNaN(n) ? null : n; };
    let gpsLat: number | null = parseCoord(formData.get('latitude') as string | null);
    let gpsLon: number | null = parseCoord(formData.get('longitude') as string | null);
    // Camera/lens/exposure metadata parsed from the file's EXIF in chunk 0 below.
    let exif: PhotoExif = {};
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

    // Authoritative live-photo link from the (mobile) client: the app uploads
    // the MOV first, then the still with livePhotoVideoId = the video's asset
    // id. Read BEFORE the dedup check so a retried still can backfill the link
    // onto its existing row (otherwise the link is lost and the motion video
    // shows up as a separate timeline item).
    const livePhotoVideoId = (formData.get('livePhotoVideoId') as string) || null;

    // ── Deduplication check ──────────────────────────────────────────────────
    // Run BEFORE any Telegram work. When the Immich mobile app reopens it
    // retries every asset whose status it doesn't know — `deviceAssetId +
    // deviceId` is the stable phone-local identity it sends on every upload.
    // Live-photo pairs share the SAME deviceAssetId (both the MOV and the
    // still use asset.localId); we discriminate by media kind (video vs not)
    // so we never return the wrong half of a live pair as a duplicate.
    if (env.DB) {
      await ensureDeduplicationSchema(env.DB);
      const adapter = new D1Adapter(env.DB);
      const isVideoMime = mimeType.startsWith('video/');

      // Primary: deviceAssetId+deviceId (set on every mobile upload)
      if (deviceAssetId && deviceId) {
        const existing = await adapter.getPhotoByDeviceAsset(uid, deviceAssetId, deviceId, isVideoMime);
        if (existing) {
          // Self-healing backfill: rows uploaded before checksum-on-upload existed
          // have an empty checksum, which keeps the storm alive (bulk-upload-check
          // can't match) and keeps the photo showing twice (sync can't merge). The
          // storm re-sends the bytes here, so seize the moment to populate it.
          if (!existing.checksum && checksum) {
            try {
              await adapter.updatePhoto(existing.id, { checksum });
              existing.checksum = checksum;
              console.log(`[Upload] Backfilled checksum for ${existing.id} uid=${uid}`);
            } catch (e: any) {
              console.warn(`[Upload] checksum backfill failed for ${existing.id}: ${e?.message}`);
            }
          }
          // Link backfill: the app retries a still whose first upload happened
          // before its motion video existed (or whose response was lost). The
          // retry carries the authoritative livePhotoVideoId — store it, or the
          // motion video stays unhidden as a duplicate timeline item.
          if (livePhotoVideoId && !existing.livePhotoVideoId && !isVideoMime) {
            try {
              await adapter.updatePhoto(existing.id, { livePhotoVideoId });
              existing.livePhotoVideoId = livePhotoVideoId;
              console.log(`[Upload] Backfilled livePhotoVideoId for ${existing.id} uid=${uid}`);
            } catch (e: any) {
              console.warn(`[Upload] livePhotoVideoId backfill failed for ${existing.id}: ${e?.message}`);
            }
          }
          console.log(`[Upload] Dedup hit (deviceAsset) for ${deviceAssetId} uid=${uid} — returning ${existing.id}`);
          return json(toAssetResponseDto(D1Adapter.normalizeRow(existing), uid));
        }
      }

      // Fallback: checksum (catches legacy rows that predate the dedup schema
      // and photos where deviceAssetId was not stored). Without this, bulk-upload-check
      // returns 'accept' for those photos → the app re-sends the full file →
      // the worker deduplicates at the upload level instead of wasting the
      // round-trip bandwidth.
      if (checksum) {
        const [match] = await adapter.getPhotosByChecksums(uid, [checksum]);
        if (match) {
          // getPhotosByChecksums returns only id+checksum; load the full row so
          // the response DTO is complete (web reads more than just the id).
          const existing2 = (await adapter.getPhoto(match.id)) || match;
          console.log(`[Upload] Dedup hit (checksum) for ${checksum} uid=${uid} — returning ${match.id}`);
          return json(toAssetResponseDto(D1Adapter.normalizeRow(existing2), uid));
        }
      }
    }
    // ── End deduplication check ──────────────────────────────────────────────

    const thumbBase64 = formData.get('thumbData_base64') as string | null;
    // ThumbHash (base64) → instant blur placeholder in the grid. The web client
    // sends one directly; for mobile/server uploads we derive it below from the
    // Telegram-generated thumbnail. Serving + web-render paths already exist.
    let thumbhash = (formData.get('thumbhash') as string) || null;

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
        // Honour client-reported thumbEncrypted so the read path knows whether to decrypt
        const teVal = formData.get('thumbEncrypted');
        if (teVal === 'true' || teVal === '1') thumbEncrypted = true;
    } else {
        // --- Legacy Server-Side Upload Logic ---
        // Define these before the loop so GPS extraction + Strategy 2 can reference them.
        const isVideo = mimeType.startsWith('video/') && !isHeic;
        const isImage = mimeType.startsWith('image/') || isHeic;
        const totalChunks = Math.ceil(fileSize / CHUNK_SIZE);
        const isSingleChunk = totalChunks === 1;
    for (let i = 0; i < totalChunks; i++) {
      const start = i * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, fileSize);
      
      // CRITICAL: Slice the file instead of reading the whole thing into memory
      const chunk = file!.slice(start, end);
      let chunkData = await chunk.arrayBuffer();

      if (i === 0) {
        const buffer = new Uint8Array(chunkData);
        if (width === 0 || height === 0) {
          try {
            const dimensions = sizeOf(buffer);
            if (dimensions) {
              width = dimensions.width || 0;
              height = dimensions.height || 0;
            }
          } catch (e) {
            console.log('Failed to extract dimensions:', e);
          }
        }
        // Extract EXIF (camera, lens, exposure, GPS) — exifr reads only the
        // metadata segments of JPEG AND HEIC, no pixel decode, so it stays
        // within the Worker CPU budget. Best-effort: a parse failure must never
        // break an upload. Client-supplied GPS coords always win.
        if (!isVideo) {
          try {
            exif = await extractExif(buffer);
          } catch (e: any) {
            console.log(`[Upload] EXIF parse failed for ${fileName} (non-fatal): ${e?.message}`);
          }
          if (gpsLat === null && gpsLon === null) {
            if (typeof exif.latitude === 'number' && typeof exif.longitude === 'number') {
              gpsLat = exif.latitude;
              gpsLon = exif.longitude;
            } else if (!isHeic) {
              // Legacy minimal scanner as fallback if exifr found nothing
              const gps = extractJpegGps(buffer);
              if (gps) { gpsLat = gps.latitude; gpsLon = gps.longitude; }
            }
          }
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
      let tgData: any;
      let tgStatus = 200;
      try {
        // Retry on 429 with backoff (tgFetchWithRetry honours Telegram's
        // retry_after). A big batch upload fires many sends per photo (blob +
        // thumb), so without this the tail of a batch gets rate-limited and
        // those photos fail. The backoff is the "delay" that kicks in exactly
        // when Telegram throttles.
        const tgRes = await tgFetchWithRetry(`https://api.telegram.org/bot${botToken}/sendDocument`, {
          method: 'POST', body: tgFormData,
        });
        tgStatus = tgRes.status;
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

        // Propagate rate limit so Immich app's own backoff coordinates cross-isolate retries
        if (tgStatus === 429 || tgData.error_code === 429) {
          const retryAfter = tgData.parameters?.retry_after || 5;
          return new Response(JSON.stringify({ message: 'Rate limited by Telegram, retry later' }), {
            status: 429,
            headers: { 'Content-Type': 'application/json', 'Retry-After': String(retryAfter) },
          });
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
    // Thumbnail strategy:
    //   - Encrypted upload: encrypt thumb bytes with the same AES key, push via
    //     sendDocument as opaque .bin so Telegram never sees plaintext. Read
    //     path detects `thumbEncrypted=1` and decrypts before serving.
    //   - Unencrypted upload: send raw via sendPhoto/sendVideo so Telegram
    //     generates a small thumb we can serve directly.
    // Strategy 1: Mobile-provided JPEG thumbnail
    if (!telegramThumbId && thumbBase64) {
      try {
        let thumbBytes: ArrayBuffer = Uint8Array.from(atob(thumbBase64), c => c.charCodeAt(0)).buffer;
        const encryptThumb = isEncryptedByServer && !!key;
        if (encryptThumb) {
          thumbBytes = await encryptChunk(thumbBytes, key!);
        }

        const thumbForm = new FormData();
        thumbForm.append('chat_id', channelId);

        const queue = getTgQueue(botToken);
        await queue.acquire(undefined, 5);
        try {
          if (encryptThumb) {
            thumbForm.append('document', new Blob([thumbBytes], { type: 'application/octet-stream' }), 'thumb.bin');
            const r = await fetch(`https://api.telegram.org/bot${botToken}/sendDocument`, { method: 'POST', body: thumbForm });
            const j = await r.json() as any;
            if (j.ok && j.result?.document?.file_id) {
              telegramThumbId = j.result.document.file_id;
              thumbEncrypted = true;
              console.log(`[Upload] Stored encrypted mobile thumbnail for ${fileName}`);
            } else {
              console.log(`[Upload] encrypted sendDocument thumb failed:`, JSON.stringify(j).slice(0, 200));
            }
          } else {
            thumbForm.append('photo', new Blob([thumbBytes], { type: 'image/jpeg' }), 'thumb.jpg');
            const r = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, { method: 'POST', body: thumbForm });
            const j = await r.json() as any;
            if (j.ok && j.result.photo?.length > 0) {
              telegramThumbId = j.result.photo[0].file_id;
              console.log(`[Upload] Stored mobile thumbnail for ${fileName}`);
            } else {
              console.log(`[Upload] sendPhoto failed for mobile thumb:`, JSON.stringify(j).slice(0, 200));
            }
          }
        } finally { queue.release(); }
      } catch (e) {
        console.log('[Upload] Mobile thumbnail upload failed:', e);
      }
    }

    // Strategy 2: derive a thumb from the raw file — ONLY for non-HEIC images.
    // HEIC and video are deliberately skipped here: Telegram can't thumbnail
    // HEIC (the temp-send produces nothing — pure wasted Telegram ops + pacing
    // delay), and at auto-backup scale that wasted work timed out the worker and
    // triggered Cloudflare 5xx. The Utilities "Fix" tool handles HEIC + video
    // thumbnails client-side instead, so these uploads just store the blob and
    // return fast.
    if (!telegramThumbId && isImage && !isHeic && !isVideo && isSingleChunk && file) {
      try {
        const rawSlice = file.slice(0, Math.min(file.size, CHUNK_SIZE));
        const rawData = await rawSlice.arrayBuffer();

        const thumbForm = new FormData();
        thumbForm.append('chat_id', channelId);

        const queue = getTgQueue(botToken);
        await queue.acquire(undefined, 5);
        try {
          if (isEncryptedByServer && key) {
            // Real downscaled thumbnail for ENCRYPTED (mobile) uploads.
            // Sending the encrypted blob to Telegram yields no thumbnail (random
            // bytes), so briefly send the *plaintext* original, let Telegram
            // produce a small JPEG thumb (sendPhoto re-encode, retried on 429),
            // re-encrypt that thumb as thumb.bin so it's stored zero-knowledge
            // like every other thumb, then DELETE the temp plaintext message —
            // only the encrypted original + encrypted thumb persist. Mobile-only
            // path; the web clientUpload path ships its own thumb and skips this.
            let thumbBytes: ArrayBuffer | null = null;
            let tmpMsgId: number | null = null;
            if (isHeic) {
              // Telegram can't thumbnail HEIC — decode it on the Python backend
              // (real CPU) and get a JPEG back. No Telegram temp-send needed.
              thumbBytes = await convertHeicThumbViaBackend(rawData, idToken);
              if (thumbBytes) console.log(`[Upload] HEIC converted to JPEG via backend for ${fileName}`);
            } else {
              const r = await fetchTelegramThumb(botToken, channelId, rawData, fileName, mimeType);
              thumbBytes = r.thumbBytes;
              tmpMsgId = r.tmpMsgId;
            }

            if (thumbBytes) {
              // Derive a ThumbHash from the small plaintext thumb (cheap JPEG
              // decode) before encrypting — instant blur placeholder for mobile.
              if (!thumbhash) {
                thumbhash = computeThumbHashFromJpeg(new Uint8Array(thumbBytes));
                if (thumbhash) console.log(`[Upload] Derived ThumbHash for ${fileName}`);
              }
              const encThumb = await encryptChunk(thumbBytes, key);
              const encForm = new FormData();
              encForm.append('chat_id', channelId);
              encForm.append('document', new Blob([encThumb], { type: 'application/octet-stream' }), 'thumb.bin');
              const r = await tgFetchWithRetry(`https://api.telegram.org/bot${botToken}/sendDocument`, { method: 'POST', body: encForm });
              const j = await r.json() as any;
              if (j.ok && j.result?.document?.file_id) {
                telegramThumbId = j.result.document.file_id;
                thumbEncrypted = true;
                console.log(`[Upload] Generated + encrypted thumbnail for ${fileName}`);
              } else {
                console.log(`[Upload] thumb.bin sendDocument failed: ${JSON.stringify(j).slice(0, 160)}`);
              }
            } else {
              console.log(`[Upload] No Telegram thumbnail obtained for ${fileName} (mime=${mimeType})`);
            }

            // Remove the temporary plaintext message regardless of outcome.
            if (tmpMsgId) {
              await fetch(`https://api.telegram.org/bot${botToken}/deleteMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: channelId, message_id: tmpMsgId }),
              }).catch(() => { /* best-effort cleanup */ });
            }
          } else if (isVideo) {
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
      thumbhash: thumbhash || undefined,
      livePhotoVideoId: livePhotoVideoId || undefined,
      encryptionMode,
      checksum,
      isHeic: isHeic ? 1 : 0,
      duration: duration || undefined,
      latitude: gpsLat ?? undefined,
      longitude: gpsLon ?? undefined,
      // EXIF camera metadata (undefined fields are dropped by savePhoto).
      // orientation is stored as TEXT — the Immich mobile contract types it as
      // String and Dart's strict parse rejects a number.
      make: exif.make,
      model: exif.model,
      lensModel: exif.lensModel,
      fNumber: exif.fNumber,
      focalLength: exif.focalLength,
      iso: exif.iso,
      exposureTime: exif.exposureTime,
      orientation: exif.orientation !== undefined ? String(exif.orientation) : undefined,
      dateTimeOriginal: exif.dateTimeOriginal,
      // Legacy/server path parsed EXIF above → mark inspected. Client uploads
      // (web) skip parsing here, so leave 0 and let the lazy backfill handle
      // them when they're not client-encrypted.
      exifChecked: clientUpload ? undefined : 1,
      // Dedup fields — stored so future uploads from the same device can be
      // identified as duplicates without re-uploading to Telegram.
      deviceAssetId: deviceAssetId || undefined,
      deviceId: deviceId || undefined,
    };

    if (env.DB) {
      const adapter = new D1Adapter(env.DB);
      await adapter.savePhoto(photo);
    } else {
      await firestoreSet(env, uid, `photos/${assetId}`, photo, idToken);
    }

    // Heuristic pairing is a FALLBACK only. When the app already sent the
    // authoritative livePhotoVideoId (stored above), running the heuristic
    // anyway let a neighbouring still taken within 2s get re-linked to this
    // video, orphaning that still's own motion video — which then showed up
    // in the timeline as a standalone extra video.
    if ((mimeType.startsWith('video/') || isHeic) && !livePhotoVideoId) {
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

// Replace the stored video bytes for an asset with a client-processed version
// (faststart + AAC audio, video stream copied losslessly). Chunks + encrypts
// exactly like the upload path, then ATOMICALLY swaps telegramChunks /
// telegramOriginalId / fileSize in a single partial UPDATE (metadata untouched),
// and only then deletes the old chunks — so a mid-upload failure never leaves
// the asset pointing at a mix of old and new chunks.
async function handleReplaceVideo(request: Request, env: Env, uid: string, assetId: string, idToken: string): Promise<Response> {
  const photo = await loadPhotoById(env, uid, assetId, idToken);
  if (!photo) return json({ message: 'Asset not found' }, 404);
  if (!env.DB) return json({ message: 'Not supported without D1' }, 400);

  const config = await getCachedConfig<any>(env, uid, idToken, 'telegram');
  if (!config) return json({ message: 'No config' }, 500);
  const botToken = config.botToken || config.bot_token;
  const channelId = config.channelId || config.channel_id;

  const isServerZke = photo.encryptionMode === 'server' || (photo.encrypted === true && !photo.encryptionMode);
  const isClientZke = photo.encryptionMode === 'client';
  const key = isServerZke ? await getEncryptionKey(env, uid, idToken) : null;

  const form = await request.formData();
  const videoFile = form.get('video') as File | null;
  if (!videoFile) return json({ message: 'No video provided' }, 400);
  const size = videoFile.size;
  const totalChunks = Math.max(1, Math.ceil(size / CHUNK_SIZE));

  // Upload all new chunks first (nothing is swapped until they all succeed).
  const newChunks: Array<{ index: number; message_id: number; file_id: string }> = [];
  let newOriginalId = '';
  for (let i = 0; i < totalChunks; i++) {
    const slice = videoFile.slice(i * CHUNK_SIZE, Math.min((i + 1) * CHUNK_SIZE, size));
    let data: ArrayBuffer = await slice.arrayBuffer();
    if (isServerZke && key) data = await encryptChunk(data, key);
    const partName = (isServerZke || isClientZke)
      ? (totalChunks === 1 ? 'blob.bin' : `blob.bin.part${String(i + 1).padStart(3, '0')}`)
      : (totalChunks === 1 ? videoFile.name : `${videoFile.name}.part${String(i + 1).padStart(3, '0')}`);
    const f = new FormData();
    f.append('chat_id', channelId);
    f.append('document', new Blob([data], { type: 'application/octet-stream' }), partName);
    const res = await tgFetchWithRetry(`https://api.telegram.org/bot${botToken}/sendDocument`, { method: 'POST', body: f });
    const j = await res.json() as any;
    if (!j.ok || !j.result?.document?.file_id) {
      return json({ message: 'Telegram upload failed', chunk: i, details: j }, 502);
    }
    const fid = j.result.document.file_id;
    if (totalChunks === 1) newOriginalId = fid;
    newChunks.push({ index: i, message_id: j.result.message_id, file_id: fid });
  }

  const oldChunks: any[] = Array.isArray(photo.telegramChunks) ? photo.telegramChunks : [];
  const oldOriginalId = photo.telegramOriginalId;

  // Atomic swap: single UPDATE pointing the asset at the new bytes.
  await new D1Adapter(env.DB).updatePhoto(assetId, totalChunks === 1
    ? { telegramChunks: '[]', telegramOriginalId: newOriginalId, fileSize: size }
    : { telegramChunks: JSON.stringify(newChunks), telegramOriginalId: '', fileSize: size });

  // Best-effort cleanup of the old messages (after the swap, so a failure here
  // is harmless — the asset already points at the new chunks).
  const toDelete = [...oldChunks.map((c: any) => c.message_id).filter(Boolean)];
  for (const messageId of toDelete) {
    fetch(`https://api.telegram.org/bot${botToken}/deleteMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: channelId, message_id: messageId }),
    }).catch(() => {});
  }

  console.log(`[ReplaceVideo] ${assetId}: ${totalChunks} chunk(s), ${size} bytes (was originalId=${oldOriginalId})`);
  return json({ success: true, chunks: totalChunks, fileSize: size });
}

async function handleThumbnailUpload(request: Request, env: Env, uid: string, assetId: string, idToken: string): Promise<Response> {
  const photo = await loadPhotoById(env, uid, assetId, idToken);
  if (!photo) return json({ message: 'Asset not found' }, 404);

  const config = await getCachedConfig<any>(env, uid, idToken, 'telegram');
  if (!config) return json({ message: 'No config' }, 500);
  const botToken = config.botToken || config.bot_token;
  const channelId = config.channelId || config.channel_id;

  try {
    const formData = await request.formData();
    const thumbFile = formData.get('thumbnail') as File | null;
    const thumbBase64 = formData.get('thumbData_base64') as string | null;
    // Client-computed ThumbHash (base64) accompanying the thumbnail. Storing it
    // also changes the timeline payload's thumbhash → the thumbnail URL's
    // cacheKey changes → clients refetch the new thumb (built-in cache-bust).
    const thumbhash = (formData.get('thumbhash') as string) || null;
    const uploadedWidth = parseInt(formData.get('width') as string) || 0;
    const uploadedHeight = parseInt(formData.get('height') as string) || 0;
    // Optional full-size JPEG preview. Lets the web viewer load a JPEG instead
    // of decoding the HEIC original (which is slow/fails in browsers). The
    // original HEIC is left untouched for true-original download.
    const previewFile = formData.get('preview') as File | null;
    const previewBytes = previewFile ? await previewFile.arrayBuffer() : null;

    if (!thumbFile && !thumbBase64) {
      return json({ message: 'No thumbnail data provided' }, 400);
    }

    let thumbBytes: ArrayBuffer;
    if (thumbBase64) {
      thumbBytes = Uint8Array.from(atob(thumbBase64), c => c.charCodeAt(0)).buffer;
    } else {
      thumbBytes = await thumbFile!.arrayBuffer();
    }

    // Store the thumb the same way the upload path does: encrypted as thumb.bin
    // for server-ZKE assets (so the client-generated HEIC/backfill thumbnail is
    // zero-knowledge like every other thumb), else a plain Telegram photo.
    const isServerZke = photo.encryptionMode === 'server' || (photo.encrypted === true && !photo.encryptionMode);
    const key = isServerZke ? await getEncryptionKey(env, uid, idToken) : null;

    // Store one image (thumb or preview) the same zero-knowledge way as every
    // other thumb: encrypted as a .bin document for server-ZKE, else a plain
    // Telegram photo. Returns { fileId, encrypted } or null on failure.
    const storeOne = async (bytes: ArrayBuffer): Promise<{ fileId: string; encrypted: boolean } | null> => {
      const queue = getTgQueue(botToken);
      await queue.acquire(undefined, 5);
      try {
        if (isServerZke && key) {
          const enc = await encryptChunk(bytes, key);
          const form = new FormData();
          form.append('chat_id', channelId);
          form.append('document', new Blob([enc], { type: 'application/octet-stream' }), 'thumb.bin');
          const res = await tgFetchWithRetry(`https://api.telegram.org/bot${botToken}/sendDocument`, { method: 'POST', body: form });
          const data = await res.json() as any;
          return data.ok && data.result?.document?.file_id ? { fileId: data.result.document.file_id, encrypted: true } : null;
        }
        const form = new FormData();
        form.append('chat_id', channelId);
        form.append('photo', new Blob([bytes], { type: 'image/jpeg' }), 'thumb.jpg');
        const res = await tgFetchWithRetry(`https://api.telegram.org/bot${botToken}/sendPhoto`, { method: 'POST', body: form });
        const data = await res.json() as any;
        return data.ok && data.result.photo?.length > 0 ? { fileId: data.result.photo[0].file_id, encrypted: false } : null;
      } finally {
        queue.release();
      }
    };

    const thumb = await storeOne(thumbBytes);
    if (!thumb) return json({ message: 'Telegram thumbnail upload failed' }, 500);

    // Partial UPDATE only — never re-INSERT. Patches just the thumbnail/preview
    // columns; ownerId / fileName / fileCreatedAt / all metadata + timestamps
    // stay untouched. (savePhoto's upsert would fail NOT NULL on a partial row.)
    const update: any = { telegramThumbId: thumb.fileId, thumbEncrypted: thumb.encrypted ? 1 : 0 };
    if (thumbhash) update.thumbhash = thumbhash;
    if (uploadedWidth > 0) update.width = uploadedWidth;
    if (uploadedHeight > 0) update.height = uploadedHeight;

    // Optional full-size preview — best-effort; a failed preview must not fail
    // the thumbnail. Served for preview/fullsize requests so web shows a JPEG.
    if (previewBytes) {
      const preview = await storeOne(previewBytes);
      if (preview) {
        update.telegramPreviewId = preview.fileId;
        update.previewEncrypted = preview.encrypted ? 1 : 0;
      }
    }

    if (env.DB) {
      await new D1Adapter(env.DB).updatePhoto(assetId, update);
    } else {
      await firestoreSet(env, uid, `photos/${assetId}`, update, idToken);
    }
    console.log(`[ThumbnailUpload] Stored thumb${update.telegramPreviewId ? '+preview' : ''} for ${assetId}`);

    return json({ success: true, telegramThumbId: thumb.fileId, preview: !!update.telegramPreviewId, thumbhash: thumbhash || null });
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

  if (wantsHighQuality && photo.telegramPreviewId) {
    // A client-generated JPEG preview exists (e.g. from the HEIC fixer) — serve
    // it for full-view requests so the browser never has to decode the HEIC.
    fileId = photo.telegramPreviewId;
  } else if (wantsHighQuality && !isMultiChunk) {
    fileId = photo.telegramOriginalId || photo.telegramThumbId;
  } else {
    fileId = photo.telegramThumbId || photo.telegramPreviewId || photo.telegramOriginalId;
  }

  if (!fileId) {
    return json({ message: 'No file data' }, 404);
  }
  if (isMultiChunk && !photo.telegramThumbId && !wantsHighQuality) {
    return json({ message: 'Thumbnail not available for multi-chunk asset' }, 404);
  }

  const config = await getCachedConfig<any>(env, uid, idToken, 'telegram');
  if (!config) return json({ message: 'No config' }, 500);
  const botToken = config.botToken || config.bot_token;

  const cache = (caches as any).default;
  const cacheKey = `${request.url}`;
  const cachedRes = await cache.match(cacheKey);
  if (cachedRes) return cachedRes;

  const isServerZke = photo.encryptionMode === 'server' || (photo.encrypted === true && !photo.encryptionMode);
  const isClientZke = photo.encryptionMode === 'client';

  // `servingThumb` is true when we end up downloading the small thumb file_id
  // (vs falling back to the original). Thumbs MAY be encrypted — newer
  // encrypted uploads store an opaque .bin via sendDocument and set
  // photo.thumbEncrypted=1. Older encrypted uploads (and all unencrypted
  // uploads) stored a plain JPEG via sendPhoto. Decrypt only when both:
  // server-zke is on AND the stored thumb is flagged encrypted.
  const servingThumb = !!photo.telegramThumbId && fileId === photo.telegramThumbId;
  const servingPreview = !!photo.telegramPreviewId && fileId === photo.telegramPreviewId;
  // Always attempt decryption for server-ZKE photos. The encrypted flag may be 0
  // for clientUpload paths that encrypted but didn't pass the flag through.
  // We try-decrypt and fall back to raw bytes if AES-GCM auth fails (plain JPEG).
  const decryptThis = isServerZke;
  const key = isServerZke ? await getEncryptionKey(env, uid, idToken) : null;
  // Thumb and preview are always JPEG; only the original keeps its real mime
  // (e.g. image/heic). So a served thumb/preview must advertise image/jpeg.
  let mimeType = photo.mimeType;
  if (servingThumb || servingPreview) {
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
    if (decryptThis && key) {
      try {
        responseData = await decryptChunk(responseData, key);
      } catch (e: any) {
        // AES-GCM auth failure → thumb was stored unencrypted (old sendPhoto path or plain thumb).
        // Fall through and serve the raw bytes — they're a valid JPEG already.
        console.warn(`[Thumbnail] ${assetId}: decrypt attempted, thumb not encrypted — serving raw (${e?.message})`);
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

// Answer a HEAD probe for a media endpoint with the headers a GET would send,
// without fetching/decrypting any bytes. Lets native mobile players validate
// the resource (size, type, range support) before they start streaming.
async function handleMediaHead(env: Env, uid: string, assetId: string, idToken: string, path: string): Promise<Response> {
  const photo = await loadPhotoById(env, uid, assetId, idToken);
  if (!photo) return new Response(null, { status: 404 });
  const isThumb = path.endsWith('/thumbnail');
  let mimeType = photo.mimeType || 'application/octet-stream';
  if (isThumb) mimeType = (photo.isHeic || !mimeType.startsWith('image/')) ? 'image/jpeg' : mimeType;
  const headers: Record<string, string> = {
    'Content-Type': mimeType,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=86400',
  };
  // Original/video have a known size; thumbnails are generated so size is unknown.
  if (!isThumb && photo.fileSize) headers['Content-Length'] = String(photo.fileSize);
  return new Response(null, { status: 200, headers });
}

// Exported for range-stitching tests (multi-chunk video playback math).
export async function handleOriginal(request: Request, env: Env, uid: string, assetId: string, idToken: string): Promise<Response> {
  console.log(`[handleOriginal] AssetID: ${assetId}, Path: ${new URL(request.url).pathname}`);
  const photo = await loadPhotoById(env, uid, assetId, idToken);
  if (!photo) return json({ message: 'Not found' }, 404);

  const config = await getCachedConfig<any>(env, uid, idToken, 'telegram');
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
      // RFC 7233 §2.1 suffix-range: "bytes=-N" means last N bytes.
      // The naive `parseInt("", 10) || 0` coerces the empty prefix to 0,
      // serving the FIRST N bytes instead — the wrong data for moov-at-end probes.
      let start: number, end: number;
      if (parts[0] === '') {
        const suffixLen = parseInt(parts[1], 10);
        end = totalSize - 1;
        start = Math.max(0, totalSize - suffixLen);
      } else {
        start = parseInt(parts[0], 10);
        end = parts[1] !== '' ? parseInt(parts[1], 10) : totalSize - 1;
      }

      if (isNaN(start) || isNaN(end) || start < 0 || end >= totalSize || start > end) {
        return json({ message: 'Invalid range', requested: `${start}-${end}`, totalSize }, 416);
      }

      // Cap the served window. Native mobile video players (ExoPlayer/AVPlayer)
      // open playback with `Range: bytes=0-`, i.e. they ask for the ENTIRE file.
      // Fulfilling that allocates `new Uint8Array(totalSize)` below — for a
      // multi-hundred-MB video that blows the Worker's 128MB memory limit and
      // the Worker (and the app's player) crash. Returning a smaller 206 than
      // requested is valid HTTP: the player simply requests the next window.
      // Browsers tolerate it too, so this fixes mobile without regressing web.
      const MAX_RANGE_BYTES = 8 * 1024 * 1024; // 8 MB per response
      if (end - start + 1 > MAX_RANGE_BYTES) end = start + MAX_RANGE_BYTES - 1;

      // Chunk-align large windows: a window that straddles two 19MB chunks
      // costs TWO Telegram downloads before the first byte goes out, which is
      // exactly when mobile players time out (single-chunk videos played fine,
      // multi-chunk ones didn't). Trimming to the current chunk's end keeps
      // every large 206 behind ONE chunk download — and that chunk is cached,
      // so the player's next sequential window is nearly free. Small explicit
      // ranges (≤2MB, e.g. moov probes) still get exactly what they asked for.
      const lastByteOfStartChunk = (Math.floor(start / chunkSize) + 1) * chunkSize - 1;
      if (end > lastByteOfStartChunk && end - start + 1 > 2 * 1024 * 1024) {
        end = lastByteOfStartChunk;
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
      let start: number, end: number;
      if (parts[0] === '') {
        const suffixLen = parseInt(parts[1], 10);
        end = totalSize - 1;
        start = Math.max(0, totalSize - suffixLen);
      } else {
        start = parseInt(parts[0], 10);
        end = parts[1] !== '' ? parseInt(parts[1], 10) : totalSize - 1;
      }

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
    deviceAssetId: photo.deviceAssetId || photo.id || '',
    deviceId: photo.deviceId || '',
    type: isVideo ? 'VIDEO' : 'IMAGE',
    originalFileName: photo.originalFileName || photo.fileName || 'unknown',
    originalMimeType: reportedMime,
    originalPath: `/upload/${id}`,
    fileCreatedAt: photo.fileCreatedAt || photo.uploadedAt || new Date().toISOString(),
    fileModifiedAt: photo.uploadedAt || new Date().toISOString(),
    localDateTime: photo.fileCreatedAt || new Date().toISOString(),
    updatedAt: photo.uploadedAt || new Date().toISOString(),
    isFavorite: !!photo.isFavorite,
    isArchived: photo.visibility === 'archive',
    isTrashed: !!photo.isTrashed,
    isOffline: false,
    isEdited: false,
    hasMetadata: true,
    duration: effectiveDuration,
    ownerId,
    thumbhash: photo.thumbhash || null,
    visibility: photo.visibility || 'timeline',
    exifInfo: {
      make: photo.make || null, model: photo.model || null,
      exifImageWidth: photo.width || 0, exifImageHeight: photo.height || 0,
      fileSizeInByte: photo.fileSize || 0,
      // orientation MUST be a string (or null): the mobile ExifResponseDto types
      // it String? and Dart's strict parse rejects a number.
      orientation: photo.orientation != null ? String(photo.orientation) : null,
      dateTimeOriginal: photo.dateTimeOriginal || photo.fileCreatedAt || null,
      modifyDate: null, timeZone: null, lensModel: photo.lensModel || null,
      fNumber: typeof photo.fNumber === 'number' ? photo.fNumber : null,
      focalLength: typeof photo.focalLength === 'number' ? photo.focalLength : null,
      iso: typeof photo.iso === 'number' ? photo.iso : null,
      exposureTime: photo.exposureTime || null,
      latitude: photo.latitude ?? null, longitude: photo.longitude ?? null, city: photo.city || null,
      state: null, country: photo.country || null, description: photo.description || null,
      projectionType: null, rating: null,
    },
    people: [], tags: [], stack: null, livePhotoVideoId: photo.livePhotoVideoId || null,
    unassignedFaces: [], duplicateId: null, checksum: photo.checksum || '', libraryId: null, profileImagePath: '',
    // --- DaemonClient Drive Metadata ---
    telegramFileId: photo.telegramThumbId || photo.telegramOriginalId,
    telegramOriginalId: photo.telegramOriginalId,
    encryptionMode: photo.encryptionMode || 'off'
  };
}

// ── Dashboard summary (/api/dashboard/summary) ──────────────────────────────
// One cheap round-trip for the accounts-portal launcher: real counts + a few
// recent items for both services. Photo previews ride on thumbhash (a tiny
// base64 blur string already stored per photo) so the dashboard renders REAL
// previews with no authenticated image fetch. All best-effort: a missing files
// table (older worker) or any query error degrades to empty, never 500.
export async function handleDashboardSummary(request: Request, env: Env): Promise<Response> {
  const session = await requireAuth(request, env);
  const uid = session.uid;
  const out: any = { photos: { count: 0, recent: [] }, drive: { count: 0, recent: [] } };
  if (!env.DB) return json(out);

  // Photos — exclude trashed + live-photo companion videos (same rule as sync).
  try {
    const countRow = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM photos
       WHERE ownerId = ? AND (isTrashed = 0 OR isTrashed IS NULL)
         AND id NOT IN (SELECT livePhotoVideoId FROM photos WHERE livePhotoVideoId IS NOT NULL AND ownerId = ?)`
    ).bind(uid, uid).first<{ n: number }>();
    out.photos.count = countRow?.n || 0;

    const recent = await env.DB.prepare(
      `SELECT id, thumbhash, mimeType FROM photos
       WHERE ownerId = ? AND (isTrashed = 0 OR isTrashed IS NULL)
         AND id NOT IN (SELECT livePhotoVideoId FROM photos WHERE livePhotoVideoId IS NOT NULL AND ownerId = ?)
       ORDER BY fileCreatedAt DESC LIMIT 4`
    ).bind(uid, uid).all<{ id: string; thumbhash: string | null; mimeType: string | null }>();
    out.photos.recent = (recent.results || []).map(r => ({
      id: r.id, thumbhash: r.thumbhash || null, isVideo: !!r.mimeType && r.mimeType.startsWith('video/'),
    }));
  } catch (e: any) {
    console.log('[Dashboard] photos summary failed:', e?.message);
  }

  // Drive — files only (folders excluded). Files table may not exist on workers
  // provisioned before Drive shipped.
  try {
    const countRow = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM files WHERE ownerId = ? AND type = 'file'`
    ).bind(uid).first<{ n: number }>();
    out.drive.count = countRow?.n || 0;

    const recent = await env.DB.prepare(
      `SELECT fileName, fileType FROM files WHERE ownerId = ? AND type = 'file'
       ORDER BY uploadedAt DESC LIMIT 6`
    ).bind(uid).all<{ fileName: string; fileType: string | null }>();
    out.drive.recent = (recent.results || []).map(r => ({
      fileName: r.fileName,
      ext: (r.fileName.split('.').pop() || '').toUpperCase().slice(0, 4),
    }));
  } catch (e: any) {
    console.log('[Dashboard] drive summary failed (files table may not exist):', e?.message);
  }

  return json(out);
}

// ── Downloads (/api/download/*) ─────────────────────────────────────────────
// Real implementation of the Immich download contract (was an empty stub, so
// the web "Download" button silently did nothing: /info returned zero archives
// and the loop had nothing to iterate). /info plans the archives; /archive
// streams a STORE-mode ZIP straight from Telegram chunks with backpressure, so
// memory stays one chunk regardless of archive size.
const MAX_ARCHIVE_BYTES = 3.5 * 1024 * 1024 * 1024; // stay under ZIP32's 4 GiB

async function loadOwnedPhotos(env: Env, uid: string, ids: string[]): Promise<any[]> {
  const out: any[] = [];
  // D1 caps bound parameters per statement — query in slices.
  for (let i = 0; i < ids.length; i += 80) {
    const slice = ids.slice(i, i + 80);
    const placeholders = slice.map(() => '?').join(',');
    const rows = await env.DB!.prepare(
      `SELECT * FROM photos WHERE ownerId = ? AND id IN (${placeholders})`
    ).bind(uid, ...slice).all();
    out.push(...(rows.results || []));
  }
  // Preserve the requested order (zip entries should match the selection).
  const byId = new Map(out.map(r => [r.id, r]));
  return ids.map(id => byId.get(id)).filter(Boolean);
}

export async function handleDownload(request: Request, env: Env, path: string): Promise<Response> {
  const session = await requireAuth(request, env);
  const uid = session.uid;
  const idToken = session.idToken;
  if (!env.DB) return json({ message: 'Downloads need D1' }, 501);

  if (path === '/api/download/info' && request.method === 'POST') {
    const body = await request.json().catch(() => ({})) as any;
    let ids: string[] = Array.isArray(body.assetIds) ? body.assetIds : [];
    if (!ids.length && body.albumId) {
      const rows = await env.DB.prepare(
        'SELECT assetId FROM album_assets WHERE albumId = ?'
      ).bind(body.albumId).all<{ assetId: string }>();
      ids = (rows.results || []).map(r => r.assetId);
    }
    const photos = await loadOwnedPhotos(env, uid, ids);
    const target = Math.min(Number(body.archiveSize) || MAX_ARCHIVE_BYTES, MAX_ARCHIVE_BYTES);
    const archives: Array<{ size: number; assetIds: string[] }> = [];
    let cur = { size: 0, assetIds: [] as string[] };
    let totalSize = 0;
    for (const p of photos) {
      const sz = p.fileSize || 0;
      if (cur.assetIds.length > 0 && cur.size + sz > target) {
        archives.push(cur);
        cur = { size: 0, assetIds: [] };
      }
      cur.size += sz;
      cur.assetIds.push(p.id);
      totalSize += sz;
    }
    if (cur.assetIds.length > 0) archives.push(cur);
    return json({ totalSize, archives });
  }

  if (path === '/api/download/archive' && request.method === 'POST') {
    const body = await request.json().catch(() => ({})) as any;
    const ids: string[] = Array.isArray(body.assetIds) ? body.assetIds : [];
    const photos = await loadOwnedPhotos(env, uid, ids);
    if (!photos.length) return json({ message: 'No assets found' }, 404);

    const config = await getCachedConfig<any>(env, uid, idToken, 'telegram');
    const botToken = config?.botToken || config?.bot_token;
    if (!botToken) return json({ message: 'No Telegram config' }, 500);
    // One key fetch for the whole archive (covers server-ZKE photos).
    const anyServerZke = photos.some(p => p.encryptionMode === 'server');
    const key = anyServerZke ? await getEncryptionKey(env, uid, idToken) : null;

    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const pump = async () => {
      const zip = new StoreZipWriter((b) => writer.write(b));
      const usedNames = new Set<string>();
      try {
        for (const photo of photos) {
          // Client-encrypted bytes would zip as unreadable blobs — skip them.
          if (photo.encryptionMode === 'client') continue;
          let chunks: any[] = [];
          if (typeof photo.telegramChunks === 'string') {
            try { chunks = JSON.parse(photo.telegramChunks); } catch { /* legacy */ }
          } else if (Array.isArray(photo.telegramChunks)) {
            chunks = photo.telegramChunks;
          }
          chunks.sort((a, b) => a.index - b.index);
          const fileIds: string[] = chunks.length
            ? chunks.map(c => c.file_id)
            : (photo.telegramOriginalId ? [photo.telegramOriginalId] : []);
          if (!fileIds.length) continue;

          let name = photo.fileName || `${photo.id}.bin`;
          if (usedNames.has(name)) {
            const dot = name.lastIndexOf('.');
            const stem = dot > 0 ? name.slice(0, dot) : name;
            const ext = dot > 0 ? name.slice(dot) : '';
            let n = 2;
            while (usedNames.has(`${stem} (${n})${ext}`)) n++;
            name = `${stem} (${n})${ext}`;
          }
          usedNames.add(name);

          await zip.beginFile(name, new Date(photo.fileCreatedAt || Date.now()));
          for (const fileId of fileIds) {
            const queue = getTgQueue(botToken);
            await queue.acquire(undefined, 10); // downloads: high priority, not paced
            let result;
            try { result = await tgDownloadFile(botToken, fileId); }
            finally { queue.release(); }
            if (!result.ok || !result.data) throw new Error(`chunk download failed: ${result.error}`);
            let data = result.data;
            if (photo.encryptionMode === 'server' && key) data = await decryptChunk(data, key);
            await zip.writeData(new Uint8Array(data));
          }
          await zip.endFile();
        }
        await zip.finish();
        await writer.close();
      } catch (e: any) {
        console.error('[Download] archive stream failed:', e?.message);
        await writer.abort(e).catch(() => {});
      }
    };
    if (env.waitUntil) env.waitUntil(pump()); else pump().catch(() => {});

    return new Response(readable, {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': 'attachment; filename="daemonclient-photos.zip"',
        'Cache-Control': 'no-store',
      },
    });
  }

  return json({ message: 'Download endpoint not found' }, 404);
}

// ── Lazy EXIF backfill ──────────────────────────────────────────────────────
// Photos uploaded before server-side EXIF extraction existed have no camera
// metadata and often no GPS. Instead of requiring a re-upload, sync.ts calls
// this via waitUntil after each sync response: take a few unchecked rows,
// download each photo's FIRST chunk from Telegram, decrypt it when the worker
// holds the key (server-ZKE), parse EXIF and patch the row. Every attempted
// row gets exifChecked=1 so EXIF-less photos (screenshots, client-encrypted
// blobs we can't read) are never downloaded twice. Batches are small and
// sequential so memory stays a single chunk at a time.
let exifBackfillComplete = false;
export async function backfillExifBatch(env: Env, uid: string, idToken: string, batchSize = 6): Promise<void> {
  if (exifBackfillComplete || !env.DB) return;
  try {
    await ensureDeduplicationSchema(env.DB);
    const rows = (await env.DB.prepare(
      `SELECT * FROM photos
       WHERE ownerId = ? AND mimeType LIKE 'image/%'
         AND (exifChecked IS NULL OR exifChecked = 0)
         AND make IS NULL AND dateTimeOriginal IS NULL
         AND (isTrashed = 0 OR isTrashed IS NULL)
       LIMIT ?`
    ).bind(uid, batchSize).all()).results as any[];
    if (!rows || rows.length === 0) {
      exifBackfillComplete = true;
      return;
    }

    const config = await getCachedConfig<any>(env, uid, idToken, 'telegram');
    const botToken = config?.botToken || config?.bot_token;
    if (!botToken) return;
    const adapter = new D1Adapter(env.DB);

    for (const photo of rows) {
      const patch: Record<string, any> = { exifChecked: 1 };
      try {
        let chunks: any[] = [];
        if (typeof photo.telegramChunks === 'string') {
          try { chunks = JSON.parse(photo.telegramChunks); } catch { /* legacy */ }
        } else if (Array.isArray(photo.telegramChunks)) {
          chunks = photo.telegramChunks;
        }
        const firstChunk = chunks.slice().sort((a, b) => a.index - b.index)[0];
        const fileId = firstChunk?.file_id || photo.telegramOriginalId;
        const isServerZke = photo.encryptionMode === 'server';
        const isClientZke = photo.encryptionMode === 'client';
        // Client-encrypted bytes are unreadable here — just mark checked.
        if (fileId && !isClientZke) {
          const key = isServerZke ? await getEncryptionKey(env, uid, idToken) : null;
          if (!isServerZke || key) {
            const queue = getTgQueue(botToken);
            await queue.acquire(undefined, 1); // low priority — never starve user requests
            let result;
            try { result = await tgDownloadFile(botToken, fileId); }
            finally { queue.release(); }
            if (result.ok && result.data) {
              let data = result.data;
              if (isServerZke && key) data = await decryptChunk(data, key);
              const ex = await extractExif(new Uint8Array(data));
              if (ex.make) patch.make = ex.make;
              if (ex.model) patch.model = ex.model;
              if (ex.lensModel) patch.lensModel = ex.lensModel;
              if (typeof ex.fNumber === 'number') patch.fNumber = ex.fNumber;
              if (typeof ex.focalLength === 'number') patch.focalLength = ex.focalLength;
              if (typeof ex.iso === 'number') patch.iso = ex.iso;
              if (ex.exposureTime) patch.exposureTime = ex.exposureTime;
              if (ex.orientation !== undefined) patch.orientation = String(ex.orientation);
              if (ex.dateTimeOriginal) patch.dateTimeOriginal = ex.dateTimeOriginal;
              if (photo.latitude == null && typeof ex.latitude === 'number' && typeof ex.longitude === 'number') {
                patch.latitude = ex.latitude;
                patch.longitude = ex.longitude;
              }
            }
          }
        }
      } catch (e: any) {
        console.log(`[ExifBackfill] ${photo.id} parse failed (marking checked): ${e?.message}`);
      }
      try { await adapter.updatePhoto(photo.id, patch); } catch (e: any) {
        console.log(`[ExifBackfill] ${photo.id} update failed: ${e?.message}`);
      }
    }
    console.log(`[ExifBackfill] processed ${rows.length} photos for uid=${uid}`);
  } catch (e: any) {
    console.log('[ExifBackfill] batch failed (non-fatal):', e?.message);
  }
}

// --- Telegram Fetch with Retry ---
// Per-bot send pacer. Telegram allows ~20 sendDocument / 30s to one chat (and
// ~1 msg/s generally); exceeding it returns a 429 that blocks the WHOLE bot for
// retry_after (up to ~35s). So we serialise sends to >=SEND_INTERVAL_MS apart
// per bot — reserving a future slot so concurrent calls still space out. This
// keeps big background batch uploads under the limit instead of slamming into
// the 429 wall (which is what was failing the tail of a batch). Downloads are
// NOT paced (they don't go through here) so thumbnails stay fast.
// Token-bucket send pacer per bot. Telegram allows ~20 sendDocument / 30s to a
// chat with short bursts tolerated. Strict 1.5s-per-send spacing made a single
// video upload slow (each of its chunks waited 1.5s) and starved foreground
// uploads while a backup ran. A bucket fixes that: SEND_BURST tokens let a
// file's chunks (or a few quick ops) fire immediately, and tokens refill at the
// sustained safe rate. Waits are capped so a send never hangs the worker into a
// 503; overflow falls through to the 429-retry.
const sendBuckets: Record<string, { tokens: number; last: number }> = {};
const SEND_INTERVAL_MS = 1500; // sustained refill: 1 token / 1.5s (~20 per 30s)
const SEND_BURST = 8;          // immediate burst capacity
const MAX_PACE_WAIT_MS = 4000; // never hang a single send longer than this
async function paceSend(botToken: string): Promise<void> {
  const now = Date.now();
  let b = sendBuckets[botToken];
  if (!b) { b = { tokens: SEND_BURST, last: now }; sendBuckets[botToken] = b; }
  const refill = Math.floor((now - b.last) / SEND_INTERVAL_MS);
  if (refill > 0) {
    b.tokens = Math.min(SEND_BURST, b.tokens + refill);
    b.last += refill * SEND_INTERVAL_MS;
  }
  if (b.tokens >= 1) { b.tokens -= 1; return; } // token available → send now
  // Bucket empty: wait for the next token, but never longer than the cap.
  const wait = Math.min(Math.max(b.last + SEND_INTERVAL_MS - now, 0), MAX_PACE_WAIT_MS);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  b.last = Date.now(); // consumed the refilled token
}

// Only pace true Telegram send calls. Downloads (/file/bot, /getFile) must NOT
// be paced — burning a send token for every thumbnail download was the root cause
// of 503 storms: 20+ concurrent thumb fetches each waited up to 4s for a bucket
// token → worker wall-clock exceeded → CF returned HTML 503 (no CORS) → cascade.
function isSendUrl(url: string): boolean {
  return /\/(send(Document|Photo|Video|Audio|Message)|copyMessage|forwardMessage)/i.test(url);
}

async function tgFetchWithRetry(url: string, options?: RequestInit, maxRetries = 3): Promise<Response> {
  const botToken = url.match(/\/bot([^/]+)\//)?.[1] || '';
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (botToken && isSendUrl(url)) await paceSend(botToken); // SENDS only, not downloads
    const res = await fetch(url, options);
    if (res.status === 429 || res.status === 420) {
      const body = await res.json().catch(() => ({})) as any;
      // Cap the wait: Telegram flood-waits can be 30-60s, and hanging the worker
      // request that long (×retries) overwhelms the isolate → 503. Wait a
      // bounded amount; if it's still limited after retries, return the 429 and
      // let the client re-queue (background backup retries failed photos later).
      const retryAfter = Math.min(body?.parameters?.retry_after || 3, 6);
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
  const now = Date.now();

  // L1: module-level in-memory cache (fastest, same isolate lifetime)
  const mem = filePathCache.get(fileId);
  if (mem && mem.expiresAt > now) {
    return { ok: true, url: `https://api.telegram.org/file/bot${botToken}/${mem.path}` };
  }

  // L2: CF edge cache (persists across worker restarts + shared within PoP)
  const edgeCache = (caches as any).default as Cache;
  const cfCacheKey = `https://dc-tg-path/${fileId}`;
  try {
    const cfHit = await edgeCache.match(cfCacheKey);
    if (cfHit) {
      const path = await cfHit.text();
      filePathCache.set(fileId, { path, expiresAt: now + FILE_PATH_TTL_MS });
      return { ok: true, url: `https://api.telegram.org/file/bot${botToken}/${path}` };
    }
  } catch { /* edge cache unavailable — fall through */ }

  // L3: Telegram API
  const res = await tgFetchWithRetry(`https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`);
  const data = await res.json() as any;
  if (!data.ok) return { ok: false, error: data.description || 'getFile failed' };

  const path = data.result.file_path;
  filePathCache.set(fileId, { path, expiresAt: now + FILE_PATH_TTL_MS });
  try {
    // Cache for 55 min at CF edge (well within Telegram's stated ~1 hr validity)
    edgeCache.put(cfCacheKey, new Response(path, {
      headers: { 'Cache-Control': 'public, max-age=3300' },
    }));
  } catch { /* best-effort */ }

  return { ok: true, url: `https://api.telegram.org/file/bot${botToken}/${path}` };
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

    // Query only the last few uploads (live-photo pairs land within 1-2s of each
    // other). On per-user workers we read straight from D1; the central worker
    // keeps the Firestore filter so the result set stays bounded.
    const fiveSecondsAgo = new Date(Date.now() - 5000).toISOString();
    let recentUploads: any[];
    if (env.DB) {
      const adapter = new D1Adapter(env.DB);
      const rows = await adapter.queryPhotos({ ownerId: uid, orderBy: 'uploadedAt DESC', limit: 20 });
      recentUploads = rows
        .map(D1Adapter.normalizeRow)
        .filter((p: any) => p.uploadedAt >= fiveSecondsAgo);
    } else {
      recentUploads = await firestoreQuery(
        env, uid, 'photos', idToken,
        'uploadedAt', 'DESCENDING', 20,
        [{ field: 'uploadedAt', op: 'GREATER_THAN_OR_EQUAL', value: fiveSecondsAgo }]
      );
    }

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
        // NEVER overwrite an existing link — re-linking an already-paired
        // still orphans its real motion video (shows as a duplicate video).
        if (p.livePhotoVideoId) return false;
        // Live-pair halves share the phone-local deviceAssetId — when both
        // sides carry one, only an exact match qualifies (timestamps alone
        // mis-pair bursts taken within the same 2 seconds).
        if (p.deviceAssetId && photo.deviceAssetId) {
          return p.deviceAssetId === photo.deviceAssetId && p.deviceId === photo.deviceId;
        }
        // Check if timestamps are within 2 seconds
        const timeDiff = Math.abs(
          new Date(p.fileCreatedAt).getTime() - new Date(photo.fileCreatedAt).getTime()
        );
        const withinTime = timeDiff < 2000;
        console.log(`[LivePhoto] Checking ${p._id}: isHeic=${isHeicCandidate}, timeDiff=${timeDiff}ms, withinTime=${withinTime}`);
        return withinTime;
      });

      if (matchingImage) {
        // Update the image to point to this video. updatePhoto (partial UPDATE):
        // savePhoto's upsert would throw NOT NULL (ownerId/fileName) on this
        // partial object before the conflict-update runs, silently failing the link.
        if (env.DB) {
          await new D1Adapter(env.DB).updatePhoto(matchingImage._id, { livePhotoVideoId: assetId });
        } else {
          await firestoreSet(env, uid, `photos/${matchingImage._id}`, {
            livePhotoVideoId: assetId
          }, idToken);
        }
        console.log(`[LivePhoto] ✅ Linked image ${matchingImage._id} to video ${assetId}`);
      } else {
        console.log(`[LivePhoto] ❌ No matching HEIC found for video ${assetId}`);
      }
    } else if (isHeic) {
      // This still already has its authoritative link — nothing to do.
      if (photo.livePhotoVideoId) return;
      // Look for matching MOV video
      console.log(`[LivePhoto] Looking for MOV pair for HEIC ${assetId}`);
      // Videos already claimed by another recent still are off-limits —
      // stealing them orphans that still's motion (duplicate-video bug).
      const claimedVideoIds = new Set(
        recentUploads.map((p: any) => p.livePhotoVideoId).filter(Boolean)
      );
      const matchingVideo = candidatesForLinking.find((p: any) => {
        const isVideoCandidate = p.mimeType?.startsWith('video/');
        if (!isVideoCandidate) return false;
        if (claimedVideoIds.has(p._id)) return false;
        // deviceAssetId is the app's ground-truth pairing key (both halves
        // share it) — when both sides carry one, require the exact match.
        if (p.deviceAssetId && photo.deviceAssetId) {
          return p.deviceAssetId === photo.deviceAssetId && p.deviceId === photo.deviceId;
        }

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
        // Update this image to point to the video. updatePhoto (partial UPDATE):
        // savePhoto's upsert would throw NOT NULL (ownerId/fileName) on this
        // partial object before the conflict-update runs, silently failing the link.
        if (env.DB) {
          await new D1Adapter(env.DB).updatePhoto(assetId, { livePhotoVideoId: matchingVideo._id });
        } else {
          await firestoreSet(env, uid, `photos/${assetId}`, {
            livePhotoVideoId: matchingVideo._id
          }, idToken);
        }
        console.log(`[LivePhoto] ✅ Linked image ${assetId} to video ${matchingVideo._id}`);
      } else {
        console.log(`[LivePhoto] ❌ No matching MOV found for HEIC ${assetId}`);
      }
    }
  } catch (e) {
    console.error('[LivePhoto] Link failed:', e);
  }
}
