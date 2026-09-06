// The CLI's front door, and two things it must never do:
// report success for an install that was abandoned, and hang.
//
// These spawn the real binary. Everything here was found by Gate 3 running
// commands rather than reading them, and none of it is reachable from an
// in-process test.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HERE = path.join(import.meta.dirname, '..');
const BIN = path.join(HERE, 'bin', 'daemonclient.mjs');

const HAS_PTY = (() => {
  try { execFileSync('script', ['-qec', 'true', '/dev/null'], { stdio: 'ignore' }); return true; }
  catch { return false; }
})();

describe('a cancelled run must not report success', () => {
  test('exiting 0 while a spinner is still running is corrected to 130', { timeout: 30000 }, () => {
    // WHY THIS IS NOT HYPOTHETICAL. A running clack spinner calls `block()`,
    // which puts stdin in RAW MODE — so the terminal never raises SIGINT, and
    // Ctrl-C arrives as a plain \x03 byte that @clack/core answers with
    // `process.exit(0)`. Our SIGINT handler never runs.
    //
    // `install.sh` ends with `exec node … setup`, so that exit status IS the
    // installer's. A user who gave up halfway would have handed `curl … | sh`
    // a 0, and anything scripting around it would have been told the cloud was
    // up. This asserts the reconciler that corrects it.
    const script = `
      import { spinner } from '${path.join(HERE, 'src', 'ui-kit.mjs')}';
      spinner('Deploying your worker');
      process.exit(0);          // what @clack/core does on Ctrl-C
    `;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    assert.equal(r.status, 130, 'an exit during a live spinner is an abort, not a success');
  });

  test('a normal finish still exits 0', { timeout: 30000 }, () => {
    // The reconciler must be narrow enough that finishing is unaffected —
    // otherwise every successful install reports failure, which is worse.
    const script = `
      import { spinner } from '${path.join(HERE, 'src', 'ui-kit.mjs')}';
      const s = spinner('Deploying your worker');
      s.succeed('Worker deployed');
      process.exit(0);
    `;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    assert.equal(r.status, 0, 'a stopped spinner must not turn a success into a 130');
  });

  test('a failed step that exits 1 keeps its own status', { timeout: 30000 }, () => {
    const script = `
      import { spinner } from '${path.join(HERE, 'src', 'ui-kit.mjs')}';
      const s = spinner('Deploying');
      s.fail('Cloudflare said 403');
      process.exit(1);
    `;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    assert.equal(r.status, 1, 'the reconciler only touches an exit of 0');
  });
});

describe('commands that ask questions refuse a terminal they cannot ask on', () => {
  // A clack prompt with no TTY does not fail — it prints its question, hides
  // the cursor, and WAITS. `node … setup < /dev/null`, a container without
  // `-t`, and the fallback command install.sh itself suggests all land here.
  // `interactiveProblem()` existed for this and was called from nowhere.

  for (const command of ['setup', 'update', 'doctor', 'processor']) {
    test(`\`daemonclient ${command}\` says so and exits`, { timeout: 30000 }, () => {
      const r = spawnSync(process.execPath, [BIN, command], {
        encoding: 'utf8', input: '', timeout: 20000,
      });
      assert.notEqual(r.signal, 'SIGTERM', `${command} hung instead of refusing`);
      assert.equal(r.status, 1);
      assert.match(r.stdout + r.stderr, /interactive terminal/i, 'and names what is missing');
    });
  }

  test('`daemonclient status`, which asks nothing, still runs', { timeout: 30000 }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-cli-'));
    const r = spawnSync(process.execPath, [BIN, 'status'], {
      encoding: 'utf8', input: '', cwd: dir, timeout: 20000,
    });
    fs.rmSync(dir, { recursive: true, force: true });
    assert.equal(r.status, 0, 'a read-only command must not be blocked by the guard');
    assert.match(r.stdout, /Not set up yet/);
  });
});

