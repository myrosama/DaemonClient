import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// A DIFFERENT bot token per call. The Telegram send pacer keeps a token bucket
// per bot in module scope, so a shared token would let one test's sends drain
// the bucket and make the next test wait up to 4s per send — 7s for a 4-byte
// file, entirely from a rate limiter unrelated to what is being tested.
let botSeq = 0;
vi.mock('./cached-config', () => ({
  getCachedConfig: async () => ({ botToken: `TESTBOT${botSeq}`, channelId: '-100123' }),
}));

import { handleAssets } from './assets';
import { testSessionToken, testAuthEnv } from './test-session';

// Encryption must fail CLOSED.
//
// `getEncryptionKey` used to return null for two unrelated situations —
// "encryption is off, store plaintext" and "encryption is on but the key
// material is missing" — and every caller reads a null key as the first one.
// So an install in the second state wrote every photo to Telegram in the clear,
// under its real filename, while reporting itself as encrypted. Nothing
// surfaced it, and once a file is in the channel it cannot be un-leaked.
//
// That state is not hypothetical. The migration seeds
// `zke_mode='server', zke_enabled='1', zke_password='', zke_salt=''` and a
// SECOND step fills the last two. The hosted provisioner runs it; the self-host
// CLI never did (finding §1).
//
// These tests are written against the upload path rather than the helper, so
// they assert the thing that actually matters: nothing reaches Telegram.

type Zke = { mode?: string; enabled?: string; password?: string; salt?: string };

function fakeDb(zke: Zke) {
  const rows = Object.entries({
    zke_mode: zke.mode,
    zke_enabled: zke.enabled,
    zke_password: zke.password,
    zke_salt: zke.salt,
  })
    .filter(([, v]) => v !== undefined)
    .map(([key, value]) => ({ key, value }));

  return {
    prepare: (sql: string) => ({
      bind: (..._a: any[]) => ({
        first: async () => null,
        all: async () => ({ results: sql.includes('zke_') ? rows : [] }),
        run: async () => ({}),
      }),
      first: async () => null,
      all: async () => ({ results: sql.includes('zke_') ? rows : [] }),
      run: async () => ({}),
    }),
  };
}

async function upload(zke: Zke) {
  const form = new FormData();
  form.append('assetData', new File([new Uint8Array([1, 2, 3, 4])], 'holiday.jpg', { type: 'image/jpeg' }));
  form.append('deviceAssetId', 'dev-1');
  form.append('deviceId', 'phone');

  const request = new Request('https://worker.test/api/assets', {
    method: 'POST',
    headers: { Authorization: `Bearer ${await testSessionToken()}` },
    body: form,
  });

  botSeq++;
  const env: any = testAuthEnv({ DB: fakeDb(zke), waitUntil: () => {} });
  return handleAssets(request, env, '/api/assets', new URL(request.url));
}

/** Did anything get sent to Telegram? That is the question these tests exist
 *  to answer — a refusal that still uploaded the file would be worthless. */
const sentToTelegram = () =>
  fetchSpy.mock.calls.some(([url]: [any]) => String(url).includes('api.telegram.org'));

let fetchSpy: any;
beforeEach(() => {
  // A NEW Response per call. `mockResolvedValue` hands back one shared instance,
  // whose body is consumed by the first `.json()` — the second Telegram call
  // then reads an unusable body and the upload stalls in its retry loop.
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
    new Response(JSON.stringify({ ok: true, result: { message_id: 1, document: { file_id: 'f1' } } }), {
      headers: { 'Content-Type': 'application/json' },
    }),
  );
});
afterEach(() => fetchSpy.mockRestore());

describe('encryption enabled but key material missing', () => {
  const broken = { mode: 'server', enabled: '1', password: '', salt: '' };

  it('refuses the upload instead of storing plaintext', async () => {
    const res = await upload(broken);
    expect(res.status).toBe(503);
  });

  it('sends NOTHING to Telegram', async () => {
    await upload(broken);
    expect(sentToTelegram()).toBe(false);
  });

  it('says what is wrong and what to do about it', async () => {
    const body = (await (await upload(broken)).json()) as any;
    expect(body.code).toBe('encryption_unavailable');
    // A user reading this must learn (a) it was refused deliberately and
    // (b) the command that fixes it. "Internal upload error" taught neither.
    expect(body.message).toMatch(/encryption/i);
    expect(body.message).toContain('daemonclient doctor');
  });

  it('refuses when only the salt is missing', async () => {
    const res = await upload({ mode: 'server', enabled: '1', password: 'p'.repeat(32), salt: '' });
    expect(res.status).toBe(503);
    expect(sentToTelegram()).toBe(false);
  });

  it('refuses when only the password is missing', async () => {
    const res = await upload({ mode: 'server', enabled: '1', password: '', salt: 'c2FsdA==' });
    expect(res.status).toBe(503);
    expect(sentToTelegram()).toBe(false);
  });
});

describe('the cases that must keep working', () => {
  // The whole risk of this change is blocking uploads for installs that were
  // never broken. Encryption genuinely off is a legitimate configuration.
  it('uploads with encryption switched off', async () => {
    await upload({ mode: 'off', enabled: '0', password: '', salt: '' });
    expect(sentToTelegram()).toBe(true);
  });

  it('uploads when there is no zke config at all', async () => {
    // The central worker serves users who never provisioned their own worker
    // and may have no config row. Absent config is not a claim to be
    // encrypting, so it must not be treated as the broken state.
    await upload({});
    expect(sentToTelegram()).toBe(true);
  });

  it('uploads when the key material is real', async () => {
    await upload({ mode: 'server', enabled: '1', password: 'p'.repeat(32), salt: 'c2FsdHNhbHQ=' });
    expect(sentToTelegram()).toBe(true);
  });

  it('uploads when enabled is off even though material happens to exist', async () => {
    await upload({ mode: 'server', enabled: '0', password: 'p'.repeat(32), salt: 'c2FsdHNhbHQ=' });
    expect(sentToTelegram()).toBe(true);
  });
});

describe('the refusal does not invite a retry storm', () => {
  it('sets a long Retry-After, because only a human can clear this', async () => {
    // A broken install fails every upload identically. A backup of a few
    // thousand photos would otherwise become a few thousand identical failures
    // against a worker already in a bad state.
    const res = await upload({ mode: 'server', enabled: '1', password: '', salt: '' });
    expect(Number(res.headers.get('Retry-After'))).toBeGreaterThanOrEqual(600);
  });
});
