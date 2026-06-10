import type { Env } from './index';
import { firestoreQuery, firestoreSet } from './helpers';
import { D1Adapter } from './d1-adapter';

// ── Self-healing live-photo link repair ─────────────────────────────────────
// Earlier code could corrupt pairs in two ways: the heuristic linker re-linked
// already-paired stills (orphaning their real motion video, which then showed
// in the timeline as a duplicate standalone video), and the retroactive linker
// set livePhotoVideoId on VIDEO rows (hiding the still itself). This pass,
// run once per isolate from sync, restores ground truth: live-pair halves
// share the phone's deviceAssetId, so the still's livePhotoVideoId must point
// at the video with the same deviceAssetId+deviceId. Idempotent and cheap
// (one UPDATE + one JOIN per run).
let livePhotoRepairDone = false;
export async function repairLivePhotoLinks(env: Env, uid: string): Promise<void> {
  if (livePhotoRepairDone || !env.DB) return;
  livePhotoRepairDone = true;
  try {
    const adapter = new D1Adapter(env.DB);
    // 1. Video rows must never carry livePhotoVideoId — it puts the STILL's id
    //    into the companion-hiding set and the photo vanishes from sync.
    const poisoned = await env.DB.prepare(
      `UPDATE photos SET livePhotoVideoId = NULL
       WHERE ownerId = ? AND mimeType LIKE 'video/%' AND livePhotoVideoId IS NOT NULL`
    ).bind(uid).run();

    // 2. Dangling pointers (video row deleted) — harmless but keep clean.
    await env.DB.prepare(
      `UPDATE photos SET livePhotoVideoId = NULL
       WHERE ownerId = ? AND livePhotoVideoId IS NOT NULL
         AND livePhotoVideoId NOT IN (SELECT id FROM photos WHERE ownerId = ?)`
    ).bind(uid, uid).run();

    // 3. Restore links from deviceAssetId ground truth: a non-video and a
    //    video sharing deviceAssetId+deviceId are a live pair by definition
    //    (the app uploads both halves under the asset's localId).
    const mismatched = await env.DB.prepare(
      `SELECT s.id AS stillId, v.id AS videoId
       FROM photos s
       JOIN photos v
         ON v.ownerId = s.ownerId
        AND v.deviceAssetId = s.deviceAssetId
        AND v.deviceId = s.deviceId
        AND v.mimeType LIKE 'video/%'
        AND v.id != s.id
       WHERE s.ownerId = ?
         AND s.mimeType NOT LIKE 'video/%'
         AND s.deviceAssetId IS NOT NULL AND s.deviceAssetId != ''
         AND (s.isTrashed = 0 OR s.isTrashed IS NULL)
         AND (v.isTrashed = 0 OR v.isTrashed IS NULL)
         AND (s.livePhotoVideoId IS NULL OR s.livePhotoVideoId != v.id)`
    ).bind(uid).all<{ stillId: string; videoId: string }>();

    let relinked = 0;
    for (const row of mismatched.results || []) {
      await adapter.updatePhoto(row.stillId, { livePhotoVideoId: row.videoId });
      relinked++;
    }
    const cleared = (poisoned.meta as any)?.changes ?? 0;
    if (cleared || relinked) {
      console.log(`[LivePhotoRepair] uid=${uid}: cleared ${cleared} poisoned video links, relinked ${relinked} stills`);
    }
  } catch (e: any) {
    console.log('[LivePhotoRepair] failed (non-fatal):', e?.message);
  }
}

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
          // updatePhoto (partial UPDATE): savePhoto's upsert throws NOT NULL
          // (ownerId/fileName) on these partial objects before the conflict-update
          // runs, which would silently fail the live-photo link.
          // ONLY the still gets livePhotoVideoId. Setting it on the video row
          // too (as this used to) put the STILL's id into the companion-hiding
          // set, so the photo itself vanished from sync/timeline.
          await adapter.updatePhoto(heicImage._id, { livePhotoVideoId: matchingVideo._id });
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
