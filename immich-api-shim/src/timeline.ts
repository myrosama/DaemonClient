import type { Env } from './index';
import { requireAuth, firestoreQuery, firestoreGet, json } from './helpers';
import { D1Adapter } from './d1-adapter';
import { backfillChecksumBatch, backfillHeicThumbBatch } from './assets';

// Per-user workers store photos in D1 (env.DB). The central worker (no D1
// binding) still uses Firestore. Read from whichever is present and normalize
// rows so downstream code can use a single shape (Firestore-style with `_id`).
async function loadPhotos(env: Env, uid: string, idToken: string): Promise<any[]> {
  if (env.DB) {
    const adapter = new D1Adapter(env.DB);
    const rows = await adapter.queryPhotos({ ownerId: uid, orderBy: 'fileCreatedAt DESC' });
    return rows.map(D1Adapter.normalizeRow);
  }
  return firestoreQuery(env, uid, 'photos', idToken, 'fileCreatedAt', 'DESCENDING');
}

// AlbumViewer (and the person/tag detail views) drive their contents through the
// SAME timeline endpoints, narrowed by a query param: ?albumId / ?personId /
// ?tagId. Without honoring these, an album page renders the whole library.
//
// Returns:
//   null  → no facet param present; serve the full library (timeline view).
//   Set   → the set of asset ids the bucket(s) must be intersected with. For an
//           unsupported facet (personId/tagId — we have no people/tags data in
//           the isolated per-user model) this is an EMPTY set, which yields an
//           empty bucket rather than leaking the whole library.
async function facetAssetIds(env: Env, uid: string, idToken: string, url: URL): Promise<Set<string> | null> {
  const albumId = url.searchParams.get('albumId');
  const personId = url.searchParams.get('personId');
  const tagId = url.searchParams.get('tagId');

  if (albumId) {
    if (env.DB) {
      const ids = await new D1Adapter(env.DB).getAlbumAssets(albumId);
      return new Set(ids);
    }
    // Firestore fallback: album doc holds an `assets` array of ids.
    const album = await firestoreGet(env, uid, `albums/${albumId}`, idToken);
    return new Set<string>((album?.assets as string[]) || []);
  }

  // personId / tagId are unsupported facets in the isolated model — return an
  // empty set so the bucket is empty (NOT the whole library).
  if (personId || tagId) return new Set<string>();

  return null;
}

// Round-robin cursor over the background heal jobs — one per request. Module
// scope, so it persists for the isolate's life and successive requests rotate.
let timelineJobCursor = 0;

export async function handleTimeline(request: Request, env: Env, path: string, url: URL): Promise<Response> {
  const session = await requireAuth(request, env);

  // ── Background heal jobs: ONE per request, round-robin ────────────────────
  // Browsing drives the heals too, not just mobile sync — the grid that shows
  // the gaps is what fixes them. But an invocation's ~50 subrequests are SHARED
  // with everything waitUntil spawns, and these two budget 40 and 24 for
  // themselves independently: 64 against a cap of 50, on what is otherwise a
  // trivial request. Cloudflare kills the whole invocation with error 1102, and
  // the user sees the timeline fail rather than the background work.
  //
  // sync.ts has rotated one job per invocation since the same problem was found
  // there; this is that fix applied here. Each job self-guards for completion
  // and overlap, so a finished one costs a single cheap query before bowing out.
  if (env.DB && env.waitUntil) {
    const jobs: Array<{ name: string; run: () => Promise<void> }> = [
      { name: 'ChecksumBackfill', run: () => backfillChecksumBatch(env, session.uid, session.idToken) },
      { name: 'HeicThumbBackfill', run: () => backfillHeicThumbBatch(env, session.uid, session.idToken) },
    ];
    const job = jobs[timelineJobCursor % jobs.length];
    timelineJobCursor++;
    env.waitUntil(
      job.run().catch(err => console.log(`[${job.name}] timeline dispatch failed:`, err?.message))
    );
  }

  if (path === '/api/timeline/buckets') {
    return getTimeBuckets(env, session.uid, session.idToken, url);
  }
  if (path === '/api/timeline/bucket') {
    return getTimeBucket(env, session.uid, session.idToken, url);
  }
  return json({ message: 'Not found' }, 404);
}

