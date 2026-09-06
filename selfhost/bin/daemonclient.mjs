#!/usr/bin/env node
// DaemonClient self-hosting CLI.
//
// One entry point, a handful of commands. `install.sh` runs `npm ci` before
// any of this executes, so the prompt library is present by the time we start.

import { c, accent, line, blank, panel, symbols } from '../src/ui.mjs';
import { interactiveProblem } from '../src/ui-kit.mjs';

const COMMANDS = {
  setup: {
    summary: 'Create your cloud: Telegram, Cloudflare, account, deploy',
    asks: true,
    run: async () => (await import('../src/commands/setup.mjs')).runSetup(),
  },
  status: {
    summary: 'Show what is running and whether it is healthy',
    run: async () => (await import('../src/commands/status.mjs')).runStatus(),
  },
  update: {
    summary: 'Rebuild from the current source and redeploy',
    asks: true,
    run: async () => (await import('../src/commands/update.mjs')).runUpdate(),
  },
  web: {
    summary: 'Build & deploy all three web apps (dashboard, Photos, Drive) to your Firebase',
    asks: true,
    run: async () => (await import('../src/commands/web.mjs')).runWeb(),
  },
  dashboard: {
    summary: 'Build & publish only the dashboard hub (to Cloudflare Pages)',
    asks: true,
    run: async () => (await import('../src/commands/dashboard.mjs')).runDashboard(),
  },
  processor: {
    summary: 'Add or change the media processor (HEIC thumbnails)',
    asks: true,
    run: async () => (await import('../src/commands/processor.mjs')).runProcessor(),
  },
  doctor: {
    summary: 'Diagnose a broken install and print a redacted report',
    asks: true,
    run: async (argv = []) => (await import('../src/commands/doctor.mjs'))
      .runDoctor({ showKeys: argv.includes('--show-keys') }),
  },
};

function usage() {
  blank();
  panel('DaemonClient', [
    c.gray('Your own private cloud, on infrastructure you own.'),
    '',
    c.bold('Usage'),
    `  ${accent('daemonclient')} <command>`,
    '',
    c.bold('Commands'),
    ...Object.entries(COMMANDS).map(([name, cmd]) =>
      `  ${accent(name.padEnd(10))} ${c.gray(cmd.summary)}`),
    '',
    c.gray('First time? Run: ') + accent('daemonclient setup'),
  ]);
  blank();
}

async function main() {
  const [, , command, ...rest] = process.argv;

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    usage();
    return;
  }

  const entry = COMMANDS[command];
  if (!entry) {
    blank();
    line(`  ${symbols.fail} Unknown command: ${c.bold(command)}`);
    line(`    Try ${accent('daemonclient help')}`);
    blank();
    process.exit(1);
  }

  // A prompt with no terminal to read from does not fail — it WAITS, forever,
  // having already printed its question and hidden the cursor. `node … setup
  // < /dev/null`, a container without `-t`, and the fallback command
  // install.sh itself suggests all land here. Refusing in one sentence is the
  // only decent answer.
  //
  // install.sh has its own check, and reopens /dev/tty where it can. This one
  // exists because the other paths into this binary bypass it entirely, and
  // because a guard that is never called guards nothing — which this project
  // has shipped before (`registerSubdomain` was complete, correct, and called
  // from nowhere).
  if (entry.asks) {
    const problem = interactiveProblem();
    if (problem) {
      blank();
      line(`  ${symbols.fail} ${problem}`);
      line(`    ${c.gray(`\`daemonclient ${command}\` asks questions; run it from a terminal.`)}`);
      blank();
      process.exit(1);
    }
  }

  try {
    await entry.run(rest);
  } catch (err) {
    blank();
    line(`  ${symbols.fail} ${c.red(err?.message || String(err))}`);
    if (process.env.DEBUG) line(c.gray(err?.stack || ''));
    else line(c.gray('    Run again with DEBUG=1 for the full trace.'));
    blank();
    process.exit(1);
  }
}

// `daemonclient status | head` closes the pipe while we are still writing, and
// Node turns that into an unhandled 'error' event and a stack trace. Piping
// output into `head`, `less` or `grep -q` is ordinary use, and a crash report
// for it is noise that looks like our bug.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (err) => { if (err?.code !== 'EPIPE') throw err; });
}

// Ctrl-C during a prompt should look deliberate, not like a crash.
process.on('SIGINT', () => {
  blank();
  line(c.gray('  Cancelled. Progress is saved — run the same command again to pick up where you left off.'));
  blank();
  process.exit(130);
});

main();
