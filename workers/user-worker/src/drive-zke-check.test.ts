import { describe, it, expect } from 'vitest';
import { driveKeyCheck } from './drive';
import { webdavUploadRefusal } from './webdav';

// A real check value: base64(IV ‖ AES-GCM(constant)) as the Drive app makes it.
async function realCheck(): Promise<string> {
  const key = (await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt'])) as CryptoKey;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode('daemonclient-drive-key-check-v1')));
  const all = new Uint8Array(12 + ct.length); all.set(iv); all.set(ct, 12);
  return btoa(String.fromCharCode(...all));
}

describe('driveKeyCheck — what the worker keeps of a key-check value', () => {
  it('keeps a real check value', async () => {
    const check = await realCheck();
    expect(driveKeyCheck(check)).toBe(check);
  });
  it('drops anything that is not a plain, bounded base64 string', () => {
    for (const bad of [undefined, null, 42, {}, '', 'short', 'x'.repeat(600), '<script>alert(1)</script>'.padEnd(60, 'A'), 'AAAA AAAA'.padEnd(60, 'A'), 'A'.repeat(60) + '==='])
      expect(driveKeyCheck(bad)).toBe('');
  });
});

describe('webdavUploadRefusal — the mount never stores a file unencrypted while encryption is on', () => {
  it('refuses when encryption uses a custom password (the worker has no key)', () => {
    expect(webdavUploadRefusal({ enabled: true, mode: 'custom', password: '', salt: 's' })).toMatch(/own password/);
  });
  it('allows uploads with automatic encryption (the worker encrypts) or with encryption off', () => {
    expect(webdavUploadRefusal({ enabled: true, mode: 'auto', password: 'p', salt: 's' })).toBeNull();
    expect(webdavUploadRefusal({ enabled: false })).toBeNull();
    expect(webdavUploadRefusal(null)).toBeNull();
  });
});
