import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const repo = new URL('../../', import.meta.url);
const read = (p) => readFileSync(new URL(p, repo), 'utf8');

// The CLI generated a 32-byte STORAGE_KEY, called it "File encryption key" to
// the user, warned that losing it would lose their files, and shipped it to the
// worker as ENCRYPTION_MASTER_KEY — which the worker DECLARED and never read.
// It protected nothing. Worse, the warning pointed users at the wrong thing:
// what actually decrypts their photos is zke_password/zke_salt in D1, and those
// exist nowhere else.

describe('the key that protected nothing is gone', () => {
  test('the shim no longer declares ENCRYPTION_MASTER_KEY', () => {
    assert.ok(!read('immich-api-shim/src/index.ts').includes('ENCRYPTION_MASTER_KEY'));
  });

  test('no live CLI command still ships it as a binding', () => {
    for (const f of ['setup.mjs', 'update.mjs']) {
      const src = read(`selfhost/src/commands/${f}`);
      assert.ok(!src.includes('ENCRYPTION_MASTER_KEY'), `${f} still binds it`);
      assert.ok(!src.includes('storageKey'), `${f} still generates it`);
    }
  });

  test('the config module no longer defines STORAGE_KEY as a value', () => {
    const src = read('selfhost/src/config.mjs');
    assert.ok(!/^\s*STORAGE_KEY:\s*\{/m.test(src), 'STORAGE_KEY is still a config field');
  });

  // The deployment service has a variable of the SAME NAME that is REAL: it
  // encrypts every user's stored Cloudflare API token. A repo-wide
  // grep-and-delete would have locked the whole fleet out of auto-update.
  test('the deployment service keeps its real ENCRYPTION_MASTER_KEY', () => {
    const src = read('deployment-service/src/index.ts');
    assert.ok(src.includes('ENCRYPTION_MASTER_KEY'), 'the REAL key was deleted by mistake');
    assert.match(src, /encryptToken\([^)]*ENCRYPTION_MASTER_KEY/);
  });
});

describe('the backup warning points at the real key material', () => {
  const src = read('selfhost/src/config.mjs');

  test('it names zke_password and zke_salt', () => {
    assert.match(src, /zke_password/);
    assert.match(src, /zke_salt/);
  });

  test('it no longer claims the config file can decrypt your files', () => {
    // The old text: "STORAGE_KEY is the only thing that can decrypt files
    // already in your Telegram channel". That was false.
    assert.ok(!/only thing that',?\s*$/m.test(src) || !src.includes("can decrypt files already"));
  });

  test('the command it tells the user to run actually exists', () => {
    // A warning that points at a command nobody implemented is the same class
    // of mistake as a fix aimed at code nothing executes.
    assert.match(src, /daemonclient doctor --show-keys/);
    assert.match(read('selfhost/bin/daemonclient.mjs'), /--show-keys/);
    assert.match(read('selfhost/src/commands/doctor.mjs'), /showKeys/);
  });
});

describe('doctor --show-keys', () => {
  test('prints both rows, and only when asked', async () => {
    const src = read('selfhost/src/commands/doctor.mjs');
    assert.match(src, /if \(showKeys\)/);
    assert.match(src, /readKeyMaterial/);
    // Default must stay silent — running doctor over someone's shoulder should
    // not spray the keys to their terminal.
    const i = src.indexOf('if (showKeys)');
    assert.ok(i > 0);
    assert.ok(!/zke_password\s{2,}\$\{/.test(src.slice(0, i)), 'keys printed outside the flag');
  });

  test('doctor still loads', async () => {
    const mod = await import('../src/commands/doctor.mjs');
    assert.equal(typeof mod.runDoctor, 'function');
  });
});
