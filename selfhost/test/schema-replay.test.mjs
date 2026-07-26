import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATION_SQL, splitStatements } from '../../schema/schema.mjs';

// Replaying the schema is a SUPPORTED operation, not an edge case:
// `daemonclient update` replays it on every run (update.mjs), and setup
// replays it when resuming an interrupted install. Both swallow errors matching
// /already exists|duplicate column/ and rethrow anything else.
//
// The config seed was a plain INSERT, so the second run raised
// "UNIQUE constraint failed: config.key" — which that pattern does NOT match.
// `daemonclient update` therefore aborted before building or deploying, on
// every install that had ever completed setup. Nothing caught it because no
// test ran the schema twice.

const SWALLOWED = /already exists|duplicate column/i;

function replay(db) {
  const rethrown = [];
  for (const stmt of splitStatements(MIGRATION_SQL)) {
    try { db.exec(stmt); } catch (e) {
      if (!SWALLOWED.test(e.message)) rethrown.push(e.message);
    }
  }
  return rethrown;
}

describe('the schema can be replayed, the way update and setup replay it', () => {
  test('a first run against an empty database succeeds outright', () => {
    const db = new DatabaseSync(':memory:');
    for (const stmt of splitStatements(MIGRATION_SQL)) db.exec(stmt);
    assert.ok(db.prepare('SELECT COUNT(*) c FROM config').get().c >= 4);
  });

  test('a second run raises nothing the callers do not already swallow', () => {
    const db = new DatabaseSync(':memory:');
    for (const stmt of splitStatements(MIGRATION_SQL)) db.exec(stmt);
    assert.deepEqual(replay(db), []);
  });

  test('and a third, because update runs every time', () => {
    const db = new DatabaseSync(':memory:');
    for (const stmt of splitStatements(MIGRATION_SQL)) db.exec(stmt);
    replay(db);
    assert.deepEqual(replay(db), []);
  });

  // The reason it is OR IGNORE and not OR REPLACE. The seeds are EMPTY
  // strings; replacing them would overwrite a live key with '' and make every
  // photo already in the user's channel permanently undecryptable.
  test('a replay does NOT overwrite live encryption keys', () => {
    const db = new DatabaseSync(':memory:');
    for (const stmt of splitStatements(MIGRATION_SQL)) db.exec(stmt);
    db.exec("UPDATE config SET value='live-password' WHERE key='zke_password'");
    db.exec("UPDATE config SET value='live-salt' WHERE key='zke_salt'");

    replay(db);

    assert.equal(db.prepare("SELECT value v FROM config WHERE key='zke_password'").get().v, 'live-password');
    assert.equal(db.prepare("SELECT value v FROM config WHERE key='zke_salt'").get().v, 'live-salt');
  });

  test('a replay does not overwrite any other config row either', () => {
    const db = new DatabaseSync(':memory:');
    for (const stmt of splitStatements(MIGRATION_SQL)) db.exec(stmt);
    db.exec("INSERT OR REPLACE INTO config (key,value) VALUES ('telegram','{\"botToken\":\"live\"}')");
    replay(db);
    assert.match(db.prepare("SELECT value v FROM config WHERE key='telegram'").get().v, /live/);
  });

  test('the seed statement is OR IGNORE, never OR REPLACE', () => {
    // OR REPLACE would pass every test above except the two key ones, and
    // would silently destroy libraries in production.
    assert.match(MIGRATION_SQL, /INSERT OR IGNORE INTO config/);
    assert.ok(!/INSERT OR REPLACE INTO config \(key, value\) VALUES \('zke_mode'/.test(MIGRATION_SQL));
  });
});
