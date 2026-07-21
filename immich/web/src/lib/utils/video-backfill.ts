import { rgbaToThumbHash } from 'thumbhash';
import { extractVideoPoster } from './video-poster';

// Used by the Utilities "Fix video thumbnails" tool. For each video asset that
// has no thumbnail (the worker deliberately skips thumb-gen for encrypted videos
// because Telegram can't thumbnail them), the browser extracts a poster frame
// via the native HTMLVideoElement (zero cost, no server-side processing), computes
// a ThumbHash for the blur placeholder, and stores both on the worker via the
// existing /api/assets/:id/thumbnail endpoint.
//
// The original video and all metadata are never touched.

function rgbaThumbhash(imageData: ImageData): string {
  const hash = rgbaToThumbHash(imageData.width, imageData.height, imageData.data);
  let bin = '';
  for (const b of hash) bin += String.fromCharCode(b);
  return btoa(bin);
}

export async function backfillVideoById(assetId: string): Promise<boolean> {
  if (!assetId) return false;
  try {
    // Stream the video via the worker (service worker adds auth + decrypts).
    // We only need the first few seconds for a frame — the video element handles
    // Range requests internally, so we never download the whole file.
    let result = await extractVideoPoster(`/api/assets/${assetId}/video/playback`);
    if (!result) {
      // The browser couldn't decode this codec (e.g. HEVC on non-Safari) — which
      // also means it can't PLAY it, so this video needs both a poster AND a
      // web-playable H.264 rendition. ffmpeg.wasm (its own HEVC decoder + x264)
      // does both from one download. It needs the whole decrypted original
      // (moov atom can be at the end), so point it at /original. Lazy-imported so
      // the ~30MB ffmpeg.wasm only loads when this path is actually hit.
      const { processVideoFfmpeg } = await import('./video-poster-ffmpeg');
      const ff = await processVideoFfmpeg(`/api/assets/${assetId}/original`, { transcode: true });
      result = ff.poster;
      // Store the H.264 rendition so /video/playback can play it everywhere.
      // Best-effort + independent of the poster: a failed/oversized transcode
      // just leaves the video download-only, exactly as before.
      if (ff.playback) {
        try {
          const pf = new FormData();
          pf.append('video', ff.playback, 'playback.mp4');
          const r = await fetch(`/api/assets/${assetId}/playback-rendition`, { method: 'POST', body: pf });
          if (!r.ok) console.warn('[video-backfill] rendition upload HTTP', r.status, assetId);
        } catch (e) {
          console.warn('[video-backfill] rendition upload failed', assetId, e);
        }
      }
    }
    if (!result) return false;

    const { blob: poster, videoWidth, videoHeight } = result;

    // Compute ThumbHash at ≤100px (library requirement).
    const bitmap = await createImageBitmap(poster);
    let thumbhash: string;
    try {
      const s = Math.min(100 / bitmap.width, 100 / bitmap.height, 1);
      const w = Math.max(1, Math.round(bitmap.width * s));
      const h = Math.max(1, Math.round(bitmap.height * s));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(bitmap, 0, 0, w, h);
      thumbhash = rgbaThumbhash(ctx.getImageData(0, 0, w, h));
    } finally {
      bitmap.close?.();
    }

    // Upload thumbnail + thumbhash. We deliberately omit `preview` (no HEIC-style
    // full-res preview needed for video). Forward the video's native dimensions
    // (videoWidth/videoHeight from extractVideoPoster) so the worker stores the
    // correct width/height and video tiles get the right aspect ratio — mirrors
    // how heic-backfill.ts sends width/height.
    const form = new FormData();
    form.append('thumbnail', poster, 'thumb.jpg');
    form.append('thumbhash', thumbhash);
    if (videoWidth > 0) form.append('width', String(videoWidth));
    if (videoHeight > 0) form.append('height', String(videoHeight));

    const res = await fetch(`/api/assets/${assetId}/thumbnail`, { method: 'POST', body: form });
    return res.ok;
  } catch (e) {
    console.warn('[video-backfill] failed', assetId, e);
    return false;
  }
}
