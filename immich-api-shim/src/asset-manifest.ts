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
  encryptionMode: string;
  mimeType: string;
  fileSize: number;
  isHeic: boolean;
}

export function toAssetManifest(photo: any): AssetManifest {
  const rawChunks = typeof photo?.telegramChunks === 'string'
    ? safeParse(photo.telegramChunks)
    : (photo?.telegramChunks || []);
  const chunks = (Array.isArray(rawChunks) ? rawChunks : [])
    .filter((c: any) => c && c.file_id)
    .map((c: any) => ({ index: Number(c.index) || 0, file_id: String(c.file_id) }));

  const mimeType = photo?.mimeType || 'application/octet-stream';
  const isHeic = !!photo?.isHeic || /hei[cf]/i.test(mimeType);

  return {
    thumbId: photo?.telegramThumbId || '',
    previewId: photo?.telegramPreviewId || '',
    originalId: photo?.telegramOriginalId || '',
    chunks,
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