describe('output that goes somewhere unusual', () => {
  test('a reader that quits early does not produce a crash report', { timeout: 30000 }, async () => {
    // `daemonclient status | head`, or `| less` and pressing q. Node turns the
    // closed pipe into an unhandled 'error' event and the user gets an EPIPE
    // stack trace that looks like our bug.
    //
    // Destroying the child's stdout after its first chunk, rather than piping
    // through `head`, because `head` is a RACE: it has to exit before our next
    // write, and on a short command it often does not. The first version of
    // this test used `head -2` and passed with the handler deliberately
    // removed — it was asserting nothing. It also sent stderr INTO the pipe,
    // so the very crash report it was looking for was being swallowed.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-pipe-'));
    const child = spawn(process.execPath, [BIN, 'status'], {
      cwd: dir, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.stdout.once('data', () => child.stdout.destroy());

    const code = await new Promise((resolve) => child.on('close', resolve));
    fs.rmSync(dir, { recursive: true, force: true });

    assert.ok(!/EPIPE|Unhandled 'error' event/.test(err),
      `a closed pipe produced a crash report:\n${err}`);
    assert.equal(code, 0, 'and it is not treated as a failure');
  });

  test('a terminal that reports no width still renders readable panels', { timeout: 30000 }, () => {
    // `script -c`, `expect`, some CI runners and a detached tmux pane all
    // report columns === 0. clack's getColumns accepts any number, including
    // 0, and then wraps at width zero — one character per line, a few hundred
    // lines of it. The hand-rolled panel it replaced clamped with `|| 80`.
    const script = `
      process.stdout.columns = 0;
      const { note } = await import('${path.join(HERE, 'src', 'ui-kit.mjs')}');
      note(['API   https://dc-test.workers.dev', 'Database   connected'], 'Status');
    `;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    const lines = r.stdout.split('\n').length;
    assert.ok(lines < 20, `rendered ${lines} lines for a two-row panel — width 0 was not clamped`);
    assert.match(r.stdout, /https:\/\/dc-test\.workers\.dev/, 'and the content is on one line, not spelled out');
  });
});

describe('a signalled interrupt stops the work, not just the message', () => {
  test('taskList does not start the next step after a SIGINT', {
    skip: HAS_PTY ? false : 'needs a pty', timeout: 60000,
  }, () => {
    // A SIGNAL-delivered SIGINT takes a different path from a Ctrl-C keystroke:
    // clack's spinner handler prints "Canceled" and RETURNS without exiting.
    // Without a check the list carried on — so the wizard said "Canceled" and
    // then created the D1 database and deployed the worker anyway. Verified
    // against the unfixed kit: step two ran and taskList returned normally.
    //
    // The child is a FILE and the marker comes from the environment. The first
    // version interpolated the path into a template literal, JSON-stringified
    // that, and handed it to `script -qec` — two layers of shell quoting, and
    // the write landed somewhere else, inside a task whose throw the test
    // swallowed. It passed with the fix removed.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-sigint-'));
    const marker = path.join(dir, 'deploy-ran');
    const childFile = path.join(dir, 'child.mjs');

    fs.writeFileSync(childFile, `
      import { taskList } from ${JSON.stringify(path.join(HERE, 'src', 'ui-kit.mjs'))};
      import fs from 'node:fs';
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      try {
        await taskList([
          { title: 'Creating the database', task: async () => {
              process.kill(process.pid, 'SIGINT');
              await sleep(800);
              return 'Database created';
            } },
          { title: 'Deploying the worker', task: async () => {
              fs.writeFileSync(process.env.DC_MARKER, 'the deploy ran after the cancel');
              return 'Worker deployed';
            } },
        ]);
      } catch {}
      await sleep(200);
    `);

    spawnSync('script', ['-qec', `${process.execPath} ${childFile}`, '/dev/null'], {
      encoding: 'utf8', timeout: 40000, stdio: 'ignore',
      env: { ...process.env, DC_MARKER: marker },
    });

    const ranAnyway = fs.existsSync(marker);
    fs.rmSync(dir, { recursive: true, force: true });
    assert.equal(ranAnyway, false,
      'the deploy step ran after the run was cancelled — saying "Canceled" while deploying is the worst thing to be wrong about here');
  });
});
