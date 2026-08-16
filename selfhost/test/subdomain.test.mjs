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

import { ensureSubdomain, suggestSubdomain, isLegalSubdomain, CF } from '../src/subdomain.mjs';

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
      if (taken.includes(name)) { const e = new Error('Subdomain is unavailable'); e.code = CF.TAKEN; throw e; }
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

  test('a plan/entitlement failure is fatal, not mistaken for a taken name', async () => {
    // The old code matched the message text /not available/, so
    // "This feature is not available on your plan" burned every candidate with
    // blind writes and then told the user to go pick a name in the dashboard —
    // advice that could not have helped them.
    const notEntitled = new Error('This feature is not available on your plan');
    notEntitled.code = 10015;
    const cf = fakeCf({ existing: null, failRegister: notEntitled });

    await assert.rejects(
      () => ensureSubdomain(cf, 'tok', 'acct', { desired: 'a', candidates: ['b', 'c'] }),
      (e) => { assert.match(e.message, /not available on your plan/); return true; },
    );
    assert.equal(cf.calls.filter(([k]) => k === 'register').length, 1, 'stops at the first, does not burn candidates');
  });

  test('a concurrency error retries the SAME name rather than re-rolling', async () => {
    // 10035 is "multiple attempts to modify a resource at the same time". The
    // first version of this module treated it as "taken" and discarded a
    // perfectly good candidate.
    let hits = 0;
    const cf = {
      calls: [],
      async getSubdomain() { return null; },
      async registerSubdomain(_a, _b, name) {
        this.calls.push(['register', name]);
        if (hits++ === 0) { const e = new Error('concurrent'); e.code = CF.CONCURRENT; throw e; }
        return { subdomain: name };
      },
    };
    const sub = await ensureSubdomain(cf, 'tok', 'acct', { desired: 'wanted', candidates: ['other'] });
    assert.equal(sub, 'wanted');
    assert.deepEqual(cf.calls, [['register', 'wanted'], ['register', 'wanted']]);
  });

  test('an empty-string subdomain is not treated as an existing one', async () => {
    const cf = fakeCf({ existing: '' });
    const sub = await ensureSubdomain(cf, 'tok', 'acct', { desired: 'fresh-name' });
    assert.equal(sub, 'fresh-name');
  });

  test('prefers the name the API reports over the one we asked for', async () => {
    const cf = {
      async getSubdomain() { return null; },
      async registerSubdomain() { return { subdomain: 'normalised-by-cloudflare' }; },
    };
    assert.equal(await ensureSubdomain(cf, 't', 'a', { desired: 'what-we-asked' }),
                 'normalised-by-cloudflare');
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
  test('matches the rule workers.dev actually enforces', () => {
    // Cloudflare's own rule, from wrangler: max 63, and it may not begin or end
    // with a dash. Written out here rather than importing LEGAL — the earlier
    // version of this test asserted the implementation's own regex, so it only
    // ever proved the function agreed with itself. It passed while that regex
    // permitted a trailing dash and capped at 55.
    const CLOUDFLARE_RULE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
    for (let i = 0; i < 40; i++) {
      const s = suggestSubdomain();
      assert.match(s, CLOUDFLARE_RULE, JSON.stringify(s));
      assert.ok(s.length <= 63);
      assert.ok(!s.endsWith('-') && !s.startsWith('-'));
    }
  });

  test('leaks nothing about the account', () => {
    // The previous version derived the label from the Cloudflare account name,
    // whose default on a personal signup is "<your email>'s Account" — putting
    // the user's email into a permanent public hostname and into Certificate
    // Transparency logs, on a privacy product, without asking.
    const s = suggestSubdomain("contact@boboxon.uz's Account");
    assert.doesNotMatch(s, /boboxon|contact|gmail|account/i,
      'a suggested name must not carry anything about the account');
    assert.match(s, /^daemonclient-[0-9a-f]{8}$/);
  });

  test('two calls do not collide', () => {
    assert.notEqual(suggestSubdomain(), suggestSubdomain());
  });

  test('isLegalSubdomain enforces the same rule for names a user types', () => {
    for (const ok of ['a', 'my-cloud', 'x9', 'a'.repeat(63)]) assert.ok(isLegalSubdomain(ok), ok);
    for (const bad of ['-lead', 'trail-', 'Upper', 'has_underscore', '', 'a'.repeat(64), null, 42]) {
      assert.ok(!isLegalSubdomain(bad), JSON.stringify(bad));
    }
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
