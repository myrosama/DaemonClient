import type { Env } from './index';
import { json } from './helpers';

/** Stub handler for all non-critical endpoints. Returns empty/disabled responses. */
export async function handleStubs(request: Request, _env: Env, path: string): Promise<Response> {
  const method = request.method;
  // Socket.io — Immich frontend tries WebSocket for real-time notifications.
  // We don't have a WS server, so return a valid socket.io handshake that won't retry aggressively.
  if (path.startsWith('/api/socket.io')) {
    return json({ sid: 'stub', upgrades: [], pingInterval: 300000, pingTimeout: 300000 });
  }

  // Albums
  if (path === '/api/albums') return json([]);
  if (path.startsWith('/api/albums/')) return json({ id: '', albumName: '', assets: [], assetCount: 0 });

  // People / Faces
  if (path === '/api/people') return json({ total: 0, visible: 0, people: [] });
  if (path.startsWith('/api/people/')) return json({ id: '', name: '', thumbnailPath: '' });

  // Tags — feature disabled in the isolated model (preferences hide the UI),
  // but the web SDK can still call these; return SHAPED responses so
  // upsertTags()/tagAssets() don't crash on undefined.
  if (path === '/api/tags') {
    if (method === 'PUT') return json([]); // upsertTags → TagResponseDto[]
    return json([]);                        // getAllTags → TagResponseDto[]
  }
  // PUT/DELETE /api/tags/{id}/assets → BulkIdResponseDto[]
  if (path.match(/^\/api\/tags\/[^/]+\/assets$/)) {
    return json([]);
  }
  if (path.startsWith('/api/tags/')) return json({ id: '', name: '', value: '' });

  // Search
  if (path === '/api/search/suggestions') return json([]);
  if (path === '/api/search/explore') return json([]);
  if (path === '/api/search/metadata') return json({ assets: { total: 0, count: 0, items: [], facets: [] } });
  if (path === '/api/search/smart') return json({ assets: { total: 0, count: 0, items: [], facets: [] } });
  if (path === '/api/search/places') return json([]);
  if (path === '/api/search/cities') return json([]);

  // Map markers — handled in handleAssets with real D1 query

  // Partners
  if (path === '/api/partners') return json([]);

  // Shared links — cross-user sharing isn't built yet (see design doc), so
  // these are gracefully stubbed with SHAPED responses, not bare {}.
  // GET /api/shared-links/me drives the public share page, which reads
  // sharedLink.assets.length — so `assets` MUST be an array, never undefined.
  if (path === '/api/shared-links/me') {
    return json(emptySharedLink());
  }
  if (path === '/api/shared-links') {
    if (method === 'POST') return json(emptySharedLink(), 201); // createSharedLink → SharedLinkResponseDto
    return json([]);                                            // getAllSharedLinks → SharedLinkResponseDto[]
  }
  if (path.startsWith('/api/shared-links/')) {
    return json(emptySharedLink());
  }

  // Sessions
  if (path === '/api/sessions') return json([]);

  // API keys
  if (path === '/api/api-keys') return json([]);

  // Notifications — handled in handleAssets with real D1 query

  // Jobs/Queues
  if (path === '/api/jobs') return json({});
  if (path.startsWith('/api/jobs/')) return json({});

  // Libraries
  if (path === '/api/libraries') return json([]);

  // Admin
  if (path.startsWith('/api/admin')) return json({ message: 'Admin not available' }, 403);

  // Trash — handled in handleAssets with real D1 operations

  // Memories
  if (path === '/api/memories') return json([]);

  // Duplicates
  if (path === '/api/duplicates') return json([]);

  // Stacks
  if (path === '/api/stacks') return json([]);

  // Workflows
  if (path === '/api/workflows') return json([]);

  // Plugins
  if (path === '/api/plugins') return json([]);
  if (path === '/api/plugins/triggers') return json([]);

  // User admin
  if (path.startsWith('/api/admin/users')) return json([]);

  // Database
  if (path === '/api/database-backups') return json([]);

  // Onboarding
  if (path === '/api/server/onboarding') return json({});

  // Audit
  if (path.startsWith('/api/audit')) return json([]);

  // Reports
  if (path.startsWith('/api/reports')) return json([]);

  // Catch-all: return empty object to prevent frontend crashes
  console.log(`[STUB] Unhandled: ${path}`);
  return json({});
}

// A SharedLinkResponseDto-shaped object with an empty asset list. The public
// share page and shared-links utils read sharedLink.assets.length and
// sharedLink.assets[0]?.id, so `assets` must always be an array.
function emptySharedLink() {
  return {
    id: '',
    type: 'INDIVIDUAL',
    key: '',
    slug: null,
    description: null,
    password: null,
    userId: '',
    createdAt: new Date().toISOString(),
    expiresAt: null,
    allowUpload: false,
    allowDownload: false,
    showMetadata: false,
    album: null,
    assets: [] as any[],
  };
}
