import type { D1Database } from '@cloudflare/workers-types';

export interface Photo {
  id: string;
  ownerId: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  width?: number;
  height?: number;
  duration?: string | null;
  fileCreatedAt: string;
  uploadedAt: string;
  telegramOriginalId?: string | null;
  telegramThumbId?: string | null;
  telegramChunks?: string | null; // JSON string
  encryptionMode?: string;
  thumbEncrypted?: number;
  checksum?: string;
  isHeic?: number;
  livePhotoVideoId?: string;
  isFavorite?: number;
  isTrashed?: number;
  visibility?: string;
  description?: string;
  city?: string;
  country?: string;
  latitude?: number | null;
  longitude?: number | null;
  // Dedup fields — populated by mobile uploads (Immich app sends these in multipart form).
  // Added via self-healing ALTER in ensureDeduplicationSchema(); NULL for legacy rows.
  deviceAssetId?: string | null;
  deviceId?: string | null;
}

export interface Album {
  id: string;
  albumName: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
  albumThumbnailAssetId?: string | null;
}

export class D1Adapter {
  constructor(private db: D1Database) {}

  // ────────────────────────────────────────────────────────────
  // Photos
  // ────────────────────────────────────────────────────────────

  async getPhoto(id: string): Promise<Photo | null> {
    const result = await this.db.prepare(
      'SELECT * FROM photos WHERE id = ?'
    ).bind(id).first<Photo>();

    return result || null;
  }

  // Normalize a D1 photo row to the legacy Firestore-shaped object the rest
  // of the codebase still consumes: `_id` alongside `id`, `originalFileName`
  // alongside `fileName`, and `telegramChunks` parsed back into an array.
  static normalizeRow(row: any): any {
    if (!row) return row;
    let chunks = row.telegramChunks;
    if (typeof chunks === 'string') {
      try { chunks = JSON.parse(chunks); } catch { chunks = []; }
    }
    return {
      ...row,
      _id: row.id,
      originalFileName: row.fileName,
      telegramChunks: chunks,
    };
  }

  async savePhoto(photo: Partial<Photo> & { id: string }): Promise<void> {
    // D1 .bind() rejects `undefined` ("D1_TYPE_ERROR: Type 'undefined' not
    // supported"). Drop undefined fields entirely (the column will keep its
    // default / NULL) and coerce any other non-bindable values (NaN) to null.
    const entries = Object.entries(photo).filter(([, v]) => v !== undefined).map(
      ([k, v]) => [k, typeof v === 'number' && Number.isNaN(v) ? null : v] as const
    );
    const keys = entries.map(([k]) => k);
    const values = entries.map(([, v]) => v);
    const placeholders = keys.map(() => '?').join(', ');

    const updateSet = keys
      .filter(k => k !== 'id')
      .map(k => `${k} = excluded.${k}`)
      .join(', ');

    await this.db.prepare(
      `INSERT INTO photos (${keys.join(', ')}) VALUES (${placeholders})
       ON CONFLICT(id) DO UPDATE SET ${updateSet}`
    ).bind(...values).run();
  }

  // Partial UPDATE of an existing photo — only the given columns, leaving every
  // other column (ownerId, fileName, fileCreatedAt, all metadata/timestamps)
  // untouched. Use this instead of savePhoto for "patch a few fields on a row
  // that already exists": savePhoto's INSERT…ON CONFLICT upsert first attempts
  // an INSERT, which fails the NOT NULL constraints (ownerId etc.) when the
  // object is partial, before the conflict-update can run.
  async updatePhoto(id: string, fields: Partial<Photo>): Promise<void> {
    const entries = Object.entries(fields).filter(([k, v]) => k !== 'id' && v !== undefined).map(
      ([k, v]) => [k, typeof v === 'number' && Number.isNaN(v) ? null : v] as const
    );
    if (entries.length === 0) return;
    const setClause = entries.map(([k]) => `${k} = ?`).join(', ');
    const values = entries.map(([, v]) => v);
    await this.db.prepare(`UPDATE photos SET ${setClause} WHERE id = ?`).bind(...values, id).run();
  }

  async deletePhoto(id: string): Promise<void> {
    await this.db.prepare('DELETE FROM photos WHERE id = ?').bind(id).run();
  }

