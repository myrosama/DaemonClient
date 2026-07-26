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
    c.gray('Cloudflare Workers cannot decode iPhone HEIC photos or pull a frame'),
    c.gray('out of a video — both need more CPU than a worker is allowed. This'),
    c.gray('small companion service does it, on a free instance you own.'),
    '',
    state.processorUrl
      ? `Currently: ${c.bold(state.processorUrl)}`
      : c.gray('Currently: none — HEIC and video thumbnails stay blank.'),
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
    line(`  ${c.bold('Deploy on Render (free)')}`);
    line('    1. Fork this repository on GitHub');
    line(`    2. Open ${accent('https://render.com/deploy')} and select your fork`);
    line(`       ${c.gray('Render reads processor/render.yaml — no other config needed')}`);
    line('    3. Set the environment variables it asks for:');
    line(`         OWNER_UID = ${accent(state.adminUserId || '(your user id)')}`);
    line(`         ${c.gray('FIREBASE_PROJECT_ID can stay blank on a self-hosted install')}`);
    line('    4. Copy the service URL once the first deploy finishes');
    blank();
    hint('OWNER_UID pins the instance to your account, so its URL is safe to store in config.');
    blank();
    if (!(await confirm('Connect it now?', true))) return;
  }

  if (action === 'remove') {
    await writeProcessorUrl(state, null);
    delete state.processorUrl;
    saveState(state);
    ok('Processor disconnected. HEIC and video thumbnails will stop being generated.');
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
        s.succeed(`Healthy — HEIC: ${body.capabilities?.heicThumbnail ? 'yes' : 'no'}, video posters: ${body.capabilities?.videoPoster ? 'yes' : 'no'}`);
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
