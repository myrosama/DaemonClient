import { browser } from '$app/environment';
import { authManager } from '$lib/managers/auth-manager.svelte';

export interface TelegramConfig {
  botToken: string;
  channelId: string;
  proxyUrl: string;
}

export interface ZkeConfig {
  enabled: boolean;
  password?: string;
  salt?: string;
}

class DaemonClientDrive {
  private config?: TelegramConfig;
  private zkeConfig?: ZkeConfig;
  private encryptionKey?: CryptoKey;
  private objectUrls = new Map<string, { url: string; createdAt: number }>();
  private cleanupInterval?: number;

  private async getConfig(): Promise<TelegramConfig> {
    if (this.config) return this.config;
    const res = await fetch('/api/server/telegram-config');
    this.config = await res.json();
    return this.config!;
  }

  private async getZkeConfig(): Promise<ZkeConfig> {
    if (this.zkeConfig) return this.zkeConfig;
    const res = await fetch('/api/assets/zke-status');
    const status = await res.json();
    if (status.mode === 'server') {
        // We need to fetch the actual password/salt from the shim if it's server-mode
        // but for security, usually it's better if the client has it.
        // For now, let's assume we can fetch it if authenticated.
        const configRes = await fetch('/api/server/zke-config'); // I should add this endpoint
        this.zkeConfig = await configRes.json();
    } else {
        this.zkeConfig = { enabled: false };
    }
    return this.zkeConfig!;
  }

  private async getEncryptionKey(): Promise<CryptoKey | null> {
    if (this.encryptionKey) return this.encryptionKey;
    const zke = await this.getZkeConfig();
    if (zke.enabled && zke.password && zke.salt) {
      this.encryptionKey = await this.deriveKey(zke.password, zke.salt);
      return this.encryptionKey;
    }
    return null;
  }

