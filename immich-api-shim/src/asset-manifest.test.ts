import { describe, it, expect } from 'vitest';
import { toAssetManifest } from './asset-manifest';

describe('toAssetManifest', () => {
  it('maps a single-file photo row to a manifest', () => {
    const m = toAssetManifest({
      id: 'a1',
      telegramThumbId: 'THUMB',
      telegramPreviewId: 'PREV',
      telegramOriginalId: 'ORIG',
      telegramChunks: '[]',
      encryptionMode: 'server',
      mimeType: 'image/jpeg',
      fileSize: 1234,
      isHeic: 0,
    });
    expect(m).toEqual({
      thumbId: 'THUMB',
      previewId: 'PREV',
      originalId: 'ORIG',
      chunks: [],
      encryptionMode: 'server',
      mimeType: 'image/jpeg',
      fileSize: 1234,
      isHeic: false,
    });
  });

  it('parses telegramChunks when stored as a JSON string', () => {
    const m = toAssetManifest({
      telegramChunks: JSON.stringify([
        { index: 0, file_id: 'C0', message_id: 10 },
        { index: 1, file_id: 'C1', message_id: 11 },
      ]),
    });
    // message_id is internal — the manifest only needs index + file_id.
    expect(m.chunks).toEqual([
      { index: 0, file_id: 'C0' },
      { index: 1, file_id: 'C1' },
    ]);
  });

  it('accepts telegramChunks already given as an array', () => {
    const m = toAssetManifest({ telegramChunks: [{ index: 0, file_id: 'C0' }] });
    expect(m.chunks).toEqual([{ index: 0, file_id: 'C0' }]);
  });

  it('defaults encryptionMode to off and missing ids to empty strings', () => {
    const m = toAssetManifest({ mimeType: 'video/mp4' });
    expect(m.encryptionMode).toBe('off');
    expect(m.thumbId).toBe('');
    expect(m.previewId).toBe('');
    expect(m.originalId).toBe('');
    expect(m.chunks).toEqual([]);
  });

  it('treats a hei* mimeType as HEIC even when isHeic flag is unset', () => {
    expect(toAssetManifest({ mimeType: 'image/heic' }).isHeic).toBe(true);
    expect(toAssetManifest({ mimeType: 'image/heif' }).isHeic).toBe(true);
  });
});
