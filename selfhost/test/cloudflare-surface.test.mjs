import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import * as cf from '../src/api/cloudflare.mjs';

// `daemonclient setup` called cf.listAccounts, cf.getWorkersSubdomain,
// cf.deployWorker and cf.enableWorkersDev. NONE of them existed: the Cloudflare
// layer was rewritten in 63141e1 and the commands were never updated with it.
// The module still imported cleanly — a missing named export on a namespace
// import is only an error when you CALL it — so setup threw
// "cf.deployWorker is not a function" partway through provisioning a real
// account, after creating the database.
//
// No test drove the real command, so nothing caught it. This one does not need
// to: it just checks that every cf.* the commands reference actually exists.

describe('every Cloudflare call the commands make actually exists', () => {
  const commands = readdirSync(new URL('../src/commands/', import.meta.url))
    .filter((f) => f.endsWith('.mjs'));

  test('the command directory was found', () => {
    assert.ok(commands.length >= 3, `expected several commands, found ${commands.length}`);
  });

  for (const file of commands) {
    test(`${file} references nothing missing`, () => {
      const src = readFileSync(new URL(`../src/commands/${file}`, import.meta.url), 'utf8');
      const called = [...src.matchAll(/\bcf\.([A-Za-z0-9_]+)/g)].map((m) => m[1]);
      const missing = [...new Set(called)].filter((name) => cf[name] === undefined);
      assert.deepEqual(missing, [], `${file} calls cf.${missing.join(', cf.')} which do not exist`);
    });
  }
});

describe('deployWorker builds a real multipart upload', () => {
  test('it exists and takes the arguments the commands pass', () => {
    assert.equal(typeof cf.deployWorker, 'function');
    assert.equal(cf.deployWorker.length, 4); // 5th (bindings) has a default
  });

  test('it sends FormData, not a JSON-stringified object', async (t) => {
    // rest() used to stringify EVERY body and force application/json, which
    // would have uploaded the literal text "[object FormData]" and stripped the
    // multipart boundary. Adding the function without fixing that would have
    // produced a deploy that fails on a real account and passes any test that
    // only checks the function is defined.
    let seen;
    const original = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      seen = { url: String(url), init };
      return new Response(JSON.stringify({ success: true, result: {} }), {
        headers: { 'Content-Type': 'application/json' },
      });
    };
    t.after(() => { globalThis.fetch = original; });

    await cf.deployWorker('tok', 'acct', 'dc-test', 'export default {}', [
      { type: 'd1', name: 'DB', id: 'db-1' },
      { type: 'secret_text', name: 'SESSION_SECRET', text: 's'.repeat(43) },
    ]);

    assert.ok(seen.init.body instanceof FormData, 'body must be FormData');
    assert.equal(seen.init.method, 'PUT');
    assert.ok(!('Content-Type' in seen.init.headers), 'fetch must set the multipart boundary itself');
    assert.match(seen.url, /\/accounts\/acct\/workers\/scripts\/dc-test$/);

    const metadata = JSON.parse(await seen.init.body.get('metadata').text());
    assert.equal(metadata.main_module, 'worker.js');
    assert.deepEqual(metadata.bindings, [
      { type: 'd1', name: 'DB', id: 'db-1' },
      { type: 'secret_text', name: 'SESSION_SECRET', text: 's'.repeat(43) },
    ]);
  });

  test('a JSON call still sends JSON', async (t) => {
    let seen;
    const original = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      seen = init;
      return new Response(JSON.stringify({ success: true, result: {} }), {
        headers: { 'Content-Type': 'application/json' },
      });
    };
    t.after(() => { globalThis.fetch = original; });

    await cf.enableWorkersDev('tok', 'acct', 'dc-test');
    assert.equal(seen.headers['Content-Type'], 'application/json');
    assert.equal(seen.body, JSON.stringify({ enabled: true }));
  });
});
