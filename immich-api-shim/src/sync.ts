import type { Env } from './index';
import { requireAuth, firestoreQuery } from './helpers';
import { D1Adapter } from './d1-adapter';

// Fire at most once per Worker isolate lifetime (typically 30 min – a few hours).
// Sync is called every few minutes by the mobile app, so this ensures long-lived
// sessions still get worker updates even when the user never re-logs in.
let lastAutoUpdateAttempt = 0;

export async function handleSyncStream(request: Request, env: Env): Promise<Response> {
  const session = await requireAuth(request, env);

  // Piggy-back the auto-update on sync rather than only on login.
  // Rate-limit to once per isolate to avoid hammering the deployment service.
  const now = Date.now();
  if (env.DEPLOYMENT_SERVICE_URL && env.waitUntil && now - lastAutoUpdateAttempt > 60 * 60 * 1000) {
    lastAutoUpdateAttempt = now;
    env.waitUntil(
      fetch(env.DEPLOYMENT_SERVICE_URL.replace(/\/$/, '') + '/auto-update', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${session.idToken}`, 'Content-Type': 'application/json' },
        body: '{}',
      }).catch(err => console.error('[auto-update/sync] dispatch failed:', err))
    );
  }

  let reqBody: any = {};
  if (request.method === 'POST' && request.headers.get('content-type')?.includes('json')) {
    reqBody = await request.json();
  }

  // Per-user workers (env.DB bound) read from D1; central worker still uses
  // Firestore. Without this branch, sync was always doing a full Firestore
  // collection scan on every page load — adding ~150-300ms to boot even when
  // the user had zero photos.
  // Exclude live-photo companion videos at SQL level so they never appear as
  // separate timeline items regardless of whether livePhotoVideoId is set.
  const photos = env.DB
    ? (await env.DB.prepare(
        `SELECT * FROM photos
         WHERE ownerId = ? AND (isTrashed = 0 OR isTrashed IS NULL)
           AND id NOT IN (SELECT livePhotoVideoId FROM photos WHERE livePhotoVideoId IS NOT NULL AND ownerId = ?)
         ORDER BY fileCreatedAt DESC`
      ).bind(session.uid, session.uid).all()).results.map(D1Adapter.normalizeRow)
    : await firestoreQuery(env, session.uid, 'photos', session.idToken, 'fileCreatedAt', 'DESCENDING');

  // Tombstones: soft-deleted rows (Telegram data gone, D1 row kept with isTrashed=1).
  // Emit AssetDeleteV1 for each so mobile removes them from its local DB on sync.
  const deletedPhotos = env.DB
    ? (await new D1Adapter(env.DB).queryPhotos({ ownerId: session.uid, isTrashed: 1 })).map(D1Adapter.normalizeRow)
    : [];

  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: any) => {
        controller.enqueue(new TextEncoder().encode(JSON.stringify(obj) + '\n'));
      };

      if (reqBody.reset) {
        send({ type: 'SyncResetV1', data: {}, ack: 'SyncResetV1|reset' });
        controller.close();
        return;
      }

      // Pre-flight UserV1 sync to satisfy SQLite Foreign Key constraints for ownerId
      send({
        type: 'UserV1',
        data: {
          id: session.uid,
          email: session.email || 'user@example.com',
          name: (session.email || 'User').split('@')[0],
          avatarColor: 'primary',
          hasProfileImage: false,
          profileChangedAt: new Date().toISOString(),
          deletedAt: null
        },
        ack: `UserV1|${session.uid}`,
        ids: [session.uid]
      });

      // Collect IDs of videos that are live photo companions
      const livePhotoVideoIds = new Set<string>();
      for (const p of photos) {
        if (p?.livePhotoVideoId) livePhotoVideoIds.add(p.livePhotoVideoId);
      }

      const seenChecksums = new Set<string>();
      // Send all assets
      for (const photo of photos) {
        if (!photo) continue;
        // Hide live photo companion videos from sync
        if (livePhotoVideoIds.has(photo._id)) continue;

        // Emit the real checksum so the app can merge the phone's local copy with
        // this remote one (matching base64(SHA-1)). Falling back to _id when it's
        // missing is only to keep the in-sync de-dup key stable for legacy rows
        // that haven't been backfilled yet — those still show twice until the next
        // upload backfills their checksum (see handleUpload).
        const csum = photo.checksum || photo._id;
        if (seenChecksums.has(csum)) continue;
        seenChecksums.add(csum);

        const isVideo = photo.mimeType?.startsWith('video/') || photo.type === 'VIDEO';
        const dateStr = photo.fileCreatedAt || photo.uploadedAt || new Date().toISOString();
        const assetData = {
          id: photo._id,
          deviceAssetId: photo.deviceAssetId || photo._id,
          deviceId: photo.deviceId || '',
          type: isVideo ? 'VIDEO' : 'IMAGE',
          checksum: csum,
          fileCreatedAt: dateStr,
          fileModifiedAt: photo.fileModifiedAt || dateStr,
          deletedAt: null,
          duration: (!photo.duration || photo.duration === '0' || photo.duration === '0.000' || photo.duration === '0:00:00.00000') ? null : photo.duration,
          height: photo.height || 0,
          isEdited: false,
          // MUST be a real boolean: D1 stores isFavorite as INTEGER (0/1).
          // `1 || false` evaluates to the number 1, and the native Dart app's
          // AssetV1.fromJson requires a bool — an int 1 throws in the sync
          // isolate (runInIsolateGentle) and aborts ALL remote sync, so no
          // photos load. `!!` coerces both D1 ints and Firestore bools correctly.
          isFavorite: !!photo.isFavorite,
          libraryId: null,
          livePhotoVideoId: photo.livePhotoVideoId || null,
          localDateTime: dateStr,
          originalFileName: photo.originalFileName || photo.fileName || photo._id,
          ownerId: session.uid,
          stackId: null,
          thumbhash: photo.thumbhash || null,
          visibility: photo.visibility || 'timeline',
          width: photo.width || 0,
        };

        send({
          type: 'AssetV1',
          data: assetData,
          ack: `AssetV1|${photo._id}`,
          ids: [photo._id]
        });
      }

      // Emit delete events for tombstoned assets (isTrashed=1 in D1).
      // Mobile's deleteAssetsV1 handler removes these from its local DB.
      for (const photo of deletedPhotos) {
        if (!photo?._id) continue;
        send({
          type: 'AssetDeleteV1',
          data: { assetId: photo._id },
          ack: `AssetDeleteV1|${photo._id}`,
          ids: [photo._id],
        });
      }

      // Finally send complete
      const nowId = new Date().toISOString();
      send({ type: 'SyncCompleteV1', data: {}, ack: `SyncCompleteV1|${nowId}` });

      controller.close();
    }
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/jsonlines+json',
      'Transfer-Encoding': 'chunked'
    }
  });
}
