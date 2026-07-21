// Early-dedup short-circuit for the upload path. During a big backup session the
// Immich app re-sends every asset whose status it doesn't know — a "storm" of
// retries of already-uploaded files. Normally each retry buffers the whole file
// (memory) and hashes it (CPU) before the dedup check discovers it's a
// duplicate, which is what pushes the free-tier worker over its 128MB/CPU limits
// and returns the 502s seen in big sessions.
//
// This decides, from JUST the (deviceAssetId, deviceId) rows — i.e. WITHOUT the
// file — whether we can safely return the existing asset and skip buffering the
// upload entirely.
//
// Conservative by design: only short-circuit when exactly one settled row
// exists. A live-photo pair shares one deviceAssetId, so any case that might
// need a live-photo link backfill (still + companion video) shows up as TWO
// rows and is routed to the normal upload path, preserving the precise dedup +
// backfill logic exactly.

export type DedupRow = {
  id: string;
  checksum?: string | null;
  mimeType?: string | null;
  livePhotoVideoId?: string | null;
};

export type DedupDecision<T> = { short: true; photo: T } | { short: false };

export function earlyDedupDecision<T extends DedupRow>(rows: T[]): DedupDecision<T> {
  if (rows.length !== 1) return { short: false }; // 0 = new asset, >1 = live pair
  const row = rows[0];
  if (!row.checksum) return { short: false }; // file needed to backfill the checksum
  return { short: true, photo: row };
}
