// BUILD_ORDER P5 — the UI kit.
//
// HOW THESE TESTS ARE WRITTEN, AND WHY IT MATTERS HERE.
//
// Twice in this project a green suite has endorsed a bug, because the test
// asserted what the source SAID rather than what it DID: a retry loop keyed on
// the wrong Cloudflare error code, with a test that manufactured that same
// wrong code; and a version check whose assertion was an `||` whose right side
// was always true. So none of the tests below read `ui-kit.mjs` as text. They
// drive the real prompts, through injected streams, with real keystrokes, and
// assert on what came back and what was written to the terminal.
//
// The property that gets the most attention is cancellation, because clack
// signals Ctrl-C by RESOLVING with a symbol rather than rejecting. A symbol is
// truthy. If one ever reached a caller it would pass a validity check and be
// written to disk, and the failure would surface somewhere else entirely.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import path from 'node:path';

import {
  text, password, confirm, select, spinner, taskList, note, intro, outro, log,
  setResumeHint, __setExitHandlerForTests, Cancelled, interactiveProblem,
} from '../src/ui-kit.mjs';

const SRC = path.join(import.meta.dirname, '..', 'src');

/** A terminal that is not a terminal: clack writes here, tests type there. */
function terminal() {
  const input = new PassThrough();
  const output = new PassThrough();
  let seen = '';
  output.on('data', (d) => { seen += d.toString(); });
  input.isTTY = true;
  input.setRawMode = () => {};
  output.isTTY = true;
  output.columns = 80;
  output.rows = 24;
  return { input, output, seen: () => seen };
}

/** Type into a prompt once it has rendered. */
function type(input, ...keys) {
  setTimeout(() => { for (const k of keys) input.write(k); }, 30);
}

const ENTER = '\r';
const CTRL_C = '\x03';
const DOWN = '\x1b[B';

/** Run `fn` with the exit path captured instead of killing the test process. */
async function capturingExit(fn) {
  const codes = [];
  const restore = __setExitHandlerForTests((code) => { codes.push(code); });
  try {
    return { codes, result: await fn().then((v) => ({ returned: v }), (e) => ({ threw: e })) };
  } finally {
    restore();
  }
}

describe('cancellation — the symbol must never reach a caller', () => {
  for (const [name, run] of [
    ['text', (t) => text('Your name', t)],
    ['password', (t) => password('Your token', t)],
    ['confirm', (t) => confirm('Proceed?', t)],
    ['select', (t) => select('Pick one', [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }], t)],
  ]) {
    test(`${name}: Ctrl-C exits rather than returning a value`, async () => {
      const t = terminal();
      type(t.input, CTRL_C);
      const { codes, result } = await capturingExit(() => run(t));

      assert.deepEqual(codes, [130], 'exits with 130, the conventional SIGINT status');
      assert.ok(result.threw instanceof Cancelled,
        `${name} must not resolve on cancel — a caller would treat the symbol as an answer`);
      assert.equal(result.returned, undefined);
    });
  }

  test('the cancel message tells the user how to resume', async () => {
    const t = terminal();
    setResumeHint('daemonclient setup');
    type(t.input, CTRL_C);
    await capturingExit(() => text('Your name', t));
    assert.match(t.seen(), /daemonclient setup/, 'names the command that resumes');
    assert.match(t.seen(), /Nothing was lost/i, 'says the work so far is kept — setup is resumable');
  });

  test('a custom resume hint is what gets printed', async () => {
    const t = terminal();
    setResumeHint('daemonclient web');
    type(t.input, CTRL_C);
    await capturingExit(() => text('Your name', t));
    assert.match(t.seen(), /daemonclient web/);
    setResumeHint('daemonclient setup'); // restore for the other tests
  });
});

