#!/usr/bin/env node
// DaemonClient self-hosting CLI.
//
// One entry point, a handful of commands, no build step and no dependencies —
// `node selfhost/bin/daemonclient.mjs` works straight out of a fresh clone.

import { c, accent, line, blank, panel, symbols } from '../src/ui.mjs';

const COMMANDS = {
  setup: {
    summary: 'Create your cloud: Telegram, Cloudflare, account, deploy',
    run: async () => (await import('../src/commands/setup.mjs')).runSetup(),
  },
  status: {
    summary: 'Show what is running and whether it is healthy',
    run: async () => (await import('../src/commands/status.mjs')).runStatus(),
  },
  update: {
    summary: 'Rebuild from the current source and redeploy',
    run: async () => (await import('../src/commands/update.mjs')).runUpdate(),
  },
  web: {
    summary: 'Build & deploy all three web apps (dashboard, Photos, Drive) to your Firebase',
    run: async () => (await import('../src/commands/web.mjs')).runWeb(),
  },
  dashboard: {
    summary: 'Build & publish only the dashboard hub (to Cloudflare Pages)',
    run: async () => (await import('../src/commands/dashboard.mjs')).runDashboard(),
  },
  processor: {
    summary: 'Add or change the media processor (HEIC thumbnails)',
    run: async () => (await import('../src/commands/processor.mjs')).runProcessor(),
  },
  doctor: {
    summary: 'Diagnose a broken install and print a redacted report',
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

// Ctrl-C during a prompt should look deliberate, not like a crash.
process.on('SIGINT', () => {
  blank();
  line(c.gray('  Cancelled. Progress is saved — run the same command again to pick up where you left off.'));
  blank();
  process.exit(130);
});

main();
