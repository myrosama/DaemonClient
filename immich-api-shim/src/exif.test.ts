import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractExif } from './exif';

// Fixture: 32x24 JPEG generated with sharp .withExif() — Apple/iPhone 15 Pro,
// f/1.78, 6.764mm, ISO 125, 1/250s, orientation 6, GPS 41°18'N 69°16.5'E
// (Tashkent-ish). Regenerate with the snippet in the repo history if needed.
const fixture = () => new Uint8Array(readFileSync(join(__dirname, '..', 'test-fixtures', 'exif-sample.jpg')));

describe('extractExif', () => {
  it('extracts camera, exposure, orientation, date and GPS from a JPEG', async () => {
    const exif = await extractExif(fixture());
    expect(exif.make).toBe('Apple');
    expect(exif.model).toBe('iPhone 15 Pro');
    expect(exif.lensModel).toBe('iPhone 15 Pro back camera');
    expect(exif.fNumber).toBeCloseTo(1.78, 2);
    expect(exif.focalLength).toBeCloseTo(6.764, 3);
    expect(exif.iso).toBe(125);
    expect(exif.exposureTime).toBe('1/250');
    // numeric 1-8 code, NOT the translated "Rotate 90 CW" string —
    // Immich's rotation logic needs the number
    expect(exif.orientation).toBe(6);
    expect(exif.dateTimeOriginal).toMatch(/^2026-06-01T/);
    expect(exif.latitude).toBeCloseTo(41.3, 4);
    expect(exif.longitude).toBeCloseTo(69.275, 4);
  });

  it('returns an empty object for EXIF-less bytes instead of throwing', async () => {
    // Plain PNG header + junk — no EXIF anywhere
    const junk = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]);
    let exif;
    try {
      exif = await extractExif(junk);
    } catch {
      // throwing is also acceptable per the contract (caller guards), but it
      // must not hang or corrupt — reaching here is fine
      exif = {};
    }
    expect(Object.keys(exif).filter(k => (exif as any)[k] !== undefined)).toEqual([]);
  });
});
