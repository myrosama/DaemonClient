// `daemonclient update` — rebuild from the current source and redeploy.
//
// The update path is deliberately dumb: it does not download code from us, it
// does not self-modify, and it does not run anything it did not just build from
// the git checkout the operator controls. Pulling new code is `git pull`, which
// we prompt for but never do silently — an update that rewrites your source
// without asking is how supply-chain incidents start.

import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { c, accent, line, blank, panel, ok, fail, warn, info, hint, spinner, confirm } from '../ui.mjs';
import { loadState, saveState, isDone } from '../state.mjs';
import * as cf from '../api/cloudflare.mjs';
import { buildWorkerBundle } from '../build.mjs';
import { workerBindings } from '../bindings.mjs';
import { buildVersion, versionWarning } from '../version.mjs';
import { ensureEncryptionKeys } from '../zke.mjs';
import { MIGRATION_SQL, splitStatements } from '../../../schema/schema.mjs';

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..');

export async function runUpdate({ silent = false } = {}) {
  const state = loadState();
  blank();

  if (!isDone(state, 'deploy')) {
    fail('Nothing deployed from this folder yet.');
    hint(`Run ${accent('daemonclient setup')} first.`);
    return;
  }

  let head = 'unknown';
  try {
    const { stdout } = await run('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO_ROOT });
    head = stdout.trim();
  } catch {}

  if (!silent) {
    panel('Update', [
      `Worker   ${c.bold(state.workerName)}`,
      `Source   ${c.bold(head)}`,
      '',
      c.gray('This rebuilds the worker from the code currently in this folder and'),
      c.gray('redeploys it. Your database, files and sign-in are untouched.'),
    ]);
    blank();
  }

  // Offer to fetch new code, but let the operator decide.
  try {
    const { stdout } = await run('git', ['status', '--porcelain'], { cwd: REPO_ROOT });
    if (stdout.trim()) {
      warn('You have uncommitted changes — they will be included in this build.');
    } else if (!silent && await confirm('Pull the latest code from git first?', true)) {
      const s = spinner('git pull');
      try {
        await run('git', ['pull', '--ff-only'], { cwd: REPO_ROOT });
        const { stdout: newHead } = await run('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO_ROOT });
        s.succeed(`Updated source to ${newHead.trim()}`);
      } catch (e) {
        s.fail(`git pull failed: ${e.message.split('\n')[0]}`);
        if (!(await confirm('Deploy the code you already have?', false))) return;
      }
    }
  } catch {
    info('Not a git checkout — deploying the code in this folder as-is.');
  }

  // Schema first: new code may expect columns the old database lacks. Every
  // statement is CREATE/ALTER-if-missing, so this is safe to repeat.
  const s1 = spinner('Applying any new database changes');
  try {
    for (const statement of splitStatements(MIGRATION_SQL)) {
      await cf.queryD1(state.cloudflareToken, state.cloudflareAccountId, state.databaseId, statement)
        .catch((e) => {
          if (!/already exists|duplicate column/i.test(e.message)) throw e;
        });
    }
    s1.succeed('Database ready');
  } catch (e) {
    s1.fail(`Schema update failed: ${e.message}`);
    return;
  }

  // Installs created before the CLI seeded key material have encryption enabled
  // with an empty password, which the worker treats as fail-closed: every upload
  // is refused. Repairing that here means an operator who runs `update` — the
  // command that brings in the fix — also gets the data fix, without being told
  // to reinstall. Keys that already exist are never rewritten (see zke.mjs).
  const s1b = spinner('Checking encryption keys');
  try {
    const outcome = await ensureEncryptionKeys({
      query: (sql, params) => cf.queryD1(
        state.cloudflareToken, state.cloudflareAccountId, state.databaseId, sql, params),
    });
    s1b.succeed(outcome.seeded ? 'Encryption keys generated' : 'Encryption keys present');
  } catch (e) {
    // Deliberately not fatal. The keys are untouched either way, and refusing to
    // deploy over a failed *read* would block the very update that carries the
    // fix for whatever is broken.
    s1b.fail(`Could not check the encryption keys: ${e.message}`);
    warn('Nothing was changed. Run "daemonclient doctor" after this finishes.');
  }

  const s2 = spinner('Building');
  let bundle;
  try {
    bundle = await buildWorkerBundle(REPO_ROOT);
    s2.succeed(`Built (${Math.round(bundle.length / 1024)} KB)`);
  } catch (e) {
    s2.fail(`Build failed: ${e.message}`);
    return;
  }

  const vWarn = versionWarning(REPO_ROOT);
  if (vWarn) warn(vWarn);

  const s3 = spinner('Deploying');
  try {
    const bindings = workerBindings(state, { repoRoot: REPO_ROOT });
    await cf.deployWorker(state.cloudflareToken, state.cloudflareAccountId, state.workerName, bundle, bindings);
    s3.succeed('Deployed');
  } catch (e) {
    s3.fail(`Deploy failed: ${e.message}`);
    return;
  }

  const s4 = spinner('Checking it came back up');
  let healthy = false;
  for (let i = 0; i < 8; i++) {
    try {
      const res = await fetch(`${state.workerUrl}/api/health`, { signal: AbortSignal.timeout(8000) });
      if (res.ok) { healthy = true; break; }
    } catch {}
    await new Promise((r) => setTimeout(r, 2000));
  }
  healthy ? s4.succeed('Healthy') : s4.fail('Not answering yet — give it a minute, then run "daemonclient status".');

  state.lastUpdate = { at: new Date().toISOString(), source: head };
  saveState(state);
  blank();
  ok(`Updated to ${c.bold(buildVersion(REPO_ROOT))} ${c.gray(`(built from ${head})`)}`);
  blank();
}
