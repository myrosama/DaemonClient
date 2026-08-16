// `daemonclient dashboard` — build the web dashboard and put it online.
//
// This is the accounts portal, the same one the hosted service uses, built
// against the operator's own Firebase project and their own worker. Building it
// here rather than shipping a prebuilt bundle means they run code they can read
// from their own checkout.
//
// It deploys to Cloudflare Pages because they already have a Cloudflare
// account — no fifth provider to sign up for. Anything that serves static files
// works just as well, and the built output is left on disk for that.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  c, accent, line, blank, panel, ok, fail, warn, info, hint, spinner, ask, confirm, select,
} from '../ui.mjs';
import { loadState, saveState, isDone } from '../state.mjs';

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..');
const PORTAL = path.join(REPO_ROOT, 'accounts-portal');

export async function runDashboard() {
  const state = loadState();
  blank();

  // `!state.workerUrl` as well as the deploy flag, matching web.mjs. Without
  // it this builds the dashboard with an EMPTY VITE_API_BASE, deploys it, and
  // finishes with a green "Dashboard is live" for a page that can never reach
  // an API. Same silent-success class as the blank address setup used to print.
  if (!isDone(state, 'deploy') || !state.workerUrl) {
    fail('Your worker is not deployed yet, or has no address.');
    hint(`Run ${accent('daemonclient setup')} first — the dashboard needs a worker to point at.`);
    return;
  }
  if (!state.firebaseProjectId || !state.firebaseApiKey) {
    fail('No Firebase project recorded.');
    hint(`Run ${accent('daemonclient setup')} and complete the Firebase step.`);
    return;
  }

  panel('Dashboard', [
    c.gray('A web page for signing in, opening Photos and Drive, and seeing'),
    c.gray('whether everything is healthy. Built from this checkout, against'),
    c.gray('your Firebase project and your worker.'),
    '',
    `Worker    ${c.bold(state.workerUrl)}`,
    `Firebase  ${c.bold(state.firebaseProjectId)}`,
  ]);
  blank();

  // Where the user put Photos and Drive. Blank is fine — the dashboard shows
  // those cards as unavailable rather than linking somewhere wrong.
  const photosUrl = await ask('Photos app URL (blank if not deployed yet)', { defaultValue: state.photosUrl || '' });
  const driveUrl = await ask('Drive app URL (blank if not deployed yet)', { defaultValue: state.driveUrl || '' });

  const envFile = path.join(PORTAL, '.env.selfhost');
  const envBody = [
    '# Written by `daemonclient dashboard`. Safe to commit? No — treat as local.',
    'VITE_SELF_HOST=1',
    `VITE_FIREBASE_API_KEY=${state.firebaseApiKey}`,
    `VITE_FIREBASE_AUTH_DOMAIN=${state.firebaseProjectId}.firebaseapp.com`,
    `VITE_FIREBASE_PROJECT_ID=${state.firebaseProjectId}`,
    `VITE_API_BASE=${state.workerUrl}`,
    `VITE_PHOTOS_URL=${photosUrl}`,
    `VITE_DRIVE_URL=${driveUrl}`,
    '',
  ].join('\n');
  fs.writeFileSync(envFile, envBody, { mode: 0o600 });

  if (!fs.existsSync(path.join(PORTAL, 'node_modules'))) {
    const s = spinner('Installing the portal dependencies (first time only)');
    try {
      await run('npm', ['install'], { cwd: PORTAL, maxBuffer: 64 * 1024 * 1024 });
      s.succeed('Dependencies installed');
    } catch (e) {
      s.fail(`npm install failed: ${firstLine(e)}`);
      return;
    }
  }

  const s2 = spinner('Building');
  try {
    // Vite reads .env.<mode>, so building in "selfhost" mode picks up the file
    // written above without disturbing any .env the operator already has.
    await run('npx', ['vite', 'build', '--mode', 'selfhost'], {
      cwd: PORTAL,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, NODE_ENV: 'production' },
    });
    s2.succeed('Built');
  } catch (e) {
    s2.fail(`Build failed: ${firstLine(e)}`);
    return;
  }

  const dist = path.join(PORTAL, 'dist');
  blank();
  const where = await select('Where should it go?', [
    { label: 'Cloudflare Pages', value: 'pages', hint: 'you already have the account' },
    { label: 'Just build it — I will upload dist/ myself', value: 'manual' },
  ]);

  if (where === 'manual') {
    blank();
    ok(`Built into ${c.bold(dist)}`);
    hint('Upload that folder to any static host. Remember to add its address to ALLOWED_ORIGINS (daemonclient update), or the browser will block its API calls.');
    blank();
    state.photosUrl = photosUrl;
    state.driveUrl = driveUrl;
    saveState(state);
    return;
  }

  const projectName = await ask('Pages project name', {
    defaultValue: state.pagesProject || `${state.workerName}-dashboard`,
    validate: (v) => (/^[a-z0-9][a-z0-9-]{1,54}$/.test(v) ? null : 'Lowercase letters, numbers and dashes.'),
  });

  const s3 = spinner('Uploading to Cloudflare Pages');
  let deployedUrl = '';
  try {
    const { stdout } = await run(
      'npx',
      ['wrangler', 'pages', 'deploy', dist, '--project-name', projectName, '--commit-dirty=true'],
      {
        cwd: REPO_ROOT,
        maxBuffer: 32 * 1024 * 1024,
        env: {
          ...process.env,
          CLOUDFLARE_API_TOKEN: state.cloudflareToken,
          CLOUDFLARE_ACCOUNT_ID: state.cloudflareAccountId,
          WRANGLER_SEND_METRICS: 'false',
        },
      },
    );
    const match = stdout.match(/https:\/\/[a-z0-9.-]+\.pages\.dev/i);
    deployedUrl = match ? match[0] : '';
    s3.succeed(deployedUrl ? `Deployed to ${c.bold(deployedUrl)}` : 'Deployed');
  } catch (e) {
    s3.fail(`Upload failed: ${firstLine(e)}`);
    hint('Your Cloudflare token may need the "Cloudflare Pages: Edit" permission as well.');
    hint(`The built site is in ${dist} — you can upload it by hand.`);
    return;
  }

  // The dashboard calls the worker from the browser, so its address has to be
  // allowed or every request is blocked by CORS.
  if (deployedUrl) {
    const origins = new Set(
      (state.allowedOrigins || 'http://localhost:5173').split(',').map((o) => o.trim()).filter(Boolean),
    );
    origins.add(deployedUrl);
    if (photosUrl) origins.add(photosUrl.replace(/\/+$/, ''));
    if (driveUrl) origins.add(driveUrl.replace(/\/+$/, ''));
    state.allowedOrigins = [...origins].join(',');
    state.dashboardUrl = deployedUrl;
    blank();
    info('Your worker needs to allow this address before the dashboard can talk to it.');
    if (await confirm('Update the worker now?', true)) {
      const { runUpdate } = await import('./update.mjs');
      saveState(state);
      await runUpdate({ silent: true });
    } else {
      hint(`Run ${accent('daemonclient update')} when you are ready.`);
    }
  }

  state.photosUrl = photosUrl;
  state.driveUrl = driveUrl;
  state.pagesProject = projectName;
  saveState(state);

  blank();
  panel('Dashboard is live', [
    deployedUrl || dist,
    '',
    `Sign in with ${c.bold(state.adminEmail || 'your Firebase user')}.`,
  ]);
  blank();
}

const firstLine = (e) => String(e?.stderr || e?.message || e).split('\n').find((l) => l.trim()) || 'unknown error';
