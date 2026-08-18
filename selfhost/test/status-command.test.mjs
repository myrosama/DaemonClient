// `daemonclient status` — it must always finish.
//
// THE BUG THIS PINS, WHICH WAS REAL AND SHIPPED.
//
// The old implementation opened a spinner and then returned past it:
//
//     const s4 = spinner('Checking for updates');
//     try {
//       if (!state.workerUrl) return null;      // s4 never stopped
//
// On a real terminal that spinner is a `setInterval` plus a `\x1b[?25l` that
// hides the cursor. Returning past its `stop()` therefore left the interval
// running — so `daemonclient status` NEVER EXITED, and left the user's
// terminal with no cursor. Reproduced under a pty before the fix (`timeout`
// killed it at 25s) and confirmed to exit 0 after.
//
// The state that triggers it is not exotic: `steps.deploy.done` set with no
// `workerUrl` recorded, which is exactly what the resume path used to produce
// — the same defect that once printed a literal `null` under "Your cloud is
// live".
//
// WHY A UNIT TEST COULD NOT HAVE FOUND IT, AND WHAT THAT MEANS FOR THESE TESTS.
//
// `ui.mjs`'s spinner short-circuits to a no-op object when `stdout.isTTY` is
// false. `node --test` is never a TTY. So the hang did not merely go unnoticed
// by the suite — it was UNREACHABLE from it, and adding tests in the same style
// would have kept it that way. It took running the command under a pty.
//
// So this file guards it twice, and neither guard is a source-text match:
//
//   * every test below asserts the command RETURNS, and that the missing
//     address is named rather than reported as a generic outage — the symptom
//     a user would have hit;
//   * the last one runs the real binary under a real pty with a timeout, which
//     is the only thing that reproduces the hang itself. It skips where
//     `script(1)` is unavailable rather than pretending to have run.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runStatus } from '../src/commands/status.mjs';

const realFetch = globalThis.fetch;
const realWrite = process.stdout.write;
let cwd;
let dir;

/** Write a state file into a throwaway directory and run there. */
function givenState(state) {
  fs.writeFileSync(
    path.join(dir, '.daemonclient-selfhost.json'),
    JSON.stringify({ version: 1, steps: {}, ...state }),
    { mode: 0o600 },
  );
}

/** Capture everything the command prints. */
function capture() {
  let seen = '';
  process.stdout.write = (chunk, ...rest) => {
    seen += typeof chunk === 'string' ? chunk : String(chunk);
    if (typeof rest[rest.length - 1] === 'function') rest[rest.length - 1]();
    return true;
  };
  return () => seen;
}

beforeEach(() => {
  cwd = process.cwd();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-status-'));
  process.chdir(dir);
});

