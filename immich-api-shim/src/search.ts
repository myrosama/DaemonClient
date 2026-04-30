import { Env } from './index';
import { requireAuth, firestoreQuery, json } from './helpers';
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

  return new Response(JSON.stringify({ message: 'Not found' }), { status: 404 });
}

async function handleSearchMetadata(request: Request, env: Env): Promise<Response> {
  const session = await requireAuth(request, env);
  const uid = session.uid;
  const idToken = session.idToken;

  const body = await request.json() as any;
  const query = body.q || '';
  const startDate = body.takenAfter || null;
  const endDate = body.takenBefore || null;
  const isArchived = body.isArchived;
  const isFavorite = body.isFavorite;
  const type = body.type; // 'IMAGE' | 'VIDEO'

  let allPhotos = await loadPhotos(env, uid, idToken);

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

  const assets = allPhotos.map((p: any) => ({
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
    isTrashed: false,
    duration: p.duration || '0:00:00.000000',
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
    isHeic: p.isHeic || false,
    checksum: p.checksum || p._id,
  }));

  return json({
    assets: {
      count: assets.length,
      items: assets,
      facets: [],
    },
  });
}