describe('questions return what was typed', () => {
  test('text', async () => {
    const t = terminal();
    type(t.input, 'boborjon', ENTER);
    assert.equal(await text('Your name', t), 'boborjon');
  });

  test('confirm: Enter takes the default, and the default is settable', async () => {
    const t1 = terminal();
    type(t1.input, ENTER);
    assert.equal(await confirm('Proceed?', { ...t1, initialValue: true }), true);

    const t2 = terminal();
    type(t2.input, ENTER);
    assert.equal(await confirm('Proceed?', { ...t2, initialValue: false }), false);
  });

  test('select returns the value, not the label', async () => {
    const t = terminal();
    type(t.input, DOWN, ENTER);
    const got = await select('Pick one', [
      { value: 'first', label: 'The first one' },
      { value: 'second', label: 'The second one' },
    ], t);
    assert.equal(got, 'second');
  });

  test('a required question refuses empty input instead of accepting it', async () => {
    // An empty string is the shape that has bitten this project before: it
    // sails through a truthiness check and lands in state as "configured".
    const t = terminal();
    setTimeout(() => t.input.write(ENTER), 30);          // nothing typed
    setTimeout(() => t.input.write('actual-value'), 90); // then a real answer
    setTimeout(() => t.input.write(ENTER), 120);
    const got = await text('Your name', t);
    assert.equal(got, 'actual-value');
    assert.match(t.seen(), /Required/, 'and says why it refused');
  });

  test('a validator can reject a value and the prompt asks again', async () => {
    // Note what this asserts about the rejected input: it STAYS in the buffer.
    // clack does not clear it, so the user corrects their typo rather than
    // retyping a 46-character bot token from scratch. Worth pinning, because
    // "clear the field on error" is a plausible-looking change that would make
    // the worst prompt in the wizard materially worse.
    const t = terminal();
    setTimeout(() => t.input.write(`1234${ENTER}`), 30);      // no colon — rejected
    setTimeout(() => t.input.write(`:AAtoken${ENTER}`), 90);  // appended to what is still there
    const got = await text('Bot token', {
      ...t,
      validate: (v) => (v.includes(':') ? undefined : 'A bot token looks like 1234:AA…'),
    });
    assert.equal(got, '1234:AAtoken');
    assert.match(t.seen(), /A bot token looks like/, 'and the rejection said what was wrong');
  });
});

describe('secrets', () => {
  test('a password is never written to the terminal', async () => {
    // Not a style point. The installer asks for a Telegram bot token, a
    // Cloudflare API token and an account password, and people run installers
    // while screen-sharing and while recording their terminal.
    const t = terminal();
    const secret = 'correct-horse-battery-staple';
    type(t.input, secret, ENTER);
    const got = await password('Your password', t);

    assert.equal(got, secret, 'the caller still gets the real value');
    assert.ok(!t.seen().includes(secret), 'but it never appears in the output stream');
  });

  test('every character is masked, not just some', async () => {
    const t = terminal();
    type(t.input, 'abcdef', ENTER);
    await password('Your password', t);
    for (const ch of ['abcdef', 'abcde', 'abcd', 'abc']) {
      assert.ok(!t.seen().includes(ch), `a fragment (${ch}) leaked into the output`);
    }
  });
});

describe('progress', () => {
  test('the spinner cleans up after itself — no leaked handlers, no leaked interval', async () => {
    // WHAT THIS DOES AND DOES NOT PROVE. clack installs its SIGINT, SIGTERM,
    // exit, uncaughtExceptionMonitor and unhandledRejection handlers together
    // with the render interval, and removes them together too — so the
    // listener count is an observable proxy for "the interval was cleared",
    // which is the leak that hangs the process. That is what this asserts.
    //
    // It does NOT prove anything about Ctrl-C. A running spinner puts stdin in
    // RAW MODE, so the terminal never raises SIGINT at all and this listener
    // never fires on a real keystroke — the earlier version of this test said
    // otherwise in its own comment, which is exactly the kind of overclaim that
    // makes a suite feel safer than it is. Cancellation is covered in
    // test/cli-entry.test.mjs, against the real binary.
    const t = terminal();
    const before = process.listenerCount('SIGINT');

    const s = spinner('Deploying your worker', t);
    assert.ok(process.listenerCount('SIGINT') > before,
      'clack installs its handlers with the interval; if they are absent, so is the cleanup');

    s.update('Uploading the bundle');
    s.succeed('Worker deployed');

    assert.equal(process.listenerCount('SIGINT'), before,
      'and must remove the handler when it stops, so they do not accumulate');
  });

  test('the spinner reports both outcomes', async () => {
    const t1 = terminal();
    spinner('Working', t1).succeed('Done');
    assert.match(t1.seen(), /Done/);

    const t2 = terminal();
    spinner('Working', t2).fail('Could not reach Cloudflare');
    assert.match(t2.seen(), /Could not reach Cloudflare/);
  });

  test('taskList runs each task in order and shows what it finished', async () => {
    const t = terminal();
    const order = [];
    await taskList([
      { title: 'Creating the database', task: async () => { order.push('db'); return 'Database created'; } },
      { title: 'Deploying the worker', task: async (msg) => { order.push('worker'); msg('uploading'); return 'Worker deployed'; } },
    ], t);

    assert.deepEqual(order, ['db', 'worker'], 'in order — later steps depend on earlier ones');
    assert.match(t.seen(), /Database created/);
    assert.match(t.seen(), /Worker deployed/);
  });

  test('taskList skips a disabled task without running it', async () => {
    // The wizard is resumable: a step already done must not run twice. Creating
    // a D1 database a second time is not free.
    const t = terminal();
    let ran = false;
    await taskList([
      { title: 'Already done', task: async () => { ran = true; return 'x'; }, enabled: false },
      { title: 'Still to do', task: async () => 'Done' },
    ], t);
    assert.equal(ran, false, 'a disabled task must not execute');
    assert.ok(!t.seen().includes('Already done'), 'nor be shown as if it had');
  });

  test('a failing task surfaces the error rather than swallowing it', async () => {
    const t = terminal();
    await assert.rejects(
      () => taskList([{ title: 'Deploying', task: async () => { throw new Error('Cloudflare said 403'); } }], t),
      /Cloudflare said 403/,
    );
    assert.match(t.seen(), /Deploying/, 'and the step is left on screen marked failed');
  });

  test('a failing task does not leave the process alive', async () => {
    // THE REGRESSION THIS PINS. `clack.tasks()` starts a spinner per step and
    // stops it on the line AFTER awaiting the task, with no `try`. A throwing
    // step therefore leaks a running interval and its exit handlers: the CLI
    // prints a perfectly good error and then hangs forever, and the user's only
    // way out is Ctrl-C. Deploy steps fail routinely — expired token, 403, name
    // taken — so that was the COMMON path, not an edge case.
    //
    // Measured as listener count rather than by watching the clock, because a
    // test that waits to see whether something hangs either takes seconds or
    // lies. The handlers and the interval are installed and removed together.
    const t = terminal();
    const before = process.listenerCount('SIGINT');

    await assert.rejects(() => taskList([
      { title: 'Creating the database', task: async () => 'Database created' },
      { title: 'Deploying the worker', task: async () => { throw new Error('403'); } },
      { title: 'Never reached', task: async () => 'x' },
    ], t));

    assert.equal(process.listenerCount('SIGINT'), before,
      'a thrown task must still stop its spinner — otherwise the installer never exits');
  });

  test('a failing task stops the list rather than carrying on', async () => {
    const t = terminal();
    let laterRan = false;
    await assert.rejects(() => taskList([
      { title: 'Deploying', task: async () => { throw new Error('403'); } },
      { title: 'Seeding encryption keys', task: async () => { laterRan = true; return 'x'; } },
    ], t));
    assert.equal(laterRan, false, 'later steps depend on earlier ones — seeding keys into a database that was never created is worse than stopping');
  });
});

