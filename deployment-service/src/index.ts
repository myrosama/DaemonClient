import { CloudflareAPI } from './cloudflare-api';

// Inline encryption helper
const IV_LENGTH = 12;
async function encryptToken(token: string, masterKeyString: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(masterKeyString),
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt']
  );
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(token));
  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(encrypted), iv.length);
  return btoa(String.fromCharCode(...combined));
}

export interface Env {
  FIREBASE_API_KEY: string;
  FIREBASE_PROJECT_ID: string;
  ENCRYPTION_MASTER_KEY: string;
}

const MIGRATION_SQL = `
CREATE TABLE photos (
  id TEXT PRIMARY KEY, ownerId TEXT NOT NULL, fileName TEXT NOT NULL,
  fileSize INTEGER NOT NULL, mimeType TEXT NOT NULL, width INTEGER, height INTEGER,
  duration TEXT, fileCreatedAt TEXT NOT NULL, uploadedAt TEXT NOT NULL,
  telegramOriginalId TEXT, telegramThumbId TEXT, telegramChunks TEXT,
  encryptionMode TEXT DEFAULT 'off', thumbEncrypted INTEGER DEFAULT 0,
  checksum TEXT, isHeic INTEGER DEFAULT 0, livePhotoVideoId TEXT,
  isFavorite INTEGER DEFAULT 0, isTrashed INTEGER DEFAULT 0,
  visibility TEXT DEFAULT 'timeline', description TEXT, city TEXT, country TEXT
);
CREATE INDEX idx_photos_uploadedAt ON photos(uploadedAt DESC);
CREATE INDEX idx_photos_fileCreatedAt ON photos(fileCreatedAt DESC);
CREATE INDEX idx_photos_livePhoto ON photos(livePhotoVideoId) WHERE livePhotoVideoId IS NOT NULL;
CREATE INDEX idx_photos_favorite ON photos(isFavorite) WHERE isFavorite = 1;
CREATE INDEX idx_photos_trashed ON photos(isTrashed);
CREATE TABLE albums (
  id TEXT PRIMARY KEY, albumName TEXT NOT NULL, description TEXT,
  createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, albumThumbnailAssetId TEXT
);
CREATE TABLE album_assets (
  albumId TEXT NOT NULL, assetId TEXT NOT NULL, addedAt TEXT NOT NULL,
  PRIMARY KEY (albumId, assetId),
  FOREIGN KEY (albumId) REFERENCES albums(id) ON DELETE CASCADE,
  FOREIGN KEY (assetId) REFERENCES photos(id) ON DELETE CASCADE
);
CREATE INDEX idx_album_assets_albumId ON album_assets(albumId);
CREATE INDEX idx_album_assets_assetId ON album_assets(assetId);
CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO config (key, value) VALUES ('zke_mode','server'),('zke_enabled','1'),('zke_password',''),('zke_salt','');
CREATE TABLE upload_sessions (
  sessionId TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'active',
  createdAt TEXT NOT NULL, expiresAt TEXT NOT NULL
);`;

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function corsResponse(body: string | null, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers || {});
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  if (!headers.has('Content-Type') && body) headers.set('Content-Type', 'application/json');
  return new Response(body, { ...init, headers });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') return corsResponse(null, { status: 204 });
    const url = new URL(request.url);
    if (url.pathname === '/deploy-worker' && request.method === 'POST') return handleDeployWorker(request, env);
    if (url.pathname === '/validate-cf-token' && request.method === 'POST') return handleValidateToken(request, env);
    return corsResponse(JSON.stringify({ error: 'Not found' }), { status: 404 });
  },
};

