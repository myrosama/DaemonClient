import type { Env } from './index';
import { requireAuth, firestoreQuery } from './helpers';

export async function handleSyncStream(request: Request, env: Env): Promise<Response> {
  const session = await requireAuth(request);

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
        send({ type: 'syncResetV1', data: {}, ack: 'syncResetV1|reset' });
        controller.close();
        return;
      }

      // Send all assets
      for (const photo of photos) {
        if (!photo) continue;
        const assetData = {
          id: photo._id,
          deviceAssetId: photo.deviceAssetId || photo._id,
          deviceId: photo.deviceId || 'daemonclient-web',
          type: (photo.type || 'IMAGE') === 'IMAGE' ? 'IMAGE' : 'VIDEO',
          checksum: btoa(photo.checksum || photo._id), // fake base64 checksum
          fileCreatedAt: photo.fileCreatedAt || photo.uploadedAt || new Date().toISOString(),
          fileModifiedAt: photo.fileModifiedAt || photo.uploadedAt || new Date().toISOString(),
          updatedAt: photo.updatedAt || photo.uploadedAt || new Date().toISOString(),
          isFavorite: photo.isFavorite || false,
          isArchived: photo.visibility === 'archive',
          isExternal: false,
          isReadOnly: false,
          isOffline: false,
          isTrashed: photo.isTrashed || false,
          thumbhash: photo.thumbhash || null,
          deletedAt: null,
          ownerId: session.uid,
          libraryId: 'default',
        };

        send({
          type: 'assetV1',
          data: assetData,
          ack: `assetV1|${photo._id}`,
          ids: [photo._id]
        });
      }

      // Finally send complete
      const nowId = new Date().toISOString();
      send({ type: 'syncCompleteV1', data: {}, ack: `syncCompleteV1|${nowId}` });

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