  async queryPhotos(
    filters: {
      ownerId?: string;
      isTrashed?: number;
      visibility?: string;
      orderBy?: string;
      limit?: number;
      offset?: number;
    }
  ): Promise<Photo[]> {
    let query = 'SELECT * FROM photos WHERE 1=1';
    const bindings: any[] = [];

    if (filters.ownerId !== undefined) {
      query += ' AND ownerId = ?';
      bindings.push(filters.ownerId);
    }

    if (filters.isTrashed !== undefined) {
      query += ' AND isTrashed = ?';
      bindings.push(filters.isTrashed);
    }

    if (filters.visibility !== undefined) {
      query += ' AND visibility = ?';
      bindings.push(filters.visibility);
    }

    if (filters.orderBy) {
      const allowedColumns = ['uploadedAt', 'fileCreatedAt', 'fileName', 'fileSize', 'width', 'height'];
      const [column, direction = 'DESC'] = filters.orderBy.split(' ');
      const upperDirection = direction.toUpperCase();

      if (!allowedColumns.includes(column) || !['ASC', 'DESC'].includes(upperDirection)) {
        throw new Error(`Invalid orderBy parameter: ${filters.orderBy}`);
      }
      query += ` ORDER BY ${column} ${upperDirection}`;
    }

    if (filters.limit !== undefined) {
      query += ' LIMIT ?';
      bindings.push(filters.limit);
    }

    if (filters.offset !== undefined) {
      query += ' OFFSET ?';
      bindings.push(filters.offset);
    }

    const result = await this.db.prepare(query).bind(...bindings).all<Photo>();
    return result.results || [];
  }

  // ────────────────────────────────────────────────────────────
  // Albums
  // ────────────────────────────────────────────────────────────

  async getAlbum(id: string): Promise<Album | null> {
    const result = await this.db.prepare(
      'SELECT * FROM albums WHERE id = ?'
    ).bind(id).first<Album>();

    return result || null;
  }

  async saveAlbum(album: Partial<Album> & { id: string }): Promise<void> {
    const keys = Object.keys(album);
    const placeholders = keys.map(() => '?').join(', ');
    const values = Object.values(album);

    const updateSet = keys
      .filter(k => k !== 'id')
      .map(k => `${k} = excluded.${k}`)
      .join(', ');

    await this.db.prepare(
      `INSERT INTO albums (${keys.join(', ')}) VALUES (${placeholders})
       ON CONFLICT(id) DO UPDATE SET ${updateSet}`
    ).bind(...values).run();
  }

  async deleteAlbum(id: string): Promise<void> {
    await this.db.prepare('DELETE FROM albums WHERE id = ?').bind(id).run();
  }

  async getAlbumAssets(albumId: string): Promise<string[]> {
    const result = await this.db.prepare(
      'SELECT assetId FROM album_assets WHERE albumId = ? ORDER BY addedAt DESC'
    ).bind(albumId).all<{ assetId: string }>();

    return result.results?.map(r => r.assetId) || [];
  }

  async listAlbums(): Promise<Album[]> {
    const result = await this.db.prepare(
      'SELECT * FROM albums ORDER BY updatedAt DESC'
    ).all<Album>();
    return result.results || [];
  }

  async countAlbumAssets(albumId: string): Promise<number> {
    const result = await this.db.prepare(
      'SELECT COUNT(*) as c FROM album_assets WHERE albumId = ?'
    ).bind(albumId).first<{ c: number }>();
    return result?.c || 0;
  }

  async addAssetToAlbum(albumId: string, assetId: string): Promise<void> {
    await this.db.prepare(
      'INSERT OR IGNORE INTO album_assets (albumId, assetId, addedAt) VALUES (?, ?, ?)'
    ).bind(albumId, assetId, new Date().toISOString()).run();
  }

  async removeAssetFromAlbum(albumId: string, assetId: string): Promise<void> {
    await this.db.prepare(
      'DELETE FROM album_assets WHERE albumId = ? AND assetId = ?'
    ).bind(albumId, assetId).run();
  }

  // ────────────────────────────────────────────────────────────
  // Config
  // ────────────────────────────────────────────────────────────

  async getConfig(key: string): Promise<string | null> {
    const result = await this.db.prepare(
      'SELECT value FROM config WHERE key = ?'
    ).bind(key).first<{ value: string }>();

    return result?.value || null;
  }

  async setConfig(key: string, value: string): Promise<void> {
    await this.db.prepare(
      'INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)'
    ).bind(key, value).run();
  }

  // JSON-blob config helpers — these store a serialized object under a single
  // key in the existing config table, so we can move per-user document configs
  // (telegram/photosFlags/worker/immich_profile) off Firestore without adding
  // new columns or migrations.
  async getJsonConfig<T = any>(key: string): Promise<T | null> {
    const raw = await this.getConfig(key);
    if (!raw) return null;
    try { return JSON.parse(raw) as T; } catch { return null; }
  }

  async setJsonConfig(key: string, value: any): Promise<void> {
    await this.setConfig(key, JSON.stringify(value));
  }

  async getZkeConfig(): Promise<{
    mode: string;
    enabled: boolean;
    password: string;
    salt: string;
  } | null> {
    const result = await this.db.prepare(
      `SELECT key, value FROM config
       WHERE key IN ('zke_mode', 'zke_enabled', 'zke_password', 'zke_salt')`
    ).all<{ key: string; value: string }>();

    if (!result.results || result.results.length === 0) {
      return null;
    }

    const config = Object.fromEntries(
      result.results.map(r => [r.key, r.value])
    );

    if (!config.zke_mode) return null;

    return {
      mode: config.zke_mode,
      enabled: config.zke_enabled === '1',
      password: config.zke_password || '',
      salt: config.zke_salt || ''
    };
  }

