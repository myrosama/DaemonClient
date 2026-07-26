import { describe, it, expect } from 'vitest';
import { makeFileLike } from './upload-stream';
import { sha1Base64OfFile, sha1Base64OfBytes } from './sha1';

// The upload path computes base64(SHA-1) of every uploaded file so the Immich
// app can match its local copy to the server copy. sha1Base64OfFile prefers
// Cloudflare's native crypto.DigestStream (C++, negligible CPU) and falls back
// to the portable pure-JS Sha1 only when the input exposes no stream().
//
// The streamed uploader hands it a FileLike (not a real File). When FileLike
// lacked stream(), EVERY mobile upload silently took the pure-JS path — tens of
// ms of interpreted hashing per photo, and the app fires 4-6 uploads per second
// during a backlog drain. That CPU burn is a direct contributor to Cloudflare
// 1102 "Worker exceeded resource limits" kills, which the app surfaces as
// failed backups.

const bytesOf = (n: number, seed: number) => {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (i * 31 + seed) & 0xff;
  return out;
};

describe('FileLike hashing', () => {
  it('exposes a stream() so the native DigestStream fast path is reachable', () => {
    const f = makeFileLike([bytesOf(100, 1)], 100, 'a.jpg', 'image/jpeg');
    expect(typeof (f as any).stream).toBe('function');
  });

  it('streams exactly the file bytes, in order, across multiple chunks', async () => {
    const c1 = bytesOf(50, 1);
    const c2 = bytesOf(70, 2);
    const c3 = bytesOf(30, 3);
    const f = makeFileLike([c1, c2, c3], 150, 'a.jpg', 'image/jpeg');

    const reader = (f as any).stream().getReader();
    const got: number[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      got.push(...Array.from(value as Uint8Array));
    }
    expect(got.length).toBe(150);
    expect(got).toEqual([...Array.from(c1), ...Array.from(c2), ...Array.from(c3)]);
  });

  it('hashes a multi-chunk FileLike to the same value as hashing the concatenation', async () => {
    const c1 = bytesOf(1000, 7);
    const c2 = bytesOf(1500, 9);
    const whole = new Uint8Array(2500);
    whole.set(c1, 0);
    whole.set(c2, 1000);

    const f = makeFileLike([c1, c2], 2500, 'b.heic', 'image/heic');
    expect(await sha1Base64OfFile(f as any)).toBe(sha1Base64OfBytes(whole));
  });

  it('hashes an empty file correctly (SHA-1 of zero bytes)', async () => {
    const f = makeFileLike([], 0, 'empty.bin', 'application/octet-stream');
    expect(await sha1Base64OfFile(f as any)).toBe(sha1Base64OfBytes(new Uint8Array(0)));
  });

  it('keeps slice() byte-exact after the stream() addition (upload path reads chunks via slice)', async () => {
    const c1 = bytesOf(1000, 7);
    const c2 = bytesOf(1500, 9);
    const f = makeFileLike([c1, c2], 2500, 'b.heic', 'image/heic');
    const mid = new Uint8Array(await f.slice(900, 1100).arrayBuffer());
    expect(mid.length).toBe(200);
    expect(Array.from(mid.subarray(0, 100))).toEqual(Array.from(c1.subarray(900, 1000)));
    expect(Array.from(mid.subarray(100))).toEqual(Array.from(c2.subarray(0, 100)));
  });
});
