// `daemonclient processor` — attach, change, or remove the media processor.

import { c, accent, line, blank, panel, ok, fail, warn, info, hint, spinner, ask, confirm, select, symbols } from '../ui.mjs';
import { loadState, saveState, isDone } from '../state.mjs';
import * as cf from '../api/cloudflare.mjs';

export async function runProcessor() {
  const state = loadState();
  blank();

  if (!isDone(state, 'deploy')) {
    fail('Nothing deployed from this folder yet.');
    hint(`Run ${accent('daemonclient setup')} first.`);
    return;
  }

  panel('Media processor', [
    c.gray('Cloudflare Workers cannot decode iPhone HEIC photos — that needs more'),
    c.gray('CPU than a worker is allowed. This small companion service does it, on'),
    c.gray('a free instance you own. (Other formats Telegram thumbnails for you.)'),
    '',
    state.processorUrl
      ? `Currently: ${c.bold(state.processorUrl)}`
      : c.gray('Currently: none — HEIC photos show no grid thumbnail.'),
  ]);
  blank();

  const action = await select('What would you like to do?', [
    { label: state.processorUrl ? 'Point at a different one' : 'Connect one', value: 'set' },
    { label: 'Show deployment instructions', value: 'guide' },
    ...(state.processorUrl ? [{ label: 'Disconnect the current one', value: 'remove' }] : []),
    { label: 'Nothing, exit', value: 'exit' },
  ]);

  if (action === 'exit') return;

  if (action === 'guide') {
    blank();
    line(`  ${c.bold('Deploy on Vercel (free)')}`);
    line(`    1. Install the Vercel CLI if you need it: ${accent('npm i -g vercel')}`);
    line(`    2. From this repository: ${accent('cd processor && npx vercel deploy --prod')}`);
    line('    3. Set two environment variables on the Vercel project, then redeploy:');
    line(`         FIREBASE_PROJECT_ID = ${accent(state.firebaseProjectId || '(your Firebase project id)')}`);
    line(`         OWNER_UID           = ${accent(state.adminUserId || '(your user id)')}`);
    line('    4. Copy the service URL once the deploy finishes');
    blank();
    hint('OWNER_UID pins the instance to your account; FIREBASE_PROJECT_ID must match your project or every conversion is rejected.');
    blank();
    if (!(await confirm('Connect it now?', true))) return;
  }

  if (action === 'remove') {
    await writeProcessorUrl(state, null);
    delete state.processorUrl;
    saveState(state);
    ok('Processor disconnected. HEIC photos will stop getting grid thumbnails.');
    blank();
    return;
  }

  let url = '';
  while (true) {
    url = (await ask('Processor URL', { defaultValue: state.processorUrl || '' })).replace(/\/+$/, '');
    if (!url) return;
    const s = spinner('Checking it (a sleeping free instance can take a minute)');
    try {
      const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(90000) });
      const body = await res.json().catch(() => ({}));
      if (!String(body?.service || '').includes('daemonclient')) {
        throw new Error('That URL did not answer like a DaemonClient processor.');
      }
      if (!body.ownerPinned) {
        s.stop();
        warn('This processor is not pinned to a single account (OWNER_UID is unset).');
        hint('Anyone with a valid token for its Firebase project could use it. Fine if you are the only user; otherwise set OWNER_UID and redeploy.');
        if (!(await confirm('Use it anyway?', false))) continue;
      } else {
        s.succeed(`Healthy — HEIC thumbnails: ${body.capabilities?.heicThumbnail ? 'yes' : 'no'}`);
      }
      break;
    } catch (e) {
      s.fail(e.message);
      if (!(await confirm('Try another URL?', true))) return;
    }
  }

  await writeProcessorUrl(state, `${url}/convertHeicThumbnail`);
  state.processorUrl = url;
  saveState(state);
  blank();
  ok('Connected. Missing thumbnails will fill in over the next few minutes as the app is used.');
  blank();
}

/** Merge the processor URL into the worker's telegram config row. */
async function writeProcessorUrl(state, convertUrl) {
  const s = spinner('Saving');
  try {
    const existing = await cf.queryD1(
      state.cloudflareToken, state.cloudflareAccountId, state.databaseId,
      'SELECT value FROM config WHERE key = ?', ['telegram'],
    );
    const current = JSON.parse(existing?.[0]?.results?.[0]?.value || '{}');
    const next = { ...current };
    if (convertUrl) next.heicConvertUrl = convertUrl;
    else delete next.heicConvertUrl;

    await cf.queryD1(
      state.cloudflareToken, state.cloudflareAccountId, state.databaseId,
      'INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)', ['telegram', JSON.stringify(next)],
    );
    s.succeed('Saved');
  } catch (e) {
    s.fail(`Could not save: ${e.message}`);
    throw e;
  }
}
