import jpeg from 'jpeg-js';
import { rgbaToThumbHash } from 'thumbhash';

// Nearest-neighbour downscale of an RGBA buffer to (dw x dh). ThumbHash output
// is intentionally blurry, so a cheap sampler is more than good enough and
// keeps Worker CPU negligible.
function downscaleRGBA(src: Uint8Array, sw: number, sh: number, dw: number, dh: number): Uint8Array {
  const out = new Uint8Array(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(sh - 1, Math.floor((y * sh) / dh));
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(sw - 1, Math.floor((x * sw) / dw));
      const si = (sy * sw + sx) * 4;
      const di = (y * dw + x) * 4;
      out[di] = src[si];
      out[di + 1] = src[si + 1];
      out[di + 2] = src[si + 2];
      out[di + 3] = src[si + 3];
    }
  }
  return out;
}

function base64FromBytes(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/**
 * Compute a base64 ThumbHash from JPEG bytes (e.g. the small thumbnail Telegram
 * auto-generates for a mobile upload). ThumbHash requires the source ≤100px on
 * its longest edge, so we decode then downscale. Returns null on any failure —
 * the upload proceeds without a placeholder. Cheap enough for the Worker free
 * CPU budget because the input is already a tiny (~320px) thumbnail.
 */
export function computeThumbHashFromJpeg(bytes: Uint8Array): string | null {
  try {
    const decoded = jpeg.decode(bytes, { useTArray: true, maxResolutionInMP: 5 });
    const { width, height, data } = decoded;
    if (!width || !height) return null;
    const scale = Math.min(100 / width, 100 / height, 1);
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    const rgba = w === width && h === height ? new Uint8Array(data) : downscaleRGBA(new Uint8Array(data), width, height, w, h);
    const hash = rgbaToThumbHash(w, h, rgba);
    return base64FromBytes(hash);
  } catch {
    return null;
  }
}
