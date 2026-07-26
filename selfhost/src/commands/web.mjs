// `daemonclient web` — build and deploy the three web apps to YOUR Firebase.
//
// This is the "host it on Firebase serverless" step. It builds all three apps
// from your own checkout — the accounts dashboard (the main page, the same one
// the hosted service uses), Photos, and Drive — each pointed at YOUR worker and
// YOUR Firebase, then deploys them to Firebase Hosting on your own project. Free,
// serverless, and nothing here touches the operator: a self-host build of every
// app is verified to contain no operator address.
//
// Three Firebase Hosting sites in one project (all free on the Spark plan):
//   <project>.web.app         → the dashboard (main page)
//   <project>-photos.web.app  → Photos
//   <project>-drive.web.app   → Drive
//
// Firebase Hosting deploy needs the Firebase CLI signed in as you (it is YOUR
// project). We never see it. If you are not signed in, the command tells you the
// one command to run and stops before changing anything.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  c, accent, line, blank, panel, ok, fail, warn, info, hint, spinner, confirm,
} from '../ui.mjs';
import { loadState, saveState, isDone } from '../state.mjs';

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..');

const APPS = {
  dashboard: { dir: 'accounts-portal', dist: 'dist', label: 'Dashboard (main page)' },
  photos: { dir: 'immich/web', dist: 'build', label: 'Photos' },
  drive: { dir: 'drive', dist: 'dist', label: 'Drive' },
};

const bigBuffer = { maxBuffer: 64 * 1024 * 1024 };
const firstLine = (e) => String(e?.stderr || e?.message || e).split('\n').find((l) => l.trim()) || 'unknown error';
const fullErr = (e) => String(e?.stderr || e?.message || e);

// A Firebase Hosting site id: lowercase alphanumerics + hyphens, max 30 chars,
// no leading/trailing hyphen. A project id can be up to 30 chars, so appending
// "-photos" can overflow — truncate the project part when it would.
function siteId(projectId, suffix) {
  const full = `${projectId}-${suffix}`;
  if (full.length <= 30) return full;
  const keep = Math.max(1, 30 - (suffix.length + 1));
  return `${projectId.slice(0, keep).replace(/-+$/, '')}-${suffix}`;
}

