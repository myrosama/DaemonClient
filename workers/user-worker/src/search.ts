import { Env } from './index';
import { requireAuth, firestoreQuery, json, durationToMs } from './helpers';
import { D1Adapter } from './d1-adapter';

// Read from D1 (per-user worker) or Firestore (central worker), normalized
// to the Firestore-style shape the rest of this file expects.
async function loadPhotos(env: Env, uid: string, idToken: string): Promise<any[]> {
  if (env.DB) {
    const adapter = new D1Adapter(env.DB);
    const rows = await adapter.queryPhotos({ ownerId: uid, orderBy: 'fileCreatedAt DESC' });
    return rows.map(D1Adapter.normalizeRow);
  }
  return firestoreQuery(env, uid, 'photos', idToken);
}

export async function handleSearch(request: Request, env: Env, path: string): Promise<Response> {
  if (path === '/api/search/metadata') {
    return handleSearchMetadata(request, env);
  }

  // Everything else under /api/search gets an EMPTY, correctly SHAPED result
  // rather than a 404.
  //
  // These are not hypothetical routes. Web and mobile both call
  // searchSmart, getSearchSuggestions, getExploreData, searchPlaces and
  // getAssetsByCity, and every one of them was getting a 404 — because this
  // handler is dispatched from index.ts BEFORE the catch-all in stubs.ts, so
  // the correctly shaped stubs that already existed at stubs.ts:35-40 were
  // unreachable. The clients then fail on `.length` / `.assets.items` against
  // an error body.
  //
  // Shapes match stubs.ts exactly; there is no smart search, no people and no
  // places in the isolated per-user model, so empty is the honest answer.
  if (path === '/api/search/suggestions') return json([]);
  if (path === '/api/search/explore') return json([]);
  if (path === '/api/search/places') return json([]);
  if (path === '/api/search/cities') return json([]);
  if (path === '/api/search/smart') {
    return json({ assets: { total: 0, count: 0, items: [], facets: [] } });
  }

  return new Response(JSON.stringify({ message: 'Not found' }), { status: 404 });
}

async function handleSearchMetadata(request: Request, env: Env): Promise<Response> {
  const session = await requireAuth(request, env);
  const uid = session.uid;
  const idToken = session.idToken;

  const body = await request.json() as any;
  // The iPhone app speaks Immich v3.2: { filter, size, orderBy, cursor }. The
  // website sends the older flat body below.
  if (body && typeof body.filter === 'object' && body.filter !== null && !Array.isArray(body.filter)) {
    return searchWithFilter(env, uid, idToken, body);
  }
  const query = body.q || '';
  const startDate = body.takenAfter || null;
  const endDate = body.takenBefore || null;
  const isArchived = body.isArchived;
  const isFavorite = body.isFavorite;
  const type = body.type; // 'IMAGE' | 'VIDEO'

  // Deleted photos stay out unless asked for (Immich's `withDeleted`); photos
  // already erased from Telegram never come back.
  let allPhotos = (await loadPhotos(env, uid, idToken))
    .filter((p: any) => !p.purgedAt && (body.withDeleted === true || !p.isTrashed));

  // Filter by text search (filename)
  if (query) {
    const lowerQuery = query.toLowerCase();
    allPhotos = allPhotos.filter((p: any) =>
      p.originalFileName?.toLowerCase().includes(lowerQuery)
    );
  }

  // Filter by date range
  if (startDate) {
    allPhotos = allPhotos.filter((p: any) => p.fileCreatedAt >= startDate);
  }
  if (endDate) {
    allPhotos = allPhotos.filter((p: any) => p.fileCreatedAt <= endDate);
  }

  // Filter by archive status (stored as visibility field: 'archive' or 'timeline')
  if (typeof isArchived === 'boolean') {
    allPhotos = allPhotos.filter((p: any) => {
      const actuallyArchived = p.visibility === 'archive';
      return actuallyArchived === isArchived;
    });
  }

  // Filter by favorite status
  if (typeof isFavorite === 'boolean') {
    allPhotos = allPhotos.filter((p: any) => p.isFavorite === isFavorite);
  }

  // Filter by type
  if (type) {
    allPhotos = allPhotos.filter((p: any) => {
      const isVideo = p.mimeType?.startsWith('video/') || p.type === 'VIDEO' || p.duration;
      if (type === 'VIDEO') return isVideo;
      if (type === 'IMAGE') return !isVideo;
      return true;
    });
  }

  const assets = allPhotos.map((p: any) => toSearchItem(p, uid));

  return json({
    assets: {
      count: assets.length,
      items: assets,
      facets: [],
    },
  });
}

function toSearchItem(p: any, uid: string) {
  return {
    id: p._id,
    deviceAssetId: p.originalFileName,
    ownerId: uid,
    deviceId: 'telegram',
    type: (p.mimeType?.startsWith('video/') || p.type === 'VIDEO' || p.duration) ? 'VIDEO' : 'IMAGE',
    originalPath: p.originalFileName,
    originalFileName: p.originalFileName,
    fileCreatedAt: p.fileCreatedAt,
    fileModifiedAt: p.fileModifiedAt || p.fileCreatedAt,
    localDateTime: p.fileCreatedAt,
    updatedAt: p.uploadedAt,
    isFavorite: !!p.isFavorite,
    isArchived: p.visibility === 'archive',
    isTrashed: !!p.isTrashed,
    duration: p.duration || '0:00:00.000000',
    durationMs: p.livePhotoVideoId ? null : durationToMs(p.duration),
    exifInfo: {
      make: p.exifInfo?.make || null,
      model: p.exifInfo?.model || null,
      exifImageWidth: p.exifInfo?.exifImageWidth || null,
      exifImageHeight: p.exifInfo?.exifImageHeight || null,
      fileSizeInByte: p.exifInfo?.fileSizeInByte || 0,
      orientation: p.exifInfo?.orientation || '1',
      dateTimeOriginal: p.fileCreatedAt,
      timeZone: p.exifInfo?.timeZone || null,
      latitude: p.exifInfo?.latitude || null,
      longitude: p.exifInfo?.longitude || null,
    },
    livePhotoVideoId: p.livePhotoVideoId || null,
    isHeic: !!p.isHeic,
    checksum: p.checksum || p._id,
  };
}

