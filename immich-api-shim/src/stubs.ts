import type { Env } from './index';
import { json } from './helpers';

/** Stub handler for all non-critical endpoints. Returns empty/disabled responses. */
export async function handleStubs(_request: Request, _env: Env, path: string): Promise<Response> {
  // Albums
  if (path === '/api/albums') return json([]);
  if (path.startsWith('/api/albums/')) return json({ id: '', albumName: '', assets: [], assetCount: 0 });

  // People / Faces
  if (path === '/api/people') return json({ total: 0, visible: 0, people: [] });
  if (path.startsWith('/api/people/')) return json({ id: '', name: '', thumbnailPath: '' });

  // Tags
  if (path === '/api/tags') return json([]);

  // Search
  if (path === '/api/search/suggestions') return json([]);
  if (path === '/api/search/explore') return json([]);
  if (path === '/api/search/metadata') return json({ assets: { total: 0, count: 0, items: [], facets: [] } });
  if (path === '/api/search/smart') return json({ assets: { total: 0, count: 0, items: [], facets: [] } });
  if (path === '/api/search/places') return json([]);
  if (path === '/api/search/cities') return json([]);

  // Map
  if (path === '/api/map/markers') return json([]);

  // Partners
  if (path === '/api/partners') return json([]);

  // Shared links
  if (path === '/api/shared-links') return json([]);

  // Sessions
  if (path === '/api/sessions') return json([]);

  // API keys
  if (path === '/api/api-keys') return json([]);

  // Notifications
  if (path === '/api/notifications') return json([]);

  // Jobs/Queues
  if (path === '/api/jobs') return json({});
  if (path.startsWith('/api/jobs/')) return json({});

  // Libraries
  if (path === '/api/libraries') return json([]);

  // Admin
  if (path.startsWith('/api/admin')) return json({ message: 'Admin not available' }, 403);

  // Trash
  if (path === '/api/trash/empty') return json({});
  if (path === '/api/trash/restore') return json({});
  if (path === '/api/trash/restore/assets') return json({});

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

  // Download
  if (path === '/api/download/info') return json({ totalSize: 0, archives: [] });

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