export async function runWeb() {
  const state = loadState();
  blank();

  if (!isDone(state, 'deploy') || !state.workerUrl) {
    fail('Your worker is not deployed yet.');
    hint(`Run ${accent('daemonclient setup')} first — the web apps need a worker to point at.`);
    return;
  }
  if (!state.firebaseProjectId || !state.firebaseApiKey) {
    fail('No Firebase project recorded.');
    hint(`Run ${accent('daemonclient setup')} and complete the Firebase step.`);
    return;
  }

  const projectId = state.firebaseProjectId;
  const worker = state.workerUrl.replace(/\/+$/, '');
  // One project, three sites. The default site is the project id; the other two
  // are derived and created on demand. All three end in .web.app.
  const sites = {
    dashboard: projectId, // the project's default Hosting site
    photos: siteId(projectId, 'photos'),
    drive: siteId(projectId, 'drive'),
  };
  const urls = {
    dashboard: `https://${sites.dashboard}.web.app`,
    photos: `https://${sites.photos}.web.app`,
    drive: `https://${sites.drive}.web.app`,
  };

  panel('Deploy the web apps', [
    c.gray('Builds all three apps from this checkout, each pointed at your worker,'),
    c.gray('and deploys them to Firebase Hosting on your own project. Free.'),
    '',
    `Worker     ${c.bold(worker)}`,
    `Firebase   ${c.bold(projectId)}`,
    '',
    `Dashboard  ${c.bold(urls.dashboard)}`,
    `Photos     ${c.bold(urls.photos)}`,
    `Drive      ${c.bold(urls.drive)}`,
  ]);
  blank();
  if (!(await confirm('Build and deploy these three?', true))) return;

  // ── Build each app, self-host mode, pointed at the worker ─────────────────
  // Photos (SvelteKit) reads PUBLIC_* from the process env at build.
  await buildApp('photos', {
    PUBLIC_SELF_HOST: '1',
    PUBLIC_DAEMONCLIENT_WORKER_URL: worker,
  });

  // Drive (plain Vite) reads VITE_* from the process env at build.
  await buildApp('drive', {
    VITE_SELF_HOST: '1',
    VITE_API_BASE: worker,
  });

  // The dashboard (accounts-portal) reads .env.selfhost via `vite build --mode
  // selfhost`, matching `daemonclient dashboard`. It needs the Firebase web
  // config (apiKey/authDomain/projectId are enough for Auth) and the two service
  // URLs so its cards link to the Photos/Drive we just built.
  writeDashboardEnv(state, worker, urls.photos, urls.drive);
  await buildApp('dashboard', {}, ['vite', 'build', '--mode', 'selfhost']);

  // ── Firebase Hosting config for the three sites ───────────────────────────
  writeFirebaseConfig(projectId, sites);

  // ── Deploy ────────────────────────────────────────────────────────────────
  const cli = await firebaseCli();
  if (!cli.available) {
    blank();
    warn('The Firebase CLI is not available, so the apps were built but not deployed.');
    hint('Install it and deploy by hand:');
    line(`    ${accent('npm i -g firebase-tools')}`);
    line(`    ${accent(`firebase login && firebase deploy --only hosting --config ${SELFHOST_FIREBASE_CONFIG} --project ${projectId}`)}`);
    finishManual(state, urls);
    return;
  }
  if (!(await firebaseLoggedIn(cli, projectId))) {
    blank();
    warn('The Firebase CLI is not signed in to a Google account that can see this project.');
    hint('Sign in (this opens a browser — it is YOUR Google account, we never see it):');
    line(`    ${accent(`${cli.cmd} login`)}`);
    hint('Then run `daemonclient web` again.');
    finishManual(state, urls);
    return;
  }

  // Create the two extra sites (the default site already exists). "already exists"
  // is success on a re-run.
  for (const key of ['photos', 'drive']) {
    const s = spinner(`Ensuring the ${key} site exists (${sites[key]})`);
    try {
      await run(cli.cmd, [...cli.args, 'hosting:sites:create', sites[key], '--project', projectId], { cwd: REPO_ROOT, ...bigBuffer });
      s.succeed(`Created ${sites[key]}`);
    } catch (e) {
      const msg = fullErr(e); // scan the WHOLE error — firebase-tools often prints the reason on a later line
      if (/already exists|already been created|entity already exists|\b409\b/i.test(msg)) {
        s.succeed(`${sites[key]} already exists`);
      } else if (/has not been used|has not been enabled|SERVICE_DISABLED|firebasehosting\.googleapis\.com/i.test(msg)) {
        s.fail('Firebase Hosting is not enabled on this project yet.');
        hint('Open the Firebase console → Hosting → Get started once (that enables the Hosting API and creates the default site), then re-run `daemonclient web`.');
        return;
      } else {
        s.fail(`Could not create ${sites[key]}: ${firstLine(e)}`);
        hint('Create it in the Firebase console under Hosting → Add another site, then re-run.');
        return;
      }
    }
  }

  const s2 = spinner('Deploying to Firebase Hosting (all three sites)');
  try {
    await run(cli.cmd, [...cli.args, 'deploy', '--only', 'hosting', '--config', SELFHOST_FIREBASE_CONFIG, '--project', projectId], { cwd: REPO_ROOT, ...bigBuffer });
    s2.succeed('Deployed');
  } catch (e) {
    s2.fail(`Deploy failed: ${firstLine(e)}`);
    hint(`The built apps are on disk. Retry with: ${accent(`firebase deploy --only hosting --config ${SELFHOST_FIREBASE_CONFIG} --project ${projectId}`)}`);
    return;
  }

  // ── Let the worker accept these origins ───────────────────────────────────
  // Record the URLs on `state` BEFORE allowOrigins: it saves state and then runs
  // `update`, which reloads and re-saves state itself — writing after it would
  // clobber the fresh lastUpdate.
  state.photosUrl = urls.photos;
  state.driveUrl = urls.drive;
  state.dashboardUrl = urls.dashboard;
  await allowOrigins(state, Object.values(urls));

  blank();
  panel('Your cloud is live on the web', [
    `Open ${c.bold(urls.dashboard)} and sign in with ${c.bold(state.adminEmail || 'your account')}.`,
    'From there, open Photos or Drive.',
    '',
    `Photos  ${urls.photos}`,
    `Drive   ${urls.drive}`,
  ]);
  blank();
}