  async setZkeConfig(config: {
    mode?: string;
    enabled?: boolean;
    password?: string;
    salt?: string;
  }): Promise<void> {
    if (config.mode !== undefined) {
      await this.setConfig('zke_mode', config.mode);
    }
    if (config.enabled !== undefined) {
      await this.setConfig('zke_enabled', config.enabled ? '1' : '0');
    }
    if (config.password !== undefined) {
      await this.setConfig('zke_password', config.password);
    }
    if (config.salt !== undefined) {
      await this.setConfig('zke_salt', config.salt);
    }
  }

  // ────────────────────────────────────────────────────────────
  // Drive files (file/folder metadata — bytes live in Telegram, uploaded
  // client-side; this table never holds plaintext or keys)
  // ────────────────────────────────────────────────────────────

  // Parse the stored `messages` JSON back to an array and coerce `encrypted`
  // to a real boolean for the JSON client (mirrors normalizeRow for photos).
  static normalizeFile(row: any): any {
    if (!row) return row;
    let messages = row.messages;
    if (typeof messages === 'string') {
      try { messages = JSON.parse(messages); } catch { messages = []; }
    }
    return { ...row, messages: messages ?? [], encrypted: !!row.encrypted };
  }

  async listFiles(ownerId: string, parentId?: string): Promise<any[]> {
    let query = 'SELECT * FROM files WHERE ownerId = ?';
    const bindings: any[] = [ownerId];
    if (parentId !== undefined) {
      query += ' AND parentId = ?';
      bindings.push(parentId);
    }
    // Folders first, then files, alphabetical — matches the old Drive ordering.
    query += " ORDER BY (type = 'folder') DESC, fileName COLLATE NOCASE ASC";
    const result = await this.db.prepare(query).bind(...bindings).all<any>();
    return (result.results || []).map(D1Adapter.normalizeFile);
  }

  async getFile(id: string): Promise<any | null> {
    const result = await this.db.prepare('SELECT * FROM files WHERE id = ?').bind(id).first<any>();
    return result || null;
  }

  async saveFile(file: Record<string, any> & { id: string }): Promise<void> {
    const entries = Object.entries(file).filter(([, v]) => v !== undefined);
    const keys = entries.map(([k]) => k);
    const values = entries.map(([, v]) => v);
    const placeholders = keys.map(() => '?').join(', ');
    const updateSet = keys.filter(k => k !== 'id').map(k => `${k} = excluded.${k}`).join(', ');
    await this.db.prepare(
      `INSERT INTO files (${keys.join(', ')}) VALUES (${placeholders})
       ON CONFLICT(id) DO UPDATE SET ${updateSet}`
    ).bind(...values).run();
  }

  async updateFile(id: string, fields: Record<string, any>): Promise<void> {
    const entries = Object.entries(fields).filter(([k, v]) => k !== 'id' && v !== undefined);
    if (entries.length === 0) return;
    const setClause = entries.map(([k]) => `${k} = ?`).join(', ');
    const values = entries.map(([, v]) => v);
    await this.db.prepare(`UPDATE files SET ${setClause} WHERE id = ?`).bind(...values, id).run();
  }

  async deleteFile(id: string): Promise<void> {
    await this.db.prepare('DELETE FROM files WHERE id = ?').bind(id).run();
  }

  // ────────────────────────────────────────────────────────────
  // Deduplication lookup
  // ────────────────────────────────────────────────────────────

  // Look up an existing photo by the device-local identity pair that the Immich
  // mobile app sends on every upload. `isVideo` discriminates live-photo stills
  // (JPEG) from their companion MOV — both carry the SAME deviceAssetId — so we
  // match on mimeType kind (video/* vs everything else) to avoid returning the
  // wrong half of a live pair as a duplicate.
  async getPhotoByDeviceAsset(
    ownerId: string,
    deviceAssetId: string,
    deviceId: string,
    isVideo: boolean,
  ): Promise<Photo | null> {
    const mimeClause = isVideo
      ? "AND mimeType LIKE 'video/%'"
      : "AND mimeType NOT LIKE 'video/%'";
    const result = await this.db
      .prepare(
        `SELECT * FROM photos WHERE ownerId = ? AND deviceAssetId = ? AND deviceId = ? ${mimeClause} LIMIT 1`,
      )
      .bind(ownerId, deviceAssetId, deviceId)
      .first<Photo>();
    return result || null;
  }

  // Total bytes a user has stored in Drive (folders count as 0). Feeds the
  // storage/usage display without scanning Telegram.
  async sumFileSizes(ownerId: string): Promise<number> {
    const result = await this.db.prepare(
      "SELECT COALESCE(SUM(fileSize), 0) AS total FROM files WHERE ownerId = ? AND type = 'file'"
    ).bind(ownerId).first<{ total: number }>();
    return result?.total || 0;
  }
}
