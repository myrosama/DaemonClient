// `daemonclient status` — what is running, and is it healthy.
//
// The first command migrated onto the P5 UI kit, chosen because it is
// read-only, touches no credentials, and can be run against a real install
// without risk. Doing it surfaced a bug that had nothing to do with
// presentation: a spinner started outside a `try` and returned past.

import { spinner, note, intro, outro, log } from '../ui-kit.mjs';
import { loadState, isDone, checkStatePermissions, statePath } from '../state.mjs';
import * as tg from '../api/telegram.mjs';

const OK = '✔';
const BAD = '✖';
const NONE = '–';

export async function runStatus() {
  const state = loadState();

  intro('DaemonClient · status');

  if (!isDone(state, 'deploy')) {
    note([
      'No deployment found in this folder.',
      '',
      'Run `daemonclient setup` to create one.',
    ], 'Not set up yet');
    outro('Nothing to check yet.');
    return;
  }

  const rows = [];
  const mark = (good, label, detail) =>
    rows.push(`${good ? OK : BAD} ${label}${detail ? `  ${detail}` : ''}`);

  // ── the worker ──
  //
  // `state.workerUrl` can be missing on an install whose deploy flag was set
  // but whose address was never recorded — the resume path used to finish that
  // way, printing a literal `null` under "Your cloud is live". Every check
  // below has to tolerate it rather than assume a deployed install has an
  // address.
  let health = null;
  if (state.workerUrl) {
    const s = spinner('Checking your API');
    try {
      const res = await fetch(`${state.workerUrl}/api/health`, { signal: AbortSignal.timeout(15000) });
      health = res.ok ? await res.json().catch(() => null) : null;
      s.stop(res.ok ? 'API answered' : `API answered ${res.status}`);
      mark(res.ok, 'API', state.workerUrl);
    } catch (e) {
      s.fail('API did not answer');
      mark(false, 'API', `${state.workerUrl} — ${e.message}`);
    }
  } else {
    mark(false, 'API', 'no address recorded for this install — re-run `daemonclient setup`');
  }
  if (health) mark(health.database === 'connected', 'Database', health.database);

  // ── Telegram ──
  const s2 = spinner('Checking Telegram');
  try {
    const me = await tg.getMe(state.telegramBotToken);
    s2.stop('Telegram answered');
    mark(!!me.username, 'Telegram bot', me.username ? `@${me.username}` : 'no username');
  } catch (e) {
    s2.fail('Telegram did not answer');
    mark(false, 'Telegram bot', e.message);
  }
  mark(!!state.telegramChannelId, 'Channel', state.telegramChannelTitle || state.telegramChannelId);

  // ── the processor ──
  if (state.processorUrl) {
    const s3 = spinner('Checking the processor');
    try {
      // 60s because a free instance cold-starts, and reporting a sleeping
      // processor as broken sends people to debug something that is fine.
      const res = await fetch(`${state.processorUrl}/health`, { signal: AbortSignal.timeout(60000) });
      const body = await res.json().catch(() => ({}));
      s3.stop(res.ok ? 'Processor answered' : 'Processor reported a problem');
      mark(res.ok, 'Processor', res.ok ? state.processorUrl : (body.problems || []).join('; '));
    } catch {
      s3.fail('Processor did not answer');
      mark(false, 'Processor', 'not answering (a free instance may be asleep)');
    }
  } else {
    rows.push(`${NONE} Processor  not configured — HEIC photos will have no grid thumbnail`);
  }

  note(rows, 'Status');

  // ── updates ──
  //
  // The spinner is started INSIDE the guard, not before it. It used to sit
  // above an `if (!state.workerUrl) return null`, so an install with no
  // recorded address returned with the spinner still running: its interval kept
  // the process alive and its `\x1b[?25l` was never undone, leaving the user's
  // terminal with no cursor. Same shape as the `clack.tasks()` leak the kit
  // works around — a spinner whose stop is on a line that can be skipped.
  if (state.workerUrl) {
    const s4 = spinner('Checking for updates');
    try {
      const res = await fetch(`${state.workerUrl}/api/selfhost/status`, {
        signal: AbortSignal.timeout(15000),
      });
      if (res.status === 401) {
        s4.stop('Update status needs a sign-in');
        log.info('Sign in on the dashboard to see update status.');
      } else if (res.ok) {
        const body = await res.json();
        const update = body.update;
        if (update?.updateAvailable) {
          s4.stop('An update is available');
          note([
            `You are running ${update.currentVersion}; ${update.latestVersion} is out.`,
            '',
            'Run `daemonclient update` to upgrade.',
            update.releaseUrl || '',
          ].filter(Boolean), 'Update available');
        } else if (update?.latestVersion) {
          s4.succeed(`Up to date (${update.currentVersion})`);
        } else {
          s4.stop('No update information');
        }
      } else {
        s4.stop(`Update check answered ${res.status}`);
      }
    } catch {
      s4.fail('Could not reach the update check');
    }
  }

  const perm = checkStatePermissions();
  if (perm) log.warn(perm);

  outro(`Configuration: ${statePath()}`);
}