// ── helpers ───────────────────────────────────────────────────────────────────

async function buildApp(key, env, cmd = ['vite', 'build']) {
  const app = APPS[key];
  const cwd = path.join(REPO_ROOT, app.dir);
  if (!fs.existsSync(path.join(cwd, 'node_modules'))) {
    const s = spinner(`Installing ${app.label} dependencies (first time only)`);
    try { await run('npm', ['install'], { cwd, ...bigBuffer }); s.succeed('Dependencies installed'); }
    catch (e) { s.fail(`npm install failed: ${firstLine(e)}`); throw e; }
  }
  const s = spinner(`Building ${app.label}`);
  try {
    await run('npx', cmd, { cwd, ...bigBuffer, env: { ...process.env, NODE_ENV: 'production', ...env } });
    // Verify the build actually points at the worker and NOT the operator — a
    // silent misconfig here is exactly the "leaks to us" failure we must never ship.
    assertNoOperator(key, cwd, app.dist);
    s.succeed(`Built ${app.label}`);
  } catch (e) { s.fail(`Build failed: ${firstLine(e)}`); throw e; }
}

// The operator host each app would use for USER DATA if the self-host env failed
// to apply. This is the leak that must never ship, so finding it is a hard error.
// (The dashboard bundle also contains the operator provisioning worker inside
// setup code that self-host never reaches; that is a link, not a data path, and
// is tracked separately — so we check only the data host here.)
const DATA_HOST = {
  photos: 'api.daemonclient.uz',
  drive: 'immich-api.sadrikov49.workers.dev',
  dashboard: 'api.daemonclient.uz',
};

function assertNoOperator(key, cwd, dist) {
  const host = DATA_HOST[key];
  if (!host) return;
  const distDir = path.join(cwd, dist);
  // Fail CLOSED: a missing or empty dist means the build produced nothing, which
  // must not silently pass a guard whose whole job is to refuse a bad build.
  if (!fs.existsSync(distDir)) {
    throw new Error(`${key} build produced no ${dist}/ directory — the build did not run.`);
  }
  const hits = [];
  let scanned = 0;
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      else if (/\.(js|mjs|cjs|html|json|css|map)$/.test(name)) {
        scanned++;
        if (fs.readFileSync(p, 'utf8').includes(host)) hits.push(path.relative(cwd, p));
      }
    }
  };
  walk(distDir);
  if (scanned === 0) {
    throw new Error(`${key} build wrote no scannable files to ${dist}/ — refusing to deploy an empty build.`);
  }
  if (hits.length) {
    throw new Error(
      `self-host build of ${key} still routes data to the operator host ${host} (${hits[0]}) — ` +
      `refusing to ship it. Check the self-host env vars were passed to the build.`,
    );
  }
}

function writeDashboardEnv(state, worker, photosUrl, driveUrl) {
  const portal = path.join(REPO_ROOT, APPS.dashboard.dir);
  const body = [
    '# Written by `daemonclient web`. Local only — holds no secrets, but not committed.',
    'VITE_SELF_HOST=1',
    `VITE_FIREBASE_API_KEY=${state.firebaseApiKey}`,
    `VITE_FIREBASE_AUTH_DOMAIN=${state.firebaseProjectId}.firebaseapp.com`,
    `VITE_FIREBASE_PROJECT_ID=${state.firebaseProjectId}`,
    `VITE_API_BASE=${worker}`,
    `VITE_PHOTOS_URL=${photosUrl}`,
    `VITE_DRIVE_URL=${driveUrl}`,
    '',
  ].join('\n');
  fs.writeFileSync(path.join(portal, '.env.selfhost'), body, { mode: 0o600 });
}

