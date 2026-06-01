import { CloudflareAPI } from './cloudflare-api';
import { SHIM_BUNDLE, SHIM_VERSION } from './shim-bundle';

// Inline encryption helpers
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

async function decryptToken(combinedB64: string, masterKeyString: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(masterKeyString),
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt']
  );
  const combined = Uint8Array.from(atob(combinedB64), c => c.charCodeAt(0));
  const iv = combined.slice(0, IV_LENGTH);
  const ciphertext = combined.slice(IV_LENGTH);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  return new TextDecoder().decode(plain);
}

export interface Env {
  FIREBASE_API_KEY: string;
  FIREBASE_PROJECT_ID: string;
  ENCRYPTION_MASTER_KEY: string;
  APP_IDENTIFIER: string;
  TELEGRAM_PROXY: string;
  ALLOWED_ORIGINS: string;
  // URL of this deployment service. Injected into each per-user worker so the
  // worker can dispatch its own /auto-update on login (self-propagating shim
  // upgrades). Without it, only the central worker's login path can trigger an
  // update — which silently never fires once a user's SW pins traffic to their
  // personal worker, leaving them stuck on an old shim version.
  DEPLOYMENT_SERVICE_URL?: string;
  // Shared secret guarding the /admin/force-update endpoint (operator-triggered
  // re-deploy of a specific user's worker, bypassing the login-time path).
  ADMIN_SECRET?: string;
  // Firebase service-account credentials used by the /admin/announce endpoint
  // to write the global announcement to Firestore without requiring a user token.
  FIREBASE_SA_CLIENT_EMAIL?: string;
  FIREBASE_SA_PRIVATE_KEY?: string;
}

// The bindings every per-user shim worker needs. Centralised so deploy,
// auto-update, and force-update all stay in lockstep — a binding added here
// reaches all three deploy paths.
function buildShimBindings(env: Env, databaseId: string): any[] {
  const bindings: any[] = [
    { type: 'd1', name: 'DB', id: databaseId },
    { type: 'plain_text', name: 'FIREBASE_API_KEY', text: env.FIREBASE_API_KEY },
    { type: 'plain_text', name: 'FIREBASE_PROJECT_ID', text: env.FIREBASE_PROJECT_ID },
    { type: 'plain_text', name: 'APP_IDENTIFIER', text: env.APP_IDENTIFIER },
    { type: 'plain_text', name: 'TELEGRAM_PROXY', text: env.TELEGRAM_PROXY },
    { type: 'plain_text', name: 'ALLOWED_ORIGINS', text: env.ALLOWED_ORIGINS },
  ];
  if (env.DEPLOYMENT_SERVICE_URL) {
    bindings.push({ type: 'plain_text', name: 'DEPLOYMENT_SERVICE_URL', text: env.DEPLOYMENT_SERVICE_URL });
  }
  return bindings;
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
  visibility TEXT DEFAULT 'timeline', description TEXT, city TEXT, country TEXT,
  thumbhash TEXT, telegramPreviewId TEXT, previewEncrypted INTEGER DEFAULT 0
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
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Secret',
};

function corsResponse(body: string | null, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers || {});
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  if (!headers.has('Content-Type') && body) headers.set('Content-Type', 'application/json');
  return new Response(body, { ...init, headers });
}

// ── Service-account JWT helpers ──────────────────────────────────────────────
// Generate a short-lived Google OAuth2 access-token from a service account
// private key (PEM) using only the Web Crypto API available in CF Workers.
// Used exclusively by the /admin/announce endpoint — no external library needed.

function pemToDer(pem: string): Uint8Array {
  const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const bin = atob(b64);
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}

function base64url(data: Uint8Array | string): string {
  const bytes = typeof data === 'string'
    ? new TextEncoder().encode(data)
    : data;
  let bin = '';
  bytes.forEach(b => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function getServiceAccountAccessToken(clientEmail: string, privateKeyPem: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({
    iss: clientEmail,
    sub: clientEmail,
    aud: 'https://oauth2.googleapis.com/token',
    scope: 'https://www.googleapis.com/auth/datastore',
    iat: now,
    exp: now + 3600,
  }));
  const signingInput = `${header}.${payload}`;
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToDer(privateKeyPem),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sigBuf = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(signingInput));
  const jwt = `${signingInput}.${base64url(new Uint8Array(sigBuf))}`;

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  if (!tokenRes.ok) {
    const txt = await tokenRes.text();
    throw new Error(`SA token exchange failed: ${tokenRes.status} ${txt}`);
  }
  const { access_token } = await tokenRes.json() as any;
  return access_token as string;
}

