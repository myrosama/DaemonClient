import { describe, it, expect, vi } from 'vitest';

vi.mock('./cached-config', () => ({
  getCachedConfig: async () => ({ botToken: 'T', channelId: '-1' }),
}));

import { handleAssets } from './assets';
import { testSessionToken, testAuthEnv } from './test-session';

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

const REAL = { password: 'p'.repeat(32), salt: 'c2FsdHNhbHQ=' };

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
    const s = await status({ mode: 'server', enabled: '1', password: 'p'.repeat(32), salt: '' });
    expect(s).toMatchObject({ enabled: false, keyMaterialMissing: true });
  });

  it('a half-seeded install counts as missing (password only)', async () => {
    const s = await status({ mode: 'server', enabled: '1', password: '', salt: 'c2FsdA==' });
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