afterEach(() => {
  process.chdir(cwd);
  globalThis.fetch = realFetch;
  process.stdout.write = realWrite;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('it terminates, whatever shape the install is in', () => {
  test('a deployed install with no recorded address', { timeout: 15000 }, async () => {
    // The exact state that hung. If this test times out, the bug is back.
    givenState({
      steps: { deploy: { done: true } },
      telegramBotToken: '123:fake',
    });
    globalThis.fetch = async () => { throw new Error('network is down'); };

    const before = process.listenerCount('SIGINT');
    const seen = capture();
    await runStatus();
    process.stdout.write = realWrite;

    // Off a TTY no spinner interval is created at all, so this asserts only
    // that nothing else leaked a handler. The pty test at the bottom is what
    // covers the hang.
    assert.equal(process.listenerCount('SIGINT'), before, 'no interrupt handler leaked');
    assert.match(seen(), /no address recorded/,
      'and it says what is actually wrong rather than reporting the API as merely down');
  });

  test('a fresh machine with no state file at all', { timeout: 15000 }, async () => {
    const seen = capture();
    await runStatus();
    process.stdout.write = realWrite;
    assert.match(seen(), /Not set up yet/);
    assert.match(seen(), /daemonclient setup/, 'and points at the command that fixes it');
  });

  test('every single check failing', { timeout: 20000 }, async () => {
    givenState({
      steps: { deploy: { done: true } },
      workerUrl: 'https://dc-test.workers.dev',
      telegramBotToken: '123:fake',
      processorUrl: 'https://processor.example',
    });
    globalThis.fetch = async () => { throw new Error('network is down'); };

    const before = process.listenerCount('SIGINT');
    const seen = capture();
    await runStatus();
    process.stdout.write = realWrite;

    assert.equal(process.listenerCount('SIGINT'), before, 'no interrupt handler leaked');
    assert.match(seen(), /Telegram bot/);
    assert.match(seen(), /Processor/);
  });

  test('a healthy install', { timeout: 20000 }, async () => {
    givenState({
      steps: { deploy: { done: true } },
      workerUrl: 'https://dc-test.workers.dev',
      telegramBotToken: '123:fake',
      telegramChannelId: '-100123',
      telegramChannelTitle: 'Backups',
    });
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('/api/health')) return Response.json({ database: 'connected' });
      if (u.includes('/api/selfhost/status')) {
        return Response.json({ update: { updateAvailable: false, currentVersion: '2.1.0', latestVersion: '2.1.0' } });
      }
      if (u.includes('api.telegram.org')) return Response.json({ ok: true, result: { username: 'my_bot' } });
      throw new Error(`unexpected request to ${u}`);
    };

    const before = process.listenerCount('SIGINT');
    const seen = capture();
    await runStatus();
    process.stdout.write = realWrite;

    assert.equal(process.listenerCount('SIGINT'), before);
    assert.match(seen(), /@my_bot/);
    assert.match(seen(), /connected/);
    assert.match(seen(), /Up to date/);
  });

  test('an update being available is reported with both versions', { timeout: 20000 }, async () => {
    givenState({
      steps: { deploy: { done: true } },
      workerUrl: 'https://dc-test.workers.dev',
      telegramBotToken: '123:fake',
    });
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('/api/health')) return Response.json({ database: 'connected' });
      if (u.includes('/api/selfhost/status')) {
        return Response.json({
          update: {
            updateAvailable: true, currentVersion: '2.1.0', latestVersion: '2.2.0',
            releaseUrl: 'https://github.com/myrosama/DaemonClient/releases/tag/v2.2.0',
          },
        });
      }
      return Response.json({ ok: true, result: { username: 'my_bot' } });
    };

    const seen = capture();
    await runStatus();
    process.stdout.write = realWrite;

    assert.match(seen(), /2\.1\.0/, 'says what you are running');
    assert.match(seen(), /2\.2\.0/, 'and what is out');
    assert.match(seen(), /daemonclient update/, 'and how to get it');
  });

  test('a 401 from the update check asks for a sign-in rather than reporting a failure', { timeout: 20000 }, async () => {
    // The update endpoint is owner-gated. A signed-out user seeing "update
    // check failed" would go looking for a broken install.
    givenState({
      steps: { deploy: { done: true } },
      workerUrl: 'https://dc-test.workers.dev',
      telegramBotToken: '123:fake',
    });
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('/api/health')) return Response.json({ database: 'connected' });
      if (u.includes('/api/selfhost/status')) return new Response('', { status: 401 });
      return Response.json({ ok: true, result: { username: 'my_bot' } });
    };

    const seen = capture();
    await runStatus();
    process.stdout.write = realWrite;
    assert.match(seen(), /Sign in on the dashboard/);
  });
});

describe('under a real terminal', () => {
  // The only place the hang is reachable. `ui.mjs`'s spinner is a no-op off a
  // TTY, so this is not belt-and-braces over the tests above — it is the only
  // one of them that can fail for the original reason.
  //
  // Reproduced by hand before the fix:
  //   $ timeout 25 script -qec "node bin/daemonclient.mjs status" /dev/null
  //   exit=124        (the command never returned)
  // and after:
  //   exit=0

  const HAS_PTY = (() => {
    try {
      execFileSync('script', ['-qec', 'true', '/dev/null'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();

  test('`daemonclient status` exits on a deployed install with no address',
    { skip: HAS_PTY ? false : 'script(1) with util-linux flags is not available here', timeout: 60000 },
    () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-pty-'));
      fs.writeFileSync(
        path.join(home, '.daemonclient-selfhost.json'),
        JSON.stringify({ version: 1, steps: { deploy: { done: true } }, telegramBotToken: '123:fake' }),
        { mode: 0o600 },
      );
      const bin = path.join(import.meta.dirname, '..', 'bin', 'daemonclient.mjs');

      // `timeout` returns 124 when it has to kill the command. That is the
      // failure this asserts against, and it is why the assertion is on the
      // exit status rather than on the output.
      let status = 0;
      try {
        execFileSync('timeout', ['25', 'script', '-qec', `node ${bin} status`, '/dev/null'], {
          cwd: home, stdio: 'ignore',
        });
      } catch (e) {
        status = e.status ?? -1;
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }

      assert.notEqual(status, 124, '`daemonclient status` hung — a spinner was left running on a real terminal');
    });
});
