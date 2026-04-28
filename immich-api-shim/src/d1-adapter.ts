import type { D1Database } from '@cloudflare/workers-types';

export interface Photo {
  id: string;
  ownerId: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  width?: number;
  height?: number;
  duration?: string;
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

  async savePhoto(photo: Partial<Photo> & { id: string }): Promise<void> {
    const existing = await this.getPhoto(photo.id);

    if (existing) {
      // Update
      const updates = Object.entries(photo)
        .filter(([key]) => key !== 'id')
        .map(([key]) => `${key} = ?`);

      const values = Object.entries(photo)
        .filter(([key]) => key !== 'id')
        .map(([, value]) => value);

      await this.db.prepare(
        `UPDATE photos SET ${updates.join(', ')} WHERE id = ?`
      ).bind(...values, photo.id).run();
    } else {
      // Insert
      const keys = Object.keys(photo);
      const placeholders = keys.map(() => '?').join(', ');
      const values = Object.values(photo);

      await this.db.prepare(
        `INSERT INTO photos (${keys.join(', ')}) VALUES (${placeholders})`
      ).bind(...values).run();
    }
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
      query += ` ORDER BY ${filters.orderBy}`;
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
    const existing = await this.getAlbum(album.id);

    if (existing) {
      const updates = Object.entries(album)
        .filter(([key]) => key !== 'id')
        .map(([key]) => `${key} = ?`);

      const values = Object.entries(album)
        .filter(([key]) => key !== 'id')
        .map(([, value]) => value);

      await this.db.prepare(
        `UPDATE albums SET ${updates.join(', ')} WHERE id = ?`
      ).bind(...values, album.id).run();
    } else {
      const keys = Object.keys(album);
      const placeholders = keys.map(() => '?').join(', ');
      const values = Object.values(album);

      await this.db.prepare(
        `INSERT INTO albums (${keys.join(', ')}) VALUES (${placeholders})`
      ).bind(...values).run();
    }
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
    const mode = await this.getConfig('zke_mode');
    const enabled = await this.getConfig('zke_enabled');
    const password = await this.getConfig('zke_password');
    const salt = await this.getConfig('zke_salt');

    if (!mode) return null;

    return {
      mode,
      enabled: enabled === '1',
      password: password || '',
      salt: salt || ''
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
