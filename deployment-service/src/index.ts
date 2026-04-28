import { CloudflareAPI } from './cloudflare-api';
import { getEncryptionService } from '../../immich-api-shim/src/encryption-service';

export interface Env {
  FIREBASE_API_KEY: string;
  FIREBASE_PROJECT_ID: string;
  ENCRYPTION_MASTER_KEY: string;
  
  UPDATE_QUEUE?: Queue;
}

const MIGRATION_SQL = `-- Photos table (replaces Firestore photos/{id})
CREATE TABLE photos (
  id TEXT PRIMARY KEY,
  ownerId TEXT NOT NULL,
  fileName TEXT NOT NULL,
  fileSize INTEGER NOT NULL,
  mimeType TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  duration TEXT,
  fileCreatedAt TEXT NOT NULL,
  uploadedAt TEXT NOT NULL,
  
  -- Telegram storage
  telegramOriginalId TEXT,
  telegramThumbId TEXT,
  telegramChunks TEXT,
  
  -- Encryption
  encryptionMode TEXT DEFAULT 'off',
  thumbEncrypted INTEGER DEFAULT 0,
  
  -- Metadata
  checksum TEXT,
  isHeic INTEGER DEFAULT 0,
  livePhotoVideoId TEXT,
  
  -- User preferences
  isFavorite INTEGER DEFAULT 0,
  isTrashed INTEGER DEFAULT 0,
  visibility TEXT DEFAULT 'timeline',
  description TEXT,
  
  -- Location
  city TEXT,
  country TEXT
);

CREATE INDEX idx_photos_uploadedAt ON photos(uploadedAt DESC);
CREATE INDEX idx_photos_fileCreatedAt ON photos(fileCreatedAt DESC);
CREATE INDEX idx_photos_livePhoto ON photos(livePhotoVideoId) WHERE livePhotoVideoId IS NOT NULL;
CREATE INDEX idx_photos_favorite ON photos(isFavorite) WHERE isFavorite = 1;
CREATE INDEX idx_photos_trashed ON photos(isTrashed);

CREATE TABLE albums (
  id TEXT PRIMARY KEY,
  albumName TEXT NOT NULL,
  description TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  albumThumbnailAssetId TEXT
);

CREATE TABLE album_assets (
  albumId TEXT NOT NULL,
  assetId TEXT NOT NULL,
  addedAt TEXT NOT NULL,
  
  PRIMARY KEY (albumId, assetId),
  FOREIGN KEY (albumId) REFERENCES albums(id) ON DELETE CASCADE,
  FOREIGN KEY (assetId) REFERENCES photos(id) ON DELETE CASCADE
);

CREATE INDEX idx_album_assets_albumId ON album_assets(albumId);
CREATE INDEX idx_album_assets_assetId ON album_assets(assetId);

CREATE TABLE config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT INTO config (key, value) VALUES
  ('zke_mode', 'server'),
  ('zke_enabled', '1'),
  ('zke_password', ''),
  ('zke_salt', '');

CREATE TABLE upload_sessions (
  sessionId TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'active',
  createdAt TEXT NOT NULL,
  expiresAt TEXT NOT NULL
);`;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/deploy-worker' && request.method === 'POST') {
      return handleDeployWorker(request, env);
    }

    if (url.pathname === '/validate-cf-token' && request.method === 'POST') {
      return handleValidateToken(request, env);
    }

    return new Response('Not found', { status: 404 });
  },

  async queue(batch: MessageBatch<any>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        await processUpdate(message.body, env);
        message.ack();
      } catch (error) {
        console.error('Update failed:', error);
        message.retry();
      }
    }
  }
};

