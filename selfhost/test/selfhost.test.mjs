// Tests for the self-hosting CLI.
//
// Run: cd selfhost && npm test
//
// Two properties matter most and are tested hardest:
//   1. Nothing that can be printed, saved or shared may contain a secret.
//   2. A self-hosted install must not be wired to any service of ours. That is
//      the whole promise of self-hosting, and it is easy to break by accident —
//      one leftover default URL and someone's private server is phoning home.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  redact, loadState, saveState, statePath, SECRET_KEYS,
  checkStatePermissions, markDone, isDone,
} from '../src/state.mjs';
import { wrap, width } from '../src/ui.mjs';

const REPO = path.join(import.meta.dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');

describe('state file safety', () => {
  test('redacts every secret key, at any depth', () => {
    const state = {
      cloudflareToken: 'cf-live-token',
      telegramBotToken: '12345:AAHsecret',
      sessionSecret: 'session-secret',
      storageKey: 'storage-key',
      workerName: 'daemonclient-abc',
      nested: { cloudflareToken: 'nested-token', harmless: 'keep me' },
    };
    const serialized = JSON.stringify(redact(state));
    for (const secret of ['cf-live-token', '12345:AAHsecret', 'session-secret', 'storage-key', 'nested-token']) {
      assert.ok(!serialized.includes(secret), `leaked ${secret}`);
    }
    assert.ok(serialized.includes('daemonclient-abc'), 'non-secrets survive');
    assert.ok(serialized.includes('keep me'));
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

  test('flags a state file others can read', { skip: os.platform() === 'win32' }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-state-'));
    try {
      saveState({ version: 1, steps: {} }, dir);
      fs.chmodSync(statePath(dir), 0o644);
      assert.match(checkStatePermissions(dir) || '', /chmod 600/);
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
      assert.deepEqual(loadState(dir).steps, {});
      assert.ok(fs.readdirSync(dir).some((f) => f.includes('corrupt')), 'kept the unreadable original');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the state filename is gitignored', () => {
    assert.match(read('.gitignore'), /\.daemonclient-selfhost\.json/);
  });
});

describe('a self-hosted install depends on nothing of ours', () => {
  const setup = read('selfhost/src/commands/setup.mjs');
  const update = read('selfhost/src/commands/update.mjs');

  test('deploys the operator\'s own Firebase project, never ours', () => {
    assert.match(setup, /FIREBASE_API_KEY['"],\s*text:\s*state\.firebaseApiKey/);
    assert.match(setup, /FIREBASE_PROJECT_ID['"],\s*text:\s*state\.firebaseProjectId/);
    // Our project id must not appear as a value anywhere in the CLI.
    for (const file of [setup, update]) {
      assert.ok(!file.includes('daemonclient-c0625'), 'our Firebase project leaked into the CLI');
    }
  });

  test('never points a self-hosted worker at our relay or deployment service', () => {
    for (const [name, file] of [['setup', setup], ['update', update]]) {
      // TELEGRAM_PROXY must be blank: the managed value is a worker of ours.
      assert.match(file, /TELEGRAM_PROXY['"],\s*text:\s*['"]['"]/, `${name} sets an empty TELEGRAM_PROXY`);
      assert.ok(!/DEPLOYMENT_SERVICE_URL/.test(file), `${name} must not bind DEPLOYMENT_SERVICE_URL`);
      assert.ok(!file.includes('sadrikov49'), `${name} references our Cloudflare account`);
      assert.ok(!file.includes('daemonclient.uz'), `${name} references our domain`);
    }
  });

  test('the worker never hands a self-hosted client one of our addresses', () => {
    // Both call sites derive the address from config or the request origin.
    const server = read('immich-api-shim/src/server.ts');
    assert.match(server, /EXTERNAL_DOMAIN/);
    assert.match(server, /isSelfHost\(env\)\s*\?\s*new URL\(request\.url\)\.origin/);
    const assets = read('immich-api-shim/src/assets.ts');
    assert.match(assets, /webAppOrigin\(request, env\)/);
  });

  test('the only outbound call to a project resource is an anonymous release check', () => {
    const updateCheck = read('immich-api-shim/src/update-check.ts');
    assert.match(updateCheck, /api\.github\.com/);
    // No credentials, no identifiers, and it must be disableable.
    assert.ok(!/Authorization/.test(updateCheck), 'update check must stay anonymous');
    assert.match(updateCheck, /UPDATE_REPO/);
  });

  test('setup generates a per-install session secret rather than reusing a constant', () => {
    assert.match(setup, /SESSION_SECRET['"],\s*text:\s*state\.sessionSecret/);
    assert.match(setup, /randomSecret\(/);
  });
});

describe('terminal helpers', () => {
  test('width ignores ANSI colour codes so borders align', () => {
    assert.equal(width('\x1b[32mhello\x1b[39m'), 5);
  });

  test('wrap breaks long text at word boundaries', () => {
    const out = wrap('the quick brown fox jumps over the lazy dog', 12);
    assert.ok(out.every((l) => width(l) <= 12));
    assert.equal(out.join(' '), 'the quick brown fox jumps over the lazy dog');
  });
});

describe('cli surface', () => {
  test('every advertised command resolves to a real module that loads', async () => {
    const entry = read('selfhost/bin/daemonclient.mjs');
    const names = [...entry.matchAll(/import\('\.\.\/src\/commands\/([\w-]+)\.mjs'\)/g)].map((m) => m[1]);
    assert.ok(names.length >= 4, 'found the command list');
    for (const name of names) {
      const file = path.join(REPO, 'selfhost', 'src', 'commands', `${name}.mjs`);
      assert.ok(fs.existsSync(file), `missing command module: ${name}`);
      await import(file);
    }
  });
});