// Write (or clear) the global announcement document in Firestore.
async function writeAnnouncement(env: Env, fields: Record<string, any>): Promise<void> {
  if (!env.FIREBASE_SA_CLIENT_EMAIL || !env.FIREBASE_SA_PRIVATE_KEY) {
    throw new Error('Service-account credentials not configured (FIREBASE_SA_CLIENT_EMAIL / FIREBASE_SA_PRIVATE_KEY)');
  }
  const accessToken = await getServiceAccountAccessToken(env.FIREBASE_SA_CLIENT_EMAIL, env.FIREBASE_SA_PRIVATE_KEY);
  const url = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/global/announcement`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}` },
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Firestore write failed: ${res.status} ${txt}`);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') return corsResponse(null, { status: 204 });
    const url = new URL(request.url);
    if (url.pathname === '/deploy-worker' && request.method === 'POST') return handleDeployWorker(request, env);
    if (url.pathname === '/validate-cf-token' && request.method === 'POST') return handleValidateToken(request, env);
    if (url.pathname === '/auto-update' && request.method === 'POST') return handleAutoUpdate(request, env);
    if (url.pathname === '/admin/force-update' && request.method === 'POST') return handleForceUpdate(request, env);
    if (url.pathname === '/admin/announce' && request.method === 'POST') return handleAnnounce(request, env);
    if (url.pathname === '/admin/announce' && request.method === 'DELETE') return handleClearAnnouncement(request, env);
    return corsResponse(JSON.stringify({ error: 'Not found' }), { status: 404 });
  },
};

async function handleDeployWorker(request: Request, env: Env): Promise<Response> {
  try {
    const { apiToken, accountId } = await request.json() as any;
    const auth = await validateFirebaseToken(request, env);
    if (!auth) return corsResponse(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
    const { uid, idToken } = auth;

    // Sanitize UID for Cloudflare naming (lowercase alphanumeric + dashes only)
    const shortId = uid.substring(0, 8).toLowerCase().replace(/[^a-z0-9]/g, '');
    const cfApi = new CloudflareAPI();

    // Step 1: Create D1 database in USER's account (handle if already exists)
    const dbName = `dc-photos-${shortId}`;
    let databaseId: string;
    let isNewDatabase = false;
    const dbResult = await cfApi.createD1Database({ accountId, apiToken, databaseName: dbName });
    if (dbResult.success) {
      databaseId = dbResult.databaseId!;
      isNewDatabase = true;
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

    // Step 2: Run migration + generate ZKE keys only on a fresh DB. Re-running
    // these on an existing DB silently rotates the AES password/salt, which
    // makes every previously-uploaded photo permanently undecryptable.
    if (isNewDatabase) {
      await cfApi.executeD1Query(accountId, databaseId, apiToken, MIGRATION_SQL);

      const salt = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
      const password = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
      await cfApi.executeD1Query(accountId, databaseId, apiToken,
        `UPDATE config SET value = '${password}' WHERE key = 'zke_password'; UPDATE config SET value = '${salt}' WHERE key = 'zke_salt';`
      );
    }

    // Step 4: Deploy the real immich-api-shim to USER's account, bound to USER's D1
    const workerName = `dc-${shortId}`;
    const deployResult = await cfApi.deployWorker({
      accountId, workerName, apiToken, workerCode: SHIM_BUNDLE,
      bindings: buildShimBindings(env, databaseId)
    });
    if (!deployResult.success) return corsResponse(JSON.stringify({ error: deployResult.error }), { status: 500 });

    // Step 4b: Ensure the account has a workers.dev subdomain.
    // First-time CF Workers users don't have one until they visit the Workers
    // & Pages page in the dashboard. In that case GET /workers/subdomain
    // returns 404 / code 10007. We provision one programmatically so the user
    // doesn't have to bounce out of the flow. This MUST happen before
    // enableWorkersDev — enabling workers.dev for a script is meaningless
    // without an account-level subdomain.
    let subdomainResult = await cfApi.getWorkersSubdomain(accountId, apiToken);
    if (!subdomainResult.subdomain && subdomainResult.notProvisioned) {
      // workers.dev subdomains are globally unique — try a few candidates.
      const accountSlug = accountId.substring(0, 8).toLowerCase();
      const candidates = [
        `dc-${accountSlug}`,
        `dc-${accountSlug}-${Math.random().toString(36).substring(2, 6)}`,
        `dc-${accountSlug}-${Math.random().toString(36).substring(2, 8)}`,
      ];
      let claimed = false;
      let lastErr: string | undefined;
      for (const candidate of candidates) {
        const r = await cfApi.setWorkersSubdomain(accountId, apiToken, candidate);
        if (r.success) { claimed = true; break; }
        lastErr = r.error;
        if (!r.conflict) break;
      }
      if (!claimed) {
        return corsResponse(JSON.stringify({ error: `Could not provision workers.dev subdomain: ${lastErr}` }), { status: 500 });
      }
      subdomainResult = await cfApi.getWorkersSubdomain(accountId, apiToken);
    }
    if (!subdomainResult.subdomain) {
      return corsResponse(JSON.stringify({ error: subdomainResult.error || 'Could not fetch workers subdomain' }), { status: 500 });
    }

    // Step 4c: Make sure workers.dev is enabled for THIS script (newly
    // deployed module workers default to disabled on some accounts).
    await cfApi.enableWorkersDev(accountId, workerName, apiToken);

    // Step 5: Save config to Firestore
    const workerUrl = `https://${workerName}.${subdomainResult.subdomain}.workers.dev`;
    const encryptedToken = await encryptToken(apiToken, env.ENCRYPTION_MASTER_KEY);
    await saveWorkerConfig(uid, idToken, {
      apiToken: encryptedToken, accountId, workerName, workerUrl,
      databaseName: dbName, databaseId,
      setupTimestamp: new Date().toISOString(),
      lastDeployedVersion: SHIM_VERSION, autoUpdateEnabled: true
    }, env);

    return corsResponse(JSON.stringify({ success: true, workerUrl, deploymentId: crypto.randomUUID() }));
  } catch (error: any) {
    console.error('Deployment error:', error);
    return corsResponse(JSON.stringify({ error: error.message }), { status: 500 });
  }
}

