// BUILD_ORDER P9 — provisioning the Firebase project.
//
// Today `setup` stops and tells the user to open console.firebase.google.com
// and do FIVE things by hand — create a project, turn Analytics off, enable
// Email/Password, add a user, register a web app — then paste back a project
// id and an API key. The locked decision calls that not acceptable, and it is
// the single reason the release is still unpublished. This module removes four
// of those five steps.
//
// EVERY SHAPE AND ERROR STRING BELOW WAS TAKEN FROM THE REAL CLI, not from the
// docs and not from memory — firebase-tools 14.11.2, run against a real
// project. That matters because two of them are not what you would guess:
//
//   * `--json` is what makes any of this automatable: it "outputs JSON instead
//     of text, ALSO TRIGGERS NON-INTERACTIVE MODE". Without it these commands
//     sit waiting on a prompt that no installer will ever answer.
//   * stdout is clean JSON, but stderr carries a node punycode deprecation
//     warning and the spinner frames. Merge them — `2>&1` — and every parse
//     here fails. That is why the runner is stdout-only.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  isLegalProjectId, suggestProjectId, unwrap, pickWebApp, readSdkConfig,
  explainFirebaseError, cliErrorText, ensureProject, ensureWebApp, firebaseConfig,
} from '../src/api/firebase.mjs';

describe('project ids', () => {
  test('accepts the shapes Google accepts', () => {
    for (const id of ['daemonclient-4f21', 'abcdef', 'a1b2c3d4e5', 'my-cloud-2026']) {
      assert.equal(isLegalProjectId(id), true, `${id} should be legal`);
    }
  });

  test('rejects what Google rejects, before the API round-trip does', () => {
    // Failing here costs nothing. Failing at the API costs a round trip and
    // surfaces as a shouty 400 the user has to interpret.
    for (const [id, why] of [
      ['abc', 'under 6 characters'],
      ['a'.repeat(31), 'over 30 characters'],
      ['1abcdef', 'must start with a letter'],
      ['-abcdef', 'must start with a letter'],
      ['abcdef-', 'must not end with a hyphen'],
      ['ABCDEF', 'no uppercase'],
      ['abc_def', 'no underscores'],
      ['abc def', 'no spaces'],
      ['', 'empty'],
    ]) {
      assert.equal(isLegalProjectId(id), false, `${JSON.stringify(id)} — ${why}`);
    }
  });

  test('suggests an id that is legal and not the same twice', () => {
    // Project ids are unique across ALL of Google Cloud, not just this
    // account — "daemonclient" was taken years ago by someone else. A random
    // suffix is the difference between setup continuing and setup stopping.
    const a = suggestProjectId();
    const b = suggestProjectId();
    assert.equal(isLegalProjectId(a), true, `${a} must be legal`);
    assert.notEqual(a, b, 'two runs must not collide with each other');
  });

  test('a suggestion never leaks who the user is', () => {
    // The same mistake P8 shipped: it derived a PUBLIC name from the account,
    // and a Cloudflare account defaults to "<email>'s Account" — which put a
    // user's email into public DNS and Certificate Transparency logs. A
    // Firebase project id is just as public (it is the authDomain host).
    for (let i = 0; i < 40; i++) {
      const id = suggestProjectId('contact@boboxon.uz');
      assert.ok(!id.includes('boboxon'), `${id} leaked the account`);
      assert.ok(!id.includes('contact'), `${id} leaked the account`);
    }
  });
});

