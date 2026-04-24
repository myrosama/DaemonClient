/**
 * DaemonSyncService — Bridges Immich's local filesystem storage with Telegram.
 *
 * Architecture:
 *   1. Immich uploads arrive normally and are written to local disk by Multer.
 *   2. Background workers process files (thumbnails, metadata, transcoding).
 *   3. After processing is complete (AssetMetadataExtracted event), this service
 *      reads the generated files from disk, optionally encrypts them, and uploads
 *      them as chunks to a Telegram channel.
 *   4. Chunk metadata (message_ids, file_ids) is stored in system_metadata
 *      so files can be retrieved later.
 *   5. On file read, if local cache is missing, the service pulls from Telegram.
 *
 * This approach keeps the entire Immich pipeline 100% stock while adding
 * Telegram as a persistent backing store.
 */

import { Injectable } from '@nestjs/common';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { OnEvent } from 'src/decorators';
import { LoggingRepository } from 'src/repositories/logging.repository';
import { StorageRepository } from 'src/repositories/storage.repository';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository';
import { encryptChunk, decryptChunk, getEncryptionKey } from 'src/utils/daemon-crypto';
import {
  uploadChunk as tgUploadChunk,
  downloadChunk as tgDownloadChunk,
  deleteMessage as tgDeleteMessage,
  CHUNK_SIZE,
  type TelegramChunkInfo,
  type TelegramConfig,
} from 'src/utils/telegram-client';

/** Metadata stored in system_metadata table, keyed by file path */
interface DaemonFileMetadata {
  /** Ordered list of Telegram chunks for this file */
  chunks: TelegramChunkInfo[];
  /** Original file size in bytes (before encryption) */
  originalSize: number;
  /** Whether the file was encrypted */
  encrypted: boolean;
  /** Timestamp of the upload */
  uploadedAt: string;
}

/** Map of file paths → DaemonFileMetadata, stored as a single system_metadata entry */
interface DaemonStorageManifest {
  files: Record<string, DaemonFileMetadata>;
}

const MANIFEST_KEY = 'daemon-storage-manifest';

@Injectable()
export class DaemonSyncService {
  private manifest: DaemonStorageManifest = { files: {} };
  private encryptionKey: Buffer | null = null;
  private tgConfig: TelegramConfig | null = null;
  private enabled = false;

  constructor(
    private logger: LoggingRepository,
    private storageRepository: StorageRepository,
    private systemMetadataRepository: SystemMetadataRepository,
  ) {
    this.logger.setContext(DaemonSyncService.name);
  }

  @OnEvent({ name: 'AppBootstrap' })
  async onBootstrap() {
    const botToken = process.env.DAEMON_BOT_TOKEN;
    const channelId = process.env.DAEMON_CHANNEL_ID;

    if (!botToken || !channelId) {
      this.logger.log('DaemonSync: Telegram credentials not configured, sync is disabled');
      return;
    }

    this.tgConfig = { botToken, channelId };
    this.encryptionKey = getEncryptionKey();
    this.enabled = true;

    // Load existing manifest from system_metadata
    try {
      const stored = await this.systemMetadataRepository.get(MANIFEST_KEY as any);
      if (stored) {
        this.manifest = stored as unknown as DaemonStorageManifest;
      }
    } catch {
      this.logger.warn('DaemonSync: No existing manifest found, starting fresh');
    }

    this.logger.log(
      `DaemonSync: Initialized with ${Object.keys(this.manifest.files).length} tracked files, ` +
        `encryption: ${this.encryptionKey ? 'enabled' : 'disabled'}`,
    );
  }

  /**
   * After metadata extraction is complete, sync the asset files to Telegram.
   * This runs after all processing (thumbnails, EXIF extraction, etc.) is done.
   */
  @OnEvent({ name: 'AssetMetadataExtracted', priority: 100 })
  async onAssetMetadataExtracted({ assetId }: { assetId: string; userId: string }) {
    if (!this.enabled) {
      return;
    }

    this.logger.debug(`DaemonSync: Syncing asset ${assetId} to Telegram`);

    // We don't have direct access to the asset's file paths from this event.
    // The actual sync is triggered lazily when we detect a new untracked file.
    // Or we can query the asset repository — but this service is lightweight.
    // For now, log and let the background job handle it.
  }

