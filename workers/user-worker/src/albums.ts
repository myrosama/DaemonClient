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
      const query = new URL(request.url).searchParams;
      const shared = query.get('shared');
      const assetId = query.get('assetId') || undefined;
      // The Immich contract gives assetId precedence over shared.
      if (shared === 'true' && !assetId) return json([]);

      if (adapter) {
        const rows = await adapter.listAlbums(assetId);
        const out = await Promise.all(rows.map(async (a) => ({
          ...a,
          assetCount: await adapter.countAlbumAssets(a.id),
          ownerId: uid,
          owner: { id: uid, email: session.email, name: session.email.split('@')[0] },
        })));
        return json(out.map(toAlbumDto));
      }
      const albums = await firestoreQuery(env, uid, 'albums', idToken);
      const filtered = assetId
        ? albums.filter((a: any) => Array.isArray(a.assets) && a.assets.includes(assetId))
        : albums;
      return json(filtered.map((a: any) => toAlbumDto(a)));
    }

    if (path === '/api/albums' && request.method === 'POST') {
      const body = await request.json() as any;
      const albumId = crypto.randomUUID();
      const now = new Date().toISOString();
      const requestedAssetIds = normalizeIds(body.assetIds);
      const assetIds: string[] = adapter
        ? (await Promise.all(requestedAssetIds.map(async (id) => (await adapter.getPhoto(id)) ? id : null)))
          .filter((id): id is string => id !== null)
        : requestedAssetIds;
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

    if (path === '/api/albums/statistics' && request.method === 'GET') {
      const albums = adapter
        ? await adapter.listAlbums()
        : await firestoreQuery(env, uid, 'albums', idToken);
      return json({ owned: albums.length, shared: 0, notShared: albums.length });
    }

    // This route must be handled before /api/albums/:id because "assets" is
    // otherwise interpreted as an album ID.
    if (path === '/api/albums/assets' && request.method === 'PUT') {
      const body = await request.json() as any;
      const albumIds = normalizeIds(body.albumIds);
      const assetIds = normalizeIds(body.assetIds);
      let added = false;
      let duplicate = false;
      let notFound = false;

      if (adapter) {
        for (const albumId of albumIds) {
          const album = await adapter.getAlbum(albumId);
          if (!album) {
            notFound = true;
            continue;
          }

          const existingIds = new Set(await adapter.getAlbumAssets(albumId));
          const addedIds: string[] = [];
          for (const assetId of assetIds) {
            if (existingIds.has(assetId)) {
              duplicate = true;
              continue;
            }
            if (!await adapter.getPhoto(assetId)) {
              notFound = true;
              continue;
            }
            await adapter.addAssetToAlbum(albumId, assetId);
            existingIds.add(assetId);
            addedIds.push(assetId);
            added = true;
          }
          if (addedIds.length > 0) {
            await adapter.saveAlbum({
              ...album,
              albumThumbnailAssetId: album.albumThumbnailAssetId || addedIds[0],
              updatedAt: new Date().toISOString(),
            });
          }
        }
      } else {
        for (const albumId of albumIds) {
          const album = await firestoreGet(env, uid, `albums/${albumId}`, idToken);
          if (!album) {
            notFound = true;
            continue;
          }

          const existingIds = new Set<string>(Array.isArray(album.assets) ? album.assets : []);
          const addedIds: string[] = [];
          for (const assetId of assetIds) {
            if (existingIds.has(assetId)) {
              duplicate = true;
              continue;
            }
            const asset = await firestoreGet(env, uid, `photos/${assetId}`, idToken);
            if (!asset) {
              notFound = true;
              continue;
            }
            existingIds.add(assetId);
            addedIds.push(assetId);
            added = true;
          }
          if (addedIds.length > 0) {
            const assets = Array.from(existingIds);
            await firestoreSet(env, uid, `albums/${albumId}`, {
              assets,
              assetCount: assets.length,
              albumThumbnailAssetId: album.albumThumbnailAssetId || addedIds[0],
              updatedAt: new Date().toISOString(),
            }, idToken);
          }
        }
      }

      if (added) return json({ success: true });
      return json({
        success: false,
        error: notFound ? 'not_found' : (duplicate ? 'duplicate' : 'unknown'),
      });
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
        if (body.albumName !== undefined) updates.albumName = body.albumName;
        if (body.description !== undefined) updates.description = body.description;
        if (body.albumThumbnailAssetId !== undefined) {
          updates.albumThumbnailAssetId = body.albumThumbnailAssetId;
        }
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
      const ids = normalizeIds(body.ids);
      if (adapter) {
        const existing = await adapter.getAlbum(albumId);
        if (!existing) return json({ message: 'Album not found' }, 404);
        const existingIds = new Set(await adapter.getAlbumAssets(albumId));
        const results: Array<Record<string, unknown>> = [];
        const addedIds: string[] = [];
        for (const id of ids) {
          if (existingIds.has(id)) {
            results.push({ id, success: false, error: 'duplicate' });
          } else if (!await adapter.getPhoto(id)) {
            results.push({ id, success: false, error: 'not_found' });
          } else {
            await adapter.addAssetToAlbum(albumId, id);
            existingIds.add(id);
            addedIds.push(id);
            results.push({ id, success: true });
          }
        }
        const updated = {
          ...existing,
          albumThumbnailAssetId: existing.albumThumbnailAssetId || addedIds[0] || null,
          updatedAt: new Date().toISOString(),
        };
        if (addedIds.length > 0) await adapter.saveAlbum(updated);
        return json(results);
      }
      const album = await firestoreGet(env, uid, `albums/${albumId}`, idToken);
      if (!album) return json({ message: 'Album not found' }, 404);
      const set = new Set<string>(Array.isArray(album.assets) ? album.assets : []);
      const results: Array<Record<string, unknown>> = [];
      for (const id of ids) {
        if (set.has(id)) {
          results.push({ id, success: false, error: 'duplicate' });
          continue;
        }
        if (!await firestoreGet(env, uid, `photos/${id}`, idToken)) {
          results.push({ id, success: false, error: 'not_found' });
          continue;
        }
        set.add(id);
        results.push({ id, success: true });
      }
      const assets = Array.from(set);
      if (results.some(({ success }) => success)) {
        await firestoreSet(env, uid, `albums/${albumId}`, {
          assets,
          assetCount: assets.length,
          albumThumbnailAssetId: album.albumThumbnailAssetId || assets[0] || null,
          updatedAt: new Date().toISOString(),
        }, idToken);
      }
      return json(results);
    }

    if (assetsMatch && request.method === 'DELETE') {
      const albumId = assetsMatch[1];
      const body = await request.json() as any;
      const ids = normalizeIds(body.ids);
      if (adapter) {
        const existing = await adapter.getAlbum(albumId);
        if (!existing) return json({ message: 'Album not found' }, 404);
        const existingIds = new Set(await adapter.getAlbumAssets(albumId));
        const results: Array<Record<string, unknown>> = [];
        for (const id of ids) {
          if (!existingIds.has(id)) {
            results.push({ id, success: false, error: 'not_found' });
          } else {
            await adapter.removeAssetFromAlbum(albumId, id);
            existingIds.delete(id);
            results.push({ id, success: true });
          }
        }
        if (results.some(({ success }) => success)) {
          const updated = {
            ...existing,
            albumThumbnailAssetId: existingIds.has(existing.albumThumbnailAssetId || '')
              ? existing.albumThumbnailAssetId
              : Array.from(existingIds)[0] || null,
            updatedAt: new Date().toISOString(),
          };
          await adapter.saveAlbum(updated);
        }
        return json(results);
      }
      const album = await firestoreGet(env, uid, `albums/${albumId}`, idToken);
      if (!album) return json({ message: 'Album not found' }, 404);
      const existingIds = new Set<string>(Array.isArray(album.assets) ? album.assets : []);
      const results: Array<Record<string, unknown>> = [];
      for (const id of ids) {
        if (!existingIds.has(id)) {
          results.push({ id, success: false, error: 'not_found' });
        } else {
          existingIds.delete(id);
          results.push({ id, success: true });
        }
      }
      if (results.some(({ success }) => success)) {
        const assets = Array.from(existingIds);
        await firestoreSet(env, uid, `albums/${albumId}`, {
          assets,
          assetCount: assets.length,
          albumThumbnailAssetId: existingIds.has(album.albumThumbnailAssetId || '')
            ? album.albumThumbnailAssetId
            : assets[0] || null,
          updatedAt: new Date().toISOString(),
        }, idToken);
      }
      return json(results);
    }

    if (request.method === 'GET') {
      const mapMarkersMatch = path.match(/^\/api\/albums\/([^/]+)\/map-markers$/);
      if (mapMarkersMatch && adapter) {
        const rows = await env.DB!.prepare(
          `SELECT photos.id, photos.latitude, photos.longitude, photos.city, photos.country
           FROM photos
           INNER JOIN album_assets ON album_assets.assetId = photos.id
           WHERE album_assets.albumId = ? AND photos.ownerId = ?
             AND photos.latitude IS NOT NULL AND photos.longitude IS NOT NULL
             AND (photos.isTrashed = 0 OR photos.isTrashed IS NULL)`
        ).bind(mapMarkersMatch[1], uid).all<{
          id: string;
          latitude: number;
          longitude: number;
          city: string | null;
          country: string | null;
        }>();
        return json((rows.results || []).map((row) => ({
          id: row.id,
          lat: row.latitude,
          lon: row.longitude,
          city: row.city || null,
          state: null,
          country: row.country || null,
        })));
      }
      if (mapMarkersMatch) return json([]);
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

function normalizeIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((id): id is string => typeof id === 'string' && id.length > 0))];
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
  const owner = completeOwner(album.owner, ownerId);
  const albumUsers = (Array.isArray(album.albumUsers) ? album.albumUsers : [])
    .filter((albumUser: any) => albumUser?.user?.id && albumUser.role)
    .map((albumUser: any) => ({
      role: albumUser.role,
      user: completeOwner(albumUser.user, albumUser.user.id),
    }));
  const ownerIndex = albumUsers.findIndex((albumUser: any) => albumUser.user.id === owner.id);
  const ownerEntry = { role: 'owner', user: owner };
  if (ownerIndex >= 0) albumUsers.splice(ownerIndex, 1);
  albumUsers.unshift(ownerEntry);

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
    owner,
    albumUsers,
    hasSharedLink: false,
    startDate: null,
    endDate: null,
    lastModifiedAssetTimestamp: null,
    order: 'desc',
    isActivityEnabled: true,
  };
}
