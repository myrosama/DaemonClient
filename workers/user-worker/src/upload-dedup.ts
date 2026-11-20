// Early-dedup short-circuit for the upload path. During a big backup session the
// Immich app re-sends every asset whose status it doesn't know — a "storm" of
// retries of already-uploaded files. Normally each retry buffers the whole file
// (memory) and hashes it (CPU) before the dedup check discovers it's a
// duplicate, which is what pushes the free-tier worker over its 128MB/CPU limits
// and returns the 502s seen in big sessions.
//
// This decides, from the (deviceAssetId, deviceId) rows plus a media-kind hint
// — i.e. WITHOUT the file — whether we can safely return the existing asset and
// skip buffering the upload entirely.
//
// Conservative by design: only short-circuit when exactly one settled row
// exists AND it is the same media kind as the incoming upload. The kind check
// is load-bearing: a live-photo pair shares one deviceAssetId and the app
// uploads the MOV before the still, so on the still's FIRST upload the only
// stored row is the video. Kind-blind matching returned the video's DTO and
// silently dropped the still — live photos never appeared in the library.

export type DedupRow = {
  id: string;
  checksum?: string | null;
  mimeType?: string | null;
  livePhotoVideoId?: string | null;
};

export type DedupDecision<T> = { short: true; photo: T } | { short: false };

export function earlyDedupDecision<T extends DedupRow>(
  rows: T[],
  incomingIsVideo: boolean | null,
): DedupDecision<T> {
  if (rows.length !== 1) return { short: false }; // 0 = new asset, >1 = live pair
  if (incomingIsVideo === null) return { short: false }; // unknown kind → precise path
  const row = rows[0];
  if (!row.checksum) return { short: false }; // file needed to backfill the checksum
  if (!row.mimeType) return { short: false }; // can't verify kind → precise path
  const rowIsVideo = row.mimeType.startsWith('video/');
  if (rowIsVideo !== incomingIsVideo) return { short: false }; // other half of a live pair
  return { short: true, photo: row };
}

// Derive the incoming upload's media kind from the metadata fields that arrive
// BEFORE the file part. The mobile uploader's field order is filename,
// deviceAssetId, deviceId, … — so by the time the dedup callback fires the
// filename (extension included; the motion stage is named <still>.mov) is
// available. Extension lists mirror the mime-fix table in the upload handler.
// Unknown/missing → null, which earlyDedupDecision treats as "don't short".
const VIDEO_EXT = new Set(['mp4', 'mov', 'qt', 'avi', 'webm', 'mkv', 'm4v', '3gp']);
const IMAGE_EXT = new Set(['heic', 'heif', 'jpg', 'jpeg', 'png', 'webp', 'gif', 'dng', 'raw', 'tiff', 'tif', 'bmp', 'avif']);

export function videoHintFromFields(fields: Map<string, string>): boolean | null {
  const name = fields.get('filename') || fields.get('fileName') || '';
  const dot = name.lastIndexOf('.');
  if (dot < 0) return null;
  const ext = name.slice(dot + 1).toLowerCase();
  if (VIDEO_EXT.has(ext)) return true;
  if (IMAGE_EXT.has(ext)) return false;
  return null;
}
