import { describe, it, expect } from 'vitest';
import { earlyDedupDecision, videoHintFromFields } from './upload-dedup';

// The early-dedup short-circuit lets a backup-storm RETRY of an already-uploaded
// asset return without the worker ever buffering the file. It must be
// conservative: only short-circuit when the (deviceAssetId, deviceId) maps to
// exactly ONE settled row (has a checksum) AND that row is the same media kind
// as the incoming upload.
//
// The kind check exists because a live-photo pair shares one deviceAssetId: the
// app uploads the MOV first, then the still. On the still's FIRST upload the
// only stored row is the video — kind-blind matching returned the video's DTO
// and silently dropped the still, so live photos never reached the library.

describe('earlyDedupDecision', () => {
  it('falls through when there is no existing row (a genuinely new asset)', () => {
    expect(earlyDedupDecision([], false)).toEqual({ short: false });
  });

  it('short-circuits a settled single image row for an image retry', () => {
    const row = { id: 'p1', checksum: 'abc', mimeType: 'image/jpeg', livePhotoVideoId: null };
    expect(earlyDedupDecision([row], false)).toEqual({ short: true, photo: row });
  });

  it('short-circuits a settled single video row for a video retry', () => {
    const row = { id: 'v1', checksum: 'abc', mimeType: 'video/mp4', livePhotoVideoId: null };
    expect(earlyDedupDecision([row], true)).toEqual({ short: true, photo: row });
  });

  it('REGRESSION: falls through for the first still upload of a live photo (only the motion video row exists)', () => {
    // The app uploads the MOV first (row below), then the still with the SAME
    // deviceAssetId. Short-circuiting here would return the video's DTO and the
    // still would never be stored — the "live photos never upload" bug.
    const motionRow = { id: 'v1', checksum: 'movsum', mimeType: 'video/quicktime', livePhotoVideoId: null };
    expect(earlyDedupDecision([motionRow], false)).toEqual({ short: false });
  });

  it('falls through for a video upload when only the still row exists (inverse kind mismatch)', () => {
    const stillRow = { id: 'p1', checksum: 'stillsum', mimeType: 'image/heic', livePhotoVideoId: 'v1' };
    expect(earlyDedupDecision([stillRow], true)).toEqual({ short: false });
  });

  it('falls through when the incoming media kind is unknown', () => {
    const row = { id: 'p1', checksum: 'abc', mimeType: 'image/jpeg', livePhotoVideoId: null };
    expect(earlyDedupDecision([row], null)).toEqual({ short: false });
  });

  it('falls through when the stored row has no mimeType to compare against', () => {
    const row = { id: 'p1', checksum: 'abc', mimeType: null, livePhotoVideoId: null };
    expect(earlyDedupDecision([row], false)).toEqual({ short: false });
  });

  it('falls through when the row has no checksum (the file is needed to backfill it)', () => {
    expect(earlyDedupDecision([{ id: 'p1', checksum: '', mimeType: 'image/jpeg' }], false)).toEqual({ short: false });
    expect(earlyDedupDecision([{ id: 'p2', mimeType: 'image/jpeg' }], false)).toEqual({ short: false });
  });

  it('falls through when multiple rows share the device id (a settled live-photo pair → precise dedup)', () => {
    expect(earlyDedupDecision([
      { id: 'still', checksum: 'a', mimeType: 'image/jpeg', livePhotoVideoId: 'vid' },
      { id: 'vid', checksum: 'b', mimeType: 'video/mp4', livePhotoVideoId: null },
    ], false)).toEqual({ short: false });
  });
});

describe('videoHintFromFields', () => {
  const f = (entries: Record<string, string>) => new Map(Object.entries(entries));

  it('detects the motion-video stage from the .mov filename field', () => {
    // The app names the motion upload after the still but with the video ext.
    expect(videoHintFromFields(f({ filename: 'IMG_0001.mov' }))).toBe(true);
    expect(videoHintFromFields(f({ filename: 'IMG_0001.MOV' }))).toBe(true);
    expect(videoHintFromFields(f({ filename: 'clip.mp4' }))).toBe(true);
  });

  it('detects the still stage from image filename fields', () => {
    expect(videoHintFromFields(f({ filename: 'IMG_0001.HEIC' }))).toBe(false);
    expect(videoHintFromFields(f({ fileName: 'photo.jpg' }))).toBe(false);
    expect(videoHintFromFields(f({ filename: 'shot.png' }))).toBe(false);
  });

  it('returns null (unknown) when there is no filename field or the extension is unrecognised', () => {
    expect(videoHintFromFields(f({}))).toBe(null);
    expect(videoHintFromFields(f({ filename: 'mystery.xyz' }))).toBe(null);
    expect(videoHintFromFields(f({ filename: 'noext' }))).toBe(null);
  });
});
