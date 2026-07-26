// `daemonclient status` — what is running, and is it healthy.

import { c, accent, line, blank, panel, ok, fail, warn, info, spinner, symbols, hint } from '../ui.mjs';
import { loadState, isDone, checkStatePermissions, statePath } from '../state.mjs';
import * as tg from '../api/telegram.mjs';

export async function runStatus() {
  const state = loadState();
  blank();

  if (!isDone(state, 'deploy')) {
    panel('Not set up yet', [
      'No deployment found in this folder.',
      '',
      `Run ${accent('daemonclient setup')} to create one.`,
    ], { color: c.yellow });
    return;
  }

  const rows = [];
  const mark = (good, label, detail) =>
    rows.push(`${good ? symbols.ok : symbols.fail} ${label}${detail ? c.gray(`  ${detail}`) : ''}`);

  const s = spinner('Checking your API');
  let apiOk = false;
  let status = null;
  try {
    const res = await fetch(`${state.workerUrl}/api/health`, { signal: AbortSignal.timeout(15000) });
    apiOk = res.ok;
    status = await res.json().catch(() => null);
    s.stop();
  } catch (e) {
    s.stop();
  }
  mark(apiOk, 'API', state.workerUrl);
  if (status) mark(status.database === 'connected', 'Database', status.database);

  const s2 = spinner('Checking Telegram');
  let tgOk = false;
  try {
    const me = await tg.getMe(state.telegramBotToken);
    tgOk = !!me.username;
    s2.stop();
    mark(tgOk, 'Telegram bot', `@${me.username}`);
  } catch (e) {
    s2.stop();
    mark(false, 'Telegram bot', e.message);
  }
  mark(!!state.telegramChannelId, 'Channel', state.telegramChannelTitle || state.telegramChannelId);

  if (state.processorUrl) {
    const s3 = spinner('Checking the processor');
    try {
      const res = await fetch(`${state.processorUrl}/health`, { signal: AbortSignal.timeout(60000) });
      const body = await res.json().catch(() => ({}));
      s3.stop();
      mark(res.ok, 'Processor', res.ok ? state.processorUrl : (body.problems || []).join('; '));
    } catch {
      s3.stop();
      mark(false, 'Processor', 'not answering (a free instance may be asleep)');
    }
  } else {
    rows.push(`${c.gray('–')} Processor ${c.gray('not configured — HEIC and video thumbnails will be blank')}`);
  }

  panel('Status', rows);

  // Update check, straight from GitHub releases.
  const s4 = spinner('Checking for updates');
  try {
    const res = await fetch(`${state.workerUrl}/api/selfhost/status`, {
      signal: AbortSignal.timeout(15000),
    });
    s4.stop();
    if (res.status === 401) {
      info('Sign in on the dashboard to see update status.');
    } else if (res.ok) {
      const body = await res.json();
      if (body.update?.updateAvailable) {
        blank();
        panel('Update available', [
          `You are running ${c.bold(body.update.currentVersion)}; ${c.bold(body.update.latestVersion)} is out.`,
          '',
          `Run ${accent('daemonclient update')} to upgrade.`,
          body.update.releaseUrl ? c.gray(body.update.releaseUrl) : '',
        ].filter(Boolean), { color: c.yellow });
      } else if (body.update?.latestVersion) {
        ok(`Up to date (${body.update.currentVersion})`);
      }
    }
  } catch {
    s4.stop();
  }

  const perm = checkStatePermissions();
  if (perm) { blank(); warn(perm); }
  blank();
  hint(`Configuration: ${statePath()}`);
  blank();
}
