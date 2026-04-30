import type { Env } from './index';
import { requireAuth, firestoreQuery } from './helpers';
import { D1Adapter } from './d1-adapter';

export async function handleSyncStream(request: Request, env: Env): Promise<Response> {
  const session = await requireAuth(request, env);

  let reqBody: any = {};
  if (request.method === 'POST' && request.headers.get('content-type')?.includes('json')) {
    reqBody = await request.json();
  }

  // Per-user workers (env.DB bound) read from D1; central worker still uses
  // Firestore. Without this branch, sync was always doing a full Firestore
  // collection scan on every page load — adding ~150-300ms to boot even when
  // the user had zero photos.
  const photos = env.DB
    ? (await new D1Adapter(env.DB).queryPhotos({ ownerId: session.uid, orderBy: 'fileCreatedAt DESC' })).map(D1Adapter.normalizeRow)
    : await firestoreQuery(env, session.uid, 'photos', session.idToken, 'fileCreatedAt', 'DESCENDING');

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

      const seenChecksums = new Set();
      // Send all assets
      for (const photo of photos) {
        if (!photo) continue;
        // Hide live photo companion videos from sync
        if (livePhotoVideoIds.has(photo._id)) continue;

        const csum = photo.checksum || photo._id;
        if (seenChecksums.has(csum)) continue;
        seenChecksums.add(csum);

        const isVideo = photo.mimeType?.startsWith('video/') || photo.type === 'VIDEO';
        const dateStr = photo.fileCreatedAt || photo.uploadedAt || new Date().toISOString();
        const assetData = {
          id: photo._id,
          type: isVideo ? 'VIDEO' : 'IMAGE',
          checksum: csum,
          fileCreatedAt: dateStr,
          fileModifiedAt: photo.fileModifiedAt || dateStr,
          deletedAt: null,
          duration: (!photo.duration || photo.duration === '0' || photo.duration === '0.000' || photo.duration === '0:00:00.00000') ? null : photo.duration,
          height: photo.height || 0,
          isEdited: false,
          isFavorite: photo.isFavorite || false,
          libraryId: null,
          livePhotoVideoId: photo.livePhotoVideoId || null,
          localDateTime: dateStr,
          originalFileName: photo.deviceAssetId || photo._id,
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
