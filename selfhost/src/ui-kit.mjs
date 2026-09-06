// P5 · The UI kit — everything the installer shows a human goes through here.
//
// WHY A WRAPPER AND NOT JUST IMPORTING @clack/prompts EVERYWHERE.
//
// Two reasons, and the second one is the important one.
//
// 1. One place to change. If the choice of prompt library turns out wrong,
//    it is wrong in this file only.
//
// 2. ONE PLACE WHERE CANCELLATION IS HANDLED. `@clack/prompts` signals Ctrl-C
//    by RESOLVING with a symbol, not by rejecting. A symbol is truthy. So a
//    caller that writes
//
//        const token = await text({ message: 'Cloudflare token' });
//        state.cloudflareToken = token;      // Symbol(clack:cancel)
//
//    passes every truthiness check, saves a symbol to disk as `null`, and
//    fails three steps later somewhere unrelated. This codebase has already
//    shipped that exact shape of bug twice — an `''` that sailed through a
//    truthiness check, and a `10035` that made a retry loop dead — so the kit
//    does not offer callers the chance. Every prompt below routes cancellation
//    into `handleCancel()`, which exits. Nothing here can return the symbol.
//
// WHY NOT listr2, WHICH THE PLAN NAMED.
//
// `BUILD_ORDER.md` specified `@clack/prompts` + `listr2`, on the belief that
// clack had no task-list widget. It has: `tasks()`, since 1.x. Measured, on
// this machine, on 2026-08-18:
//
//     @clack/prompts alone      6 packages    372K
//     + listr2                 24 packages    1.2M
//
// That is 18 extra packages installed on a stranger's machine, by a script
// they piped into a shell, to render a list of steps that clack already
// renders. The contract P5 asks for (`taskList`) is met either way, so the
// smaller supply chain wins. `selfhost/` used to forbid dependencies outright;
// this keeps as much of that spirit as a wizard allows.

import {
  intro as clackIntro,
  outro as clackOutro,
  cancel as clackCancel,
  text as clackText,
  password as clackPassword,
  confirm as clackConfirm,
  select as clackSelect,
  spinner as clackSpinner,
  note as clackNote,
  log as clackLog,
  isCancel,
} from '@clack/prompts';

// A pty with no window size reports `columns === 0` — `script -c`, `expect`,
// some CI runners, a detached tmux pane. clack's `getColumns` returns
// `output.columns` whenever it is a NUMBER, and 0 is a number, so it then wraps
// every panel at width zero: one character per line, a few hundred lines of it.
// The hand-rolled `ui.mjs` clamped with `stdout.columns || 80` and did not have
// this. Clamp once, and only for the value that is meaningless.
if (process.stdout.columns === 0) process.stdout.columns = 80;

// ── cancellation ─────────────────────────────────────────────────────────────

/** Thrown after the exit handler runs. In production `process.exit` never
 *  returns, so this never happens — it exists so a test can prove a cancelled
 *  prompt cannot fall through and hand the caller a value. */
export class Cancelled extends Error {
  constructor() {
    super('cancelled');
    this.name = 'Cancelled';
  }
}

// Setup is resumable (see state.mjs), so a Ctrl-C is not a disaster — but only
// if we say so. Someone who quits halfway through a Cloudflare step and is told
// nothing will reasonably assume they have to start over.
let resumeHint = 'daemonclient setup';

/** What to tell someone who quits halfway. Set once, by the command. */
export function setResumeHint(command) {
  resumeHint = String(command || '').trim() || 'daemonclient setup';
}

let exitHandler = (code) => process.exit(code);

/** Test seam. Named so nobody mistakes it for part of the interface.
 *
 *  The returned restore only puts back what it replaced IF nothing else has
 *  swapped the handler since. Without that check, two overlapping tests
 *  restoring out of order leave `handleCancel` non-exiting for the rest of the
 *  process — and every later cancellation assertion silently stops testing
 *  cancellation. */
export function __setExitHandlerForTests(fn) {
  const previous = exitHandler;
  const mine = typeof fn === 'function' ? fn : previous;
  exitHandler = mine;
  return () => { if (exitHandler === mine) exitHandler = previous; };
}

/** The single exit path for Ctrl-C at any prompt. 130 is the conventional
 *  "terminated by SIGINT" status, which matters because install.sh runs under
 *  `set -e` and a caller may be scripting around us. */
export function handleCancel(opts = {}) {
  clackCancel(`Stopped. Nothing was lost — run ${resumeHint} to pick up where you left off.`, opts);
  exitHandler(130);
  throw new Cancelled();
}

/** Every prompt result passes through here. */
function guard(value, opts) {
  if (isCancel(value)) return handleCancel(opts);
  return value;
}

