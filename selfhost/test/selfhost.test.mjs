// Tests for the self-hosting CLI.
//
// Run: cd selfhost && npm test
//
// Two things matter most and are tested hardest:
//   1. The password hash this CLI writes must be verifiable by the worker.
//      If these two implementations ever drift, every self-hosted install
//      locks its owner out — and the failure would only appear at first login,
//      long after setup reported success.
//   2. Nothing that can print or transmit state may include a secret.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { hashPasswordNode, verifyPasswordNode, PASSWORD_ITERATIONS } from '../src/password.mjs';
import { redact, loadState, saveState, statePath, SECRET_KEYS, checkStatePermissions, markDone, isDone } from '../src/state.mjs';
import { wrap, width } from '../src/ui.mjs';

describe('password hashing agrees with the worker', () => {
  test('produces the format selfhost-auth.ts parses', async () => {
    const record = await hashPasswordNode('a-test-password');
    const parts = record.split('$');
    assert.equal(parts.length, 4);
    assert.equal(parts[0], 'pbkdf2-sha256');
    assert.equal(Number(parts[1]), PASSWORD_ITERATIONS);
    assert.ok(Buffer.from(parts[2], 'base64').length >= 16, 'salt is at least 16 bytes');
    assert.equal(Buffer.from(parts[3], 'base64').length, 32, 'hash is 256 bits');
  });

  test('uses the same work factor the worker expects', () => {
    // Read the worker's constant directly: a mismatch here is the drift we
    // most fear, and it should fail in CI rather than at someone's first login.
    const src = fs.readFileSync(
      path.join(import.meta.dirname, '..', '..', 'immich-api-shim', 'src', 'selfhost-auth.ts'),
      'utf8',
    );
    const m = src.match(/PASSWORD_ITERATIONS\s*=\s*([\d_]+)/);
    assert.ok(m, 'worker defines PASSWORD_ITERATIONS');
    assert.equal(Number(m[1].replace(/_/g, '')), PASSWORD_ITERATIONS);
  });

  test('round-trips', async () => {
    const record = await hashPasswordNode('correct horse battery staple');
    assert.equal(await verifyPasswordNode('correct horse battery staple', record), true);
    assert.equal(await verifyPasswordNode('wrong', record), false);
  });

  test('salts each hash', async () => {
    const a = await hashPasswordNode('same');
    const b = await hashPasswordNode('same');
    assert.notEqual(a, b);
  });

  test('rejects malformed records rather than throwing', async () => {
    for (const bad of ['', 'nope', 'pbkdf2-sha256$x$y$z', 'md5$1$a$b']) {
      assert.equal(await verifyPasswordNode('x', bad), false);
    }
  });
});

describe('state file safety', () => {
  test('redacts every secret key', () => {
    const state = {
      cloudflareToken: 'cf-live-token',
      telegramBotToken: '12345:AAHsecret',
      sessionSecret: 'session-secret',
      storageKey: 'storage-key',
      adminPassword: 'hunter2',
      workerName: 'daemonclient-abc',
      nested: { cloudflareToken: 'nested-token', harmless: 'keep me' },
    };
    const safe = redact(state);
    const serialized = JSON.stringify(safe);

    for (const secret of ['cf-live-token', '12345:AAHsecret', 'session-secret', 'storage-key', 'hunter2', 'nested-token']) {
      assert.ok(!serialized.includes(secret), `leaked ${secret}`);
    }
    assert.equal(safe.workerName, 'daemonclient-abc');
    assert.equal(safe.nested.harmless, 'keep me');
  });

  test('the redactor covers every declared secret key', () => {
    const state = Object.fromEntries([...SECRET_KEYS].map((k) => [k, `value-of-${k}`]));
    const serialized = JSON.stringify(redact(state));
    for (const k of SECRET_KEYS) {
      assert.ok(!serialized.includes(`value-of-${k}`), `${k} was not redacted`);
    }
  });

  test('writes the state file owner-only', { skip: os.platform() === 'win32' }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-state-'));
    try {
      saveState({ version: 1, steps: {}, cloudflareToken: 'secret' }, dir);
      const mode = fs.statSync(statePath(dir)).mode & 0o777;
      assert.equal(mode & 0o077, 0, `mode ${mode.toString(8)} is readable by others`);
      assert.equal(checkStatePermissions(dir), null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('flags a state file that others can read', { skip: os.platform() === 'win32' }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-state-'));
    try {
      saveState({ version: 1, steps: {} }, dir);
      fs.chmodSync(statePath(dir), 0o644);
      const warning = checkStatePermissions(dir);
      assert.ok(warning && /chmod 600/.test(warning));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('round-trips state and tracks completed steps', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-state-'));
    try {
      const state = loadState(dir);
      assert.equal(isDone(state, 'telegram'), false);
      markDone(state, 'telegram', { botUsername: 'x' });
      saveState(state, dir);

      const reloaded = loadState(dir);
      assert.equal(isDone(reloaded, 'telegram'), true);
      assert.equal(reloaded.steps.telegram.botUsername, 'x');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('recovers from a corrupt state file instead of crashing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-state-'));
    try {
      fs.writeFileSync(statePath(dir), '{ not json');
      const state = loadState(dir);
      assert.deepEqual(state.steps, {});
      // The unreadable original is preserved rather than silently destroyed.
      assert.ok(fs.readdirSync(dir).some((f) => f.includes('corrupt')));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the state filename is gitignored', () => {
    const ignore = fs.readFileSync(path.join(import.meta.dirname, '..', '..', '.gitignore'), 'utf8');
    assert.ok(ignore.includes('.daemonclient-selfhost.json'), 'state file must be gitignored');
  });
});

describe('terminal helpers', () => {
  test('width ignores ANSI colour codes so borders align', () => {
    assert.equal(width('\x1b[32mhello\x1b[39m'), 5);
    assert.equal(width('plain'), 5);
  });

  test('wrap breaks long text at word boundaries', () => {
    const out = wrap('the quick brown fox jumps over the lazy dog', 12);
    assert.ok(out.every((l) => width(l) <= 12), 'no line exceeds the width');
    assert.equal(out.join(' '), 'the quick brown fox jumps over the lazy dog');
  });

  test('wrap leaves short text alone', () => {
    assert.deepEqual(wrap('short', 20), ['short']);
  });
});

describe('cli surface', () => {
  test('every advertised command resolves to a real module', async () => {
    const entry = fs.readFileSync(path.join(import.meta.dirname, '..', 'bin', 'daemonclient.mjs'), 'utf8');
    const names = [...entry.matchAll(/import\('\.\.\/src\/commands\/([\w-]+)\.mjs'\)/g)].map((m) => m[1]);
    assert.ok(names.length >= 5, 'found the command list');
    for (const name of names) {
      const file = path.join(import.meta.dirname, '..', 'src', 'commands', `${name}.mjs`);
      assert.ok(fs.existsSync(file), `missing command module: ${name}`);
      await import(file); // must parse and load
    }
  });
});
