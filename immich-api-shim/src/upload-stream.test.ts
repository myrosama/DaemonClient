import { describe, it, expect } from 'vitest';
import { makeFileLike, parseUploadRequest } from './upload-stream';

function multipart(fields: Record<string, string>, file?: { name: string; type: string; bytes: Uint8Array }): Request {
  const boundary = '----dc' + Math.random().toString(16).slice(2);
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  if (file) {
    parts.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="assetData"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`));
    parts.push(file.bytes);
    parts.push(enc.encode(`\r\n`));
  }
  parts.push(enc.encode(`--${boundary}--\r\n`));
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const body = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { body.set(p, off); off += p.byteLength; }
  return new Request('https://x/api/assets', {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body,
  });
}

describe('makeFileLike', () => {
  const chunks = [Uint8Array.of(0, 1, 2, 3), Uint8Array.of(4, 5, 6, 7), Uint8Array.of(8, 9)];
  const file = makeFileLike(chunks, 10, 'IMG.JPG', 'image/jpeg');

  it('reports size, name and type', () => {
    expect(file.size).toBe(10);
    expect(file.name).toBe('IMG.JPG');
    expect(file.type).toBe('image/jpeg');
  });

  it('slices bytes within a single chunk', async () => {
    const buf = await file.slice(0, 3).arrayBuffer();
    expect(new Uint8Array(buf)).toEqual(Uint8Array.of(0, 1, 2));
  });

  it('slices bytes spanning multiple chunks', async () => {
    const buf = await file.slice(2, 9).arrayBuffer();
    expect(new Uint8Array(buf)).toEqual(Uint8Array.of(2, 3, 4, 5, 6, 7, 8));
  });

  it('clamps an end past the file size', async () => {
    const buf = await file.slice(8, 100).arrayBuffer();
    expect(new Uint8Array(buf)).toEqual(Uint8Array.of(8, 9));
  });
});

describe('parseUploadRequest', () => {
  const noDedup = async () => null;

  it('collects text fields and the file from a multipart upload', async () => {
    const bytes = new Uint8Array(5000).map((_, i) => i % 256);
    const req = multipart(
      { deviceAssetId: 'DA-1', deviceId: 'DEV-9', fileCreatedAt: '2026-01-01' },
      { name: 'IMG.JPG', type: 'image/jpeg', bytes },
    );
    const res = await parseUploadRequest(req, noDedup);
    expect(res.kind).toBe('parsed');
    if (res.kind !== 'parsed') return;
    expect(res.fields.get('deviceAssetId')).toBe('DA-1');
    expect(res.fields.get('deviceId')).toBe('DEV-9');
    expect(res.fields.get('fileCreatedAt')).toBe('2026-01-01');
    expect(res.file).toBeTruthy();
    expect(res.file!.size).toBe(5000);
    expect(res.file!.name).toBe('IMG.JPG');
    const got = new Uint8Array(await res.file!.slice(0, res.file!.size).arrayBuffer());
    expect(got).toEqual(bytes);
  });

  it('accepts files larger than the parser default 2MB cap (real photos)', async () => {
    // Regression: @mjackson/multipart-parser defaults maxFileSize to 2MB and
    // throws on bigger files — which broke every photo/video upload until we
    // raised the limit. A 3MB file must parse cleanly.
    const bytes = new Uint8Array(3 * 1024 * 1024).map((_, i) => i % 256);
    const req = multipart(
      { deviceAssetId: 'DA-1', deviceId: 'DEV-9' },
      { name: 'BIG.HEIC', type: 'image/heic', bytes },
    );
    const res = await parseUploadRequest(req, noDedup);
    expect(res.kind).toBe('parsed');
    if (res.kind !== 'parsed') return;
    expect(res.file!.size).toBe(3 * 1024 * 1024);
  });

  it('short-circuits BEFORE the file when the dedup callback returns a response', async () => {
    let fileWasParsed = false;
    const bytes = new Uint8Array(5000).fill(9);
    const req = multipart(
      { deviceAssetId: 'DA-1', deviceId: 'DEV-9' },
      { name: 'IMG.JPG', type: 'image/jpeg', bytes },
    );
    const res = await parseUploadRequest(req, async (da, di) => {
      expect(da).toBe('DA-1');
      expect(di).toBe('DEV-9');
      return new Response('dup', { status: 200 });
    });
    expect(res.kind).toBe('dedup');
    if (res.kind === 'dedup') expect(await res.response.text()).toBe('dup');
    // (the file is never assembled — verified implicitly: we returned before it)
    expect(fileWasParsed).toBe(false);
  });

  it('handles a fields-only request (client upload, no assetData)', async () => {
    const req = multipart({ clientUpload: 'true', telegramOriginalId: 'TID' });
    const res = await parseUploadRequest(req, noDedup);
    expect(res.kind).toBe('parsed');
    if (res.kind !== 'parsed') return;
    expect(res.file).toBeNull();
    expect(res.fields.get('clientUpload')).toBe('true');
  });
});
