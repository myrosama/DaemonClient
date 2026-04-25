import type { Env } from './index';
import { requireAuth, firestoreQuery } from './helpers';

export async function handleSyncStream(request: Request, env: Env): Promise<Response> {
  const session = await requireAuth(request, env);

  let reqBody: any = {};
  if (request.method === 'POST' && request.headers.get('content-type')?.includes('json')) {
    reqBody = await request.json();
  }

  // Get assets
  const photos = await firestoreQuery(env, session.uid, 'photos', session.idToken, 'fileCreatedAt', 'DESCENDING');

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

      // Send all assets
      for (const photo of photos) {
        if (!photo) continue;
        const dateStr = photo.fileCreatedAt || photo.uploadedAt || new Date().toISOString();
        const assetData = {
          id: photo._id,
          type: (photo.type || 'IMAGE') === 'IMAGE' ? 'IMAGE' : 'VIDEO',
          checksum: btoa(photo.checksum || photo._id), // fake base64 checksum
          fileCreatedAt: dateStr,
          fileModifiedAt: photo.fileModifiedAt || dateStr,
          deletedAt: null,
          duration: (!photo.duration || photo.duration === '0' || photo.duration === '0.000' || photo.duration === '0:00:00.00000') ? null : photo.duration,
          height: photo.height || 0,
          isEdited: false,
          isFavorite: photo.isFavorite || false,
          libraryId: 'default',
          livePhotoVideoId: null,
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