// Per-app SPA rewrites, matching the operator's own firebase.json so routing
// behaves identically on a self-hosted deploy.
function hostingEntry(site, publicDir, kind) {
  const base = { site, public: publicDir, ignore: ['firebase.json', '**/.*', '**/node_modules/**'] };
  if (kind === 'photos') {
    return { ...base, cleanUrls: true, rewrites: [{ source: '**', destination: '/app.html' }] };
  }
  if (kind === 'drive') {
    return { ...base, rewrites: [
      { source: '/login', destination: '/app.html' },
      { source: '/dashboard', destination: '/app.html' },
      { source: '**', destination: '/index.html' },
    ] };
  }
  return { ...base, rewrites: [{ source: '**', destination: '/index.html' }] }; // dashboard
}

const SELFHOST_FIREBASE_CONFIG = 'firebase.selfhost.json';

function writeFirebaseConfig(projectId, sites) {
  const firebaseJson = {
    hosting: [
      hostingEntry(sites.dashboard, `${APPS.dashboard.dir}/${APPS.dashboard.dist}`, 'dashboard'),
      hostingEntry(sites.photos, `${APPS.photos.dir}/${APPS.photos.dist}`, 'photos'),
      hostingEntry(sites.drive, `${APPS.drive.dir}/${APPS.drive.dist}`, 'drive'),
    ],
  };
  // A dedicated config file, NOT firebase.json — the repo ships the operator's own
  // firebase.json (which targets the operator's dirs/sites), and we must not read
  // or clobber it. `firebase deploy --config firebase.selfhost.json` uses ours.
  // The `site` key on each entry names the target site directly, so no .firebaserc
  // target mapping is needed and the operator's .firebaserc is left untouched.
  fs.writeFileSync(path.join(REPO_ROOT, SELFHOST_FIREBASE_CONFIG), JSON.stringify(firebaseJson, null, 2));
}

async function firebaseCli() {
  // Prefer a globally-installed firebase; fall back to npx firebase-tools.
  try { await run('firebase', ['--version'], { ...bigBuffer }); return { available: true, cmd: 'firebase', args: [] }; }
  catch {}
  try { await run('npx', ['--yes', 'firebase-tools', '--version'], { cwd: REPO_ROOT, ...bigBuffer }); return { available: true, cmd: 'npx', args: ['--yes', 'firebase-tools'] }; }
  catch { return { available: false }; }
}

async function firebaseLoggedIn(cli, projectId) {
  try {
    const { stdout } = await run(cli.cmd, [...cli.args, 'projects:list', '--json'], { cwd: REPO_ROOT, ...bigBuffer });
    // Match the project id EXACTLY, not as a substring — otherwise access to an
    // unrelated `<projectId>-staging` would read as "logged in" and the deploy
    // would fail later with a confusing error instead of prompting a login.
    const parsed = JSON.parse(stdout);
    const projects = Array.isArray(parsed?.result) ? parsed.result : (Array.isArray(parsed) ? parsed : []);
    return projects.some((p) => (p?.projectId || p?.id) === projectId);
  } catch { return false; }
}

async function allowOrigins(state, newOrigins) {
  const origins = new Set((state.allowedOrigins || 'http://localhost:5173').split(',').map((o) => o.trim()).filter(Boolean));
  for (const o of newOrigins) origins.add(o.replace(/\/+$/, ''));
  state.allowedOrigins = [...origins].join(',');
  // Persist origins (and any URL fields the caller set on `state`) unconditionally,
  // so declining the worker update still saves them.
  saveState(state);
  blank();
  info('The worker must allow these addresses or the browser blocks their API calls.');
  if (await confirm('Update the worker now?', true)) {
    const { runUpdate } = await import('./update.mjs');
    await runUpdate({ silent: true });
  } else {
    hint(`Run ${accent('daemonclient update')} when you are ready.`);
  }
}

function finishManual(state, urls) {
  state.photosUrl = urls.photos;
  state.driveUrl = urls.drive;
  state.dashboardUrl = urls.dashboard;
  saveState(state);
  blank();
  ok(`All three apps are built on disk and ${SELFHOST_FIREBASE_CONFIG} is written.`);
  hint(`Deploy when ready: ${accent(`firebase deploy --only hosting --config ${SELFHOST_FIREBASE_CONFIG} --project ${state.firebaseProjectId}`)}`);
  blank();
}
