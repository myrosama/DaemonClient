// BUILD_ORDER P6 — what the state file is allowed to contain.
//
// `PRODUCT_SPEC.md` §4 says the account password "never touches disk — not
// .daemonclient-selfhost.json, not a log, not the terminal echo." Today nothing
// enforces that. `SECRET_KEYS` governs REDACTION IN OUTPUT — `redact()` uses it
// so `doctor` can print a report — and `saveState` happily serialises whatever
// object it is handed.
//
// The distinction matters because the two sets are genuinely different:
//
//   must persist, must be redacted:  cloudflareToken, telegramBotToken,
//                                    sessionSecret — the install cannot work
//                                    without them, so they are written 0600
//   must NEVER persist:              adminPassword — it is used once, within
//                                    seconds of being typed, to create the
//                                    Firebase account, and there is no reason
//                                    for it to survive the process
//
// One `Set` cannot express both, and today only the first exists. So a single
// `state.adminPassword = pw` anywhere — plausible, since setup already holds
// the value — would silently put a password on disk in cleartext and no test
// would notice.
//
// These assert the FILE ON DISK, not the in-memory object. That is the only
// thing that survives the process and the only thing an attacker reads.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  saveState, loadState, statePath, redact,
  SECRET_KEYS, NEVER_PERSIST,
} from '../src/state.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dc-state-'));
const raw = (dir) => fs.readFileSync(statePath(dir), 'utf8');

describe('the password never reaches disk', () => {
  test('adminPassword is dropped before writing, however it was set', () => {
    const dir = tmp();
    saveState({
      version: 1, steps: {},
      adminEmail: 'me@example.test',
      adminPassword: 'hunter2-correct-horse',
      cloudflareToken: 'cf-token-value',
    }, dir);

    const onDisk = raw(dir);
    assert.ok(!onDisk.includes('hunter2-correct-horse'), 'the password is not in the file');
    assert.ok(!onDisk.includes('adminPassword'), 'not even the key remains');
    // The things that MUST survive still do — dropping too much is its own bug.
    assert.match(onDisk, /cf-token-value/, 'the Cloudflare token still persists');
    assert.match(onDisk, /me@example\.test/, 'the email still persists');
  });

  test('nested occurrences are dropped too', () => {
    // A resume payload or a step record could carry it one level down.
    const dir = tmp();
    saveState({ version: 1, steps: { account: { done: true, adminPassword: 'nested-secret' } } }, dir);
    assert.ok(!raw(dir).includes('nested-secret'));
  });

  test('the caller keeps its own object — we do not mutate what we were handed', () => {
    // setup.mjs uses the password immediately after saveState in the same run.
    // Stripping the caller's live object would break the flow it is protecting.
    const dir = tmp();
    const state = { version: 1, steps: {}, adminPassword: 'still-needed-in-memory' };
    saveState(state, dir);
    assert.equal(state.adminPassword, 'still-needed-in-memory');
  });

  test('a resumed run cannot silently proceed with a blank password', () => {
    // Because it is never stored, loadState must not resurrect it as ''. An
    // empty string would sail through a truthiness check and try to create a
    // Firebase account with no password.
    const dir = tmp();
    saveState({ version: 1, steps: {}, adminPassword: 'x' }, dir);
    const reloaded = loadState(dir);
    assert.equal(reloaded.adminPassword, undefined, 'absent, not empty string');
  });

  test('the two sets are not the same thing, and both are non-empty', () => {
    // Guards against someone "simplifying" them into one. Everything that must
    // never persist must also be redacted from output; the reverse is false.
    assert.ok(NEVER_PERSIST.size > 0);
    for (const k of NEVER_PERSIST) {
      assert.ok(SECRET_KEYS.has(k), `${k} must also be redacted from output`);
    }
    assert.ok(SECRET_KEYS.size > NEVER_PERSIST.size, 'some secrets legitimately persist');
    for (const mustKeep of ['cloudflareToken', 'telegramBotToken', 'sessionSecret']) {
      assert.ok(!NEVER_PERSIST.has(mustKeep), `${mustKeep} is required for the install to work`);
    }
  });
});

describe('the file is never briefly world-readable', () => {
  test('created 0600 from the outset', { skip: os.platform() === 'win32' }, () => {
    const dir = tmp();
    saveState({ version: 1, steps: {} }, dir);
    const mode = fs.statSync(statePath(dir)).mode & 0o777;
    assert.equal(mode & 0o077, 0, `mode is ${mode.toString(8)}`);
  });

  test('rewriting an existing file does not widen it', () => {
    const dir = tmp();
    saveState({ version: 1, steps: {} }, dir);
    if (os.platform() !== 'win32') fs.chmodSync(statePath(dir), 0o644);
    saveState({ version: 1, steps: {}, again: true }, dir);
    if (os.platform() !== 'win32') {
      assert.equal(fs.statSync(statePath(dir)).mode & 0o077, 0, 'tightened back to 0600');
    }
  });
});

describe('redaction still covers what does persist', () => {
  test('every persisted secret is redacted in output', () => {
    const out = redact({
      cloudflareToken: 'cf', telegramBotToken: 'tg', sessionSecret: 's'.repeat(40),
      workerName: 'dc-abc',
    });
    assert.equal(out.cloudflareToken, '<redacted>');
    assert.equal(out.telegramBotToken, '<redacted>');
    assert.equal(out.sessionSecret, '<redacted>');
    assert.equal(out.workerName, 'dc-abc', 'non-secrets survive so the report is useful');
  });

  test('an empty secret redacts to empty, not to <redacted>', () => {
    // "<redacted>" for an absent value tells the operator a credential exists
    // when it does not — the opposite of what a diagnostic is for.
    assert.equal(redact({ cloudflareToken: '' }).cloudflareToken, '');
  });
});
