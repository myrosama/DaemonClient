import type { Env } from './index';
import { requireAuth, firestoreQuery, json } from './helpers';
import { D1Adapter } from './d1-adapter';

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

export async function handleTimeline(request: Request, env: Env, path: string, url: URL): Promise<Response> {
  const session = await requireAuth(request, env);

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

  // Collect IDs of videos that are linked as live photo companions
  const livePhotoVideoIds = new Set<string>();
  for (const p of photos) {
    if (p?.livePhotoVideoId) livePhotoVideoIds.add(p.livePhotoVideoId);
  }

  let filtered = photos.filter(p => p !== null);
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

  const targetMonth = timeBucket.substring(0, 7); // "2024-03"

  // Collect IDs of videos that are linked as live photo companions
  const livePhotoVideoIds = new Set<string>();
  for (const p of photos) {
    if (p?.livePhotoVideoId) livePhotoVideoIds.add(p.livePhotoVideoId);
  }

  let filtered = photos.filter(p => {
    if (!p) return false;
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
    isFavorite: filtered.map(p => p.isFavorite || false),
    isImage: filtered.map(p => {
      if (p.mimeType?.startsWith('video/')) return false;
      if (p.type === 'VIDEO') return false;
      return true;
    }),
    isTrashed: filtered.map(p => p.isTrashed || false),
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