// ── Immich v3.2 filter ──────────────────────────────────────────────────────
// The subset of the filter language the apps use. Each field maps to a value
// on the row; each operator compares it. A field or operator this worker does
// not know matches NOTHING: ignoring it would return the whole library.
const DATE_FIELDS: Record<string, string> = { takenAt: 'fileCreatedAt', createdAt: 'uploadedAt' };
const TEXT_FIELDS = new Set(['city', 'country', 'make', 'model', 'lensModel']);

function fieldValue(p: any, field: string, albumsOf: Map<string, string[]>): { known: boolean; value?: any } {
  if (field in DATE_FIELDS) {
    const t = Date.parse(p[DATE_FIELDS[field]] || '');
    return { known: true, value: Number.isNaN(t) ? null : t };
  }
  if (TEXT_FIELDS.has(field)) return { known: true, value: p[field] ?? null };
  switch (field) {
    case 'type': return { known: true, value: p.mimeType?.startsWith('video/') || p.type === 'VIDEO' ? 'VIDEO' : 'IMAGE' };
    case 'visibility': return { known: true, value: p.visibility || 'timeline' };
    case 'isFavorite': return { known: true, value: !!p.isFavorite };
    case 'isMotion': return { known: true, value: !!p.livePhotoVideoId };
    case 'trashedAt': return { known: true, value: p.isTrashed ? 'trashed' : null };
    case 'originalFileName': return { known: true, value: p.originalFileName || p.fileName || '' };
    case 'albumIds': return { known: true, value: albumsOf.get(p._id) || [] };
    case 'hasAlbums': return { known: true, value: albumsOf.has(p._id) };
    // No people, tags or OCR here: nothing can match them.
    case 'personIds': case 'tagIds': return { known: true, value: [] };
    default: return { known: false };
  }
}

function compare(actual: any, op: string, v: any, isDate: boolean): boolean {
  if (isDate && typeof v === 'string') v = Date.parse(v);
  switch (op) {
    case 'eq': return actual === v;
    case 'ne': return actual !== v;
    case 'gt': return actual != null && actual > v;
    case 'gte': return actual != null && actual >= v;
    case 'lt': return actual != null && actual < v;
    case 'lte': return actual != null && actual <= v;
    case 'like': return typeof actual === 'string' && typeof v === 'string'
      && actual.toLowerCase().includes(v.replace(/%/g, '').toLowerCase());
    case 'any': return Array.isArray(actual) && Array.isArray(v) && v.some((x) => actual.includes(x));
    case 'all': return Array.isArray(actual) && Array.isArray(v) && v.length > 0 && v.every((x) => actual.includes(x));
    default: return false;
  }
}

export function matchesFilter(p: any, filter: Record<string, any>, albumsOf: Map<string, string[]>): boolean {
  // Deleted photos only when the filter asks about them (Immich's default).
  if (!('trashedAt' in filter) && p.isTrashed) return false;
  for (const [field, cond] of Object.entries(filter)) {
    const { known, value } = fieldValue(p, field, albumsOf);
    if (!known || !cond || typeof cond !== 'object') return false;
    const ops = Object.entries(cond);
    if (ops.length === 0) return false;
    for (const [op, v] of ops) if (!compare(value, op, v, field in DATE_FIELDS)) return false;
  }
  return true;
}

async function albumMembership(env: Env, filter: Record<string, any>): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (!env.DB || !('albumIds' in filter || 'hasAlbums' in filter)) return map;
  const rows = await env.DB.prepare('SELECT albumId, assetId FROM album_assets').all<{ albumId: string; assetId: string }>();
  for (const r of rows.results || []) map.set(r.assetId, [...(map.get(r.assetId) || []), r.albumId]);
  return map;
}

async function searchWithFilter(env: Env, uid: string, idToken: string, body: any): Promise<Response> {
  const filter = body.filter as Record<string, any>;
  const albumsOf = await albumMembership(env, filter);
  // Rows already erased from Telegram never come back.
  const rows = (await loadPhotos(env, uid, idToken))
    .filter((p: any) => !p.purgedAt && matchesFilter(p, filter, albumsOf));
  const asc = body.orderBy?.direction === 'asc';
  rows.sort((a: any, b: any) => {
    const d = String(a.fileCreatedAt || '').localeCompare(String(b.fileCreatedAt || ''));
    return asc ? d : -d;
  });
  const size = Math.min(1000, Math.max(1, Number(body.size) || 250));
  const offset = Math.max(0, parseInt(String(body.cursor ?? '0'), 10) || 0);
  const page = rows.slice(offset, offset + size);
  const next = offset + size < rows.length ? String(offset + size) : null;
  return json({
    assets: {
      total: rows.length,
      count: page.length,
      items: page.map((p: any) => toSearchItem(p, uid)),
      facets: [],
      nextCursor: next,
    },
  });
}
