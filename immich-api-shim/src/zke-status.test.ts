import { describe, it, expect, vi } from 'vitest';

vi.mock('./cached-config', () => ({
  getCachedConfig: async () => ({ botToken: 'T', channelId: '-1' }),
}));

import { handleAssets } from './assets';
import { testSessionToken, testAuthEnv } from './test-session';

// Fixtures are deliberately self-describing rather than realistic. A test
// constant that LOOKS like a credential trips secret scanners on every push,
// and a repo whose alerts are all false positives is a repo where a real leak
// gets waved through. These only need to be non-empty and valid base64 where
// the code decodes them.
const FAKE_PASSWORD = 'not-a-real-password-'.padEnd(32, 'x');
const FAKE_SALT = btoa('not-a-real-salt');

// `/api/assets/zke-status` is the endpoint that made the plaintext bug
// invisible. It reported `enabled` straight from the config flag and never
// checked that the key material to honour it existed — so an install writing
// photos to Telegram in the clear showed a closed padlock and "Encryption: ON"
// (`NavigationBar.svelte:172-179`).
//
// Three states, not two. The one that did not exist in the response is the one
// that mattered: configured for encryption, unable to do it.

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
  const res = { results: rows };
  return {
    prepare: (_sql: string) => ({
      bind: (..._a: any[]) => ({ first: async () => null, all: async () => res, run: async () => ({}) }),
      first: async () => null,
      all: async () => res,
      run: async () => ({}),
    }),
  };
}

async function status(zke: Zke) {
  const req = new Request('https://worker.test/api/assets/zke-status', {
    headers: { Authorization: `Bearer ${await testSessionToken()}` },
  });
  const env: any = testAuthEnv({ DB: fakeDb(zke), waitUntil: () => {} });
  const res = await handleAssets(req, env, '/api/assets/zke-status', new URL(req.url));
  return (await res.json()) as any;
}

const REAL = { password: FAKE_PASSWORD, salt: FAKE_SALT };

describe('zke-status tells the truth about all three states', () => {
  it('genuinely encrypted → enabled, nothing missing', async () => {
    const s = await status({ mode: 'server', enabled: '1', ...REAL });
    expect(s).toMatchObject({ mode: 'server', enabled: true, keyMaterialMissing: false });
  });

  it('deliberately off → not enabled, and NOT flagged as broken', async () => {
    // "Off" and "broken" need opposite messages to the user, so they must not
    // collapse into the same response.
    const s = await status({ mode: 'off', enabled: '0', password: '', salt: '' });
    expect(s).toMatchObject({ mode: 'off', enabled: false, keyMaterialMissing: false });
  });

  it('THE BUG: configured for encryption with no keys → enabled is false', async () => {
    const s = await status({ mode: 'server', enabled: '1', password: '', salt: '' });
    expect(s.enabled).toBe(false);
  });

  it('THE BUG: and that state is distinguishable from being switched off', async () => {
    const s = await status({ mode: 'server', enabled: '1', password: '', salt: '' });
    expect(s.keyMaterialMissing).toBe(true);
  });

  it('a half-seeded install counts as missing (salt only)', async () => {
    const s = await status({ mode: 'server', enabled: '1', password: FAKE_PASSWORD, salt: '' });
    expect(s).toMatchObject({ enabled: false, keyMaterialMissing: true });
  });

  it('a half-seeded install counts as missing (password only)', async () => {
    const s = await status({ mode: 'server', enabled: '1', password: '', salt: FAKE_SALT });
    expect(s).toMatchObject({ enabled: false, keyMaterialMissing: true });
  });

  it('keeps reporting `mode` as configured, which is what clients branch on', async () => {
    // PARITY.md forbids repurposing a field. daemonclient-drive.ts:34 tests
    // `mode === 'server'` to decide whether to fetch key config, and
    // NavigationBar.svelte renders from it — quietly turning it into 'off' when
    // keys are missing would change client behaviour, not just wording.
    const s = await status({ mode: 'server', enabled: '1', password: '', salt: '' });
    expect(s.mode).toBe('server');
  });

  it('no config at all → off, and not flagged broken', async () => {
    const s = await status({});
    expect(s).toMatchObject({ mode: 'off', enabled: false, keyMaterialMissing: false });
  });
});

describe('the encryption toggle is gone', () => {
  // It let anyone switch encryption OFF for the whole install from a button.
  // It was also destructive: both branches read the existing config to decide
  // whether to reuse the key material, and on the Firestore branch that read
  // (`firestoreGet`) returns null on ANY failure — 401, 429, 500. A blip while
  // turning encryption on therefore generated and wrote a FRESH password and
  // salt, permanently orphaning every photo encrypted with the old ones.
  it('POST /api/assets/zke-toggle no longer exists', async () => {
    const req = new Request('https://worker.test/api/assets/zke-toggle', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await testSessionToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ mode: 'off' }),
    });
    const env: any = testAuthEnv({
      DB: fakeDb({ mode: 'server', enabled: '1', ...REAL }),
      waitUntil: () => {},
    });
    const res = await handleAssets(req, env, '/api/assets/zke-toggle', new URL(req.url));
    expect(res.status).toBe(404);
  });

  it('and encryption cannot be switched off through it', async () => {
    const req = new Request('https://worker.test/api/assets/zke-toggle', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await testSessionToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ mode: 'off' }),
    });
    const env: any = testAuthEnv({
      DB: fakeDb({ mode: 'server', enabled: '1', ...REAL }),
      waitUntil: () => {},
    });
    await handleAssets(req, env, '/api/assets/zke-toggle', new URL(req.url));
    // Still reporting encrypted afterwards.
    expect((await status({ mode: 'server', enabled: '1', ...REAL })).enabled).toBe(true);
  });
});
