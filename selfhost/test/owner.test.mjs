// The P0 bootstrap bug: a fresh self-hosted install cannot be signed into.
//
// `owner_uid` is a row in the install's own D1 `config` table
// (`immich-api-shim/src/owner-gate.ts`). Nothing ever wrote it — the string
// appears once in the whole repository, as a key constant. An unclaimed install
// can only be claimed by a credential carrying `mayClaim`, and `helpers.ts:119`
// passes **false** for Firebase ID tokens, deliberately: one Firebase project
// serves the entire managed fleet, so such a token verifies on every install
// and must never be able to seize an unowned one.
//
// The accounts dashboard presents nothing but Firebase ID tokens. So the
// documented happy path — `daemonclient web`, open the dashboard, sign in —
// returns "Not authenticated" on a brand-new install, forever. It works only if
// the user happens to open Photos first, which uses the worker's own password
// login.
//
// The fix is not to loosen the gate. It is for setup to claim the install
// explicitly at the point it already knows the uid, while it is demonstrably
// the person holding the Cloudflare token for that database.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { claimInstallOwner } from '../src/owner.mjs';

/** A fake D1 that records every statement and its bindings. */
function fakeDb(rows = {}) {
  const writes = [];
  return {
    writes,
    rows,
    async query(sql, params = []) {
      if (/^\s*SELECT/i.test(sql)) {
        const key = params[0];
        return { result: [{ results: this.rows[key] !== undefined ? [{ value: this.rows[key] }] : [] }] };
      }
      writes.push({ sql, params });
      // INSERT OR IGNORE: an existing key is left alone.
      const [key, value] = params;
      if (this.rows[key] === undefined) this.rows[key] = value;
      return { result: [{ results: [] }] };
    },
  };
}

describe('setup claims the install so its owner can sign in', () => {
  test('writes owner_uid when nobody owns the install yet', async () => {
    const db = fakeDb();
    const out = await claimInstallOwner({ query: (s, p) => db.query(s, p) }, 'firebase-uid-abc');

    assert.equal(out.claimed, true);
    assert.equal(db.rows.owner_uid, 'firebase-uid-abc');
    assert.equal(db.writes.length, 1);
    assert.match(db.writes[0].sql, /INSERT OR IGNORE/i,
      'OR IGNORE so a concurrent claim cannot overwrite the winner');
  });

  test('never overwrites an owner that already exists', async () => {
    // Overwriting would hand someone else's install to whoever ran setup last.
    const db = fakeDb({ owner_uid: 'the-real-owner' });
    const out = await claimInstallOwner({ query: (s, p) => db.query(s, p) }, 'someone-else');

    assert.equal(out.claimed, false);
    assert.equal(out.reason, 'already-owned');
    assert.equal(db.rows.owner_uid, 'the-real-owner');
    assert.equal(db.writes.length, 0, 'not even an ignored write');
  });

  test('re-running setup with the same uid is a no-op, not an error', async () => {
    const db = fakeDb({ owner_uid: 'me' });
    const out = await claimInstallOwner({ query: (s, p) => db.query(s, p) }, 'me');
    assert.equal(out.claimed, false);
    assert.equal(out.reason, 'already-owned');
  });

  test('refuses to write a missing or blank uid', async () => {
    // An empty owner_uid is worse than none: `readOwner` trims and treats ''
    // as null, so the install would look unclaimed while carrying a row —
    // and a blank value in a security-deciding column is never intentional.
    for (const bad of ['', '   ', null, undefined, 42, {}]) {
      const db = fakeDb();
      await assert.rejects(
        () => claimInstallOwner({ query: (s, p) => db.query(s, p) }, bad),
        (e) => { assert.match(e.message, /uid/i); return true; },
        `should reject ${JSON.stringify(bad)}`,
      );
      assert.equal(db.writes.length, 0);
    }
  });

  test('a failed read writes nothing — unknown is not "unowned"', async () => {
    // Same rule as zke.mjs: if the read did not clearly succeed, we do not know
    // the install is unowned, and guessing wrong hands it to the wrong person.
    const db = {
      writes: [],
      async query(sql) {
        if (/^\s*SELECT/i.test(sql)) throw new Error('D1 unavailable');
        this.writes.push(sql);
        return {};
      },
    };
    await assert.rejects(() => claimInstallOwner({ query: (s, p) => db.query(s, p) }, 'uid'));
    assert.equal(db.writes.length, 0, 'no write on an unknown read');
  });

  test('an unrecognised read shape is unknown, not empty', async () => {
    const db = { writes: [], async query() { return { unexpected: true }; } };
    await assert.rejects(() => claimInstallOwner({ query: (s, p) => db.query(s, p) }, 'uid'));
    assert.equal(db.writes.length, 0);
  });
});

describe('setup actually claims it', () => {
  // Weak by nature — a source-text match a rename defeats — but the bug being
  // guarded is precisely "the function exists and nothing calls it", which is
  // how owner_uid came to be written by nothing at all. The behavioural
  // coverage is above; this only guards the wiring.
  const setup = fs.readFileSync(
    path.join(import.meta.dirname, '..', 'src', 'commands', 'setup.mjs'), 'utf8');

  test('calls claimInstallOwner with the uid it just signed in as', () => {
    assert.match(setup, /claimInstallOwner\(/);
    assert.match(setup, /state\.adminUserId/,
      'claims for the account setup created, not some other id');
  });

  test('claims inside the deploy step, which runs before the summary', () => {
    // The first version of this compared source POSITIONS — and `stepFinish`
    // is referenced at the top of the file, inside runSetup, hundreds of lines
    // above the claim. Source order is not execution order, so it asserted
    // nothing true. What matters is which STEP the call lives in: runSetup
    // calls stepDeployWorker before stepFinish, so a claim inside the former
    // is guaranteed to precede the summary.
    const start = setup.indexOf('async function stepDeployWorker');
    const end = setup.indexOf('async function stepProcessor');
    assert.ok(start > 0 && end > start, 'located the deploy step');
    const body = setup.slice(start, end);
    assert.match(body, /claimInstallOwner\(/, 'the claim is inside stepDeployWorker');

    // And runSetup really does order those two the way this relies on.
    const run = setup.slice(setup.indexOf('export async function runSetup'), start);
    assert.ok(run.indexOf('stepDeployWorker(state)') < run.indexOf('stepFinish(state)'));
  });
});