async function handleDeployWorker(request: Request, env: Env): Promise<Response> {
  try {
    const { apiToken, accountId } = await request.json() as any;
    const uid = await validateFirebaseToken(request, env);
    if (!uid) return corsResponse(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });

    // Sanitize UID for Cloudflare naming (lowercase alphanumeric + dashes only)
    const shortId = uid.substring(0, 8).toLowerCase().replace(/[^a-z0-9]/g, '');
    const cfApi = new CloudflareAPI();

    // Step 1: Create D1 database in USER's account (handle if already exists)
    const dbName = `dc-photos-${shortId}`;
    let databaseId: string;
    const dbResult = await cfApi.createD1Database({ accountId, apiToken, databaseName: dbName });
    if (dbResult.success) {
      databaseId = dbResult.databaseId!;
    } else {
      // Database might already exist — try to find it
      const listRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database`, {
        headers: { 'Authorization': `Bearer ${apiToken}` }
      });
      const listData = await listRes.json() as any;
      const existing = listData.result?.find((d: any) => d.name === dbName);
      if (existing) {
        databaseId = existing.uuid;
      } else {
        return corsResponse(JSON.stringify({ error: dbResult.error }), { status: 500 });
      }
    }

    // Step 2: Run migration
    await cfApi.executeD1Query(accountId, databaseId, apiToken, MIGRATION_SQL);

    // Step 3: Generate ZKE keys
    const salt = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
    const password = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
    await cfApi.executeD1Query(accountId, databaseId, apiToken,
      `UPDATE config SET value = '${password}' WHERE key = 'zke_password'; UPDATE config SET value = '${salt}' WHERE key = 'zke_salt';`
    );

    // Step 4: Deploy worker to USER's account
    // Use a valid ES module placeholder — the real immich-api-shim will be deployed via wrangler later
    const workerCode = `
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Content-Type': 'application/json'
    };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    return new Response(JSON.stringify({
      status: 'active',
      message: 'DaemonClient worker is running. Deploy the full immich-api-shim for Photos functionality.',
      path: url.pathname
    }), { headers: cors });
  }
};`;

    const workerName = `dc-${shortId}`;
    const deployResult = await cfApi.deployWorker({
      accountId, workerName, apiToken, workerCode,
      bindings: [{ type: 'd1', name: 'DB', id: databaseId }]
    });
    if (!deployResult.success) return corsResponse(JSON.stringify({ error: deployResult.error }), { status: 500 });

    // Step 5: Save config to Firestore
    const workerUrl = `https://${workerName}.${accountId}.workers.dev`;
    const encryptedToken = await encryptToken(apiToken, env.ENCRYPTION_MASTER_KEY);
    await saveWorkerConfig(uid, {
      apiToken: encryptedToken, accountId, workerName, workerUrl,
      databaseName: dbName, databaseId,
      setupTimestamp: new Date().toISOString(),
      lastDeployedVersion: '1.0.0', autoUpdateEnabled: true
    }, env);

    return corsResponse(JSON.stringify({ success: true, workerUrl, deploymentId: crypto.randomUUID() }));
  } catch (error: any) {
    console.error('Deployment error:', error);
    return corsResponse(JSON.stringify({ error: error.message }), { status: 500 });
  }
}

async function handleValidateToken(request: Request, env: Env): Promise<Response> {
  try {
    const { token } = await request.json() as any;
    const response = await fetch('https://api.cloudflare.com/client/v4/accounts', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!response.ok) return corsResponse(JSON.stringify({ valid: false, error: 'Invalid token or insufficient permissions' }));
    const data = await response.json() as any;
    const account = data.result?.[0];
    if (!account) return corsResponse(JSON.stringify({ valid: false, error: 'No accounts found' }));
    return corsResponse(JSON.stringify({ valid: true, accountId: account.id, accountName: account.name }));
  } catch (error: any) {
    return corsResponse(JSON.stringify({ valid: false, error: error.message }));
  }
}

async function validateFirebaseToken(request: Request, env: Env): Promise<string | null> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) return null;
  const idToken = authHeader.substring(7);
  const response = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${env.FIREBASE_API_KEY}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken }) }
  );
  if (!response.ok) return null;
  const data = await response.json() as any;
  return data.users?.[0]?.localId || null;
}

async function saveWorkerConfig(uid: string, config: any, env: Env): Promise<void> {
  const path = `artifacts/default-daemon-client/users/${uid}/config/cloudflare`;
  const url = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/${path}`;
  const fields: any = {};
  for (const [key, value] of Object.entries(config)) {
    fields[key] = { stringValue: String(value) };
  }
  await fetch(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fields }) });
}
