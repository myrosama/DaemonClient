import { describe, expect, it } from 'vitest';
import {
  type AssetManifest,
  decryptBytes,
  deriveKey,
  parseAssetBinaryPath,
  selectFileIds,
} from './telegram-media';

describe('parseAssetBinaryPath', () => {
  it('extracts id and thumbnail kind', () => {
    expect(parseAssetBinaryPath('/api/assets/29fc20bb-a45d-47ff-bbbb-000000000001/thumbnail')).toEqual({
      assetId: '29fc20bb-a45d-47ff-bbbb-000000000001',
      kind: 'thumbnail',
    });
  });

  it('extracts id and original kind', () => {
    expect(parseAssetBinaryPath('/api/assets/2b2ffec2-3333-4444-5555-666677778888/original')).toEqual({
      assetId: '2b2ffec2-3333-4444-5555-666677778888',
      kind: 'original',
    });
  });

  it('returns null for non-asset-binary paths', () => {
    expect(parseAssetBinaryPath('/api/assets/abc/dc-manifest')).toBeNull();
    expect(parseAssetBinaryPath('/api/users/me')).toBeNull();
  });
});

const baseManifest: AssetManifest = {
  thumbId: 'THUMB',
  previewId: 'PREVIEW',
  originalId: 'ORIG',
  chunks: [],
  encryptionMode: 'off',
  mimeType: 'image/jpeg',
  fileSize: 1000,
  isHeic: false,
};

describe('selectFileIds', () => {
  it('grid thumbnail uses the thumb file id', () => {
    expect(selectFileIds(baseManifest, 'thumbnail', '')).toEqual(['THUMB']);
  });

  it('high-quality thumbnail prefers the preview file id', () => {
    expect(selectFileIds(baseManifest, 'thumbnail', 'preview')).toEqual(['PREVIEW']);
  });

  it('original of a single-file asset uses the original id', () => {
    expect(selectFileIds(baseManifest, 'original', '')).toEqual(['ORIG']);
  });

  it('original of a multi-chunk asset returns every chunk in index order', () => {
    const m: AssetManifest = {
      ...baseManifest,
      originalId: '',
      chunks: [
        { index: 2, file_id: 'C2' },
        { index: 0, file_id: 'C0' },
        { index: 1, file_id: 'C1' },
      ],
    };
    expect(selectFileIds(m, 'original', '')).toEqual(['C0', 'C1', 'C2']);
  });

  it('grid thumbnail of a multi-chunk asset with no thumb is unavailable (empty)', () => {
    const m: AssetManifest = { ...baseManifest, thumbId: '', previewId: '', chunks: [
      { index: 0, file_id: 'C0' },
      { index: 1, file_id: 'C1' },
    ] };
    expect(selectFileIds(m, 'thumbnail', '')).toEqual([]);
  });
});

describe('deriveKey + decryptBytes', () => {
  // Mirror the worker's AES-GCM scheme: 12-byte random IV prepended to the
  // ciphertext (WebCrypto appends the GCM tag). The client must reverse this.
  // The worker derives its own encrypt-capable key from the same password+salt;
  // the production client key is decrypt-only, so derive an encrypt key here.
  async function workerEncryptKey(password: string, saltBase64: string): Promise<CryptoKey> {
    const salt = Uint8Array.from(atob(saltBase64), (c) => c.charCodeAt(0));
    const km = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
      km,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt'],
    );
  }

  async function encryptLikeWorker(plain: ArrayBuffer, key: CryptoKey): Promise<ArrayBuffer> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain);
    const out = new Uint8Array(iv.length + ct.byteLength);
    out.set(iv, 0);
    out.set(new Uint8Array(ct), iv.length);
    return out.buffer;
  }

  it('round-trips bytes encrypted with the worker scheme', async () => {
    const password = 'hunter2';
    const salt = btoa('sixteen.byte.salt!!'); // base64, like zke-config returns
    const encKey = await workerEncryptKey(password, salt);
    const key = await deriveKey(password, salt);

    const original = new TextEncoder().encode('the quick brown fox 🦊').buffer;
    const encrypted = await encryptLikeWorker(original, encKey);
    const decrypted = await decryptBytes(encrypted, key);

    expect(new Uint8Array(decrypted)).toEqual(new Uint8Array(original));
  });
});
