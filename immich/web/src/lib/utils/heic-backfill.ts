import { rgbaToThumbHash } from 'thumbhash';

// Used by the Utilities "Fix HEIC & missing thumbnails" tool. For each asset
// the worker can't thumbnail itself (HEIC, HEIC live-photo stills), the browser
// decodes it and produces THREE things, which are stored on the worker:
//   - a 720px JPEG thumbnail (fast grid), and its ThumbHash (instant blur), and
//   - a ~2048px high-quality JPEG preview (so the web viewer shows a JPEG
//     instead of decoding the HEIC original — full view loads fast).
// The original HEIC is never touched, so downloads stay true-original and no
// metadata/timestamps change. Decode is on the user's device → $0, scales.

function drawScaled(bitmap: ImageBitmap, maxEdge: number) {
  const s = Math.min(maxEdge / bitmap.width, maxEdge / bitmap.height, 1);
  const w = Math.max(1, Math.round(bitmap.width * s));
  const h = Math.max(1, Math.round(bitmap.height * s));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0, w, h);
  return { canvas, ctx, w, h };
}

function toJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/jpeg', quality),
  );
}

async function deriveAssets(imageBlob: Blob): Promise<{ thumb: Blob; preview: Blob; thumbhash: string }> {
  const bitmap = await createImageBitmap(imageBlob);
  try {
    // 256px @ q0.8 — exactly matches the web uploader's thumbnail size, so
    // fixed-HEIC grid tiles download as fast as normally-uploaded photos
    // (~20KB, not the ~70KB a 720px thumb produced). The full-size preview
    // below is what carries the quality for the detail view.
    const thumb = await toJpeg(drawScaled(bitmap, 256).canvas, 0.8);
    // Near-native resolution, high quality (~2-3MB) so the web full view feels
    // like the real photo. The untouched HEIC original is still what downloads.
    const preview = await toJpeg(drawScaled(bitmap, 4096).canvas, 0.9);
    // ThumbHash needs ≤100px.
    const { ctx, w, h } = drawScaled(bitmap, 100);
    const { data } = ctx.getImageData(0, 0, w, h);
    const hash = rgbaToThumbHash(w, h, data);
    let bin = '';
    for (const b of hash) bin += String.fromCharCode(b);
    return { thumb, preview, thumbhash: btoa(bin) };
  } finally {
    bitmap.close?.();
  }
}

async function postBackfill(assetId: string, thumb: Blob, preview: Blob, thumbhash: string): Promise<boolean> {
  const form = new FormData();
  form.append('thumbnail', thumb, 'thumb.jpg');
  form.append('preview', preview, 'preview.jpg');
  form.append('thumbhash', thumbhash);
  // Relative /api → the service worker adds auth + routes to the user's worker.
  const res = await fetch(`/api/assets/${assetId}/thumbnail`, { method: 'POST', body: form });
  return res.ok;
}

/**
 * Fetch an asset's original, decode it in-browser (HEIC via libheif, others
 * directly), and store a thumbnail + preview + thumbhash on the worker.
 * Heavy (full-image decode), so the caller must run these sequentially.
 */
export async function backfillAssetById(assetId: string): Promise<boolean> {
  if (!assetId) return false;
  try {
    const res = await fetch(`/api/assets/${assetId}/original`);
    if (!res.ok) return false;
    const blob = await res.blob();
    const head = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
    const txt = String.fromCharCode(...head);
    const isHeic = txt.includes('heic') || txt.includes('heif') || txt.includes('hevc') || txt.includes('mif1');
    let imageBlob: Blob = blob;
    if (isHeic) {
      const { decodeHeicToBlob } = await import('$lib/utils/heic-decode');
      imageBlob = await decodeHeicToBlob(blob, 0.95);
    }
    const { thumb, preview, thumbhash } = await deriveAssets(imageBlob);
    return await postBackfill(assetId, thumb, preview, thumbhash);
  } catch (e) {
    console.warn('[heic-backfill] failed', assetId, e);
    return false;
  }
}
