import { describe, expect, it } from 'vitest';
import {
  type AssetManifest,
  decryptBytes,
  deriveKey,
  parseAssetBinaryPath,
  planVideoRange,
  selectFileIds,
  VIDEO_CHUNK_SIZE,
} from './telegram-media';

// Range planning for client-direct video. Small chunk size keeps the
// arithmetic readable; production uses 19 MB.
describe('planVideoRange', () => {
  const CS = 100; // chunk size
  const TOTAL = 250; // 3 chunks: [0..99] [100..199] [200..249]
  const COUNT = 3;
  const plan = (h: string | null) => planVideoRange(h, TOTAL, CS, COUNT);

  it('no Range header asks for the whole file', () => {
    expect(plan(null)).toEqual({ kind: 'full', totalSize: 250 });
  });

  it('bytes=0- starts at chunk 0 and stops at that chunk boundary', () => {
    // Deliberately NOT the whole file: one chunk per response is what keeps
    // browser memory flat on a 1 GB video. The player re-requests the rest.
    expect(plan('bytes=0-')).toEqual({ kind: 'range', start: 0, end: 99, chunkIndex: 0 });
  });

  it('a mid-file seek resolves to the chunk containing it', () => {
    expect(plan('bytes=150-')).toEqual({ kind: 'range', start: 150, end: 199, chunkIndex: 1 });
  });

  it('an explicit short range inside one chunk is served exactly', () => {
    expect(plan('bytes=120-140')).toEqual({ kind: 'range', start: 120, end: 140, chunkIndex: 1 });
  });

  it('a range spanning chunks is truncated at the first chunk boundary', () => {
    expect(plan('bytes=50-250')).toEqual({ kind: 'range', start: 50, end: 99, chunkIndex: 0 });
  });

  it('a suffix range (bytes=-N) reads the END of the file, not the start', () => {
    // MP4s from iPhones put the moov atom last; players probe with a suffix
    // range. Coercing the empty prefix to 0 would serve the wrong bytes and
    // the video would never start.
    expect(plan('bytes=-50')).toEqual({ kind: 'range', start: 200, end: 249, chunkIndex: 2 });
  });

  it('a suffix larger than the file clamps to the whole file', () => {
    expect(plan('bytes=-9999')).toEqual({ kind: 'range', start: 0, end: 99, chunkIndex: 0 });
  });

  it('an end past EOF is clamped rather than rejected', () => {
    expect(plan('bytes=200-9999')).toEqual({ kind: 'range', start: 200, end: 249, chunkIndex: 2 });
  });

  it('a start at or past EOF is unsatisfiable', () => {
    expect(plan('bytes=250-')).toEqual({ kind: 'unsatisfiable', totalSize: 250 });
    expect(plan('bytes=9999-')).toEqual({ kind: 'unsatisfiable', totalSize: 250 });
  });

  it('a chunk index beyond the manifest is unsatisfiable', () => {
    expect(planVideoRange('bytes=240-', 250, 100, 2)).toEqual({ kind: 'unsatisfiable', totalSize: 250 });
  });

  it('a garbled Range header falls back to the whole file', () => {
    expect(plan('bytes=abc-def')).toEqual({ kind: 'full', totalSize: 250 });
  });
});

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

describe('real file: 101,356,528 bytes across 6 chunks (IMG_7517.MOV)', () => {
  const TOTAL = 101_356_528;
  const COUNT = 6;

  it('chunk count matches what is stored in D1', () => {
    expect(Math.ceil(TOTAL / VIDEO_CHUNK_SIZE)).toBe(COUNT);
  });

  it('sequential playback tiles the file exactly, with no gaps or overlaps', () => {
    let cursor = 0;
    let responses = 0;
    while (cursor < TOTAL) {
      const plan = planVideoRange(`bytes=${cursor}-`, TOTAL, VIDEO_CHUNK_SIZE, COUNT);
      expect(plan.kind).toBe('range');
      if (plan.kind !== 'range') break;
      expect(plan.start).toBe(cursor);      // no gap
      expect(plan.end).toBeGreaterThanOrEqual(plan.start);
      cursor = plan.end + 1;                // no overlap
      responses++;
      expect(responses).toBeLessThan(50);   // must terminate
    }
    expect(cursor).toBe(TOTAL);             // covered the whole file
    expect(responses).toBe(COUNT);          // one response per chunk
  });

  it('a seek to the middle lands in the right chunk', () => {
    const mid = Math.floor(TOTAL / 2);
    const plan = planVideoRange(`bytes=${mid}-`, TOTAL, VIDEO_CHUNK_SIZE, COUNT);
    expect(plan).toMatchObject({ kind: 'range', start: mid, chunkIndex: 2 });
  });

  it('the moov probe at the tail reads the LAST chunk', () => {
    const plan = planVideoRange('bytes=-262144', TOTAL, VIDEO_CHUNK_SIZE, COUNT);
    expect(plan).toMatchObject({ kind: 'range', chunkIndex: 5, end: TOTAL - 1 });
  });

  it('never asks for more than one chunk of memory', () => {
    for (let c = 0; c < COUNT; c++) {
      const plan = planVideoRange(`bytes=${c * VIDEO_CHUNK_SIZE}-`, TOTAL, VIDEO_CHUNK_SIZE, COUNT);
      if (plan.kind !== 'range') throw new Error('expected range');
      expect(plan.end - plan.start + 1).toBeLessThanOrEqual(VIDEO_CHUNK_SIZE);
    }
  });
});
