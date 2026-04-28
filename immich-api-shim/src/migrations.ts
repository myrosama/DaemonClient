import type { D1Database } from '@cloudflare/workers-types';

export interface Migration {
  version: string;
  sql: string;
}

// All migrations in order
const MIGRATIONS: Migration[] = [
  {
    version: '1.0.0',
    sql: `-- Photos table (replaces Firestore photos/{id})
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
  telegramChunks TEXT, -- JSON array

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

-- Indexes for common queries
CREATE INDEX idx_photos_uploadedAt ON photos(uploadedAt DESC);
CREATE INDEX idx_photos_fileCreatedAt ON photos(fileCreatedAt DESC);
CREATE INDEX idx_photos_livePhoto ON photos(livePhotoVideoId) WHERE livePhotoVideoId IS NOT NULL;
CREATE INDEX idx_photos_favorite ON photos(isFavorite) WHERE isFavorite = 1;
CREATE INDEX idx_photos_trashed ON photos(isTrashed);

-- Albums table
CREATE TABLE albums (
  id TEXT PRIMARY KEY,
  albumName TEXT NOT NULL,
  description TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  albumThumbnailAssetId TEXT
);

-- Album assets junction table
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

-- Config table
CREATE TABLE config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Insert default ZKE config (encryption ON by default for new users)
INSERT INTO config (key, value) VALUES
  ('zke_mode', 'server'),
  ('zke_enabled', '1'),
  ('zke_password', ''),
  ('zke_salt', '');

-- Upload sessions table
CREATE TABLE upload_sessions (
  sessionId TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'active',
  createdAt TEXT NOT NULL,
  expiresAt TEXT NOT NULL
);`
  }
];

export async function runMigrations(
  db: D1Database,
  fromVersion: string,
  toVersion: string
): Promise<void> {
  const migrations = getMigrationsInRange(fromVersion, toVersion);

  console.log(`Running ${migrations.length} migrations: ${fromVersion} → ${toVersion}`);

  for (const migration of migrations) {
    try {
      console.log(`[Migration] Running ${migration.version}...`);

      // Split SQL into individual statements
      const statements = migration.sql
        .split(';')
        .map(s => s.trim())
        .filter(s => s.length > 0 && !s.startsWith('--'))
        .map(s => db.prepare(s));

      // Add schema version update to the statement batch
      statements.push(
        db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)')
          .bind('schema_version', migration.version)
      );

      // Run all statements in single batch transaction
      if (statements.length > 0) {
        await db.batch(statements);
      }

      console.log(`[Migration] ✓ ${migration.version} complete`);
    } catch (error: any) {
      console.error(`[Migration] ✗ ${migration.version} failed:`, error.message);
      throw new Error(`Migration ${migration.version} failed: ${error.message}`);
    }
  }
}

export function getMigrationsInRange(fromVersion: string, toVersion: string): Migration[] {
  const fromIdx = MIGRATIONS.findIndex(m => m.version === fromVersion);
  const toIdx = MIGRATIONS.findIndex(m => m.version === toVersion);

  if (fromIdx === -1) {
    // No current version, run all migrations up to toVersion
    return MIGRATIONS.filter(m => compareVersions(m.version, toVersion) <= 0);
  }

  if (toIdx === -1) {
    throw new Error(`Target version ${toVersion} not found`);
  }

  // Return migrations between fromVersion and toVersion (exclusive of fromVersion)
  return MIGRATIONS.slice(fromIdx + 1, toIdx + 1);
}

export function compareVersions(v1: string, v2: string): number {
  const parts1 = v1.split('.').map(Number);
  const parts2 = v2.split('.').map(Number);

  for (let i = 0; i < 3; i++) {
    if (parts1[i] > parts2[i]) return 1;
    if (parts1[i] < parts2[i]) return -1;
  }

  return 0;
}

export async function getCurrentSchemaVersion(db: D1Database): Promise<string | null> {
  try {
    // Check if config table exists
    const tableCheck = await db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='config'"
    ).first();

    if (!tableCheck) {
      return null; // Table doesn't exist, first-time setup
    }

    const result = await db.prepare(
      'SELECT value FROM config WHERE key = ?'
    ).bind('schema_version').first<{ value: string }>();

    return result?.value || null;
  } catch (error) {
    console.error('[Migration] Error checking schema version:', error);
    throw error; // Re-throw instead of returning null
  }
}
