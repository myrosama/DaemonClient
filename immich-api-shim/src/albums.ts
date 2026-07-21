import type { Env } from './index';
import { requireAuth, firestoreGet, firestoreSet, firestoreDelete, firestoreQuery, json } from './helpers';
import { D1Adapter } from './d1-adapter';

// Albums live in D1 on per-user workers (tables `albums` + `album_assets`).
// On the central worker (no env.DB) we still go through Firestore for backwards
// compatibility with users who haven't deployed their personal worker yet.
export async function handleAlbums(request: Request, env: Env, path: string): Promise<Response> {
  const session = await requireAuth(request, env);
  const uid = session.uid;
  const idToken = session.idToken;
  const adapter = env.DB ? new D1Adapter(env.DB) : null;

  try {
    if (path === '/api/albums' && request.method === 'GET') {
      // The Sharing page calls /api/albums?shared=true. Real cross-user sharing
      // isn't built yet, so no album is shared — honor the param and return []
      // instead of leaking the whole album list onto the Sharing page.
      const shared = new URL(request.url).searchParams.get('shared');
      if (shared === 'true') return json([]);

      if (adapter) {
        const rows = await adapter.listAlbums();
        const out = await Promise.all(rows.map(async (a) => ({
          ...a,
          assetCount: await adapter.countAlbumAssets(a.id),
          ownerId: uid,
          owner: { id: uid, email: session.email, name: session.email.split('@')[0] },
        })));
        return json(out.map(toAlbumDto));
      }
      const albums = await firestoreQuery(env, uid, 'albums', idToken);
      return json(albums.map((a: any) => toAlbumDto(a)));
    }

    if (path === '/api/albums' && request.method === 'POST') {
      const body = await request.json() as any;
      const albumId = crypto.randomUUID();
      const now = new Date().toISOString();
      const assetIds: string[] = body.assetIds || [];
      const album: any = {
        id: albumId,
        albumName: body.albumName || 'Untitled Album',
        description: body.description || '',
        createdAt: now,
        updatedAt: now,
        albumThumbnailAssetId: assetIds[0] || null,
      };
      if (adapter) {
        await adapter.saveAlbum(album);
        for (const id of assetIds) await adapter.addAssetToAlbum(albumId, id);
      } else {
        await firestoreSet(env, uid, `albums/${albumId}`, {
          ...album,
          assets: assetIds,
          assetCount: assetIds.length,
          ownerId: uid,
        }, idToken);
      }
      return json(toAlbumDto({
        ...album,
        assetCount: assetIds.length,
        ownerId: uid,
        owner: { id: uid, email: session.email, name: session.email.split('@')[0] },
      }), 201);
    }

    const albumMatch = path.match(/^\/api\/albums\/([^/]+)$/);
    if (albumMatch) {
      const albumId = albumMatch[1];

      if (request.method === 'GET') {
        if (adapter) {
          const a = await adapter.getAlbum(albumId);
          if (!a) return json({ message: 'Album not found' }, 404);
          const count = await adapter.countAlbumAssets(albumId);
          return json(toAlbumDto({
            ...a, assetCount: count,
            ownerId: uid,
            owner: { id: uid, email: session.email, name: session.email.split('@')[0] },
          }));
        }
        const album = await firestoreGet(env, uid, `albums/${albumId}`, idToken);
        if (!album) return json({ message: 'Album not found' }, 404);
        return json(toAlbumDto(album));
      }

      if (request.method === 'PATCH') {
        const body = await request.json() as any;
        const updates: any = { id: albumId, updatedAt: new Date().toISOString() };
        if (body.albumName) updates.albumName = body.albumName;
        if (body.description !== undefined) updates.description = body.description;
        if (adapter) {
          const existing = await adapter.getAlbum(albumId);
          if (!existing) return json({ message: 'Album not found' }, 404);
          await adapter.saveAlbum({ ...existing, ...updates });
          const count = await adapter.countAlbumAssets(albumId);
          return json(toAlbumDto({
            ...existing, ...updates,
            assetCount: count, ownerId: uid,
            owner: { id: uid, email: session.email, name: session.email.split('@')[0] },
          }));
        }
        await firestoreSet(env, uid, `albums/${albumId}`, updates, idToken);
        const album = await firestoreGet(env, uid, `albums/${albumId}`, idToken);
        return json(toAlbumDto(album));
      }

      if (request.method === 'DELETE') {
        if (adapter) await adapter.deleteAlbum(albumId);
        else await firestoreDelete(env, uid, `albums/${albumId}`, idToken);
        return new Response(null, { status: 204 });
      }
    }

    const assetsMatch = path.match(/^\/api\/albums\/([^/]+)\/assets$/);
    if (assetsMatch && request.method === 'PUT') {
      const albumId = assetsMatch[1];
      const body = await request.json() as any;
      const ids: string[] = body.ids || [];
      if (adapter) {
        const existing = await adapter.getAlbum(albumId);
        if (!existing) return json({ message: 'Album not found' }, 404);
        for (const id of ids) await adapter.addAssetToAlbum(albumId, id);
        const updated = {
          ...existing,
          albumThumbnailAssetId: existing.albumThumbnailAssetId || ids[0] || null,
          updatedAt: new Date().toISOString(),
        };
        await adapter.saveAlbum(updated);
        const count = await adapter.countAlbumAssets(albumId);
        return json([{ id: albumId, album: toAlbumDto({
          ...updated, assetCount: count, ownerId: uid,
          owner: { id: uid, email: session.email, name: session.email.split('@')[0] },
        }), success: true }]);
      }
      const album = await firestoreGet(env, uid, `albums/${albumId}`, idToken);
      if (!album) return json({ message: 'Album not found' }, 404);
      const set = new Set(album.assets || []);
      ids.forEach((id) => set.add(id));
      const assets = Array.from(set);
      await firestoreSet(env, uid, `albums/${albumId}`, {
        assets,
        assetCount: assets.length,
        albumThumbnailAssetId: assets[0] || album.albumThumbnailAssetId,
        updatedAt: new Date().toISOString(),
      }, idToken);
      const updated = await firestoreGet(env, uid, `albums/${albumId}`, idToken);
      return json([{ id: albumId, album: toAlbumDto(updated), success: true }]);
    }

    if (assetsMatch && request.method === 'DELETE') {
      const albumId = assetsMatch[1];
      const body = await request.json() as any;
      const ids: string[] = body.ids || [];
      if (adapter) {
        for (const id of ids) await adapter.removeAssetFromAlbum(albumId, id);
        const existing = await adapter.getAlbum(albumId);
        if (!existing) return json({ message: 'Album not found' }, 404);
        const updated = { ...existing, updatedAt: new Date().toISOString() };
        await adapter.saveAlbum(updated);
        const count = await adapter.countAlbumAssets(albumId);
        return json([{ id: albumId, album: toAlbumDto({
          ...updated, assetCount: count, ownerId: uid,
          owner: { id: uid, email: session.email, name: session.email.split('@')[0] },
        }), success: true }]);
      }
      const album = await firestoreGet(env, uid, `albums/${albumId}`, idToken);
      if (!album) return json({ message: 'Album not found' }, 404);
      const assets = (album.assets || []).filter((id: string) => !ids.includes(id));
      await firestoreSet(env, uid, `albums/${albumId}`, {
        assets,
        assetCount: assets.length,
        updatedAt: new Date().toISOString(),
      }, idToken);
      const updated = await firestoreGet(env, uid, `albums/${albumId}`, idToken);
      return json([{ id: albumId, album: toAlbumDto(updated), success: true }]);
    }

    // Album sharing subpaths — cross-user sharing isn't built yet (see the
    // design doc). Return SHAPED, non-crashing responses instead of 404 so
    // AlbumOptionsModal / share-with-user flows degrade gracefully.
    //   PUT /api/albums/{id}/users          → addUsersToAlbum  → AlbumResponseDto
    //   PUT/DELETE /api/albums/{id}/user/{userId} → update/remove album user
    const albumUsersMatch = path.match(/^\/api\/albums\/([^/]+)\/users$/);
    if (albumUsersMatch && request.method === 'PUT') {
      const albumId = albumUsersMatch[1];
      // Return the album unchanged with no added users — sharing is a no-op here.
      if (adapter) {
        const a = await adapter.getAlbum(albumId);
        if (a) {
          const count = await adapter.countAlbumAssets(albumId);
          return json(toAlbumDto({
            ...a, assetCount: count, ownerId: uid,
            owner: { id: uid, email: session.email, name: session.email.split('@')[0] },
          }));
        }
      }
      return json(toAlbumDto({ id: albumId, albumName: '', ownerId: uid }));
    }

    const albumUserMatch = path.match(/^\/api\/albums\/([^/]+)\/user\/([^/]+)$/);
    if (albumUserMatch && (request.method === 'PUT' || request.method === 'DELETE')) {
      // Updating/removing a shared album user — no-op, but answer 200 not 404.
      return json({ success: true });
    }

    return json({ message: 'Album endpoint not found' }, 404);
  } catch (err: any) {
    console.error('[handleAlbums] Error:', err.message);
    return json({ message: `Album error: ${err.message}` }, 500);
  }
}

