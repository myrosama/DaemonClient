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
    // Pin the REASON, not just the status. THREE different 503s live on this
    // path — this refusal, the byte-budget shed, and the direct-byte-path flag
    // — and the other two also send nothing to Telegram. Asserting the status
    // alone would pass against a build that refuses for an unrelated reason.
    expect(((await res.json()) as any).code).toBe('encryption_unavailable');
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
    // HOSTED wording: this env has no SELF_HOST, and a hosted user has no
    // terminal and no CLI. Telling them to run `daemonclient doctor` would be a
    // self-host detail leaking into the hosted product — and a hosted install
    // CAN reach this state via a failed provisioning step or a D1 restore.
    expect(body.message).not.toContain('daemonclient doctor');
    expect(body.message).toMatch(/report/i);
  });

  it('tells a SELF-HOSTED owner the command that fixes it', async () => {
    botSeq++;
    const env: any = testAuthEnv({ DB: fakeDb(broken), waitUntil: () => {}, SELF_HOST: '1' });
    const form = new FormData();
    form.append('assetData', new File([new Uint8Array([1, 2, 3, 4])], 'h.jpg', { type: 'image/jpeg' }));
    const req = new Request('https://worker.test/api/assets', {
      method: 'POST',
      headers: { Authorization: `Bearer ${await testSessionToken()}` },
      body: form,
    });
    const body = (await (await handleAssets(req, env, '/api/assets', new URL(req.url))).json()) as any;
    expect(body.code).toBe('encryption_unavailable');
    expect(body.message).toContain('daemonclient doctor');
  });

  it('refuses when only the salt is missing', async () => {
    const res = await upload({ mode: 'server', enabled: '1', password: 'p'.repeat(32), salt: '' });
    expect(((await res.json()) as any).code).toBe('encryption_unavailable');
    expect(sentToTelegram()).toBe(false);
  });

  it('refuses when only the password is missing', async () => {
    const res = await upload({ mode: 'server', enabled: '1', password: '', salt: 'c2FsdA==' });
    expect(((await res.json()) as any).code).toBe('encryption_unavailable');
    expect(sentToTelegram()).toBe(false);
  });

  it('refuses when zke_mode is missing but enabled still claims encryption', async () => {
    // getZkeConfig returned null whenever zke_mode was absent, and every caller
    // reads null as "off" — a fail-open sitting inside the one function whose
    // job is to fail closed.
    const res = await upload({ enabled: '1', password: '', salt: '' });
    expect(((await res.json()) as any).code).toBe('encryption_unavailable');
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

describe('the positive case actually encrypts', () => {
  // Every other test here asserts an ABSENCE (nothing reached Telegram). All of
  // them would still pass if encryption were removed outright — encryptChunk
  // made a no-op, deriveKey returning a constant. For a file whose whole point
  // is "nothing reaches Telegram in the clear", the assertion that was missing
  // is the positive one.
  it('does not send the plaintext bytes to Telegram', async () => {
    const PLAINTEXT = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);

    const form = new FormData();
    form.append('assetData', new File([PLAINTEXT], 'secret.jpg', { type: 'image/jpeg' }));
    form.append('deviceAssetId', 'dev-enc');
    form.append('deviceId', 'phone');

    botSeq++;
    const env: any = testAuthEnv({
      DB: fakeDb({ mode: 'server', enabled: '1', password: 'p'.repeat(32), salt: 'c2FsdHNhbHQ=' }),
      waitUntil: () => {},
    });
    const req = new Request('https://worker.test/api/assets', {
      method: 'POST',
      headers: { Authorization: `Bearer ${await testSessionToken()}` },
      body: form,
    });
    await handleAssets(req, env, '/api/assets', new URL(req.url));

    const docs: Array<{ name: string; bytes: Uint8Array }> = [];
    for (const [u, init] of fetchSpy.mock.calls) {
      if (!String(u).includes('sendDocument')) continue;
      const body = (init as any)?.body;
      if (!(body instanceof FormData)) continue;
      const doc: any = body.get('document');
      if (!doc || typeof doc.arrayBuffer !== 'function') continue;
      docs.push({ name: doc.name ?? '', bytes: new Uint8Array(await doc.arrayBuffer()) });
    }
    expect(docs.length).toBeGreaterThan(0);

    // Everything PERSISTED must be ciphertext. AES-GCM is 12-byte IV +
    // ciphertext + 16-byte tag, so it is strictly longer than its input and
    // must not contain it verbatim.
    const stored = docs.filter((d) => d.name !== 'secret.jpg');
    expect(stored.length).toBeGreaterThan(0);
    for (const d of stored) {
      expect(d.bytes.length).toBeGreaterThan(PLAINTEXT.length);
      const hex = Array.from(d.bytes, (b) => b.toString(16).padStart(2, '0')).join('');
      expect(hex).not.toContain('deadbeef');
    }
  });

  // KNOWN AND DELIBERATE, pinned here so it cannot regress silently.
  //
  // `fetchTelegramThumb` (assets.ts:792) uploads the PLAINTEXT original to the
  // user's channel so Telegram will generate a thumbnail, then deletes that
  // message. So on an encrypted install the unencrypted file does reach
  // Telegram — briefly — and the only thing removing it is a deleteMessage
  // call. The comment at assets.ts:1530 records a past regression where the
  // raw copy was NOT deleted under load.
  //
  // This test does not endorse it. It makes the delete load-bearing: remove it
  // and this fails. The wider question is finding §18.
  it('deletes the temp plaintext it sends to get a thumbnail', async () => {
    const form = new FormData();
    form.append('assetData', new File([new Uint8Array([1, 2, 3, 4])], 'temp.jpg', { type: 'image/jpeg' }));
    form.append('deviceAssetId', 'dev-tmp');
    form.append('deviceId', 'phone');

    botSeq++;
    const env: any = testAuthEnv({
      DB: fakeDb({ mode: 'server', enabled: '1', password: 'p'.repeat(32), salt: 'c2FsdHNhbHQ=' }),
      waitUntil: () => {},
    });
    const req = new Request('https://worker.test/api/assets', {
      method: 'POST',
      headers: { Authorization: `Bearer ${await testSessionToken()}` },
      body: form,
    });
    await handleAssets(req, env, '/api/assets', new URL(req.url));

    const sentPlaintext = fetchSpy.mock.calls.some(([u]: [any], _i: number) => String(u).includes('sendDocument'));
    const deleted = fetchSpy.mock.calls.some(([u]: [any]) => String(u).includes('deleteMessage'));
    expect(sentPlaintext).toBe(true);
    expect(deleted).toBe(true);
  });
});
