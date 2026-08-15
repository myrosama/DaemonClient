// BUILD_ORDER P8 — a fresh Cloudflare account has no workers.dev subdomain.
//
// The bug this exists to prevent: `registerSubdomain` was written, complete and
// correct, and called from nowhere. `setup.mjs` only ever *read* the subdomain
// (`getSubdomain(...).catch(() => null)`), so on an account that had never had
// one, `state.workersSubdomain` stayed null, `workerUrl` stayed null, the health
// check was skipped, and setup finished with a cheerful summary reading
//
//     Your API
//       (no workers.dev subdomain — check the Cloudflare dashboard)
//
// A brand-new Cloudflare account is the *expected* state for a self-hoster, so
// the one configuration we most need to work was the one that silently didn't.
// `enableWorkersDev` produced the same blank-URL ending by a second route: its
// failure was swallowed with `.catch(() => {})`.
//
// These tests assert behaviour against a fake Cloudflare, not source text — a
// text assertion cannot survive a rename, which a Gate 3 review demonstrated on
// P11 by reintroducing two bugs under different names against a green suite.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { ensureSubdomain, suggestSubdomain } from '../src/subdomain.mjs';

/** A fake Cloudflare that records what was asked of it. */
function fakeCf({ existing = null, taken = [], failRegister = null } = {}) {
  const calls = [];
  return {
    calls,
    current: existing,
    async getSubdomain() { calls.push(['get']); return this.current; },
    async registerSubdomain(_auth, _acct, name) {
      calls.push(['register', name]);
      if (failRegister) throw failRegister;
      if (taken.includes(name)) { const e = new Error('already exists'); e.code = 10035; throw e; }
      this.current = name;
      return { subdomain: name };
    },
  };
}

describe('a fresh account gets a subdomain instead of a blank URL', () => {
  test('registers one when the account has never had one', async () => {
    const cf = fakeCf({ existing: null });
    const sub = await ensureSubdomain(cf, 'tok', 'acct', { desired: 'daemonclient-a1b2c3' });

    assert.equal(sub, 'daemonclient-a1b2c3');
    assert.deepEqual(cf.calls, [['get'], ['register', 'daemonclient-a1b2c3']]);
  });

  test('keeps the existing one rather than clobbering it', async () => {
    // Registering over a subdomain the operator already uses would move every
    // other worker on their account. Read before write, always.
    const cf = fakeCf({ existing: 'their-existing-name' });
    const sub = await ensureSubdomain(cf, 'tok', 'acct', { desired: 'daemonclient-a1b2c3' });

    assert.equal(sub, 'their-existing-name');
    assert.deepEqual(cf.calls, [['get']], 'no register call at all');
  });

  test('tries another name when the first is taken globally', async () => {
    // workers.dev subdomains are a global namespace, so a plausible name can be
    // gone. One rejection must not end the install.
    const cf = fakeCf({ existing: null, taken: ['daemonclient-aaa'] });
    const sub = await ensureSubdomain(cf, 'tok', 'acct', {
      desired: 'daemonclient-aaa',
      candidates: ['daemonclient-bbb', 'daemonclient-ccc'],
    });

    assert.equal(sub, 'daemonclient-bbb');
    assert.equal(cf.calls.filter(([k]) => k === 'register').length, 2);
  });

  test('THROWS rather than returning null when it cannot get one', async () => {
    // The whole point. Returning null here is what produced a "successful"
    // install with no address — the failure mode this part exists to remove.
    const cf = fakeCf({ existing: null, taken: ['a', 'b', 'c'] });
    await assert.rejects(
      () => ensureSubdomain(cf, 'tok', 'acct', { desired: 'a', candidates: ['b', 'c'] }),
      (e) => {
        assert.match(e.message, /subdomain/i);
        assert.doesNotMatch(e.message, /undefined|null|\[object/, 'message is for a human');
        return true;
      },
    );
  });

  test('surfaces a permissions failure instead of swallowing it', async () => {
    const denied = new Error('Authentication error');
    denied.code = 10000;
    const cf = fakeCf({ existing: null, failRegister: denied });

    await assert.rejects(() => ensureSubdomain(cf, 'tok', 'acct', { desired: 'x' }),
      (e) => { assert.match(e.message, /Authentication error|permission/i); return true; });
  });
});

describe('suggested names are legal workers.dev subdomains', () => {
  test('lowercase, alphanumeric and dashes only', () => {
    for (const raw of ['My Account Name', 'user@example.com', 'Ünïcødé Ltd.', '  spaced  ']) {
      const s = suggestSubdomain(raw);
      assert.match(s, /^[a-z0-9][a-z0-9-]{1,54}$/, `${JSON.stringify(raw)} -> ${JSON.stringify(s)}`);
      assert.ok(!s.endsWith('-'), 'no trailing dash');
    }
  });

  test('always returns something usable, even from junk', () => {
    // Zero-state: an account name of '' or symbols must still yield a valid
    // candidate rather than an empty string the API would reject.
    for (const raw of ['', '   ', '...', '???', null, undefined]) {
      const s = suggestSubdomain(raw);
      assert.match(s, /^[a-z0-9][a-z0-9-]{1,54}$/, `${JSON.stringify(raw)} -> ${JSON.stringify(s)}`);
    }
  });

  test('two calls do not collide', () => {
    const a = suggestSubdomain('same name');
    const b = suggestSubdomain('same name');
    assert.notEqual(a, b, 'a random suffix keeps retries from repeating a taken name');
  });
});

describe('setup actually uses it', () => {
  // A weaker guard than the behavioural tests above, and deliberately labelled
  // as such: it matches source text, which a rename defeats. It is here only
  // because `stepCloudflare` is an interactive wizard step that cannot be
  // invoked from a test without faking a terminal.
  //
  // What it does catch is the specific regression that produced this part:
  // ensureSubdomain existing and being called from nowhere, which is exactly
  // what happened to registerSubdomain for months. The real assurance lives in
  // the ensureSubdomain tests; this one guards the wiring.
  const setup = fs.readFileSync(
    path.join(import.meta.dirname, '..', 'src', 'commands', 'setup.mjs'), 'utf8');

  test('calls ensureSubdomain rather than reading and giving up', () => {
    assert.match(setup, /ensureSubdomain\(/, 'setup calls it');
    assert.ok(
      !/getSubdomain\([^)]*\)\.catch\(\s*\(\)\s*=>\s*null\s*\)/.test(setup),
      'the read-and-fall-back-to-null pattern is gone — that is what produced a blank address',
    );
  });

  test('does not swallow the enableWorkersDev failure', () => {
    assert.ok(
      !/enableWorkersDev\([^;]*\)\s*\.catch\(\s*\(\)\s*=>\s*\{\s*\}\s*\)/.test(setup),
      'a swallowed failure here yields a worker that exists and answers nothing',
    );
  });

  test('the summary no longer has a "no subdomain" branch to print', () => {
    // Setup now exits before reaching the summary if it has no address, so a
    // fallback there would be unreachable — and would keep implying the install
    // is usable without one.
    //
    // Matches the FALLBACK, not the phrase: the first version of this assertion
    // searched for "no workers.dev subdomain" anywhere and tripped on the
    // explanatory comment above stepCloudflare, reporting a bug that was
    // already fixed. A guard that fires on prose is a guard nobody trusts.
    assert.ok(
      !/state\.workerUrl\s*\|\|/.test(setup),
      'the summary must print the address, not fall back to an apology',
    );
  });
});