// ── framing ──────────────────────────────────────────────────────────────────

export function intro(title, opts = {}) {
  clackIntro(title, opts);
}

export function outro(message, opts = {}) {
  clackOutro(message, opts);
}

export function note(body, title, opts = {}) {
  clackNote(Array.isArray(body) ? body.join('\n') : String(body ?? ''), title, opts);
}

export const log = {
  info: (msg, opts = {}) => clackLog.info(msg, opts),
  success: (msg, opts = {}) => clackLog.success(msg, opts),
  warn: (msg, opts = {}) => clackLog.warn(msg, opts),
  error: (msg, opts = {}) => clackLog.error(msg, opts),
  step: (msg, opts = {}) => clackLog.step(msg, opts),
  message: (msg, opts = {}) => clackLog.message(msg, opts),
};

// ── questions ────────────────────────────────────────────────────────────────

// The kit's validator convention matches the one the existing commands already
// use: return a problem string, or nothing if the value is fine. That is also
// clack's convention, so validators pass straight through.
function withRequired(validate, required, label) {
  if (!required) return validate;
  return (value) => {
    if (!String(value ?? '').trim()) return label;
    return validate?.(value);
  };
}

export async function text(message, opts = {}) {
  const { required = true, validate, placeholder, initialValue, defaultValue, ...rest } = opts;
  // `...rest` FIRST. Spread last, a caller passing `{ message: … }` silently
  // replaced the question actually being asked, and `select`'s `{ options: … }`
  // silently replaced the choices — the prompt would ask one thing and return
  // an answer to another. Nothing does that today; P15 migrates every caller
  // onto this file, which is precisely when it would start happening.
  const value = await clackText({
    ...rest,
    message,
    placeholder,
    initialValue,
    defaultValue,
    validate: withRequired(validate, required && defaultValue === undefined, 'Required.'),
  });
  return guard(value, rest);
}

/** Echoes nothing, so a shoulder-surfer or a screen recording never captures
 *  the value. Used for the bot token, the Cloudflare token and the account
 *  password — and note that the password must also never reach disk, which is
 *  `state.mjs`'s NEVER_PERSIST, not this function's job. */
export async function password(message, opts = {}) {
  const { required = true, validate, ...rest } = opts;
  const value = await clackPassword({
    ...rest,
    message,
    validate: withRequired(validate, required, 'Required.'),
  });
  return guard(value, rest);
}

export async function confirm(message, opts = {}) {
  const { initialValue = true, ...rest } = opts;
  const value = await clackConfirm({ ...rest, message, initialValue });
  return guard(value, rest);
}

/** @param {Array<{value: any, label?: string, hint?: string}>} options */
export async function select(message, options, opts = {}) {
  const value = await clackSelect({ ...opts, message, options });
  return guard(value, opts);
}

// ── progress ─────────────────────────────────────────────────────────────────

/**
 * A spinner with the shape the existing commands already call
 * (`update` / `succeed` / `fail` / `stop`), so migrating them is mechanical.
 *
 * The reason this is not the hand-rolled spinner in `ui.mjs`: that one writes
 * `\x1b[?25l` to hide the cursor and only restores it in its own `clear()`. A
 * Ctrl-C, an uncaught exception or an unhandled rejection mid-spin therefore
 * leaves the user's terminal with **no cursor** after we exit, until they run
 * `reset`. clack's spinner registers SIGINT, SIGTERM, exit,
 * uncaughtExceptionMonitor and unhandledRejection handlers and removes them on
 * stop. That is the whole argument for this part in one sentence.
 */
let spinnersRunning = 0;
let exitReconcilerInstalled = false;

/**
 * Ctrl-C during a spinner does not reach us, and it exits 0.
 *
 * A running clack spinner calls `block()` from `@clack/core`, which puts stdin
 * in RAW MODE. With ISIG off the terminal never raises SIGINT at all — Ctrl-C
 * arrives as a plain `\x03` byte, `block`'s own key handler sees it, and does:
 *
 *     t && r.write(cursor.show), process.exit(0);
 *
 * `process.exit(0)`. So `handleCancel()` never runs, the resume message never
 * prints, and — the part that actually matters — **an abandoned install reports
 * SUCCESS**. `install.sh` `exec`s us, so `curl … | sh` on a cancelled setup
 * exits 0, and anything scripting around it is told the cloud is up.
 *
 * We cannot outrank `block`'s handler: it is registered when the spinner
 * starts, before ours could be. But an `exit` listener can still correct the
 * status — calling `process.exit` from inside one replaces the code. So the
 * rule is: if the process is exiting 0 while a spinner is still running, that
 * was not a success.
 *
 * Deliberately narrow. It cannot fire on a normal finish, because finishing
 * stops the spinner first.
 */