  private async deriveKey(password: string, saltStr: string): Promise<CryptoKey> {
    const salt = Uint8Array.from(atob(saltStr), (c) => c.charCodeAt(0));
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(password),
      'PBKDF2',
      false,
      ['deriveBits', 'deriveKey']
    );
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: salt, iterations: 100000, hash: 'SHA-256' },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  async decryptChunk(encryptedChunk: ArrayBuffer, key: CryptoKey): Promise<ArrayBuffer> {
    const data = new Uint8Array(encryptedChunk);
    const iv = data.slice(0, 12);
    const encrypted = data.slice(12);
    return crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, encrypted.buffer);
  }

  async downloadSingleFile(fileId: string): Promise<ArrayBuffer> {
    const config = await this.getConfig();
    const botToken = config.botToken;
    const proxy = config.proxyUrl || '';

    const getFileUrl = `${proxy}?url=${encodeURIComponent(`https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`)}`;
    const fileRes = await fetch(getFileUrl);
    const fileData = await fileRes.json();
    if (!fileData.ok) throw new Error(`Failed to get file path for ${fileId}`);

    const filePath = fileData.result.file_path;
    const downloadUrl = `${proxy}?url=${encodeURIComponent(`https://api.telegram.org/file/bot${botToken}/${filePath}`)}`;

    const res = await fetch(downloadUrl);
    if (!res.ok) throw new Error(`Download failed for ${fileId}`);
    return res.arrayBuffer();
  }

  concatenateBuffers(buffers: ArrayBuffer[]): ArrayBuffer {
    const totalLength = buffers.reduce((acc, buf) => acc + buf.byteLength, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const buf of buffers) {
      result.set(new Uint8Array(buf), offset);
      offset += buf.byteLength;
    }
    return result.buffer;
  }

  async downloadMedia(asset: any, quality: 'thumbnail' | 'preview' | 'original' = 'thumbnail'): Promise<string> {
    if (!browser) return '';

    // Choose the correct ID based on quality
    const fileId = (quality === 'original') ? (asset.telegramOriginalId || asset.telegramFileId) : asset.telegramFileId;
    const chunks = asset.telegramChunks || [];

    let buffer: ArrayBuffer;

    if (quality === 'original' && chunks.length > 1) {
      const partBuffers = [];
      for (const chunk of chunks) {
        partBuffers.push(await this.downloadSingleFile(chunk.file_id));
      }
      buffer = this.concatenateBuffers(partBuffers);
    } else {
      if (!fileId) throw new Error(`No Telegram ID for quality ${quality}`);
      const key = await this.getEncryptionKey();
      const isEncrypted = asset.encryptionMode === 'server' || asset.encryptionMode === 'client';
      
      // If NOT encrypted and it's a single file, we can return the direct URL for streaming!
      if (!isEncrypted && quality === 'original' && chunks.length <= 1) {
          const config = await this.getConfig();
          const botToken = config.botToken;
          const proxy = config.proxyUrl || '';
          const getFileUrl = `${proxy}?url=${encodeURIComponent(`https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`)}`;
          const fileRes = await fetch(getFileUrl);
          const fileData = await fileRes.json();
          if (fileData.ok) {
              const filePath = fileData.result.file_path;
              return `${proxy}?url=${encodeURIComponent(`https://api.telegram.org/file/bot${botToken}/${filePath}`)}`;
          }
      }
      buffer = await this.downloadSingleFile(fileId);
    }

    // 3. Decrypt if needed
    if (asset.encryptionMode === 'server' || asset.encryptionMode === 'client') {
      const key = await this.getEncryptionKey();
      if (key) {
        try {
          // Decrypt chunk by chunk if we had chunks? 
          // Actually, our encryptChunk puts IV at the start of EVERY chunk.
          // So if we joined chunks, we must decrypt them individually.
          if (quality === 'original' && chunks.length > 1) {
             // Re-decrypt individual parts if they were joined
             // (Optimization: we could have decrypted them inside the loop above)
             const partBuffers = [];
             let offset = 0;
             const view = new Uint8Array(buffer);
             // This is tricky because chunk sizes might vary if encrypted.
             // Better to decrypt during download loop.
             return this.downloadAndDecryptComplex(asset, quality);
          } else {
             buffer = await this.decryptChunk(buffer, key);
          }
        } catch (e) {
          console.error('Decryption failed. Key might be wrong or data corrupted.');
          throw e;
        }
      }
    }

    let finalBlob = new Blob([buffer], { type: asset.originalMimeType || (quality === 'thumbnail' ? 'image/jpeg' : 'image/jpeg') });

    // 4. HEIC conversion for browser support
    const isHeic = (asset.originalMimeType?.includes('heic') || asset.originalPath?.toLowerCase().endsWith('.heic') || asset.originalPath?.toLowerCase().endsWith('.heif'));
    if (isHeic && quality !== 'thumbnail') {
      try {
        const module = await import('./heic2any.js');
        const heic2any = module.default || module;
        const converted = await heic2any({ blob: finalBlob, toType: 'image/jpeg', quality: 0.8 });
        finalBlob = Array.isArray(converted) ? converted[0] : converted;
      } catch (e) {
        console.error('HEIC conversion failed during download:', e);
      }
    }

    const url = URL.createObjectURL(finalBlob);
    this.trackObjectUrl(url);
    return url;
  }

  async downloadAndDecryptComplex(asset: any, quality: 'thumbnail' | 'preview' | 'original'): Promise<string> {
    const chunks = asset.telegramChunks || [];
    const key = await this.getEncryptionKey();
    const decryptedParts = [];

    if (quality === 'original' && chunks.length > 0) {
      for (const chunk of chunks) {
        let part = await this.downloadSingleFile(chunk.file_id);
        if (key && (asset.encryptionMode === 'server' || asset.encryptionMode === 'client')) {
          part = await this.decryptChunk(part, key);
        }
        decryptedParts.push(part);
      }
    } else {
      const fileId = (quality === 'original') ? (asset.telegramOriginalId || asset.telegramFileId) : asset.telegramFileId;
      if (!fileId) throw new Error('No file ID');
      let part = await this.downloadSingleFile(fileId);
      if (key && (asset.encryptionMode === 'server' || asset.encryptionMode === 'client')) {
        part = await this.decryptChunk(part, key);
      }
      decryptedParts.push(part);
    }

    const finalBuffer = this.concatenateBuffers(decryptedParts);
    let finalBlob = new Blob([finalBuffer], { type: asset.originalMimeType || (quality === 'thumbnail' ? 'image/jpeg' : 'video/mp4') });

    // HEIC conversion
    const isHeic = (asset.originalMimeType?.includes('heic') || asset.originalPath?.toLowerCase().endsWith('.heic') || asset.originalPath?.toLowerCase().endsWith('.heif'));
    if (isHeic && quality !== 'thumbnail') {
      try {
        const module = await import('./heic2any.js');
        const heic2any = module.default || module;
        const converted = await heic2any({ blob: finalBlob, toType: 'image/jpeg', quality: 0.8 });
        finalBlob = Array.isArray(converted) ? converted[0] : converted;
      } catch (e) {
        console.error('HEIC conversion failed in complex download:', e);
      }
    }

    const url = URL.createObjectURL(finalBlob);
    this.trackObjectUrl(url);
    return url;
  }

  private trackObjectUrl(url: string) {
    this.objectUrls.set(url, { url, createdAt: Date.now() });

    // Start cleanup interval if not already running
    if (!this.cleanupInterval && typeof window !== 'undefined') {
      this.cleanupInterval = window.setInterval(() => this.cleanupOldUrls(), 60000); // Run every minute
    }
  }

  private cleanupOldUrls() {
    const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
    for (const [url, data] of this.objectUrls.entries()) {
      if (data.createdAt < fiveMinutesAgo) {
        URL.revokeObjectURL(url);
        this.objectUrls.delete(url);
      }
    }
  }

  revokeObjectUrl(url: string) {
    if (this.objectUrls.has(url)) {
      URL.revokeObjectURL(url);
      this.objectUrls.delete(url);
    }
  }

  async encryptChunk(chunkData: ArrayBuffer, key: CryptoKey): Promise<ArrayBuffer> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, chunkData);
    const result = new Uint8Array(iv.length + encrypted.byteLength);
    result.set(iv, 0);
    result.set(new Uint8Array(encrypted), iv.length);
    return result.buffer;
  }

  private async tgFetchWithRetry(url: string, options: RequestInit, maxRetries = 5): Promise<any> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const res = await fetch(url, options);
      const data = await res.json();

      if (data.ok) return data;

      if (data.error_code === 429) {
        const retryAfter = data.parameters?.retry_after || 5;
        console.warn(`Telegram 429, waiting ${retryAfter + 1}s (attempt ${attempt + 1}/${maxRetries + 1})`);
        await new Promise(r => setTimeout(r, (retryAfter + 1) * 1000));
        continue;
      }

      throw new Error(`Telegram upload failed: ${data.description}`);
    }
    throw new Error('Telegram upload failed: max retries exceeded');
  }

  private delay(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
  }

  async uploadMedia(file: File, thumbBlob?: Blob | null, onProgress?: (loaded: number, total: number) => void): Promise<any> {
    const config = await this.getConfig();
    const botToken = config.botToken;
    const proxy = config.proxyUrl || '';
    const channelId = config.channelId;

    if (!botToken || !channelId) throw new Error('Telegram not configured');

    const key = await this.getEncryptionKey();
    const isEncrypted = key !== null;
    const CHUNK_SIZE = 19 * 1024 * 1024;
    const INTER_REQUEST_DELAY = 1500;

    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
    const telegramChunks: Array<{ index: number; message_id: number; file_id: string }> = [];

    for (let i = 0; i < totalChunks; i++) {
      const start = i * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, file.size);
      const chunk = file.slice(start, end);
      let chunkData = await chunk.arrayBuffer();

      if (isEncrypted) {
        chunkData = await this.encryptChunk(chunkData, key);
      }

      const partName = totalChunks === 1 ? file.name : `${file.name}.part${String(i + 1).padStart(3, '0')}`;
      const formData = new FormData();
      formData.append('chat_id', channelId);
      formData.append('document', new Blob([chunkData], { type: 'application/octet-stream' }), partName);

      const tgUrl = `${proxy}?url=${encodeURIComponent(`https://api.telegram.org/bot${botToken}/sendDocument`)}`;
      const data = await this.tgFetchWithRetry(tgUrl, { method: 'POST', body: formData });

      telegramChunks.push({ index: i, message_id: data.result.message_id, file_id: data.result.document.file_id });
      if (onProgress) onProgress(Math.min((i + 1) * CHUNK_SIZE, file.size), file.size);

      if (i < totalChunks - 1) await this.delay(INTER_REQUEST_DELAY);
    }

    let telegramThumbId: string | null = null;
    if (thumbBlob) {
      await this.delay(INTER_REQUEST_DELAY);

      let thumbData = await thumbBlob.arrayBuffer();
      if (isEncrypted) {
        thumbData = await this.encryptChunk(thumbData, key);
      }

      const formData = new FormData();
      formData.append('chat_id', channelId);
      if (isEncrypted) {
        formData.append('document', new Blob([thumbData], { type: 'application/octet-stream' }), 'thumb.bin');
      } else {
        formData.append('photo', thumbBlob, 'thumb.jpg');
      }

      const method = isEncrypted ? 'sendDocument' : 'sendPhoto';
      const tgUrl = `${proxy}?url=${encodeURIComponent(`https://api.telegram.org/bot${botToken}/${method}`)}`;
      try {
        const data = await this.tgFetchWithRetry(tgUrl, { method: 'POST', body: formData });
        telegramThumbId = isEncrypted ? data.result.document.file_id : data.result.photo[data.result.photo.length - 1].file_id;
      } catch (e) {
        console.error('Thumb upload failed:', e);
      }
    }

    return {
      telegramChunks,
      telegramOriginalId: telegramChunks.length === 1 ? telegramChunks[0].file_id : null,
      telegramThumbId,
      encryptionMode: isEncrypted ? 'server' : 'off'
    };
  }

  async deleteMedia(chunks: any[]): Promise<void> {
    if (!chunks || chunks.length === 0) return;
    const config = await this.getConfig();
    const botToken = config.botToken;
    const proxy = config.proxyUrl || '';
    const channelId = config.channelId;

    if (!botToken || !channelId) return;

    for (const chunk of chunks) {
      if (!chunk.message_id) continue;
      const tgUrl = `${proxy}?url=${encodeURIComponent(`https://api.telegram.org/bot${botToken}/deleteMessage`)}`;
      try {
        await fetch(tgUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: channelId, message_id: chunk.message_id })
        });
      } catch { /* best effort */ }
    }
  }
}

export const daemonDrive = new DaemonClientDrive();
