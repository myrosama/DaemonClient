import type { Env } from './index';
import { firestoreQuery, firestoreSet } from './helpers';
import { D1Adapter } from './d1-adapter';

export async function linkExistingLivePhotos(request: Request, env: Env, uid: string, idToken: string): Promise<Response> {
  console.log('[LinkLivePhotos] Starting retroactive linking for user:', uid);

  try {
    const adapter = env.DB ? new D1Adapter(env.DB) : null;
    let allPhotos: any[];
    if (adapter) {
      const rows = await adapter.queryPhotos({ ownerId: uid });
      allPhotos = rows.map(D1Adapter.normalizeRow);
    } else {
      allPhotos = await firestoreQuery(env, uid, 'photos', idToken);
    }
    console.log(`[LinkLivePhotos] Found ${allPhotos.length} total photos`);

    let linkedCount = 0;
    let skippedCount = 0;

    const heicImages = allPhotos.filter((p: any) =>
      (p.isHeic || p.mimeType === 'image/heic' || p.mimeType === 'image/heif') && !p.livePhotoVideoId
    );

    const shortVideos = allPhotos.filter((p: any) => {
      if (!p.mimeType?.startsWith('video/')) return false;
      if (p.linkedAsLivePhoto) return false;
      // Duration must be between 0.5 and 4 seconds (live photo range)
      const dur = parseFloat(p.duration);
      if (!isNaN(dur) && dur >= 0.5 && dur <= 4) return true;
      // If no duration info, check by file extension (MOV files from iPhones)
      const ext = (p.fileName || '').toLowerCase().split('.').pop();
      if (ext === 'mov' && (!p.duration || p.duration === '0' || p.duration === '0.000')) return true;
      return false;
    });

    console.log(`[LinkLivePhotos] Found ${heicImages.length} unlinked HEIC images, ${shortVideos.length} candidate short videos`);

    // Track which videos have been linked to prevent double-linking
    const linkedVideoIds = new Set<string>();

    for (const heicImage of heicImages) {
      const matchingVideo = shortVideos.find((video: any) => {
        if (linkedVideoIds.has(video._id)) return false;
        const timeDiff = Math.abs(
          new Date(video.fileCreatedAt).getTime() - new Date(heicImage.fileCreatedAt).getTime()
        );
        return timeDiff < 2000;
      });

      if (matchingVideo) {
        linkedVideoIds.add(matchingVideo._id);

        if (adapter) {
          await adapter.savePhoto({ id: heicImage._id, livePhotoVideoId: matchingVideo._id });
          await adapter.savePhoto({ id: matchingVideo._id, livePhotoVideoId: heicImage._id });
        } else {
          await firestoreSet(env, uid, `photos/${heicImage._id}`, {
            livePhotoVideoId: matchingVideo._id
          }, idToken);
          await firestoreSet(env, uid, `photos/${matchingVideo._id}`, {
            linkedAsLivePhoto: true
          }, idToken);
        }

        linkedCount++;
        console.log(`[LinkLivePhotos] Linked ${heicImage._id} → ${matchingVideo._id}`);
      } else {
        skippedCount++;
      }
    }

    console.log(`[LinkLivePhotos] Done: ${linkedCount} linked, ${skippedCount} skipped`);

    return new Response(JSON.stringify({
      success: true,
      totalPhotos: allPhotos.length,
      heicImages: heicImages.length,
      shortVideos: shortVideos.length,
      linked: linkedCount,
      skipped: skippedCount
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err: any) {
    console.error('[LinkLivePhotos] Error:', err);
    return new Response(JSON.stringify({
      success: false,
      error: err.message
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