function installExitReconciler() {
  if (exitReconcilerInstalled) return;
  exitReconcilerInstalled = true;
  process.on('exit', (code) => {
    if (spinnersRunning > 0 && code === 0) process.exit(130);
  });
}

export function spinner(message, opts = {}) {
  installExitReconciler();
  const s = clackSpinner(opts);
  let current = message;
  let finished = false;
  const finish = (fn, text) => {
    if (!finished) { finished = true; spinnersRunning -= 1; }
    fn(text || current);
  };
  spinnersRunning += 1;
  s.start(current);
  return {
    update(text) { current = text; s.message(text); },
    succeed(text) { finish((t) => s.stop(t), text); },
    fail(text) { finish((t) => s.error(t), text); },
    stop(text) { finish((t) => s.stop(t), text); },
    /** True when a SIGNAL-delivered SIGINT reached clack's spinner. It prints
     *  "Canceled" and does NOT exit, so the caller has to notice. */
    get isCancelled() { return s.isCancelled; },
  };
}

/**
 * The multi-minute deploy: a list of steps, each rendering its own progress and
 * leaving one line behind when it finishes.
 *
 * WHY THIS IS NOT `clack.tasks()`, WHICH DOES EXACTLY THIS.
 *
 * Because `clack.tasks()` has no `try`. Its whole body is:
 *
 *     for (const t of o) {
 *       if (t.enabled === false) continue;
 *       const s = spinner(e);
 *       s.start(t.title);
 *       const n = await t.task(s.message);   // throws here
 *       s.stop(n || t.title);                // never runs
 *     }
 *
 * When a task throws, the spinner it started is never stopped, so its interval
 * keeps ticking and its exit handlers stay installed. The error propagates, the
 * CLI prints it — and then **the process never exits**. Confirmed on
 * @clack/prompts 1.7.0: `getActiveResourcesInfo()` still reports a live
 * `Timeout` after the throw.
 *
 * A step of this list is "deploy the worker" and "create the database". Those
 * fail routinely — an expired Cloudflare token, a 403, a name already taken.
 * So the common failure would have been: the wizard prints a useful error and
 * then hangs forever, with the user's only option being Ctrl-C. The
 * one-liner that delegates to clack was written first and a test caught this,
 * which is the entire reason the wrapper exists.
 *
 * Ours stops the spinner in a `catch` and rethrows, so the failed step is
 * *marked* failed and the caller still decides what to do about it.
 *
 * @param {Array<{title: string, task: (message: (s: string) => void) => Promise<string|void>, enabled?: boolean}>} list
 */
export async function taskList(list, opts = {}) {
  for (const item of list) {
    // `enabled: false` is how a resumed setup skips work it already did.
    // Creating a D1 database a second time is not free.
    if (item?.enabled === false) continue;

    const s = spinner(item.title, opts);
    let done;
    try {
      done = await item.task((message) => s.update(message));
    } catch (err) {
      s.fail(`${item.title} — failed`);
      throw err;
    }

    // A SIGNAL-delivered SIGINT (`kill -INT`, a parent shell forwarding one)
    // takes a different path from a Ctrl-C keystroke: clack's spinner handler
    // prints "Canceled" and RETURNS, without exiting. Without this check the
    // list carried straight on — so the wizard said "Canceled" and then
    // created the D1 database and deployed the worker anyway. Saying you
    // stopped while a deploy continues is the worst thing to be wrong about at
    // that particular moment.
    //
    // The step already in flight cannot be un-run; it finished above. What
    // this guarantees is that the NEXT one does not start.
    if (s.isCancelled) {
      s.stop(`${item.title} — stopped`);
      return handleCancel(opts);
    }

    s.succeed(done || item.title);
  }
}

// ── the terminal we were actually given ──────────────────────────────────────

/**
 * Refuse, with one sentence, rather than hang.
 *
 * This is not hypothetical. The documented entry point is
 * `curl … | sh`, which means the SHELL's stdin is the pipe carrying the script
 * — and `install.sh` hands over with `exec node … setup`, so the wizard
 * inherits that same, already-exhausted pipe. Every prompt then reads EOF
 * immediately. install.sh reopens `/dev/tty` for exactly this reason; this
 * function is what catches the case where that was not possible (a cron job, a
 * CI runner, a container with no controlling terminal) and says so, instead of
 * a wizard that appears to accept every default and produces a broken install.
 *
 * @returns {string|null} a problem to print, or null if we can proceed
 */
export function interactiveProblem(stdin = process.stdin) {
  if (stdin?.isTTY) return null;
  return 'This setup asks questions, so it needs an interactive terminal — and it did not get one.';
}