async function handleDeployWorker(request: Request, env: Env): Promise<Response> {
  try {
    const { apiToken, accountId } = await request.json() as any;
    
    const uid = await validateFirebaseToken(request, env);
    if (!uid) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { 
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const cfApi = new CloudflareAPI();

    // Step 1: Create D1 database
    const dbResult = await cfApi.createD1Database({
      accountId,
      apiToken,
      databaseName: `photos-db-${uid.substring(0, 8)}`
    });

    if (!dbResult.success) {
      return new Response(JSON.stringify({ error: dbResult.error }), { 
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const databaseId = dbResult.databaseId!;

    // Step 2: Run initial migration (create tables with ZKE enabled by default)
    await cfApi.executeD1Query(accountId, databaseId, apiToken, MIGRATION_SQL);

    // Step 3: Generate ZKE keys
    const salt = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
    const password = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));

    // Step 4: Update ZKE config with generated keys
    const zkeSQL = `
      UPDATE config SET value = '${password}' WHERE key = 'zke_password';
      UPDATE config SET value = '${salt}' WHERE key = 'zke_salt';
    `;
    await cfApi.executeD1Query(accountId, databaseId, apiToken, zkeSQL);

    // Step 5: Deploy worker
    const workerCode = await fetch('https://raw.githubusercontent.com/yourusername/daemonclient/main/immich-api-shim/dist/worker.js')
      .then(r => r.text())
      .catch(() => '// Worker code placeholder');
    
    const workerName = `daemonclient-${uid.substring(0, 8)}`;

    const deployResult = await cfApi.deployWorker({
      accountId,
      workerName,
      apiToken,
      workerCode,
      bindings: [
        { type: 'd1', name: 'DB', id: databaseId }
      ]
    });

    if (!deployResult.success) {
      return new Response(JSON.stringify({ error: deployResult.error }), { 
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Step 6: Save config to Firebase
    const workerUrl = `https://${workerName}.${accountId}.workers.dev`;
    
    const encryptionService = await getEncryptionService(env.ENCRYPTION_MASTER_KEY);
    const encryptedToken = await encryptionService.encryptToken(apiToken);
    
    await saveWorkerConfig(uid, {
      apiToken: encryptedToken,
      accountId,
      workerName,
      workerUrl,
      databaseName: `photos-db-${uid.substring(0, 8)}`,
      databaseId,
      setupTimestamp: new Date().toISOString(),
      lastDeployedVersion: '1.0.0',
      autoUpdateEnabled: true
    }, env);

    return new Response(JSON.stringify({ 
      success: true,
      workerUrl,
      deploymentId: crypto.randomUUID()
    }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: any) {
    console.error('Deployment error:', error);
    return new Response(JSON.stringify({ error: error.message }), { 
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

async function handleValidateToken(request: Request, env: Env): Promise<Response> {
  try {
    const { token } = await request.json() as any;
    
    const response = await fetch('https://api.cloudflare.com/client/v4/accounts', {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (!response.ok) {
      return new Response(JSON.stringify({ 
        valid: false,
        error: 'Invalid token or insufficient permissions'
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const data = await response.json() as any;
    const account = data.result?.[0];

    if (!account) {
      return new Response(JSON.stringify({ 
        valid: false,
        error: 'No accounts found'
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({ 
      valid: true,
      accountId: account.id
    }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: any) {
    return new Response(JSON.stringify({ 
      valid: false,
      error: error.message
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

async function processUpdate(message: any, env: Env): Promise<void> {
  console.log('Processing update:', message);
}

async function validateFirebaseToken(request: Request, env: Env): Promise<string | null> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) return null;

  const idToken = authHeader.substring(7);
  
  const response = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${env.FIREBASE_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken })
    }
  );

  if (!response.ok) return null;

  const data = await response.json() as any;
  return data.users?.[0]?.localId || null;
}

async function saveWorkerConfig(uid: string, config: any, env: Env): Promise<void> {
  const path = `artifacts/default-daemon-client/users/${uid}/config/cloudflare`;
  const firestoreUrl = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/${path}`;
  
  const fields: any = {};
  for (const [key, value] of Object.entries(config)) {
    fields[key] = { stringValue: String(value) };
  }
  
  await fetch(firestoreUrl, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields })
  });
}
