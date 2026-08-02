// The lightweight manifest the Photos web service worker needs to read an
// asset's bytes straight from Telegram (through the user's own streaming
// `/proxy`) and decrypt them in the browser. Served by GET
// /api/assets/:id/dc-manifest. Pure + tiny so it stays well within the
// per-user Worker's CPU budget — no bytes, no Telegram round-trips here.

export interface AssetManifest {
  thumbId: string;
  previewId: string;
  originalId: string;
  chunks: Array<{ index: number; file_id: string }>;
  /** H.264 rendition produced by "Fix Videos", when one exists. `handleOriginal`
   *  serves these for /video/playback instead of the (often HEVC) original, so
   *  the client-direct path must be able to do the same — otherwise a repaired
   *  video would silently go back to playing its unsupported source. Absent for
   *  every asset that has no rendition, which today is all of them. */
  playbackChunks?: Array<{ index: number; file_id: string }>;
  /** Plaintext byte length of the rendition; the range arithmetic needs the
   *  size of whatever is actually being served, not the original's. */
  playbackSize?: number;
  encryptionMode: string;
  mimeType: string;
  fileSize: number;
  isHeic: boolean;
}

function parseChunks(raw: any): Array<{ index: number; file_id: string }> {
  const arr = typeof raw === 'string' ? safeParse(raw) : (raw || []);
  return (Array.isArray(arr) ? arr : [])
    .filter((c: any) => c && c.file_id)
    .map((c: any) => ({ index: Number(c.index) || 0, file_id: String(c.file_id) }));
}

export function toAssetManifest(photo: any): AssetManifest {
  const chunks = parseChunks(photo?.telegramChunks);

  // Mirrors handleOriginal's rendition swap for /video/playback.
  let playbackChunks: Array<{ index: number; file_id: string }> | undefined;
  let playbackSize: number | undefined;
  const rawPlayback = photo?.telegramPlaybackChunks;
  if (rawPlayback) {
    try {
      const pb = typeof rawPlayback === 'string' ? safeParse(rawPlayback) : rawPlayback;
      const parsed = parseChunks(pb?.chunks);
      if (parsed.length > 0) {
        playbackChunks = parsed;
        playbackSize = Number(pb?.size) || undefined;
      }
    } catch { /* malformed rendition → fall through to the original */ }
  }

  const mimeType = photo?.mimeType || 'application/octet-stream';
  const isHeic = !!photo?.isHeic || /hei[cf]/i.test(mimeType);

  return {
    thumbId: photo?.telegramThumbId || '',
    previewId: photo?.telegramPreviewId || '',
    originalId: photo?.telegramOriginalId || '',
    chunks,
    ...(playbackChunks ? { playbackChunks } : {}),
    ...(playbackSize ? { playbackSize } : {}),
    encryptionMode: photo?.encryptionMode || 'off',
    mimeType,
    fileSize: Number(photo?.fileSize) || 0,
    isHeic,
  };
}

function safeParse(s: string): any {
  try {
    return JSON.parse(s || '[]');
  } catch {
    return [];
  }
}
