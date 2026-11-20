// Pure, testable helpers for the Photos service worker's client-direct media
// path. The SW reads image/video bytes straight from Telegram (through the
// user's own streaming `/proxy`) and decrypts them in the browser, so the
// per-user Cloudflare Worker never touches bytes and can't hit its 128 MB / CPU
// / subrequest limits. Keep this module free of SW globals so it unit-tests in
// plain vitest.

export type AssetBinaryKind = 'thumbnail' | 'original' | 'playback';

export interface AssetChunk {
  index: number;
  file_id: string;
}

export interface AssetManifest {
  thumbId: string;
  previewId: string;
  originalId: string;
  chunks: AssetChunk[];
  /** H.264 rendition from "Fix Videos", when one exists. /video/playback must
   *  prefer it, exactly as the Worker's handleOriginal does — otherwise a
   *  repaired video reverts to its unsupported (usually HEVC) source. */
  playbackChunks?: AssetChunk[];
  playbackSize?: number;
  encryptionMode: string; // 'off' | 'server' | 'client'
  mimeType: string;
  fileSize: number;
  isHeic: boolean;
}

// `video/playback` is included so video streams take the client-direct ranged
// path too. Proxying them through the Worker meant stitching a multi-chunk
// video inside a 128 MB / 10 ms-CPU isolate, which Cloudflare killed with error
// 1102 — and a 1102 page carries no CORS headers, so the browser reported it as
// a CORS failure rather than a server error.
const ASSET_BINARY_RE = /^\/api\/assets\/([a-f0-9-]+)\/(original|thumbnail|video\/playback)\b/;

/** Pull the asset id + binary kind out of a request path, or null if it isn't one. */
export function parseAssetBinaryPath(pathname: string): { assetId: string; kind: AssetBinaryKind } | null {
  const m = ASSET_BINARY_RE.exec(pathname);
  if (!m) return null;
  const kind: AssetBinaryKind = m[2] === 'video/playback' ? 'playback' : (m[2] as AssetBinaryKind);
  return { assetId: m[1], kind };
}

/** True when the stored bytes are encrypted and must be decrypted client-side. */
export function isEncrypted(encryptionMode: string): boolean {
  return encryptionMode === 'server' || encryptionMode === 'client';
}

/** Plaintext bytes per stored chunk. Must match CHUNK_SIZE in the worker's
 *  assets.ts — the byte→chunk arithmetic below depends on both agreeing. */
export const VIDEO_CHUNK_SIZE = 19 * 1024 * 1024;

export type VideoRangePlan =
  | { kind: 'full'; totalSize: number }
  | { kind: 'range'; start: number; end: number; chunkIndex: number }
  | { kind: 'unsatisfiable'; totalSize: number };

/**
 * Work out which single stored chunk satisfies a video Range request.
 *
 * A response covers AT MOST one chunk, so peak memory is one chunk no matter
 * how large the video is — a 1 GB file streams in the same footprint as a
 * 20 MB one. Returning fewer bytes than asked for is legal for a 206, and
 * browsers simply request the next range. (Native players do NOT: ExoPlayer
 * and AVPlayer treat a short 206 as end-of-file, which is why the Worker's
 * `handleOriginal` streams the full requested range instead. This path is
 * browser-only.)
 */
export function planVideoRange(
  rangeHeader: string | null,
  totalSize: number,
  chunkSize: number,
  chunkCount: number,
): VideoRangePlan {
  if (!rangeHeader) return { kind: 'full', totalSize };

  const parts = rangeHeader.replace(/bytes=/, '').split('-');
  let start: number;
  let end: number;

  if (parts[0] === '') {
    // RFC 7233 §2.1 suffix range: "bytes=-N" is the LAST N bytes. Letting
    // parseInt('') coerce to 0 would serve the first N instead — the wrong
    // bytes for the moov-atom probe that iPhone MP4s require to start.
    const suffixLength = Number.parseInt(parts[1], 10);
    if (!Number.isFinite(suffixLength)) return { kind: 'full', totalSize };
    start = Math.max(0, totalSize - suffixLength);
    end = totalSize - 1;
  } else {
    start = Number.parseInt(parts[0], 10);
    end = parts[1] === '' || parts[1] === undefined ? totalSize - 1 : Number.parseInt(parts[1], 10);
    if (!Number.isFinite(start)) return { kind: 'full', totalSize };
    if (!Number.isFinite(end)) end = totalSize - 1;
  }

  // Only a start beyond EOF is genuinely unsatisfiable. An end past EOF is
  // clamped, not rejected — players routinely ask for more than exists, and a
  // 416 there reads as a hard failure and stops playback.
  if (start < 0 || start >= totalSize) return { kind: 'unsatisfiable', totalSize };
  if (end >= totalSize) end = totalSize - 1;
  if (end < start) end = start;

  const chunkIndex = Math.floor(start / chunkSize);
  if (chunkIndex >= chunkCount) return { kind: 'unsatisfiable', totalSize };

  // Never cross a chunk boundary: the next chunk is a separate download.
  const chunkLastByte = (chunkIndex + 1) * chunkSize - 1;
  if (end > chunkLastByte) end = chunkLastByte;

  return { kind: 'range', start, end, chunkIndex };
}

/**
 * Decide which Telegram file id(s) satisfy a given request, in download order.
 * Mirrors the worker's handleThumbnail/handleOriginal selection. An empty array
 * means "no suitable file" → the caller falls back (worker path or 404).
 */
export function selectFileIds(manifest: AssetManifest, kind: AssetBinaryKind, size: string): string[] {
  const sorted = [...manifest.chunks].sort((a, b) => a.index - b.index).map((c) => c.file_id);
  const isMultiChunk = sorted.length > 1;

  // `playback` resolves like `original`: the Worker prefers an H.264 rendition
  // when one exists, but the manifest carries no rendition chunks and none has
  // ever been produced, so both fall back to the original bytes.
  if (kind === 'original' || kind === 'playback') {
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
