import { describe, expect, it } from 'vitest';
import { SHARED_SIGNIN_RETRY_MS, mayTrySharedSignIn } from './shared-signin-guard';

const store = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};

describe('mayTrySharedSignIn', () => {
  it('allows the first attempt and records it', () => {
    const s = store();
    expect(mayTrySharedSignIn(s, 1000)).toBe(true);
  });
  it('refuses a second attempt within the window — the page shows the password form instead of looping', () => {
    const s = store();
    mayTrySharedSignIn(s, 1000);
    expect(mayTrySharedSignIn(s, 1000 + 5000)).toBe(false);
  });
  it('allows another attempt once the window has passed', () => {
    const s = store();
    mayTrySharedSignIn(s, 1000);
    expect(mayTrySharedSignIn(s, 1000 + SHARED_SIGNIN_RETRY_MS)).toBe(true);
  });
  it('a recorded time in the future does not block forever', () => {
    const s = store();
    s.setItem('dc-shared-signin-tried', String(10 ** 15));
    expect(mayTrySharedSignIn(s, 1000)).toBe(true);
  });
  it('without usable storage, it behaves as before', () => {
    expect(mayTrySharedSignIn(null, 1)).toBe(true);
    const broken = { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('x'); } };
    expect(mayTrySharedSignIn(broken, 1)).toBe(true);
  });
});