describe('reading what the CLI actually returns', () => {
  test('unwraps the {status, result} envelope', () => {
    assert.deepEqual(unwrap('{"status":"success","result":[1,2]}'), [1, 2]);
  });

  test('an error envelope throws the CLI’s own message, not a parse error', () => {
    const raw = '{"status":"error","error":"Project x has multiple apps, must specify an app id."}';
    assert.throws(() => unwrap(raw), /multiple apps/);
  });

  test('non-JSON throws something a human can act on', () => {
    // What arrives when stderr got merged in, or the CLI died early.
    assert.throws(() => unwrap('- Preparing the list of your Firebase projects'), /did not return JSON/i);
  });

  test('reads the web config out of an apps:sdkconfig payload', () => {
    // Real shape: result.sdkConfig, NOT result. Getting this wrong yields
    // undefined for every field and a dashboard that cannot sign anyone in.
    const payload = {
      fileName: 'firebase-config.js',
      fileContents: '…',
      sdkConfig: {
        projectId: 'my-cloud-4f21', appId: '1:123:web:abc', apiKey: 'AIzaFake',
        authDomain: 'my-cloud-4f21.firebaseapp.com', storageBucket: 'x',
        messagingSenderId: '123', measurementId: 'G-X', projectNumber: '123', version: '1',
      },
    };
    assert.deepEqual(readSdkConfig(payload), {
      projectId: 'my-cloud-4f21',
      appId: '1:123:web:abc',
      apiKey: 'AIzaFake',
      authDomain: 'my-cloud-4f21.firebaseapp.com',
    });
  });

  test('refuses a config missing the two fields sign-in actually needs', () => {
    // A half-read config is worse than none: setup would carry on and the
    // failure would surface as "Not authenticated" on the user's first login.
    assert.throws(() => readSdkConfig({ sdkConfig: { projectId: 'x', appId: 'y' } }), /apiKey/);
    assert.throws(() => readSdkConfig({ sdkConfig: { apiKey: 'k', authDomain: 'd' } }), /projectId/);
  });
});

describe('picking the web app on a resumed run', () => {
  // THE TRAP, reproduced against a real project: `apps:sdkconfig WEB` with no
  // app id errors out — "Project <id> has multiple apps, must specify an app
  // id" — the moment a project has more than one web app. Under --json it
  // cannot prompt, so it just fails. A resumed setup MUST find the app it
  // made last time rather than making another one and then tripping over it.

  const apps = [
    { appId: '1:1:web:aaa', displayName: 'Something else', platform: 'WEB' },
    { appId: '1:1:web:bbb', displayName: 'DaemonClient', platform: 'WEB' },
  ];

  test('finds the app this installer created, by name', () => {
    assert.equal(pickWebApp(apps, 'DaemonClient')?.appId, '1:1:web:bbb');
  });

  test('returns null when there is nothing of ours yet', () => {
    assert.equal(pickWebApp([{ appId: '1:1:web:aaa', displayName: 'Other', platform: 'WEB' }], 'DaemonClient'), null);
    assert.equal(pickWebApp([], 'DaemonClient'), null);
  });

  test('never returns an app from another platform', () => {
    const mixed = [{ appId: '1:1:android:zzz', displayName: 'DaemonClient', platform: 'ANDROID' }];
    assert.equal(pickWebApp(mixed, 'DaemonClient'), null);
  });
});

describe('finding the real reason a CLI call failed', () => {
  // Every string below is copied verbatim off a genuine failure —
  // `apps:sdkconfig WEB` with no app id, firebase-tools 14.11.2, real project.
  // Not paraphrased, because the whole point is that the real shapes are not
  // the ones you would invent.
  const realFailure = {
    message: 'Command failed: firebase apps:sdkconfig WEB --project daemonclient-c0625 --json\n(node:49148) ...',
    stdout: '{\n  "status": "error",\n  "error": "Project daemonclient-c0625 has multiple apps, must specify an app id."\n}',
    stderr: '(node:49148) [DEP0040] DeprecationWarning: The `punycode` module is deprecated. Please use a userland alternative instead.\n(Use `node --trace-deprecation ...` to show where the warning was created)',
  };

  test('reads the message out of the JSON envelope on stdout', () => {
    assert.equal(cliErrorText(realFailure), 'Project daemonclient-c0625 has multiple apps, must specify an app id.');
  });

  test('never returns the punycode warning', () => {
    // THE BUG THIS PINS. `e.stderr || e.stdout || e.message` reads perfectly
    // naturally and is exactly wrong: stderr holds a node deprecation warning
    // that has nothing to do with anything, stdout holds the actual reason. A
    // user whose deploy just failed would have been shown the warning.
    const got = cliErrorText(realFailure);
    assert.ok(!/punycode|DeprecationWarning/i.test(got), `showed the user node's chatter instead of the reason: ${got}`);
  });

  test('falls back to stderr when there is no envelope, minus the chatter', () => {
    const got = cliErrorText({
      stdout: '',
      stderr: '(node:1) [DEP0040] DeprecationWarning: punycode\nError: Failed to authenticate, have you run firebase login?',
      message: 'Command failed',
    });
    assert.match(got, /have you run firebase login/);
    assert.ok(!/DeprecationWarning/.test(got));
  });

  test('falls back to the message when there is nothing else', () => {
    assert.match(cliErrorText({ message: 'spawn npx ENOENT' }), /ENOENT/);
  });

  test('non-JSON stdout is still better than nothing', () => {
    assert.match(cliErrorText({ stdout: 'something went sideways', stderr: '', message: 'Command failed' }),
      /sideways/);
  });
});

