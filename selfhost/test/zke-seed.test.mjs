// Seeding encryption keys for a self-hosted install.
//
// Two failures are possible here and they are not symmetric:
//
//   * Not writing when the keys are absent → the worker refuses every upload.
//     Annoying, visible, fixable by running the command again.
//   * Writing when a key is already there → every photo in the Telegram channel
//     becomes undecryptable. There is no backup; the ciphertext is all there is.
//
// So most of this file is about the second one: an already-seeded database, a
// read that throws, a read that comes back as an error, a read in a shape we do
// not recognise. Every one of those must leave the database untouched, and the
// tests prove it by counting writes that never happened.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { ensureEncryptionKeys } from '../src/zke.mjs';
import { MIGRATION_SQL, splitStatements } from '../../schema/schema.mjs';

// Self-describing rather than realistic. Fixtures shaped like credentials trip
// secret scanners on every push, and a repo full of false positives is one
// where a real leak gets waved through.
const FAKE_EXISTING_PASSWORD = btoa('not-a-real-existing-password');
const FAKE_EXISTING_SALT = btoa('not-a-real-existing-salt');

const REPO = path.join(import.meta.dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');

// D1 is SQLite. `node:sqlite` is the closest thing to it available offline, and
// it is the only way these tests execute the real schema against a real engine
// instead of a fake that agrees with whatever we send it.
let DatabaseSync = null;
try { ({ DatabaseSync } = await import('node:sqlite')); } catch { /* older Node */ }

/** A stand-in for Cloudflare's D1 REST endpoint: it answers SELECTs from an
 *  in-memory config table and records every write. */
function fakeD1(initial = {}) {
  const store = { ...initial };
  const writes = [];
  const query = async (sql, params = []) => {
    if (/^SELECT/i.test(sql)) {
      const wanted = params;
      const results = Object.entries(store)
        .filter(([key]) => wanted.includes(key))
        .map(([key, value]) => ({ key, value }));
      return [{ success: true, results, meta: {} }];
    }
    if (/^INSERT OR REPLACE/i.test(sql)) {
      const [key, value] = params;
      writes.push({ key, value });
      store[key] = value;
      return [{ success: true, results: [], meta: { changes: 1 } }];
    }
    throw new Error(`unexpected statement: ${sql}`);
  };
  return { query, writes, store };
}

const decodedLength = (b64) => Buffer.from(b64, 'base64').length;

describe('seeding key material', () => {
  test('generates both values when the rows are empty', async () => {
    const db = fakeD1({ zke_password: '', zke_salt: '' });

    const outcome = await ensureEncryptionKeys({ query: db.query });

    assert.equal(outcome.seeded, true);
    assert.equal(db.writes.length, 2);
    assert.equal(decodedLength(db.store.zke_salt), 16, 'salt is 16 bytes');
    assert.equal(decodedLength(db.store.zke_password), 32, 'password is 32 bytes');
  });

  test('writes standard base64, because the worker decodes it with atob()', async () => {
    const db = fakeD1({ zke_password: '', zke_salt: '' });
    await ensureEncryptionKeys({ query: db.query });

    for (const value of [db.store.zke_salt, db.store.zke_password]) {
      // Round-tripping catches base64url: '-' and '_' decode fine but re-encode
      // as '+' and '/', so a mismatch means the wrong alphabet was used.
      assert.equal(Buffer.from(value, 'base64').toString('base64'), value,
        `${value} is not standard base64`);
      assert.ok(!/[-_]/.test(value), 'base64url would break atob() in the worker');
    }
  });

  test('writes the salt before the password, so an interrupted run stays repairable', async () => {
    // Password-last is deliberate. Crash after the salt and the next run still
    // sees an empty password and seeds both. Crash after the password and every
    // later run would see a non-empty password and refuse to touch anything —
    // an install wedged with a password and no salt, forever.
    const db = fakeD1({ zke_password: '', zke_salt: '' });
    await ensureEncryptionKeys({ query: db.query });
    assert.deepEqual(db.writes.map((w) => w.key), ['zke_salt', 'zke_password']);
  });

  test('seeds when the rows are missing entirely, not just empty', async () => {
    const db = fakeD1({});
    const outcome = await ensureEncryptionKeys({ query: db.query });
    assert.equal(outcome.seeded, true);
    assert.ok(db.store.zke_password && db.store.zke_salt);
  });

  test('a second run changes nothing', async () => {
    const db = fakeD1({ zke_password: '', zke_salt: '' });
    await ensureEncryptionKeys({ query: db.query });
    const seeded = { ...db.store };

    const outcome = await ensureEncryptionKeys({ query: db.query });

    assert.equal(outcome.seeded, false);
    assert.equal(db.writes.length, 2, 'the second run wrote nothing');
    assert.deepEqual(db.store, seeded, 'existing key material was rotated');
  });

  test('never touches an install that already has a password', async () => {
    const db = fakeD1({ zke_password: FAKE_EXISTING_PASSWORD, zke_salt: FAKE_EXISTING_SALT });
    const outcome = await ensureEncryptionKeys({ query: db.query });
    assert.equal(outcome.seeded, false);
    assert.deepEqual(db.writes, []);
  });
});

describe('a read that did not succeed is not an empty read', () => {
  test('a query that throws writes nothing', async () => {
    const writes = [];
    const query = async (sql) => {
      if (/^SELECT/i.test(sql)) throw new Error('fetch failed');
      writes.push(sql);
      return [{ success: true, results: [] }];
    };

    await assert.rejects(() => ensureEncryptionKeys({ query }), /fetch failed/);
    assert.deepEqual(writes, [], 'a network error must not rotate a live key');
  });

  test('a statement-level error writes nothing', async () => {
    const writes = [];
    const query = async (sql) => {
      if (/^SELECT/i.test(sql)) return [{ success: false, error: 'D1_ERROR: no such table: config' }];
      writes.push(sql);
      return [{ success: true, results: [] }];
    };

    await assert.rejects(() => ensureEncryptionKeys({ query }), /no such table/);
    assert.deepEqual(writes, []);
  });

  for (const [name, answer] of [
    ['null', null],
    ['an empty array', []],
    ['an object with no result set', [{ success: true }]],
    ['a string', 'ok'],
  ]) {
    test(`an unrecognised answer (${name}) writes nothing`, async () => {
      const writes = [];
      const query = async (sql) => {
        if (/^SELECT/i.test(sql)) return answer;
        writes.push(sql);
        return [{ success: true, results: [] }];
      };

      await assert.rejects(() => ensureEncryptionKeys({ query }));
      assert.deepEqual(writes, [], 'an answer we cannot read must not be treated as "no key yet"');
    });
  }
});

describe('against the real schema on a real SQLite engine', { skip: !DatabaseSync && 'node:sqlite unavailable' }, () => {
  /** The schema, applied statement by statement exactly as the CLI applies it,
   *  behind a query function shaped like Cloudflare's D1 REST answer. */
  function provisionedDatabase() {
    const db = new DatabaseSync(':memory:');
    for (const statement of splitStatements(MIGRATION_SQL)) db.exec(statement);
    const query = async (sql, params = []) => {
      const stmt = db.prepare(sql);
      const results = /^SELECT/i.test(sql) ? stmt.all(...params) : (stmt.run(...params), []);
      return [{ success: true, results, meta: {} }];
    };
    const valueOf = (key) => db.prepare('SELECT value FROM config WHERE key = ?').get(key)?.value;
    return { query, valueOf };
  }

  test('a freshly provisioned database starts with the keys empty', () => {
    // The state the whole task exists to fix, reproduced from the schema itself
    // rather than asserted from memory.
    const db = provisionedDatabase();
    assert.equal(db.valueOf('zke_password'), '');
    assert.equal(db.valueOf('zke_salt'), '');
    assert.equal(db.valueOf('zke_enabled'), '1', 'encryption is on while the key is missing');
  });

  test('after seeding, reading zke_password back gives real key material', async () => {
    const db = provisionedDatabase();

    await ensureEncryptionKeys({ query: db.query });

    const password = db.valueOf('zke_password');
    const salt = db.valueOf('zke_salt');
    assert.ok(password, 'zke_password is still empty — uploads would be refused');
    assert.ok(salt, 'zke_salt is still empty — uploads would be refused');
    assert.equal(decodedLength(password), 32);
    assert.equal(decodedLength(salt), 16);
  });

  test('running it again against the same database changes nothing', async () => {
    const db = provisionedDatabase();
    await ensureEncryptionKeys({ query: db.query });
    const before = [db.valueOf('zke_password'), db.valueOf('zke_salt')];

    await ensureEncryptionKeys({ query: db.query });

    assert.deepEqual([db.valueOf('zke_password'), db.valueOf('zke_salt')], before,
      'a re-run rotated the keys — every stored photo would now be undecryptable');
  });
});

describe('the seeding runs on the paths people actually use', () => {
  // The plan originally aimed this fix at `selfhost/src/deploy.mjs`, which has
  // no importers: the code would have been written, unit-tested against a fake
  // D1 exactly like the tests above, and a real `daemonclient setup` would still
  // have produced an install that cannot upload. These tests start from
  // bin/daemonclient.mjs — the actual entry point — and follow the imports.
  const entry = read('selfhost/bin/daemonclient.mjs');
  const commandNames = [...entry.matchAll(/import\('\.\.\/src\/commands\/([\w-]+)\.mjs'\)/g)].map((m) => m[1]);

  test('setup, update and doctor are all commands the CLI exposes', () => {
    for (const name of ['setup', 'update', 'doctor']) {
      assert.ok(commandNames.includes(name), `${name} is not reachable from the CLI`);
    }
  });

  for (const name of ['setup', 'update', 'doctor']) {
    test(`${name} seeds the keys`, () => {
      const src = read(`selfhost/src/commands/${name}.mjs`);
      // Allow other named imports alongside it — doctor also pulls in
      // readKeyMaterial for `--show-keys`. What matters is that the seeding
      // helper is imported, not that it is imported alone.
      assert.match(src, /import \{[^}]*\bensureEncryptionKeys\b[^}]*\} from '\.\.\/zke\.mjs'/,
        `${name} does not import the seeding helper`);
      assert.match(src, /await ensureEncryptionKeys\(\{/, `${name} imports it but never calls it`);
      // Called with the install's own credentials, against its own database.
      assert.match(src, /cf\.queryD1\(\s*\n?\s*state\.cloudflareToken, state\.cloudflareAccountId, state\.databaseId, sql, params\)/,
        `${name} does not pass its own database to the seeding helper`);
    });
  }

  test('update and doctor exist so an already-broken install can be repaired', () => {
    // The worker's own error message names `daemonclient doctor` as the fix
    // (immich-api-shim/src/assets.ts). If doctor stops seeding, that message
    // sends people somewhere that does not help them.
    assert.match(read('immich-api-shim/src/assets.ts'), /daemonclient doctor/);
  });
});
