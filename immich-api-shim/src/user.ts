import type { Env } from './index';
import { requireAuth, firestoreGet, firestoreSet, firestoreQuery, json } from './helpers';

export async function handleUser(request: Request, env: Env, path: string): Promise<Response> {
  const session = await requireAuth(request);

  if (path === '/api/users/me' && request.method === 'GET') {
    return getUserMe(env, session);
  }
  if (path === '/api/users/me' && request.method === 'PUT') {
    return updateUserMe(request, env, session);
  }
  if (path === '/api/users/me/preferences' && request.method === 'GET') {
    return json(defaultPreferences());
  }
  if (path === '/api/users/me/preferences' && request.method === 'PUT') {
    return json(defaultPreferences());
  }
  if (path === '/api/users/me/onboarding' && request.method === 'POST') {
    await firestoreSet(env, session.uid, 'config/immich_profile', { isOnboarded: true }, session.idToken);
    return json({});
  }
  if (path === '/api/users/me/storage') {
    return getStorage(env, session);
  }
  // GET /api/users/:id/profile-image
  if (path.match(/\/api\/users\/[^/]+\/profile-image/)) {
    // Return a 1x1 transparent PNG
    const pixel = Uint8Array.from([
      137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,1,0,0,0,1,8,6,0,0,0,
      31,21,196,137,0,0,0,10,73,68,65,84,120,156,98,0,0,0,6,0,5,130,208,142,0,0,0,0,73,69,78,68,174,66,96,130
    ]);
    return new Response(pixel, { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' } });
  }
  return json({ message: 'User endpoint not found' }, 404);
}

async function getUserMe(env: Env, session: { uid: string; email: string; idToken: string }): Promise<Response> {
  const profile = await firestoreGet(env, session.uid, 'config/immich_profile', session.idToken);
  const name = profile?.name || session.email.split('@')[0];

  return json({
    id: session.uid,
    email: session.email,
    name,
    avatarColor: profile?.avatarColor || 'primary',
    profileImagePath: '',
    profileChangedAt: new Date().toISOString(),
    isAdmin: true,
    isOnboarded: profile?.isOnboarded ?? true,
    shouldChangePassword: false,
    createdAt: profile?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    deletedAt: null,
    oauthId: '',
    quotaSizeInBytes: null,
    quotaUsageInBytes: null,
    status: 'active',
    storageLabel: null,
    license: null,
  });
}

async function updateUserMe(request: Request, env: Env, session: { uid: string; idToken: string }): Promise<Response> {
  const body = await request.json() as any;
  const updates: Record<string, any> = {};
  if (body.name) updates.name = body.name;
  if (body.avatarColor) updates.avatarColor = body.avatarColor;
  if (Object.keys(updates).length > 0) {
    await firestoreSet(env, session.uid, 'config/immich_profile', updates, session.idToken);
  }
  return getUserMe(env, { ...session, email: '' });
}

async function getStorage(env: Env, session: { uid: string; idToken: string }): Promise<Response> {
  const photos = await firestoreQuery(env, session.uid, 'photos', session.idToken);
  let totalBytes = 0;
  for (const p of photos) {
    if (p) totalBytes += (p.fileSize || 0);
  }
  return json({
    used: totalBytes,
    free: Number.MAX_SAFE_INTEGER,
    total: Number.MAX_SAFE_INTEGER,
    usage: [{ photos: photos.length, videos: 0, usage: totalBytes, userId: session.uid, userName: '' }],
  });
}

function defaultPreferences() {
  return {
    albums: { defaultAssetOrder: 'desc' },
    cast: { gCastEnabled: false },
    download: { archiveSize: 4294967296, includeEmbeddedVideos: false },
    folders: { enabled: false, sidebarWeb: false },
    memories: { enabled: false, duration: 10 },
    people: { enabled: false, sidebarWeb: false },
    ratings: { enabled: false },
    sharedLinks: { enabled: false, sidebarWeb: false },
    tags: { enabled: true, sidebarWeb: true },
    emailNotifications: { enabled: false, albumInvite: false, albumUpdate: false },
    purchase: { showSupportBadge: false, hideBuyButtonUntil: new Date(2099, 0).toISOString() },
  };
}