async function getTimeBuckets(env: Env, uid: string, idToken: string, url: URL): Promise<Response> {
  const photos = await loadPhotos(env, uid, idToken);

  const isFavorite = url.searchParams.get('isFavorite') === 'true';
  const isTrashed = url.searchParams.get('isTrashed') === 'true';
  const visibility = url.searchParams.get('visibility');

  // Narrow to an album (or empty for unsupported facets) when requested.
  const facetIds = await facetAssetIds(env, uid, idToken, url);

  // Videos that some LIVE still points at. Trashed stills must be excluded
  // from this set: a motion whose still was deleted is no longer anybody's
  // companion, and counting it as one hid it from the timeline while the trash
  // view (which filters on isTrashed) never showed it either — the asset
  // existed but had nowhere to appear.
  const livePhotoVideoIds = new Set<string>();
  for (const p of photos) {
    if (p?.livePhotoVideoId && !p.isTrashed) livePhotoVideoIds.add(p.livePhotoVideoId);
  }

  let filtered = photos.filter(p => p !== null);
  if (facetIds) filtered = filtered.filter(p => facetIds.has(p._id));
  // Hide live photo companion videos from timeline
  filtered = filtered.filter(p => !livePhotoVideoIds.has(p._id));
  if (isFavorite) filtered = filtered.filter(p => p.isFavorite);
  if (isTrashed) filtered = filtered.filter(p => p.isTrashed);
  else filtered = filtered.filter(p => !p.isTrashed);
  if (visibility === 'archive') filtered = filtered.filter(p => p.visibility === 'archive');
  else if (visibility !== 'all') filtered = filtered.filter(p => p.visibility !== 'archive');

  // Group by YYYY-MM-01
  const buckets = new Map<string, number>();
  for (const photo of filtered) {
    const date = photo.fileCreatedAt || photo.uploadedAt || new Date().toISOString();
    const month = date.substring(0, 7) + '-01T00:00:00.000Z';
    buckets.set(month, (buckets.get(month) || 0) + 1);
  }

  const result = Array.from(buckets.entries())
    .map(([timeBucket, count]) => ({ timeBucket, count }))
    .sort((a, b) => b.timeBucket.localeCompare(a.timeBucket));

  return json(result);
}

async function getTimeBucket(env: Env, uid: string, idToken: string, url: URL): Promise<Response> {
  const timeBucket = url.searchParams.get('timeBucket') || '';
  const isFavorite = url.searchParams.get('isFavorite') === 'true';
  const isTrashed = url.searchParams.get('isTrashed') === 'true';

  const photos = await loadPhotos(env, uid, idToken);

  // Narrow to an album (or empty for unsupported facets) when requested.
  const facetIds = await facetAssetIds(env, uid, idToken, url);

  const targetMonth = timeBucket.substring(0, 7); // "2024-03"

  // Same rule as getTimeBuckets: a trashed still's motion is not a companion.
  const livePhotoVideoIds = new Set<string>();
  for (const p of photos) {
    if (p?.livePhotoVideoId && !p.isTrashed) livePhotoVideoIds.add(p.livePhotoVideoId);
  }

  let filtered = photos.filter(p => {
    if (!p) return false;
    if (facetIds && !facetIds.has(p._id)) return false;
    // Hide live photo companion videos
    if (livePhotoVideoIds.has(p._id)) return false;
    const date = p.fileCreatedAt || p.uploadedAt || '';
    return date.substring(0, 7) === targetMonth;
  });

  if (isFavorite) filtered = filtered.filter(p => p.isFavorite);
  if (isTrashed) filtered = filtered.filter(p => p.isTrashed);
  else filtered = filtered.filter(p => !p.isTrashed);

  // Build TimeBucketAssetResponseDto — columnar format
  const result = {
    id: filtered.map(p => p._id),
    city: filtered.map(p => p.city || null),
    country: filtered.map(p => p.country || null),
    duration: filtered.map(p => {
      // Live photos (HEIC with linked MOV) should not report duration — prevents GIF treatment
      if (p.livePhotoVideoId) return null;
      if (!p.duration || p.duration === '0' || p.duration === '0.000' || p.duration === '0:00:00.000000') return null;
      return p.duration;
    }),
    fileCreatedAt: filtered.map(p => p.fileCreatedAt || p.uploadedAt || new Date().toISOString()),
    isFavorite: filtered.map(p => !!p.isFavorite),
    isImage: filtered.map(p => {
      if (p.mimeType?.startsWith('video/')) return false;
      if (p.type === 'VIDEO') return false;
      return true;
    }),
    isTrashed: filtered.map(p => !!p.isTrashed),
    livePhotoVideoId: filtered.map(p => p.livePhotoVideoId || null),
    localOffsetHours: filtered.map(p => p.localOffsetHours || 0),
    ownerId: filtered.map(() => uid),
    projectionType: filtered.map(() => null),
    ratio: filtered.map(p => {
      const w = p.width || 1;
      const h = p.height || 1;
      return w / h;
    }),
    thumbhash: filtered.map(p => p.thumbhash || null),
    visibility: filtered.map(p => p.visibility || 'timeline'),
  };

  return json(result);
}