// Silently re-deploy the user's per-user worker if its embedded shim version
// has drifted from the current SHIM_VERSION. Called fire-and-forget from the
// central router on /api/auth/login. Idempotent — no-op when versions match.
async function handleAutoUpdate(request: Request, env: Env): Promise<Response> {
  try {
    const auth = await validateFirebaseToken(request, env);
    if (!auth) return corsResponse(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
    const { uid, idToken } = auth;

    const cfg = await fetchWorkerConfig(uid, idToken, env);
    if (!cfg || !cfg.apiToken || !cfg.accountId || !cfg.workerName) {
      return corsResponse(JSON.stringify({ updated: false, reason: 'no-config' }));
    }
    if (cfg.autoUpdateEnabled === 'false') {
      return corsResponse(JSON.stringify({ updated: false, reason: 'disabled' }));
    }
    if (cfg.lastDeployedVersion === SHIM_VERSION) {
      return corsResponse(JSON.stringify({ updated: false, reason: 'current', version: SHIM_VERSION }));
    }

    const apiToken = await decryptToken(cfg.apiToken, env.ENCRYPTION_MASTER_KEY);
    const cfApi = new CloudflareAPI();
    const deployResult = await cfApi.deployWorker({
      accountId: cfg.accountId,
      workerName: cfg.workerName,
      apiToken,
      workerCode: SHIM_BUNDLE,
      bindings: buildShimBindings(env, cfg.databaseId)
    });
    if (!deployResult.success) {
      return corsResponse(JSON.stringify({ updated: false, reason: 'deploy-failed', error: deployResult.error }), { status: 500 });
    }

    await saveWorkerConfig(uid, idToken, {
      ...cfg,
      lastDeployedVersion: SHIM_VERSION,
      lastUpdatedAt: new Date().toISOString(),
    }, env);

    return corsResponse(JSON.stringify({ updated: true, from: cfg.lastDeployedVersion || 'unknown', to: SHIM_VERSION }));
  } catch (error: any) {
    console.error('Auto-update error:', error);
    return corsResponse(JSON.stringify({ updated: false, error: error.message }), { status: 500 });
  }
}

// Operator-triggered re-deploy of a single user's worker. Bypasses the
// login-time auto-update path (which can silently never fire) and forces the
// current SHIM_BUNDLE onto the user's worker. Guarded by ADMIN_SECRET. The
// caller passes the user's stored cloudflare config (accountId, workerName,
// databaseId, encrypted apiToken) — read from Firestore by an operator with
// admin access — so this endpoint needs no user idToken.
async function handleForceUpdate(request: Request, env: Env): Promise<Response> {
  try {
    const secret = request.headers.get('X-Admin-Secret');
    if (!env.ADMIN_SECRET || secret !== env.ADMIN_SECRET) {
      return corsResponse(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
    }
    const { accountId, workerName, databaseId, apiToken: encApiToken, migrationSql } = await request.json() as any;
    if (!accountId || !workerName || !databaseId || !encApiToken) {
      return corsResponse(JSON.stringify({ error: 'Missing required fields: accountId, workerName, databaseId, apiToken' }), { status: 400 });
    }

    const apiToken = await decryptToken(encApiToken, env.ENCRYPTION_MASTER_KEY);
    const cfApi = new CloudflareAPI();

    // Optional schema migration (e.g. ALTER TABLE ... ADD COLUMN). Run before
    // deploy so the new code never reads a column that doesn't exist yet.
    // "duplicate column name" means it already ran — treat as success.
    let migration: { ran: boolean; ok?: boolean; error?: string } = { ran: false };
    if (migrationSql) {
      const r = await cfApi.executeD1Query(accountId, databaseId, apiToken, migrationSql);
      const benign = r.error && /duplicate column name/i.test(r.error);
      migration = { ran: true, ok: r.success || !!benign, error: r.success || benign ? undefined : r.error };
    }

    const deployResult = await cfApi.deployWorker({
      accountId, workerName, apiToken, workerCode: SHIM_BUNDLE,
      bindings: buildShimBindings(env, databaseId)
    });
    if (!deployResult.success) {
      return corsResponse(JSON.stringify({ success: false, error: deployResult.error, migration }), { status: 500 });
    }
    // Keep workers.dev serving the new code (no-op if already enabled).
    await cfApi.enableWorkersDev(accountId, workerName, apiToken).catch(() => {});

    return corsResponse(JSON.stringify({ success: true, version: SHIM_VERSION, workerName, migration }));
  } catch (error: any) {
    console.error('Force-update error:', error);
    return corsResponse(JSON.stringify({ success: false, error: error.message }), { status: 500 });
  }
}

// POST /admin/announce — write a broadcast notification to Firestore
async function handleAnnounce(request: Request, env: Env): Promise<Response> {
  try {
    const secret = request.headers.get('X-Admin-Secret');
    if (!env.ADMIN_SECRET || secret !== env.ADMIN_SECRET) {
      return corsResponse(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
    }
    const { title, message } = await request.json() as any;
    if (!title || !message) {
      return corsResponse(JSON.stringify({ error: 'Missing required fields: title, message' }), { status: 400 });
    }
    await writeAnnouncement(env, {
      title: { stringValue: String(title) },
      message: { stringValue: String(message) },
      active: { booleanValue: true },
      createdAt: { stringValue: new Date().toISOString() },
    });
    return corsResponse(JSON.stringify({ success: true }));
  } catch (error: any) {
    console.error('Announce error:', error);
    return corsResponse(JSON.stringify({ success: false, error: error.message }), { status: 500 });
  }
}

// DELETE /admin/announce — deactivate the current broadcast announcement
async function handleClearAnnouncement(request: Request, env: Env): Promise<Response> {
  try {
    const secret = request.headers.get('X-Admin-Secret');
    if (!env.ADMIN_SECRET || secret !== env.ADMIN_SECRET) {
      return corsResponse(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
    }
    await writeAnnouncement(env, {
      active: { booleanValue: false },
      clearedAt: { stringValue: new Date().toISOString() },
    });
    return corsResponse(JSON.stringify({ success: true, cleared: true }));
  } catch (error: any) {
    console.error('Clear announcement error:', error);
    return corsResponse(JSON.stringify({ success: false, error: error.message }), { status: 500 });
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

async function validateFirebaseToken(request: Request, env: Env): Promise<{ uid: string; idToken: string; email?: string } | null> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) return null;
  const idToken = authHeader.substring(7);
  const response = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${env.FIREBASE_API_KEY}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken }) }
  );
  if (!response.ok) return null;
  const data = await response.json() as any;
  const u = data.users?.[0];
  const uid = u?.localId;
  return uid ? { uid, idToken, email: u?.email } : null;
}

async function fetchWorkerConfig(uid: string, idToken: string, env: Env): Promise<Record<string, string> | null> {
  const path = `artifacts/default-daemon-client/users/${uid}/config/cloudflare`;
  const url = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/${path}`;
  const res = await fetch(url, { headers: { 'Authorization': `Bearer ${idToken}` } });
  if (!res.ok) return null;
  const data = await res.json() as any;
  if (!data.fields) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries<any>(data.fields)) {
    if (v.stringValue !== undefined) out[k] = v.stringValue;
  }
  return out;
}

async function saveWorkerConfig(uid: string, idToken: string, config: any, env: Env): Promise<void> {
  const path = `artifacts/default-daemon-client/users/${uid}/config/cloudflare`;
  const url = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/${path}`;
  const fields: any = {};
  for (const [key, value] of Object.entries(config)) {
    fields[key] = { stringValue: String(value) };
  }
  // Firestore rules require an authenticated request — without the user's
  // idToken this PATCH 401s silently and the user gets bounced back through
  // the CF setup forever because no `cloudflare` doc ever appears.
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${idToken}`,
    },
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Firestore write failed: ${res.status} ${text}`);
  }
}