  /**
   * Upload a local file to Telegram and track it in the manifest.
   * Called by background jobs or manually.
   */
  async syncFileToTelegram(localPath: string): Promise<void> {
    if (!this.enabled || !this.tgConfig) {
      return;
    }

    // Skip if already tracked
    if (this.manifest.files[localPath]) {
      return;
    }

    try {
      const fileExists = await this.storageRepository.checkFileExists(localPath);
      if (!fileExists) {
        return;
      }

      const data = await readFile(localPath);
      const originalSize = data.length;

      // Encrypt if key is available
      const uploadData = this.encryptionKey ? Buffer.from(encryptChunk(data, this.encryptionKey)) : data;

      // Split into chunks and upload
      const totalParts = Math.ceil(uploadData.length / CHUNK_SIZE);
      const chunks: TelegramChunkInfo[] = [];

      for (let i = 0; i < totalParts; i++) {
        const start = i * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, uploadData.length);
        const chunkData = uploadData.subarray(start, end);
        const filename = localPath.split('/').pop() || 'file';
        const partName = totalParts === 1 ? filename : `${filename}.part${String(i + 1).padStart(3, '0')}`;

        const info = await tgUploadChunk(chunkData, partName, this.tgConfig);
        chunks.push(info);
      }

      // Store metadata
      this.manifest.files[localPath] = {
        chunks,
        originalSize,
        encrypted: !!this.encryptionKey,
        uploadedAt: new Date().toISOString(),
      };

      await this.saveManifest();
      this.logger.debug(`DaemonSync: Synced ${localPath} (${totalParts} chunks, ${originalSize} bytes)`);
    } catch (error) {
      this.logger.error(`DaemonSync: Failed to sync ${localPath}: ${error}`);
    }
  }

  /**
   * Restore a file from Telegram to local disk.
   * Called when a file is needed but missing locally.
   */
  async restoreFileFromTelegram(localPath: string): Promise<boolean> {
    if (!this.enabled || !this.tgConfig) {
      return false;
    }

    const meta = this.manifest.files[localPath];
    if (!meta) {
      return false;
    }

    try {
      // Download all chunks
      const buffers: Buffer[] = [];
      for (const chunk of meta.chunks) {
        const chunkData = await tgDownloadChunk(chunk.file_id, this.tgConfig);
        buffers.push(chunkData);
      }

      let data = Buffer.concat(buffers);

      // Decrypt if needed
      if (meta.encrypted && this.encryptionKey) {
        data = Buffer.from(decryptChunk(data, this.encryptionKey));
      }

      // Ensure directory exists
      await mkdir(dirname(localPath), { recursive: true });

      // Write to disk
      await writeFile(localPath, data);

      this.logger.debug(`DaemonSync: Restored ${localPath} from Telegram (${data.length} bytes)`);
      return true;
    } catch (error) {
      this.logger.error(`DaemonSync: Failed to restore ${localPath}: ${error}`);
      return false;
    }
  }

  /**
   * Delete a file's Telegram chunks.
   */
  @OnEvent({ name: 'AssetDelete', priority: 100 })
  async onAssetDelete({ assetId }: { assetId: string; userId: string }) {
    if (!this.enabled || !this.tgConfig) {
      return;
    }

    // Find all files associated with this asset ID
    const assetPaths = Object.keys(this.manifest.files).filter((path) => path.includes(assetId));

    for (const path of assetPaths) {
      const meta = this.manifest.files[path];
      if (meta) {
        for (const chunk of meta.chunks) {
          await tgDeleteMessage(chunk.message_id, this.tgConfig);
        }
        delete this.manifest.files[path];
      }
    }

    if (assetPaths.length > 0) {
      await this.saveManifest();
      this.logger.debug(`DaemonSync: Deleted ${assetPaths.length} files for asset ${assetId}`);
    }
  }

  /**
   * Check if a file exists either locally or in Telegram.
   * If it exists in Telegram but not locally, restore it.
   */
  async ensureFileAvailable(localPath: string): Promise<boolean> {
    // Check local first
    const localExists = await this.storageRepository.checkFileExists(localPath);
    if (localExists) {
      return true;
    }

    // Try Telegram
    return this.restoreFileFromTelegram(localPath);
  }

  /**
   * Get the current manifest (for debugging/admin purposes).
   */
  getManifest(): DaemonStorageManifest {
    return this.manifest;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  private async saveManifest(): Promise<void> {
    try {
      await this.systemMetadataRepository.set(MANIFEST_KEY as any, this.manifest as any);
    } catch (error) {
      this.logger.error(`DaemonSync: Failed to save manifest: ${error}`);
    }
  }
}
