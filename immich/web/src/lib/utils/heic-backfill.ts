import { rgbaToThumbHash } from 'thumbhash';

// Persists a real server-side thumbnail + ThumbHash for assets the worker
// can't thumbnail itself (HEIC, and HEIC live-photo stills). The decode happens
// in the browser — $0 and scales per-user, no central bottleneck. Used two ways:
//   1. passively, when an HEIC is converted for display in ImageThumbnail; and
//   2. in bulk, from the Utilities "Fix HEIC thumbnails" tool.
// Once stored, every future view (web AND the mobile app) gets an instant
// thumbnail, and the changed ThumbHash naturally busts the old cached URL.

const backfilled = new Set<string>();

async function blobToThumbAndHash(imageBlob: Blob): Promise<{ jpeg: Blob; thumbhash: string }> {
  const bitmap = await createImageBitmap(imageBlob);
  try {
    // Downscaled JPEG thumbnail (≤720px longest edge) — small but sharp.
    const ts = Math.min(720 / bitmap.width, 720 / bitmap.height, 1);
    const tw = Math.max(1, Math.round(bitmap.width * ts));
    const th = Math.max(1, Math.round(bitmap.height * ts));
    const tc = document.createElement('canvas');
    tc.width = tw;
    tc.height = th;
    tc.getContext('2d')!.drawImage(bitmap, 0, 0, tw, th);
    const jpeg = await new Promise<Blob>((resolve, reject) =>
      tc.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/jpeg', 0.8),
    );

    // ThumbHash needs ≤100px on the longest edge.
    const hs = Math.min(100 / bitmap.width, 100 / bitmap.height, 1);
    const hw = Math.max(1, Math.round(bitmap.width * hs));
    const hh = Math.max(1, Math.round(bitmap.height * hs));
    const hc = document.createElement('canvas');
    hc.width = hw;
    hc.height = hh;
    const hctx = hc.getContext('2d')!;
    hctx.drawImage(bitmap, 0, 0, hw, hh);
    const { data } = hctx.getImageData(0, 0, hw, hh);
    const hash = rgbaToThumbHash(hw, hh, data);
    let bin = '';
    for (const b of hash) bin += String.fromCharCode(b);
    return { jpeg, thumbhash: btoa(bin) };
  } finally {
    bitmap.close?.();
  }
}

async function postThumbnail(assetId: string, jpeg: Blob, thumbhash: string): Promise<boolean> {
  const form = new FormData();
  form.append('thumbnail', jpeg, 'thumb.jpg');
  form.append('thumbhash', thumbhash);
  // Relative /api path → the service worker adds auth + routes to the user's worker.
  const res = await fetch(`/api/assets/${assetId}/thumbnail`, { method: 'POST', body: form });
  return res.ok;
}

/**
 * Passive backfill: called with the JPEG already produced by heic2any when an
 * HEIC tile is rendered. Fire-and-forget; deduped per session so we don't
 * re-upload on every re-render before the timeline reloads with the new hash.
 */
export async function backfillFromConvertedBlob(assetId: string, convertedJpeg: Blob): Promise<boolean> {
  if (!assetId || backfilled.has(assetId)) return false;
  backfilled.add(assetId);
  try {
    const { jpeg, thumbhash } = await blobToThumbAndHash(convertedJpeg);
    const ok = await postThumbnail(assetId, jpeg, thumbhash);
    if (!ok) backfilled.delete(assetId);
    return ok;
  } catch (e) {
    backfilled.delete(assetId);
    console.warn('[heic-backfill] passive failed', assetId, e);
    return false;
  }
}

/**
 * Bulk backfill for the Utilities tool: fetch the asset's original (the worker
 * serves the decrypted HEIC), decode it in-browser via heic2any, then store the
 * thumbnail + thumbhash. Heavy (full HEIC decode), so callers must throttle.
 */
export async function backfillAssetById(assetId: string): Promise<boolean> {
  if (!assetId) return false;
  try {
    const res = await fetch(`/api/assets/${assetId}/original`);
    if (!res.ok) return false;
    const blob = await res.blob();
    // HEIC needs heic2any first; other images decode directly via createImageBitmap.
    const head = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
    const txt = String.fromCharCode(...head);
    const isHeic = txt.includes('heic') || txt.includes('heif') || txt.includes('hevc') || txt.includes('mif1');
    let imageBlob: Blob = blob;
    if (isHeic) {
      const module = await import('$lib/utils/heic2any.js');
      const heic2any = (module as any).default || module;
      const converted = await heic2any({ blob, toType: 'image/jpeg' });
      imageBlob = Array.isArray(converted) ? converted[0] : converted;
    }
    const { jpeg, thumbhash } = await blobToThumbAndHash(imageBlob);
    const ok = await postThumbnail(assetId, jpeg, thumbhash);
    if (ok) backfilled.add(assetId);
    return ok;
  } catch (e) {
    console.warn('[heic-backfill] bulk failed', assetId, e);
    return false;
  }
}
