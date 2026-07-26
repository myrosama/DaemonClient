// The database schema — one definition, for every path that creates a database.
//
// Why this file exists rather than a copy per provisioner:
//
//   The schema used to live inline in `deployment-service/src/index.ts`, with a
//   second, never-executed copy in `immich-api-shim/src/migrations.ts`, and the
//   self-host CLI recovered it by string-scraping the deployment service's
//   TypeScript. That is how a hosted install and a self-hosted install came to
//   differ in the one place it mattered most: the seed below inserts
//   `zke_password` and `zke_salt` EMPTY and relies on a second step to fill
//   them. The hosted provisioner runs that step; the CLI did not, so every
//   self-hosted install had encryption switched on with no key to do it with.
//   Two copies and a scraper cannot be kept in step by discipline alone, so
//   there is now one module and both sides import it.
//
//   Plain ESM with no build step on purpose: the deployment-service worker is
//   TypeScript bundled by wrangler, and the CLI is dependency-free `.mjs` run
//   straight from a clone. A `.mjs` file with no imports of its own is the only
//   form both consume without either of them growing a build.
//
//   Anything that creates or repairs a database imports from here. If you add a
//   column, add it here and nowhere else.

/** The full schema a fresh database gets: photos, albums, config, upload
 *  sessions and Drive files.
 *
 *  Note what the config seed does NOT contain: real `zke_password` /
 *  `zke_salt` values. Key material is generated per install and written
 *  afterwards — by the hosted provisioner in `deployment-service`, and by
 *  `selfhost/src/zke.mjs` for a self-hosted one. Uploads are refused while
 *  these rows are empty (`immich-api-shim/src/assets.ts`, `getEncryptionKey`),
 *  so an install that skips that step fails closed rather than storing
 *  plaintext. */
export const MIGRATION_SQL = `
CREATE TABLE photos (
  id TEXT PRIMARY KEY, ownerId TEXT NOT NULL, fileName TEXT NOT NULL,
  fileSize INTEGER NOT NULL, mimeType TEXT NOT NULL, width INTEGER, height INTEGER,
  duration TEXT, fileCreatedAt TEXT NOT NULL, uploadedAt TEXT NOT NULL,
  telegramOriginalId TEXT, telegramThumbId TEXT, telegramChunks TEXT,
  encryptionMode TEXT DEFAULT 'off', thumbEncrypted INTEGER DEFAULT 0,
  checksum TEXT, isHeic INTEGER DEFAULT 0, livePhotoVideoId TEXT,
  isFavorite INTEGER DEFAULT 0, isTrashed INTEGER DEFAULT 0,
  visibility TEXT DEFAULT 'timeline', description TEXT, city TEXT, country TEXT,
  thumbhash TEXT, telegramPreviewId TEXT, previewEncrypted INTEGER DEFAULT 0,
  latitude REAL, longitude REAL,
  deviceAssetId TEXT, deviceId TEXT,
  make TEXT, model TEXT, lensModel TEXT, fNumber REAL, focalLength REAL,
  iso INTEGER, exposureTime TEXT, orientation TEXT, dateTimeOriginal TEXT,
  exifChecked INTEGER DEFAULT 0,
  checksumChecked INTEGER DEFAULT 0,
  heicThumbChecked INTEGER DEFAULT 0
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
);
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY, ownerId TEXT NOT NULL, parentId TEXT NOT NULL DEFAULT 'root',
  type TEXT NOT NULL DEFAULT 'file', fileName TEXT NOT NULL, fileSize INTEGER DEFAULT 0,
  fileType TEXT, messages TEXT, encrypted INTEGER DEFAULT 0,
  encryptionMode TEXT DEFAULT 'off', uploadedAt TEXT NOT NULL, updatedAt TEXT
);
CREATE INDEX IF NOT EXISTS idx_files_owner_parent ON files(ownerId, parentId);`;

/** Drive on its own, for an existing database provisioned before Drive existed
 *  (schema 1.2.0). Handed to `/admin/force-update` as `migrationSql` so an old
 *  per-user worker gains the files table without a full reprovision. Every
 *  statement is IF NOT EXISTS, so re-running it is a no-op. Kept identical to
 *  the tail of MIGRATION_SQL above. */
export const DRIVE_MIGRATION_SQL = `CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY, ownerId TEXT NOT NULL, parentId TEXT NOT NULL DEFAULT 'root',
  type TEXT NOT NULL DEFAULT 'file', fileName TEXT NOT NULL, fileSize INTEGER DEFAULT 0,
  fileType TEXT, messages TEXT, encrypted INTEGER DEFAULT 0,
  encryptionMode TEXT DEFAULT 'off', uploadedAt TEXT NOT NULL, updatedAt TEXT
);
CREATE INDEX IF NOT EXISTS idx_files_owner_parent ON files(ownerId, parentId);`;

/** One statement per element — Cloudflare's D1 HTTP query endpoint executes a
 *  single statement per request, so callers cannot post the whole script.
 *  Comment-only lines are dropped because a bare comment is not a statement and
 *  D1 rejects it. */
export function splitStatements(sql) {
  return sql
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !/^--/.test(s));
}