describe('errors the user can act on', () => {
  test('project quota', () => {
    const msg = explainFirebaseError('Error: Your project quota has been exceeded. Please request an increase.');
    assert.match(msg, /quota/i);
    assert.match(msg, /console\.cloud\.google\.com|delete|request/i, 'says what to do next');
  });

  test('the id is already taken — the common case, since ids are global', () => {
    const msg = explainFirebaseError('Error: Failed to create project. Project ID already exists.');
    assert.match(msg, /already (taken|exists)/i);
    assert.match(msg, /another|different|again/i, 'tells them a different id will work');
  });

  test('an API not enabled yet', () => {
    const msg = explainFirebaseError(
      'Error: cloudresourcemanager.googleapis.com has not been used in project 123 before or it is disabled');
    assert.match(msg, /enable|console/i);
  });

  test('not signed in', () => {
    const msg = explainFirebaseError('Error: Failed to authenticate, have you run firebase login?');
    assert.match(msg, /sign in|login/i);
  });

  test('anything unrecognised comes back as itself, not swallowed', () => {
    // The failure mode this avoids: a wrapper that maps everything it does not
    // know to "something went wrong", which is how a fixable error becomes an
    // unfixable one.
    const weird = 'Error: EPERM operation not permitted, mkdir';
    assert.match(explainFirebaseError(weird), /EPERM/);
  });
});

/** A fake `firebase` CLI: records calls, replays canned stdout. */
function fakeCli(responses) {
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    const key = args.filter((a) => !a.startsWith('--')).slice(0, 2).join(' ');
    const reply = responses[key] ?? responses[args[0]];
    if (typeof reply === 'function') return reply(args);
    if (reply === undefined) throw new Error(`fake CLI got an unexpected command: ${args.join(' ')}`);
    if (reply instanceof Error) throw reply;
    return reply;
  };
  return { run, calls };
}

describe('ensureProject', () => {
  test('creates the project and returns its id', async () => {
    const { run, calls } = fakeCli({
      'projects:create': '{"status":"success","result":{"projectId":"my-cloud-4f21"}}',
    });
    const id = await ensureProject(run, { projectId: 'my-cloud-4f21', displayName: 'My Cloud' });
    assert.equal(id, 'my-cloud-4f21');
    assert.ok(calls[0].includes('--json'), '--json is what makes it non-interactive');
    assert.ok(calls[0].includes('my-cloud-4f21'));
  });

  test('refuses an illegal id before spending a round trip on it', async () => {
    const { run, calls } = fakeCli({});
    await assert.rejects(() => ensureProject(run, { projectId: 'BAD_ID', displayName: 'x' }), /project id/i);
    assert.equal(calls.length, 0, 'nothing should have been sent');
  });

  test('a taken id surfaces as advice, not as a raw CLI error', async () => {
    const { run } = fakeCli({
      'projects:create': new Error('Error: Failed to create project because Project ID already exists.'),
    });
    await assert.rejects(
      () => ensureProject(run, { projectId: 'taken-abcdef', displayName: 'x' }),
      /already (taken|exists)/i,
    );
  });
});

