// SPEC D23: the phone reads EXIF itself and sends it as one `exif` field with
// a client upload; the worker stores it instead of downloading the original.
import { describe, it, expect } from 'vitest';
import { clientExif } from './exif';
import { toAssetManifest } from './asset-manifest';

describe('the EXIF the phone sends with a client upload', () => {
  it('keeps every PhotoExif field it understands', () => {
    const exif = clientExif(JSON.stringify({
      make: 'Apple', model: 'iPhone 15', lensModel: 'back camera 6.86mm f/1.78', fNumber: 1.78,
      focalLength: 6.86, iso: 50, exposureTime: '1/250', orientation: 6,
      dateTimeOriginal: '2026-11-15T10:00:00.000Z', latitude: 41.3, longitude: 69.2,
    }));
    expect(exif).toEqual({
      make: 'Apple', model: 'iPhone 15', lensModel: 'back camera 6.86mm f/1.78', fNumber: 1.78,
      focalLength: 6.86, iso: 50, exposureTime: '1/250', orientation: 6,
      dateTimeOriginal: '2026-11-15T10:00:00.000Z', latitude: 41.3, longitude: 69.2,
    });
  });
  it('drops unknown keys and any value of the wrong type or out of range', () => {
    expect(clientExif(JSON.stringify({
      make: 42, model: 'x'.repeat(300), iso: -1, fNumber: 'f/2', orientation: 9, latitude: 91,
      longitude: -181, exposureTime: { a: 1 }, focalLength: Number.MAX_VALUE * 0, extra: 'nope', __proto__: { polluted: 1 },
    }))).toEqual({ focalLength: 0 });
    expect(({} as any).polluted).toBeUndefined();
  });
  it('treats missing, malformed, oversized or non-object input as no EXIF, never an error', () => {
    for (const raw of [null, '', 'not json', '[1,2]', '"text"', '7', 'null', JSON.stringify({ make: 'x'.repeat(9000) })]) {
      expect(clientExif(raw)).toBeNull();
    }
  });
  it('an empty object means "read, nothing found", which still counts as read', () => {
    expect(clientExif('{}')).toEqual({});
    expect(clientExif(JSON.stringify({ make: 42 }))).toEqual({});
  });
  it('takes the forms native engines produce and stores them the way the server path does', () => {
    expect(clientExif(JSON.stringify({
      exposureTime: 0.004, iso: [50], orientation: '6', dateTimeOriginal: '2026:11:15 10:00:00',
    }))).toEqual({ exposureTime: '1/250', iso: 50, orientation: 6, dateTimeOriginal: '2026-11-15T10:00:00.000Z' });
    expect(clientExif(JSON.stringify({ exposureTime: 2 }))).toEqual({ exposureTime: '2s' });
    // A date it can't read is dropped, not stored wrong; ISO is a whole number.
    expect(clientExif(JSON.stringify({ dateTimeOriginal: 'yesterday', iso: 50.5 }))).toEqual({});
  });
  it('a location needs both coordinates', () => {
    expect(clientExif(JSON.stringify({ latitude: 41.3, iso: 100 }))).toEqual({ iso: 100 });
  });
});

describe('the manifest names the encryption the readers must undo', () => {
  it('an encrypted row with no stored mode reads as server-encrypted, not plain', () => {
    expect(toAssetManifest({ encrypted: true }).encryptionMode).toBe('server');
    expect(toAssetManifest({ encrypted: 1 }).encryptionMode).toBe('server');
    expect(toAssetManifest({}).encryptionMode).toBe('off');
    expect(toAssetManifest({ encrypted: true, encryptionMode: 'client' }).encryptionMode).toBe('client');
  });
});
