import type { Env } from './index';
import { requireAuth, firestoreGet, firestoreSet, firestoreDelete, firestoreQuery, json } from './helpers';

export async function handleAlbums(request: Request, env: Env, path: string): Promise<Response> {
  const session = await requireAuth(request, env);
  const uid = session.uid;
  const idToken = session.idToken;

  try {
    // GET /api/albums - List all albums
    if (path === '/api/albums' && request.method === 'GET') {
      const albums = await firestoreQuery(env, uid, 'albums', idToken);
      return json(albums.map((a: any) => toAlbumDto(a)));
    }

    // POST /api/albums - Create album
    if (path === '/api/albums' && request.method === 'POST') {
      const body = await request.json() as any;
      const albumId = crypto.randomUUID();
      const album = {
        id: albumId,
        albumName: body.albumName || 'Untitled Album',
        description: body.description || '',
        assets: body.assetIds || [],
        assetCount: (body.assetIds || []).length,
        albumThumbnailAssetId: body.assetIds?.[0] || null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        ownerId: uid,
        owner: { id: uid, email: session.email, name: session.email.split('@')[0] },
        shared: false,
        albumUsers: []
      };
      await firestoreSet(env, uid, `albums/${albumId}`, album, idToken);
      return json(toAlbumDto(album), 201);
    }

    // Album-specific operations
    const albumMatch = path.match(/^\/api\/albums\/([^/]+)$/);
    if (albumMatch) {
      const albumId = albumMatch[1];

      // GET /api/albums/{id}
      if (request.method === 'GET') {
        const album = await firestoreGet(env, uid, `albums/${albumId}`, idToken);
        if (!album) return json({ message: 'Album not found' }, 404);
        return json(toAlbumDto(album));
      }

      // PATCH /api/albums/{id}
      if (request.method === 'PATCH') {
        const body = await request.json() as any;
        const updates: any = { updatedAt: new Date().toISOString() };
        if (body.albumName) updates.albumName = body.albumName;
        if (body.description !== undefined) updates.description = body.description;
        await firestoreSet(env, uid, `albums/${albumId}`, updates, idToken);
        const album = await firestoreGet(env, uid, `albums/${albumId}`, idToken);
        return json(toAlbumDto(album));
      }

      // DELETE /api/albums/{id}
      if (request.method === 'DELETE') {
        await firestoreDelete(env, uid, `albums/${albumId}`, idToken);
        return new Response(null, { status: 204 });
      }
    }

    // PUT /api/albums/{id}/assets
    const assetsMatch = path.match(/^\/api\/albums\/([^/]+)\/assets$/);
    if (assetsMatch && request.method === 'PUT') {
      const albumId = assetsMatch[1];
      const body = await request.json() as any;
      const { ids } = body;

      const album = await firestoreGet(env, uid, `albums/${albumId}`, idToken);
      if (!album) return json({ message: 'Album not found' }, 404);

      const existingAssets = new Set(album.assets || []);
      ids.forEach((id: string) => existingAssets.add(id));
      const assets = Array.from(existingAssets);

      await firestoreSet(env, uid, `albums/${albumId}`, {
        assets,
        assetCount: assets.length,
        albumThumbnailAssetId: assets[0] || album.albumThumbnailAssetId,
        updatedAt: new Date().toISOString()
      }, idToken);

      const updated = await firestoreGet(env, uid, `albums/${albumId}`, idToken);
      return json([{ id: albumId, album: toAlbumDto(updated), success: true }]);
    }

    // DELETE /api/albums/{id}/assets
    const removeAssetsMatch = path.match(/^\/api\/albums\/([^/]+)\/assets$/);
    if (removeAssetsMatch && request.method === 'DELETE') {
      const albumId = removeAssetsMatch[1];
      const body = await request.json() as any;
      const { ids } = body;

      const album = await firestoreGet(env, uid, `albums/${albumId}`, idToken);
      if (!album) return json({ message: 'Album not found' }, 404);

      const assets = (album.assets || []).filter((id: string) => !ids.includes(id));
      await firestoreSet(env, uid, `albums/${albumId}`, {
        assets,
        assetCount: assets.length,
        updatedAt: new Date().toISOString()
      }, idToken);

      const updated = await firestoreGet(env, uid, `albums/${albumId}`, idToken);
      return json([{ id: albumId, album: toAlbumDto(updated), success: true }]);
    }

    return json({ message: 'Album endpoint not found' }, 404);
  } catch (err: any) {
    console.error('[handleAlbums] Error:', err.message);
    return json({ message: `Album error: ${err.message}` }, 500);
  }
}

function toAlbumDto(album: any) {
  return {
    id: album.id || album._id,
    albumName: album.albumName,
    description: album.description || '',
    createdAt: album.createdAt,
    updatedAt: album.updatedAt,
    albumThumbnailAssetId: album.albumThumbnailAssetId,
    shared: album.shared || false,
    assetCount: album.assetCount || 0,
    assets: [], // Full asset list not needed for list view
    owner: album.owner || { id: album.ownerId, email: '', name: '' },
    albumUsers: album.albumUsers || [],
    hasSharedLink: false,
    startDate: null,
    endDate: null,
    isActivityEnabled: true
  };
}