describe('ensureWebApp', () => {
  const sdk = (appId) => JSON.stringify({
    status: 'success',
    result: { sdkConfig: { projectId: 'p-abcdef', appId, apiKey: 'AIzaFake', authDomain: 'p-abcdef.firebaseapp.com' } },
  });

  test('reuses the app from a previous run instead of making a second one', async () => {
    // Without this a resumed setup accumulates web apps and then cannot read a
    // config at all, because sdkconfig refuses to guess between them.
    const { run, calls } = fakeCli({
      'apps:list WEB': '{"status":"success","result":[{"appId":"1:1:web:old","displayName":"DaemonClient","platform":"WEB"}]}',
      'apps:sdkconfig WEB': sdk('1:1:web:old'),
    });
    const cfg = await ensureWebApp(run, { projectId: 'p-abcdef', displayName: 'DaemonClient' });
    assert.equal(cfg.appId, '1:1:web:old');
    assert.ok(!calls.some((c) => c[0] === 'apps:create'), 'must not create a duplicate app');
  });

  test('creates one when the project has none', async () => {
    const { run, calls } = fakeCli({
      'apps:list WEB': '{"status":"success","result":[]}',
      'apps:create WEB': '{"status":"success","result":{"appId":"1:1:web:new"}}',
      'apps:sdkconfig WEB': sdk('1:1:web:new'),
    });
    const cfg = await ensureWebApp(run, { projectId: 'p-abcdef', displayName: 'DaemonClient' });
    assert.equal(cfg.appId, '1:1:web:new');
    assert.ok(calls.some((c) => c[0] === 'apps:create'));
  });

  test('always passes the app id to sdkconfig', async () => {
    // The reproduced trap: omit it and the CLI errors as soon as the project
    // has more than one web app, which is exactly what a re-run produces.
    const { run, calls } = fakeCli({
      'apps:list WEB': '{"status":"success","result":[{"appId":"1:1:web:old","displayName":"DaemonClient","platform":"WEB"}]}',
      'apps:sdkconfig WEB': sdk('1:1:web:old'),
    });
    await ensureWebApp(run, { projectId: 'p-abcdef', displayName: 'DaemonClient' });
    const sdkCall = calls.find((c) => c[0] === 'apps:sdkconfig');
    assert.ok(sdkCall.includes('1:1:web:old'), `sdkconfig was called without an app id: ${sdkCall.join(' ')}`);
  });
});

describe('firebaseConfig — the console step that stays manual', () => {
  test('points at the exact page, for the exact project', () => {
    // Enabling the Email/Password provider has no CLI command and no
    // documented Admin API. The user flips one switch; the least we can do is
    // not make them find the page.
    const url = firebaseConfig.providersUrl('my-cloud-4f21');
    assert.match(url, /console\.firebase\.google\.com/);
    assert.match(url, /my-cloud-4f21/);
    assert.match(url, /authentication/);
  });
});

describe('one definition of where the CLI is', () => {
  test('nothing outside api/firebase.mjs defines its own firebaseCli', () => {
    // web.mjs used to carry a private copy. Two copies means two things to fix
    // when the resolution changes, and this project has repeatedly fixed the
    // copy that never runs — dead code that mentions a symbol is how a grep
    // starts lying to you.
    const src = path.join(import.meta.dirname, '..', 'src');
    const offenders = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith('.mjs')) continue;
        if (full === path.join(src, 'api', 'firebase.mjs')) continue;
        if (/(async\s+)?function\s+firebaseCli\b/.test(fs.readFileSync(full, 'utf8'))) {
          offenders.push(path.relative(src, full));
        }
      }
    };
    walk(src);
    assert.deepEqual(offenders, [], 'these should import firebaseCli from api/firebase.mjs');
  });
});
