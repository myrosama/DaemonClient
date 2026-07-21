import { describe, it, expect } from 'vitest';
import { earlyDedupDecision } from './upload-dedup';

// The early-dedup short-circuit lets a backup-storm RETRY of an already-uploaded
// asset return without the worker ever buffering the file. It must be
// conservative: only short-circuit when the (deviceAssetId, deviceId) maps to
// exactly ONE settled row (has a checksum). A live-photo pair shares one
// deviceAssetId, so any case that could need a live-photo link backfill has TWO
// rows — caught by the "exactly one" rule and routed to the precise upload path.

describe('earlyDedupDecision', () => {
  it('falls through when there is no existing row (a genuinely new asset)', () => {
    expect(earlyDedupDecision([])).toEqual({ short: false });
  });

  it('short-circuits a settled single image row', () => {
    const row = { id: 'p1', checksum: 'abc', mimeType: 'image/jpeg', livePhotoVideoId: null };
    expect(earlyDedupDecision([row])).toEqual({ short: true, photo: row });
  });

  it('short-circuits a settled single video row', () => {
    const row = { id: 'v1', checksum: 'abc', mimeType: 'video/mp4', livePhotoVideoId: null };
    expect(earlyDedupDecision([row])).toEqual({ short: true, photo: row });
  });

  it('falls through when the row has no checksum (the file is needed to backfill it)', () => {
    expect(earlyDedupDecision([{ id: 'p1', checksum: '', mimeType: 'image/jpeg' }])).toEqual({ short: false });
    expect(earlyDedupDecision([{ id: 'p2', mimeType: 'image/jpeg' }])).toEqual({ short: false });
  });

  it('falls through when multiple rows share the device id (a live-photo pair → precise dedup)', () => {
    expect(earlyDedupDecision([
      { id: 'still', checksum: 'a', mimeType: 'image/jpeg', livePhotoVideoId: 'vid' },
      { id: 'vid', checksum: 'b', mimeType: 'video/mp4', livePhotoVideoId: null },
    ])).toEqual({ short: false });
  });
});
