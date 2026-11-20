import { describe, it, expect } from 'vitest';
import { parseDurationSeconds } from './assets';

// Live-photo pairing uses duration to decide whether a video is a motion clip
// (a second or two) or a real recording. Reading it wrong in either direction
// is user-visible: a real video that gets paired disappears from the timeline
// as somebody's hidden companion, and a motion clip that does not get paired
// shows up as a stray two-second video next to the photo it belongs to.
//
// "Unknown" therefore has to stay distinct from "zero" — callers skip pairing
// on null rather than assuming a short clip.

describe('parseDurationSeconds', () => {
  it('reads the H:MM:SS.ffffff form the app sends', () => {
    expect(parseDurationSeconds('0:00:01.500000')).toBeCloseTo(1.5);
    expect(parseDurationSeconds('0:00:00.00000')).toBe(0);
    expect(parseDurationSeconds('0:01:30.000000')).toBe(90);
    expect(parseDurationSeconds('1:00:00.000000')).toBe(3600);
  });

  it('reads MM:SS and bare seconds', () => {
    expect(parseDurationSeconds('02:30')).toBe(150);
    expect(parseDurationSeconds('12.5')).toBeCloseTo(12.5);
    expect(parseDurationSeconds(3)).toBe(3);
  });

  it('returns null for anything it cannot trust, never 0', () => {
    for (const bad of [null, undefined, '', '   ', 'abc', 'x:y:z', NaN, {}, []]) {
      expect(parseDurationSeconds(bad as any), `input ${JSON.stringify(bad)}`).toBeNull();
    }
  });

  it('distinguishes a motion clip from a real video at the pairing threshold', () => {
    // The gate treats <0.3s or >6s as "not a live-photo motion clip".
    expect(parseDurationSeconds('0:00:01.200000')!).toBeLessThan(6);
    expect(parseDurationSeconds('0:00:45.000000')!).toBeGreaterThan(6);
    expect(parseDurationSeconds('0:10:00.000000')!).toBeGreaterThan(6);
  });
});
