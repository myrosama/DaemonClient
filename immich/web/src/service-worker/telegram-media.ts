// Pure, testable helpers for the Photos service worker's client-direct media
// path. The SW reads image/video bytes straight from Telegram (through the
// user's own streaming `/proxy`) and decrypts them in the browser, so the
// per-user Cloudflare Worker never touches bytes and can't hit its 128 MB / CPU
// / subrequest limits. Keep this module free of SW globals so it unit-tests in
// plain vitest.

export type AssetBinaryKind = 'thumbnail' | 'original';

export interface AssetChunk {
  index: number;
  file_id: string;
}

export interface AssetManifest {
  thumbId: string;
  previewId: string;
  originalId: string;
  chunks: AssetChunk[];
  encryptionMode: string; // 'off' | 'server' | 'client'
  mimeType: string;
  fileSize: number;
  isHeic: boolean;
}

const ASSET_BINARY_RE = /^\/api\/assets\/([a-f0-9-]+)\/(original|thumbnail)\b/;

/** Pull the asset id + binary kind out of a request path, or null if it isn't one. */
export function parseAssetBinaryPath(pathname: string): { assetId: string; kind: AssetBinaryKind } | null {
  const m = ASSET_BINARY_RE.exec(pathname);
  if (!m) return null;
  return { assetId: m[1], kind: m[2] as AssetBinaryKind };
}

/** True when the stored bytes are encrypted and must be decrypted client-side. */
export function isEncrypted(encryptionMode: string): boolean {
  return encryptionMode === 'server' || encryptionMode === 'client';
}

/**
 * Decide which Telegram file id(s) satisfy a given request, in download order.
 * Mirrors the worker's handleThumbnail/handleOriginal selection. An empty array
 * means "no suitable file" → the caller falls back (worker path or 404).
 */
export function selectFileIds(manifest: AssetManifest, kind: AssetBinaryKind, size: string): string[] {
  const sorted = [...manifest.chunks].sort((a, b) => a.index - b.index).map((c) => c.file_id);
  const isMultiChunk = sorted.length > 1;

  if (kind === 'original') {
    if (isMultiChunk) return sorted;
    return manifest.originalId ? [manifest.originalId] : sorted.length === 1 ? sorted : [];
  }

  // kind === 'thumbnail'
  const wantsHighQuality = size === 'preview' || size === 'fullsize';
  if (wantsHighQuality) {
    if (manifest.previewId) return [manifest.previewId];
    if (!isMultiChunk) return [manifest.originalId || manifest.thumbId].filter(Boolean);
    return manifest.thumbId ? [manifest.thumbId] : [];
  }
  // Grid thumbnail: real thumb wins; for single-file assets the original can
  // stand in; multi-chunk with no thumb is unavailable (matches worker 404).
  if (manifest.thumbId) return [manifest.thumbId];
  if (manifest.previewId) return [manifest.previewId];
  if (!isMultiChunk && manifest.originalId) return [manifest.originalId];
  return [];
}

/** Derive the AES-GCM key from the ZKE password + base64 salt (PBKDF2, 100k, SHA-256). */
export async function deriveKey(password: string, saltBase64: string): Promise<CryptoKey> {
  const salt = Uint8Array.from(atob(saltBase64), (c) => c.charCodeAt(0));
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt'],
  );
}

/** Reverse the worker's encryptChunk: 12-byte IV prefix + AES-GCM ciphertext. */
export async function decryptBytes(encrypted: ArrayBuffer, key: CryptoKey): Promise<ArrayBuffer> {
  const data = new Uint8Array(encrypted);
  const iv = data.slice(0, 12);
  const body = data.slice(12);
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, body);
}

/** Build the proxied Telegram getFile URL for a file id. */
export function buildGetFileUrl(proxyUrl: string, botToken: string, fileId: string): string {
  const target = `https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(fileId)}`;
  return `${proxyUrl}?url=${encodeURIComponent(target)}`;
}

/** Build the proxied Telegram file-download URL for a resolved file_path. */
export function buildDownloadUrl(proxyUrl: string, botToken: string, filePath: string): string {
  const target = `https://api.telegram.org/file/bot${botToken}/${filePath}`;
  return `${proxyUrl}?url=${encodeURIComponent(target)}`;
}
