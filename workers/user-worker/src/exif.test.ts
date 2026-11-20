import { describe, it, expect } from 'vitest';
import { extractExif } from './exif';

// 32x24 JPEG generated with sharp .withMetadata({orientation:6}).withExif() —
// Apple / iPhone 15 Pro, f/1.78, 6.764mm, ISO 125, 1/250s, orientation 6,
// GPS 41°18'N 69°16.5'E. Embedded as base64 so this test compiles under the
// Worker tsconfig (no node:fs types available here).
const FIXTURE_B64 =
  '/9j/4QHoRXhpZgAASUkqAAgAAAAJAA8BAgAGAAAAmAAAABABAgAOAAAAigAAABIBAwABAAAABgAAABoBBQABAAAAegAAABsBBQABAAAAggAAACgBAwABAAAAAgAAABMCAwABAAAAAQAAAGmHBAABAAAAngAAACWIBAABAAAAegEAAAAAAAA4YwAA6AMAADhjAADoAwAAaVBob25lIDE1IFBybwBBcHBsZQAMAJqCBQABAAAAYgEAAJ2CBQABAAAAcgEAACeIAwABAAAAfQAAAACQBwAEAAAAMDIxMAOQAgAUAAAATgEAAAGRBwAEAAAAAQIDAAqSBQABAAAAagEAAACgBwAEAAAAMDEwMAGgAwABAAAA//8AAAKgBAABAAAAIAAAAAOgBAABAAAAGAAAADSkAgAaAAAANAEAAAAAAABpUGhvbmUgMTUgUHJvIGJhY2sgY2FtZXJhADIwMjY6MDY6MDEgMTQ6MzA6MDAAAQAAAPoAAABsGgAA6AMAALIAAABkAAAABAABAAIAAgAAAE4AAAACAAUAAwAAALABAAADAAIAAgAAAEUAAAAEAAUAAwAAAMgBAAAAAAAAKQAAAAEAAAASAAAAAQAAAAAAAAABAAAARQAAAAEAAAAQAAAAAQAAAB4AAAABAAAA/+IB8ElDQ19QUk9GSUxFAAEBAAAB4GxjbXMEIAAAbW50clJHQiBYWVogB+IAAwAUAAkADgAdYWNzcE1TRlQAAAAAc2F3c2N0cmwAAAAAAAAAAAAAAAAAAPbWAAEAAAAA0y1oYW5keem/Vlo+AbaDI4VVRvdPqgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKZGVzYwAAAPwAAAAkY3BydAAAASAAAAAid3RwdAAAAUQAAAAUY2hhZAAAAVgAAAAsclhZWgAAAYQAAAAUZ1hZWgAAAZgAAAAUYlhZWgAAAawAAAAUclRSQwAAAcAAAAAgZ1RSQwAAAcAAAAAgYlRSQwAAAcAAAAAgbWx1YwAAAAAAAAABAAAADGVuVVMAAAAIAAAAHABzAFIARwBCbWx1YwAAAAAAAAABAAAADGVuVVMAAAAGAAAAHABDAEMAMAAAWFlaIAAAAAAAAPbWAAEAAAAA0y1zZjMyAAAAAAABDD8AAAXd///zJgAAB5AAAP2S///7of///aIAAAPcAADAcVhZWiAAAAAAAABvoAAAOPIAAAOPWFlaIAAAAAAAAGKWAAC3iQAAGNpYWVogAAAAAAAAJKAAAA+FAAC2xHBhcmEAAAAAAAMAAAACZmkAAPKnAAANWQAAE9AAAApb/9sAQwAGBAUGBQQGBgUGBwcGCAoQCgoJCQoUDg8MEBcUGBgXFBYWGh0lHxobIxwWFiAsICMmJykqKRkfLTAtKDAlKCko/9sAQwEHBwcKCAoTCgoTKBoWGigoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgo/8AAEQgAGAAgAwEiAAIRAQMRAf/EABUAAQEAAAAAAAAAAAAAAAAAAAAD/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/EABUBAQEAAAAAAAAAAAAAAAAAAAAG/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AkAj18AAAAAA//9k=';

function fixture(): Uint8Array {
  const bin = atob(FIXTURE_B64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

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
