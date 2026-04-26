export const CONTRACT_VERSION = 'photos.v1';

export const DEFAULT_CHUNK_SIZE = 19 * 1024 * 1024;
export const MAX_UPLOAD_SESSION_TTL_MS = 30 * 60 * 1000;

export type AssetLifecycleState =
  | 'queued'
  | 'uploading'
  | 'finalized'
  | 'failed'
  | 'deleting';

export type MediaType = 'photo' | 'video' | 'livePhoto' | 'raw';

export interface ChunkManifestItem {
  index: number;
  byteStart: number;
  byteEnd: number;
  cipherSha256?: string;
  plainSha256?: string;
  message_id: number;
  file_id: string;
  dcHint?: string | null;
}

export interface PreviewVariant {
  kind: 'micro' | 'standard' | 'screen';
  fileId: string;
  width: number;
  height: number;
  encrypted: boolean;
}

export interface PhotoAssetManifest {
  contractVersion: string;
  assetId: string;
  ownerUid: string;
  mediaType: MediaType;
  mimeType: string;
  originalFileName: string;
  fileSize: number;
  width: number;
  height: number;
  ratio: number;
  fileCreatedAt: string;
  fileModifiedAt: string;
  uploadedAt: string;
  state: AssetLifecycleState;
  cipherSpec: string;
  checksum?: string;
  encryptionMode: 'off' | 'server' | 'client';
  telegramOriginalId?: string | null;
  telegramThumbId?: string | null;
  telegramChunks: ChunkManifestItem[];
  previewManifest?: PreviewVariant[];
  albumIds: string[];
  tags: string[];
  duration: string | null;
  isFavorite: boolean;
  isTrashed: boolean;
  visibility: 'timeline' | 'archive';
  isHeic: boolean;
}

export interface UploadSessionRecord {
  sessionId: string;
  assetId: string;
  ownerUid: string;
  createdAt: string;
  expiresAt: string;
  allowedChunkRange: [number, number];
  maxParallelChunks: number;
  resumeToken: string;
  chunkSize: number;
  status: 'active' | 'expired' | 'completed' | 'aborted';
}

export function newSessionId(): string {
  return `sess_${crypto.randomUUID()}`;
}

export function computeExpiryIso(ttlMs = MAX_UPLOAD_SESSION_TTL_MS): string {
  return new Date(Date.now() + ttlMs).toISOString();
}

export function normalizePhotoManifest(
  uid: string,
  assetId: string,
  raw: Record<string, unknown>,
): PhotoAssetManifest {
  const mimeType = String(raw.mimeType || 'application/octet-stream');
  const width = Number(raw.width || 0);
  const height = Number(raw.height || 0);
  const ratio = width && height ? width / height : 1;
  const uploadedAt = String(raw.uploadedAt || new Date().toISOString());
  const fileCreatedAt = String(raw.fileCreatedAt || uploadedAt);
  const fileModifiedAt = String(raw.fileModifiedAt || uploadedAt);
  const encryptionMode =
    raw.encryptionMode === 'server' || raw.encryptionMode === 'client'
      ? raw.encryptionMode
      : 'off';

  return {
    contractVersion: CONTRACT_VERSION,
    assetId,
    ownerUid: uid,
    mediaType: mimeType.startsWith('video') ? 'video' : 'photo',
    mimeType,
    originalFileName: String(raw.originalFileName || 'unknown'),
    fileSize: Number(raw.fileSize || 0),
    width,
    height,
    ratio,
    fileCreatedAt,
    fileModifiedAt,
    uploadedAt,
    state: (raw.state as AssetLifecycleState) || 'finalized',
    cipherSpec: String(raw.cipherSpec || 'aes-256-gcm/pbkdf2-v1'),
    checksum: raw.checksum ? String(raw.checksum) : undefined,
    encryptionMode,
    telegramOriginalId: (raw.telegramOriginalId as string | null) || null,
    telegramThumbId: (raw.telegramThumbId as string | null) || null,
    telegramChunks: Array.isArray(raw.telegramChunks)
      ? (raw.telegramChunks as ChunkManifestItem[])
      : [],
    previewManifest: Array.isArray(raw.previewManifest)
      ? (raw.previewManifest as PreviewVariant[])
      : [],
    albumIds: Array.isArray(raw.albumIds) ? (raw.albumIds as string[]) : [],
    tags: Array.isArray(raw.tags) ? (raw.tags as string[]) : [],
    duration: raw.duration ? String(raw.duration) : null,
    isFavorite: Boolean(raw.isFavorite),
    isTrashed: Boolean(raw.isTrashed),
    visibility: raw.visibility === 'archive' ? 'archive' : 'timeline',
    isHeic: Boolean(raw.isHeic),
  };
}