// A COMPLETE UserResponseDto. The Immich mobile app's strict Dart parse
// null-checks required sub-fields (avatarColor, profileImagePath, …), so a
// partial owner ({id,email,name}) crashes AlbumResponseDto.fromJson with
// "Null check operator used on a null value" — which broke album creation.
function completeOwner(owner: any, ownerId: string) {
  const o = owner || {};
  const now = new Date().toISOString();
  const email = o.email || '';
  return {
    id: o.id || ownerId || '',
    email,
    name: o.name || (email ? email.split('@')[0] : 'User'),
    avatarColor: o.avatarColor || 'primary',
    profileImagePath: o.profileImagePath || '',
    profileChangedAt: o.profileChangedAt || now,
    isAdmin: o.isAdmin ?? true,
    isOnboarded: true,
    shouldChangePassword: false,
    createdAt: o.createdAt || now,
    updatedAt: now,
    deletedAt: null,
    oauthId: '',
    quotaSizeInBytes: null,
    quotaUsageInBytes: null,
    status: 'active',
    storageLabel: null,
    license: null,
  };
}

export function toAlbumDto(album: any) {
  const ownerId = album.ownerId || (album.owner && album.owner.id) || '';
  return {
    id: album.id || album._id,
    ownerId, // REQUIRED by AlbumResponseDto — its absence is null-checked → crash
    albumName: album.albumName,
    description: album.description || '',
    createdAt: album.createdAt,
    updatedAt: album.updatedAt,
    albumThumbnailAssetId: album.albumThumbnailAssetId ?? null,
    shared: !!album.shared,
    assetCount: album.assetCount || 0,
    assets: [],
    owner: completeOwner(album.owner, ownerId),
    albumUsers: album.albumUsers || [],
    hasSharedLink: false,
    startDate: null,
    endDate: null,
    lastModifiedAssetTimestamp: null,
    order: 'desc',
    isActivityEnabled: true,
  };
}
