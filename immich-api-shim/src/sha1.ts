// Incremental SHA-1 (FIPS 180-1).
//
// Why hand-rolled: the Immich mobile app identifies every asset by
// base64(SHA-1(fileBytes)) — it sends that in /api/assets/bulk-upload-check and
// uses it to merge the phone's local copy with the server copy. Our worker has
// to produce the IDENTICAL value or (a) bulk-upload-check never matches → the
// app re-uploads the whole library on every restart, and (b) the synced remote
// asset can't be matched to the local one → every photo shows twice.
//
// Web Crypto's crypto.subtle.digest('SHA-1', ...) would compute the same value
// but is one-shot: it needs the entire file in a single ArrayBuffer. The upload
// path deliberately streams the file in ~19 MB chunks to stay under the Worker's
// 128 MB memory limit, so we hash incrementally as each chunk is read instead of
// materialising the whole file. Verified against the standard test vectors in
// sha1.test.ts.
export class Sha1 {
  private h0 = 0x67452301;
  private h1 = 0xefcdab89;
  private h2 = 0x98badcfe;
  private h3 = 0x10325476;
  private h4 = 0xc3d2e1f0;
  private block = new Uint8Array(64);
  private blockLen = 0;
  private totalLen = 0; // total bytes fed (drives the length padding)
  private readonly w = new Int32Array(80);

  update(data: Uint8Array): this {
    this.totalLen += data.length;
    let offset = 0;

    // Top up a partially-filled 64-byte block first.
    if (this.blockLen > 0) {
      const need = 64 - this.blockLen;
      const take = Math.min(need, data.length);
      this.block.set(data.subarray(0, take), this.blockLen);
      this.blockLen += take;
      offset = take;
      if (this.blockLen === 64) {
        this.process(this.block, 0);
        this.blockLen = 0;
      }
    }

    // Process whole blocks straight from the input.
    while (offset + 64 <= data.length) {
      this.process(data, offset);
      offset += 64;
    }

    // Buffer the trailing remainder for next time.
    if (offset < data.length) {
      this.block.set(data.subarray(offset), 0);
      this.blockLen = data.length - offset;
    }
    return this;
  }

  private process(buf: Uint8Array, off: number): void {
    const w = this.w;
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4;
      w[i] = (buf[j] << 24) | (buf[j + 1] << 16) | (buf[j + 2] << 8) | buf[j + 3];
    }
    for (let i = 16; i < 80; i++) {
      const n = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
      w[i] = (n << 1) | (n >>> 31);
    }

    let a = this.h0, b = this.h1, c = this.h2, d = this.h3, e = this.h4;
    for (let i = 0; i < 80; i++) {
      let f: number, k: number;
      if (i < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
      else { f = b ^ c ^ d; k = 0xca62c1d6; }
      const temp = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) | 0;
      e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = temp;
    }

    this.h0 = (this.h0 + a) | 0;
    this.h1 = (this.h1 + b) | 0;
    this.h2 = (this.h2 + c) | 0;
    this.h3 = (this.h3 + d) | 0;
    this.h4 = (this.h4 + e) | 0;
  }

  // Finalise and return the raw 20-byte digest. Call once; mutates state.
  digest(): Uint8Array {
    const bitLen = this.totalLen * 8;

    // Append 0x80, then zero-pad so that (len ≡ 56 mod 64), then 8-byte length.
    const pad: number[] = [0x80];
    let len = this.blockLen + 1;
    while (len % 64 !== 56) { pad.push(0); len++; }

    // 64-bit big-endian bit length (JS bitwise is 32-bit → split hi/lo).
    const hi = Math.floor(bitLen / 0x100000000);
    const lo = bitLen >>> 0;
    pad.push((hi >>> 24) & 0xff, (hi >>> 16) & 0xff, (hi >>> 8) & 0xff, hi & 0xff);
    pad.push((lo >>> 24) & 0xff, (lo >>> 16) & 0xff, (lo >>> 8) & 0xff, lo & 0xff);

    this.update(new Uint8Array(pad));

    const out = new Uint8Array(20);
    const words = [this.h0, this.h1, this.h2, this.h3, this.h4];
    for (let i = 0; i < 5; i++) {
      out[i * 4] = (words[i] >>> 24) & 0xff;
      out[i * 4 + 1] = (words[i] >>> 16) & 0xff;
      out[i * 4 + 2] = (words[i] >>> 8) & 0xff;
      out[i * 4 + 3] = words[i] & 0xff;
    }
    return out;
  }
}

// Standard base64 (with '=' padding) of a byte array — matches iOS
// base64EncodedString() and Android Base64.NO_WRAP, which is what Immich's
// checksum uses.
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

// Hash a whole File without ever holding more than one slice in memory.
// Returns base64(SHA-1) — the exact value the Immich app computes for the same
// bytes.
//
// Prefers Cloudflare's native streaming digest (crypto.DigestStream): it's
// implemented in C++ so it barely touches the Worker's CPU budget (important on
// the free 10 ms-CPU tier — a multi-MB hash in interpreted JS could blow it and
// start failing uploads). Falls back to the portable incremental Sha1 above for
// runtimes without DigestStream (the test environment, and any non-CF host).
export async function sha1Base64OfFile(file: Blob, sliceSize = 4 * 1024 * 1024): Promise<string> {
  const DigestStream = (globalThis as any).crypto?.DigestStream;
  if (DigestStream && typeof (file as any).stream === 'function') {
    const ds = new DigestStream('SHA-1');
    await (file as any).stream().pipeTo(ds);
    const digest: ArrayBuffer = await ds.digest;
    return bytesToBase64(new Uint8Array(digest));
  }

  const hasher = new Sha1();
  const total = file.size;
  for (let start = 0; start < total; start += sliceSize) {
    const end = Math.min(start + sliceSize, total);
    const buf = await file.slice(start, end).arrayBuffer();
    hasher.update(new Uint8Array(buf));
  }
  return bytesToBase64(hasher.digest());
}

// Convenience for already-in-memory bytes.
export function sha1Base64OfBytes(bytes: Uint8Array): string {
  return bytesToBase64(new Sha1().update(bytes).digest());
}
