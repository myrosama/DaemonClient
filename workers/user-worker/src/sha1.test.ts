import { describe, it, expect } from 'vitest';
import { Sha1, sha1Base64OfBytes, sha1Base64OfFile, bytesToBase64 } from './sha1';

const enc = (s: string) => new TextEncoder().encode(s);
const hex = (bytes: Uint8Array) =>
  Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');

describe('Sha1 incremental', () => {
  // Canonical FIPS-180 digests + their standard-base64 encodings (the exact
  // values Immich's iOS/Android clients produce for these inputs).
  const vectors: Array<[string, string, string]> = [
    ['', 'da39a3ee5e6b4b0d3255bfef95601890afd80709', '2jmj7l5rSw0yVb/vlWAYkK/YBwk='],
    ['abc', 'a9993e364706816aba3e25717850c26c9cd0d89d', 'qZk+NkcGgWq6PiVxeFDCbJzQ2J0='],
    ['The quick brown fox jumps over the lazy dog', '2fd4e1c67a2d28fced849ee1bb76e7391b93eb12', 'L9ThxnotKPzthJ7hu3bnORuT6xI='],
  ];

  it('matches canonical hex + base64 vectors', () => {
    for (const [input, expectHex, expectB64] of vectors) {
      expect(hex(new Sha1().update(enc(input)).digest())).toBe(expectHex);
      expect(sha1Base64OfBytes(enc(input))).toBe(expectB64);
    }
  });

  it('is identical whether fed in one update or split across awkward chunk sizes', () => {
    // 1 MB of deterministic bytes, fed in sizes that straddle the 64-byte block
    // boundary — this is what exercises the partial-block buffering.
    const data = new Uint8Array(1024 * 1024);
    for (let i = 0; i < data.length; i++) data[i] = (i * 31 + 7) & 0xff;

    const oneShot = sha1Base64OfBytes(data);
    for (const chunk of [1, 63, 64, 65, 100, 4096, 13337]) {
      const h = new Sha1();
      for (let off = 0; off < data.length; off += chunk) {
        h.update(data.subarray(off, Math.min(off + chunk, data.length)));
      }
      expect(bytesToBase64(h.digest())).toBe(oneShot);
    }
  });

  it('hashes a Blob the same as the raw bytes (streamed file path)', async () => {
    const data = new Uint8Array(5 * 1024 * 1024 + 12345); // >1 slice, non-aligned tail
    for (let i = 0; i < data.length; i++) data[i] = (i * 17 + 3) & 0xff;
    const expected = sha1Base64OfBytes(data);
    // small sliceSize forces many slices through the streaming path
    expect(await sha1Base64OfFile(new Blob([data]), 1024 * 1024)).toBe(expected);
  });
});