describe('framing renders without a real terminal', () => {
  test('intro, note and outro all write something', () => {
    const t = terminal();
    intro('DaemonClient', t);
    note(['Line one', 'Line two'], 'A title', t);
    outro('All done', t);
    assert.match(t.seen(), /DaemonClient/);
    assert.match(t.seen(), /Line one/);
    assert.match(t.seen(), /Line two/);
    assert.match(t.seen(), /A title/);
  });

  test('note accepts an array or a string, since callers have both', () => {
    const a = terminal();
    note(['x', 'y'], 'T', a);
    const b = terminal();
    note('x\ny', 'T', b);
    assert.match(a.seen(), /x/);
    assert.match(b.seen(), /x/);
  });

  test('log has the four levels the commands actually use', () => {
    const t = terminal();
    log.info('i', t); log.success('s', t); log.warn('w', t); log.error('e', t);
    for (const s of ['i', 's', 'w', 'e']) assert.match(t.seen(), new RegExp(s));
  });
});

describe('the terminal we were actually given', () => {
  test('a non-interactive stdin is refused, not hung on', () => {
    // `curl … | sh` leaves the wizard's stdin pointing at the exhausted pipe
    // that carried the script. Every prompt then reads EOF immediately. The
    // wizard must say that in one sentence rather than appear to accept every
    // default and produce a broken install.
    const problem = interactiveProblem({ isTTY: false });
    assert.ok(problem, 'a non-TTY stdin is a problem');
    assert.match(problem, /interactive terminal/i, 'and the message says what is missing');
  });

  test('an interactive stdin passes', () => {
    assert.equal(interactiveProblem({ isTTY: true }), null);
  });
});

describe('the wrapper is the only thing that knows about clack', () => {
  test('no other module imports @clack directly', () => {
    // The entire argument for this file is "one place to change if the choice
    // turns out wrong" and "one place where cancellation is handled". A second
    // importer quietly voids both — and the cancellation one is a live bug, not
    // a tidiness point, because a direct caller gets the raw symbol.
    const offenders = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith('.mjs')) continue;
        if (full === path.join(SRC, 'ui-kit.mjs')) continue;
        if (/from\s+['"]@clack\//.test(fs.readFileSync(full, 'utf8'))) {
          offenders.push(path.relative(SRC, full));
        }
      }
    };
    walk(SRC);
    assert.deepEqual(offenders, [], 'these must go through src/ui-kit.mjs instead');
  });
});
