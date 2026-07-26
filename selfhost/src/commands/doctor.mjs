// `daemonclient doctor` — figure out why something is broken, and produce a
// report that is safe to paste into a GitHub issue.
//
// Every value printed here goes through the state redactor, so a report can
// never leak a bot token, a Cloudflare token, the session secret or the
// storage key. That matters: the most common way self-hosters get compromised
// is pasting a "here is my config" dump into a public thread.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { c, accent, line, blank, panel, ok, fail, warn, info, hint, spinner, symbols, confirm } from '../ui.mjs';
import { loadState, redact, checkStatePermissions, statePath, isDone } from '../state.mjs';
import * as cf from '../api/cloudflare.mjs';
import * as tg from '../api/telegram.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..');

export async function runDoctor() {
  const state = loadState();
  const findings = [];
  const add = (level, message, fix) => findings.push({ level, message, fix });

  blank();
  line(c.bold('  Running checks…'));
  blank();

  // ── Local environment
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 18) add('error', `Node ${process.versions.node} is too old (need 18+)`, 'Install a current Node from nodejs.org');
  else ok(`Node ${process.versions.node}`);

  if (!fs.existsSync(path.join(REPO_ROOT, 'immich-api-shim', 'node_modules'))) {
    add('error', 'immich-api-shim/node_modules is missing', 'cd immich-api-shim && npm install');
  } else ok('Dependencies installed');

  const perm = checkStatePermissions();
  if (perm) add('warn', perm, `chmod 600 ${statePath()}`);
  else if (fs.existsSync(statePath())) ok('Config file permissions');

  if (!isDone(state, 'deploy')) {
    add('error', 'No deployment recorded in this folder', 'daemonclient setup');
    report(findings, state);
    return;
  }

  // ── Cloudflare
  const s = spinner('Cloudflare');
  try {
    await cf.verifyToken(state.cloudflareToken);
    s.succeed('Cloudflare token valid');
  } catch (e) {
    s.fail('Cloudflare token');
    add('error', `Cloudflare token rejected: ${e.message}`,
      'Create a new token with Workers Scripts:Edit, D1:Edit, Account Settings:Read, then re-run setup');
  }

  // ── Database
  const s2 = spinner('Database');
  try {
    const rows = await cf.queryD1(state.cloudflareToken, state.cloudflareAccountId, state.databaseId,
      "SELECT name FROM sqlite_master WHERE type='table'");
    const tables = (rows?.[0]?.results || []).map((r) => r.name);
    const missing = ['photos', 'users', 'config'].filter((t) => !tables.includes(t));
    if (missing.length) {
      s2.fail('Database');
      add('error', `Missing tables: ${missing.join(', ')}`, 'daemonclient update (re-applies the schema)');
    } else {
      s2.succeed(`Database (${tables.length} tables)`);
    }
    const users = await cf.queryD1(state.cloudflareToken, state.cloudflareAccountId, state.databaseId,
      'SELECT COUNT(*) AS n FROM users');
    const count = users?.[0]?.results?.[0]?.n ?? 0;
    if (count === 0) add('error', 'No accounts exist — nobody can sign in', 'daemonclient password');
    else ok(`${count} account${count === 1 ? '' : 's'}`);
  } catch (e) {
    s2.fail('Database');
    add('error', `Cannot query the database: ${e.message}`, 'Check the token has D1:Edit permission');
  }

  // ── API
  const s3 = spinner('API');
  try {
    const res = await fetch(`${state.workerUrl}/api/health`, { signal: AbortSignal.timeout(15000) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`health returned ${res.status}`);
    s3.succeed(`API responding (worker ${body.version})`);
    if (body.database !== 'connected') {
      add('error', 'The worker has no database binding', 'daemonclient update');
    }
  } catch (e) {
    s3.fail('API');
    add('error', `API not responding: ${e.message}`, 'daemonclient update, then wait a minute');
  }

  // ── Telegram
  const s4 = spinner('Telegram');
  try {
    const me = await tg.getMe(state.telegramBotToken);
    s4.succeed(`Telegram bot @${me.username}`);
    try {
      await tg.verifyChannelAccess(state.telegramBotToken, state.telegramChannelId);
      ok('Bot can post to the channel');
    } catch (e) {
      add('error', `Bot cannot post to the channel: ${e.message}`,
        'Re-add the bot as a channel admin with post/edit/delete rights');
    }
  } catch (e) {
    s4.fail('Telegram');
    add('error', `Telegram bot token rejected: ${e.message}`, 'Get a fresh token from @BotFather, then re-run setup');
  }

  // ── Processor
  if (state.processorUrl) {
    const s5 = spinner('Processor');
    try {
      const res = await fetch(`${state.processorUrl}/health`, { signal: AbortSignal.timeout(90000) });
      const body = await res.json().catch(() => ({}));
      if (res.ok) s5.succeed('Processor healthy');
      else {
        s5.fail('Processor');
        add('warn', `Processor unhealthy: ${(body.problems || []).join('; ') || res.status}`,
          'Check its logs on Render, or run: daemonclient processor');
      }
    } catch {
      s5.fail('Processor');
      add('warn', 'Processor did not answer (a free instance may be asleep — this is usually fine)',
        'It wakes on the next conversion attempt');
    }
  } else {
    info('No processor configured — HEIC and video thumbnails will be blank');
  }

  report(findings, state);
}

function report(findings, state) {
  blank();
  const errors = findings.filter((f) => f.level === 'error');
  const warns = findings.filter((f) => f.level === 'warn');

  if (!errors.length && !warns.length) {
    panel('Everything looks healthy', [
      'No problems found.',
      '',
      c.gray('If something still misbehaves, run the failing action and note the'),
      c.gray('exact error, then open an issue with the report below.'),
    ]);
  } else {
    const lines = [];
    for (const f of errors) {
      lines.push(`${symbols.fail} ${f.message}`);
      if (f.fix) lines.push(`   ${c.gray('fix:')} ${accent(f.fix)}`);
    }
    for (const f of warns) {
      lines.push(`${c.yellow('!')} ${f.message}`);
      if (f.fix) lines.push(`   ${c.gray('fix:')} ${accent(f.fix)}`);
    }
    panel(`${errors.length} problem${errors.length === 1 ? '' : 's'}, ${warns.length} warning${warns.length === 1 ? '' : 's'}`,
      lines, { color: errors.length ? c.red : c.yellow });
  }

  blank();
  line(c.bold('  Report (safe to share — secrets are removed)'));
  blank();
  const safe = redact({
    worker: state.workerName,
    workerUrl: state.workerUrl,
    account: state.cloudflareAccountId ? `${String(state.cloudflareAccountId).slice(0, 8)}…` : null,
    database: state.databaseName,
    telegramBot: state.telegramBotUsername ? `@${state.telegramBotUsername}` : null,
    processor: state.processorUrl || null,
    steps: Object.keys(state.steps || {}),
    lastUpdate: state.lastUpdate || null,
    node: process.versions.node,
    platform: `${process.platform} ${process.arch}`,
  });
  for (const l of JSON.stringify(safe, null, 2).split('\n')) line(c.gray(`  ${l}`));
  blank();
}
