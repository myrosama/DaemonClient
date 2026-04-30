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
  telegramOriginalId?: string;
  telegramThumbId?: string;
  telegramChunks?: string; // JSON string
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
}

export interface Album {
  id: string;
  albumName: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
  albumThumbnailAssetId?: string;
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
}
