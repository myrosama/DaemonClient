-- Photos table (replaces Firestore photos/{id})
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
);
