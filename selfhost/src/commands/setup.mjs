// The interactive setup flow.
//
// Design rules, learned from watching people abandon self-hosted projects:
//   * Never ask for something without saying exactly where to get it.
//   * Validate every credential the moment it is entered, against the real
//     service, and say what is wrong in plain language.
//   * Never lose work: each completed step is written to disk immediately, and
//     re-running resumes rather than repeating.
//   * Never print a secret back to the screen.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  c, accent, line, blank, panel, rule, step, ok, fail, warn, info, hint,
  ask, askSecret, confirm, select, spinner, symbols,
} from '../ui.mjs';
import { loadState, saveState, markDone, isDone, checkStatePermissions, statePath } from '../state.mjs';
import * as tg from '../api/telegram.mjs';
import * as cf from '../api/cloudflare.mjs';
import { buildWorkerBundle } from '../build.mjs';
import { ensureEncryptionKeys } from '../zke.mjs';
import { MIGRATION_SQL, splitStatements } from '../../../schema/schema.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..');
const TOTAL_STEPS = 7;

const randomSecret = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

export async function runSetup(opts = {}) {
  const state = loadState();

  banner();

  const permWarning = checkStatePermissions();
  if (permWarning) warn(permWarning);

  if (Object.keys(state.steps || {}).length > 0) {
    blank();
    info(`Found a previous run in ${c.bold(statePath())} — completed steps will be skipped.`);
    hint('Delete that file to start over from scratch.');
  }

  await stepPreflight(state);
  await stepTelegram(state);
  await stepCloudflare(state);
  await stepAccount(state);
  await stepDeployWorker(state);
  await stepProcessor(state);
  await stepFinish(state);
}

function banner() {
  blank();
  panel('DaemonClient · self-hosted setup', [
    'This sets up your own private cloud on infrastructure you own:',
    '',
    `  ${symbols.bullet} your Telegram bot and channel  ${c.gray('— stores the files')}`,
    `  ${symbols.bullet} your Cloudflare Worker + D1    ${c.gray('— runs the API')}`,
    `  ${symbols.bullet} your Firebase project          ${c.gray('— your sign-in, your accounts')}`,
    '',
    c.gray('Nothing is sent to us, and nothing you set up depends on us. Every'),
    c.gray('credential goes only to the service it belongs to, straight from this'),
    c.gray('machine. Stop any time with Ctrl-C — progress is saved after each step.'),
  ]);
}

// ── 1. Preflight ────────────────────────────────────────────────────────────

async function stepPreflight(state) {
  step(1, TOTAL_STEPS, 'Checking your machine');

  const major = Number(process.versions.node.split('.')[0]);
  if (major < 18) {
    fail(`Node ${process.versions.node} is too old — this needs Node 18 or newer.`);
    hint('Install a current version from https://nodejs.org and run this again.');
    process.exit(1);
  }
  ok(`Node ${process.versions.node}`);

  const shimSrc = path.join(REPO_ROOT, 'immich-api-shim', 'src', 'index.ts');
  if (!fs.existsSync(shimSrc)) {
    fail('Cannot find immich-api-shim/ — run this from inside a clone of the repository.');
    process.exit(1);
  }
  ok('Repository looks complete');

  const s = spinner('Checking internet access');
  try {
    const res = await fetch('https://api.cloudflare.com/client/v4/ips', { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`status ${res.status}`);
    s.succeed('Internet access');
  } catch (e) {
    s.fail(`Cannot reach the Cloudflare API (${e.message})`);
    hint('Check your connection or proxy settings, then run setup again.');
    process.exit(1);
  }

  markDone(state, 'preflight');
  saveState(state);
}

// ── 2. Telegram ─────────────────────────────────────────────────────────────

async function stepTelegram(state) {
  step(2, TOTAL_STEPS, 'Telegram — where your files will live');

  if (isDone(state, 'telegram')) {
    ok(`Already configured: ${c.bold('@' + state.telegramBotUsername)} → ${state.telegramChannelTitle}`);
    if (!(await confirm('Reconfigure Telegram?', false))) return;
  }

  line();
  hint('Your files are stored as encrypted chunks in a private Telegram channel that only you control. You need two things: a bot, and a channel it can post to.');
  blank();
  line(`  ${c.bold('Create the bot')}`);
  line(`    1. Open Telegram and message ${accent('@BotFather')}`);
  line(`    2. Send ${accent('/newbot')} and follow the two prompts`);
  line(`    3. Copy the token it gives you (looks like ${c.gray('12345:AAH...')})`);
  blank();

  let botToken = state.telegramBotToken || '';
  let me;
  if (!botToken || !(await confirm('Reuse the saved bot token?', true))) {
    botToken = '';
  }

  while (true) {
    if (!botToken) botToken = await askSecret('Paste your bot token');
    const s = spinner('Checking the token with Telegram');
    try {
      me = await tg.getMe(botToken);
      s.succeed(`Bot verified: ${c.bold('@' + me.username)}`);
      break;
    } catch (e) {
      s.fail(e.message);
      hint('Tokens look like 1234567890:AAHdqTcvbXsE... — copy the whole line from BotFather.');
      botToken = '';
    }
  }

  blank();
  line(`  ${c.bold('Create the channel')}`);
  line('    1. In Telegram, create a new channel (Private)');
  line(`    2. Add ${accent('@' + me.username)} to it as an ${c.bold('administrator')}`);
  line(`       ${c.gray('It needs: post messages, edit messages, delete messages')}`);
  line(`    3. Forward any message from the channel to ${accent('@userinfobot')} to get its id`);
  line(`       ${c.gray('The id looks like -1001234567890')}`);
  blank();

  let channelId = state.telegramChannelId || '';
  let channel;
  while (true) {
    if (!channelId) {
      channelId = await ask('Channel id', {
        validate: (v) => (/^-?\d{6,}$/.test(v.trim()) ? null : 'That does not look like a channel id (e.g. -1001234567890).'),
      });
    }
    const s = spinner('Checking the bot can post to the channel');
    try {
      channel = await tg.verifyChannelAccess(botToken, channelId);
      s.succeed(`Channel verified: ${c.bold(channel.title)} — the bot can post`);
      break;
    } catch (e) {
      s.fail(e.message);
      channelId = '';
    }
  }

  await tg.clearWebhook(botToken).catch(() => {});

  state.telegramBotToken = botToken;
  state.telegramBotUsername = me.username;
  state.telegramChannelId = String(channelId);
  state.telegramChannelTitle = channel.title;
  markDone(state, 'telegram');
  saveState(state);
}

// ── 3. Cloudflare ───────────────────────────────────────────────────────────

async function stepCloudflare(state) {
  step(3, TOTAL_STEPS, 'Cloudflare — where the API will run');

  if (isDone(state, 'cloudflare')) {
    ok(`Already configured: account ${c.bold(state.cloudflareAccountName || state.cloudflareAccountId)}`);
    if (!(await confirm('Reconfigure Cloudflare?', false))) return;
  }

  line();
  hint('The API runs as a Cloudflare Worker with a D1 database, both on the free plan. You need an API token so this script can create them for you.');
  blank();
  line(`  ${c.bold('Create the token')}`);
  line(`    1. Open ${accent('https://dash.cloudflare.com/profile/api-tokens')}`);
  line('    2. Create Token → Create Custom Token');
  line('    3. Give it these permissions:');
  for (const p of cf.REQUIRED_TOKEN_PERMISSIONS) line(`         ${symbols.bullet} ${p}`);
  line('    4. Create, then copy the token');
  blank();

  let token = state.cloudflareToken || '';
  if (!token || !(await confirm('Reuse the saved Cloudflare token?', true))) token = '';

  let accounts;
  while (true) {
    if (!token) token = await askSecret('Paste your Cloudflare API token');
    const s = spinner('Verifying the token');
    try {
      await cf.verifyToken(token);
      accounts = await cf.listAccounts(token);
      if (!accounts.length) throw new Error('This token cannot see any account — add the "Account Settings · Read" permission.');
      s.succeed('Token verified');
      break;
    } catch (e) {
      s.fail(e.message);
      hint('Make sure you created a Custom Token with the three permissions listed above, not a Global API Key.');
      token = '';
    }
  }

  let account = accounts[0];
  if (accounts.length > 1) {
    blank();
    account = await select('Which account should host this?', accounts.map((a) => ({ label: a.name, value: a, hint: a.id.slice(0, 8) })));
  }
  ok(`Account: ${c.bold(account.name)}`);

  const suffix = crypto.randomBytes(3).toString('hex');
  const defaultName = `daemonclient-${suffix}`;
  blank();
  const workerName = await ask('Name for your worker', {
    defaultValue: defaultName,
    validate: (v) => (/^[a-z0-9][a-z0-9-]{1,50}$/.test(v) ? null : 'Lowercase letters, numbers and dashes only.'),
  });

  // Reuse an existing database with this name if setup ran before.
  const dbName = `${workerName}-db`;
  let database;
  const s2 = spinner('Creating the D1 database');
  try {
    const existing = await cf.listD1(token, account.id);
    database = (existing || []).find((d) => d.name === dbName);
    if (database) {
      s2.succeed(`Reusing existing database ${c.bold(dbName)}`);
    } else {
      database = await cf.createD1(token, account.id, dbName);
      s2.succeed(`Created database ${c.bold(dbName)}`);
    }
  } catch (e) {
    s2.fail(`Could not create the database: ${e.message}`);
    process.exit(1);
  }

  const dbId = database.uuid || database.id;

  const s3 = spinner('Creating tables');
  try {
    // D1's HTTP query endpoint runs one statement at a time.
    for (const statement of splitStatements(MIGRATION_SQL)) {
      await cf.queryD1(token, account.id, dbId, statement).catch((e) => {
        // Re-running setup is normal; existing objects are not an error.
        if (!/already exists|duplicate column/i.test(e.message)) throw e;
      });
    }
    s3.succeed('Tables created');
  } catch (e) {
    s3.fail(`Migration failed: ${e.message}`);
    process.exit(1);
  }

  const subdomain = await cf.getWorkersSubdomain(token, account.id).catch(() => null);

  state.cloudflareToken = token;
  state.cloudflareAccountId = account.id;
  state.cloudflareAccountName = account.name;
  state.workerName = workerName;
  state.databaseId = dbId;
  state.databaseName = dbName;
  state.workersSubdomain = subdomain;
  markDone(state, 'cloudflare');
  saveState(state);
}

// ── 4. Your account ─────────────────────────────────────────────────────────

async function stepAccount(state) {
  step(4, TOTAL_STEPS, 'Firebase — your sign-in');

  if (isDone(state, 'account')) {
    ok(`Already configured: project ${c.bold(state.firebaseProjectId)}, signing in as ${c.bold(state.adminEmail)}`);
    if (!(await confirm('Reconfigure Firebase?', false))) return;
  }

  line();
  hint('DaemonClient signs you in with Firebase Authentication, the same as the hosted version — you just use your own project instead of ours. It is free, and it is the only account store involved.');
  blank();
  line(`  ${c.bold('Create the project')}`);
  line(`    1. Open ${accent('https://console.firebase.google.com')} and add a project`);
  line(`       ${c.gray('Analytics is not needed — turn it off to keep setup short')}`);
  line('    2. Build → Authentication → Get started → enable Email/Password');
  line('    3. Authentication → Users → Add user — this is your login');
  line(`    4. Project settings ${c.gray('(gear icon)')} → General → Your apps → Web app`);
  line(`       ${c.gray('Register one, then copy apiKey and projectId from the config shown')}`);
  blank();

  const projectId = await ask('Firebase project ID', {
    defaultValue: state.firebaseProjectId || '',
    validate: (v) => (/^[a-z0-9-]{4,}$/.test(v) ? null : 'Project IDs look like my-cloud-4f21.'),
  });

  let apiKey = state.firebaseApiKey || '';
  let email = state.adminEmail || '';
  while (true) {
    if (!apiKey) {
      apiKey = await ask('Firebase Web API key', {
        validate: (v) => (v.startsWith('AIza') ? null : 'Web API keys start with AIza.'),
      });
    }
    email = await ask('The email you added as a user', {
      defaultValue: email,
      validate: (v) => (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) ? null : 'That does not look like an email address.'),
    });
    const password = await askSecret('Its password');

    // Sign in for real: a typo in the key, a project with Email/Password still
    // disabled, or a user that was never created all fail here rather than at
    // the user's first login attempt on their phone.
    const s = spinner('Signing in to check the details');
    try {
      const res = await fetch(
        `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password, returnSecureToken: true }),
        },
      );
      const body = await res.json().catch(() => ({}));
      if (body.error) throw new Error(explainFirebaseError(body.error.message));
      s.succeed(`Signed in as ${c.bold(email)}`);
      state.adminUserId = body.localId;
      break;
    } catch (e) {
      s.fail(e.message);
      if (!(await confirm('Try again?', true))) process.exit(1);
      if (/API key/i.test(e.message)) apiKey = '';
    }
  }

  state.firebaseProjectId = projectId;
  state.firebaseApiKey = apiKey;
  state.adminEmail = email.toLowerCase();
  markDone(state, 'account');
  saveState(state);
}

/** Firebase error codes are shouty and unhelpful; say what to actually do. */
function explainFirebaseError(code) {
  const map = {
    EMAIL_NOT_FOUND: 'No user with that email in this project. Add one under Authentication → Users.',
    INVALID_PASSWORD: 'Wrong password for that user.',
    INVALID_LOGIN_CREDENTIALS: 'That email and password combination was rejected. Check both, and that the user exists.',
    OPERATION_NOT_ALLOWED: 'Email/Password sign-in is not enabled. Turn it on under Authentication → Sign-in method.',
    USER_DISABLED: 'That user is disabled in the Firebase console.',
    API_KEY_INVALID: 'That Web API key is not valid for this project.',
    INVALID_EMAIL: 'That email address is not valid.',
  };
  for (const [k, v] of Object.entries(map)) if (String(code).includes(k)) return v;
  return String(code);
}

// ── 5. Deploy ───────────────────────────────────────────────────────────────

async function stepDeployWorker(state) {
  step(5, TOTAL_STEPS, 'Deploying your API');

  // Secrets are generated once and reused on later runs, so redeploying never
  // invalidates existing sessions or makes stored files unreadable.
  state.sessionSecret = state.sessionSecret || randomSecret(32);
  state.storageKey = state.storageKey || randomSecret(32);
  saveState(state);

  const s = spinner('Building the worker bundle');
  let bundle;
  try {
    bundle = await buildWorkerBundle(REPO_ROOT);
    s.succeed(`Built (${Math.round(bundle.length / 1024)} KB)`);
  } catch (e) {
    s.fail(`Build failed: ${e.message}`);
    hint('Run "npm install" inside immich-api-shim/ and try again.');
    process.exit(1);
  }

  const s2 = spinner('Uploading to Cloudflare');
  try {
    const bindings = [
      { type: 'd1', name: 'DB', id: state.databaseId },
      { type: 'plain_text', name: 'SELF_HOST', text: '1' },
      { type: 'plain_text', name: 'APP_IDENTIFIER', text: 'selfhost' },
      // Their Firebase project, never ours.
      { type: 'plain_text', name: 'FIREBASE_API_KEY', text: state.firebaseApiKey || '' },
      { type: 'plain_text', name: 'FIREBASE_PROJECT_ID', text: state.firebaseProjectId || '' },
      // Empty on purpose: the managed value points at OUR relay worker. With
      // D1 bound, the worker proxies through itself instead.
      { type: 'plain_text', name: 'TELEGRAM_PROXY', text: '' },
      // So the worker never hands their users an address of ours.
      { type: 'plain_text', name: 'EXTERNAL_DOMAIN', text: state.dashboardUrl || '' },
      { type: 'plain_text', name: 'ALLOWED_ORIGINS', text: state.allowedOrigins || 'http://localhost:5173' },
      { type: 'plain_text', name: 'UPDATE_REPO', text: state.updateRepo || 'myrosama/DaemonClient' },
      { type: 'plain_text', name: 'BUILD_VERSION', text: readVersion(REPO_ROOT) },
      // secret_text keeps these out of the dashboard's plain-text env listing.
      { type: 'secret_text', name: 'SESSION_SECRET', text: state.sessionSecret },
      { type: 'secret_text', name: 'ENCRYPTION_MASTER_KEY', text: state.storageKey },
    ];
    await cf.deployWorker(state.cloudflareToken, state.cloudflareAccountId, state.workerName, bundle, bindings);
    await cf.enableWorkersDev(state.cloudflareToken, state.cloudflareAccountId, state.workerName).catch(() => {});
    s2.succeed('Worker deployed');
  } catch (e) {
    s2.fail(`Deploy failed: ${e.message}`);
    process.exit(1);
  }

  const workerUrl = state.workersSubdomain
    ? `https://${state.workerName}.${state.workersSubdomain}.workers.dev`
    : null;
  state.workerUrl = workerUrl;

  // Seed the Telegram config into the worker's own database, so the running
  // worker needs no external config service.
  const s3 = spinner('Saving your Telegram settings to the database');
  try {
    await cf.queryD1(
      state.cloudflareToken, state.cloudflareAccountId, state.databaseId,
      'INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)',
      ['telegram', JSON.stringify({
        botToken: state.telegramBotToken,
        botUsername: state.telegramBotUsername,
        channelId: state.telegramChannelId,
      })],
    );
    await cf.queryD1(
      state.cloudflareToken, state.cloudflareAccountId, state.databaseId,
      'INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)',
      ['zke', JSON.stringify({ mode: 'server', enabled: true })],
    );
    s3.succeed('Settings saved');
  } catch (e) {
    s3.fail(`Could not save settings: ${e.message}`);
    process.exit(1);
  }

  // The schema turns encryption ON and leaves the key material empty; without
  // this step the worker refuses every upload rather than storing your photos
  // in the clear. Existing keys are never touched — see zke.mjs.
  const s3b = spinner('Setting up encryption');
  try {
    const outcome = await ensureEncryptionKeys({
      query: (sql, params) => cf.queryD1(
        state.cloudflareToken, state.cloudflareAccountId, state.databaseId, sql, params),
    });
    s3b.succeed(outcome.seeded ? 'Encryption keys generated' : 'Encryption keys already in place');
  } catch (e) {
    // Stop here rather than finishing with a cheerful summary: an install whose
    // key state is unknown cannot upload, and saying nothing would hide that.
    s3b.fail(`Could not set up encryption: ${e.message}`);
    hint('Nothing was changed. Check your connection, then run "daemonclient doctor".');
    process.exit(1);
  }

  if (workerUrl) {
    const s4 = spinner('Waiting for the API to answer');
    let healthy = false;
    for (let i = 0; i < 10; i++) {
      try {
        const res = await fetch(`${workerUrl}/api/health`, { signal: AbortSignal.timeout(8000) });
        if (res.ok) { healthy = true; break; }
      } catch {}
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (healthy) s4.succeed(`API live at ${c.bold(workerUrl)}`);
    else s4.fail('The worker deployed but is not answering yet — it may need another minute.');
  }

  markDone(state, 'deploy');
  saveState(state);
}

function readVersion(root) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

// ── 6. Media processor (optional) ───────────────────────────────────────────

async function stepProcessor(state) {
  step(6, TOTAL_STEPS, 'Photo processing (optional)');

  line();
  hint('iPhone photos (HEIC) and video thumbnails need real CPU to convert — more than a Cloudflare Worker is allowed to use. A small companion service handles it. Skip this and everything still works; those thumbnails just stay blank until you add one.');
  blank();

  if (isDone(state, 'processor') && state.processorUrl) {
    ok(`Already configured: ${state.processorUrl}`);
    if (!(await confirm('Change it?', false))) return;
  }

  const choice = await select('How do you want to handle it?', [
    { label: 'Skip for now', value: 'skip', hint: 'add it later with: daemonclient processor' },
    { label: 'I have already deployed one', value: 'url', hint: 'paste its URL' },
    { label: 'Show me how to deploy one free', value: 'guide', hint: 'Render, one click' },
  ]);

  if (choice === 'skip') {
    markDone(state, 'processor', { skipped: true });
    saveState(state);
    return;
  }

  if (choice === 'guide') {
    blank();
    line(`  ${c.bold('Deploy on Render (free)')}`);
    line(`    1. Fork this repository on GitHub (if you have not already)`);
    line(`    2. Open ${accent('https://render.com/deploy')} and point it at your fork`);
    line(`       ${c.gray('Render reads processor/render.yaml and configures everything')}`);
    line('    3. When it asks for environment variables, enter:');
    line(`         FIREBASE_PROJECT_ID = ${c.gray('(leave blank for self-hosted)')}`);
    line(`         OWNER_UID           = ${accent(state.adminUserId || '(your user id)')}`);
    line('    4. Wait for the first deploy, then copy the service URL');
    blank();
    hint('Pinning OWNER_UID means only your account can use that instance, so its URL is safe to have in a config file.');
    blank();
  }

  let url = '';
  while (true) {
    url = await ask('Processor URL (or type skip)', { defaultValue: state.processorUrl || '' });
    if (!url || /^skip$/i.test(url)) {
      markDone(state, 'processor', { skipped: true });
      saveState(state);
      return;
    }
    const base = url.replace(/\/+$/, '');
    const s = spinner('Checking the processor');
    try {
      const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(60000) });
      const body = await res.json().catch(() => ({}));
      if (!body?.service?.includes('daemonclient')) throw new Error('That URL did not answer like a DaemonClient processor.');
      if (body.problems?.length) {
        s.fail('The processor is up but reports problems:');
        for (const p of body.problems) warn(p);
        if (!(await confirm('Use it anyway?', false))) continue;
      } else {
        s.succeed(`Processor healthy (HEIC: ${body.capabilities?.heicThumbnail ? 'yes' : 'no'}, video posters: ${body.capabilities?.videoPoster ? 'yes' : 'no'})`);
      }
      url = base;
      break;
    } catch (e) {
      s.fail(e.message.includes('aborted') ? 'No answer — a sleeping free instance can take a minute to wake. Try again.' : e.message);
      if (!(await confirm('Try a different URL?', true))) {
        markDone(state, 'processor', { skipped: true });
        saveState(state);
        return;
      }
    }
  }

  const s = spinner('Saving');
  try {
    const existing = { botToken: state.telegramBotToken, botUsername: state.telegramBotUsername, channelId: state.telegramChannelId };
    await cf.queryD1(
      state.cloudflareToken, state.cloudflareAccountId, state.databaseId,
      'INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)',
      ['telegram', JSON.stringify({ ...existing, heicConvertUrl: `${url}/convertHeicThumbnail` })],
    );
    s.succeed('Processor connected');
  } catch (e) {
    s.fail(e.message);
  }

  state.processorUrl = url;
  markDone(state, 'processor');
  saveState(state);
}

// ── 7. Done ─────────────────────────────────────────────────────────────────

async function stepFinish(state) {
  step(7, TOTAL_STEPS, 'Done');
  blank();

  const lines = [
    `${c.bold('Your API')}`,
    `  ${state.workerUrl || '(no workers.dev subdomain — check the Cloudflare dashboard)'}`,
    '',
    `${c.bold('Sign in with')}`,
    `  ${state.adminEmail}`,
    '',
    `${c.bold('Storage')}`,
    `  @${state.telegramBotUsername} → ${state.telegramChannelTitle}`,
  ];
  if (state.processorUrl) {
    lines.push('', `${c.bold('Processor')}`, `  ${state.processorUrl}`);
  }
  lines.push(
    '',
    c.gray('Point the mobile app at the API URL above, or run the web apps'),
    c.gray('locally. See docs/SELF_HOSTING.md for both.'),
    '',
    `${c.bold('Useful commands')}`,
    `  ${accent('daemonclient status')}    ${c.gray('what is running, and is it healthy')}`,
    `  ${accent('daemonclient update')}    ${c.gray('pull the latest release and redeploy')}`,
    `  ${accent('daemonclient processor')} ${c.gray('add or change the media processor')}`,
  );
  panel('Your cloud is live', lines);

  blank();
  warn(`Keep ${c.bold(statePath())} safe — it holds your tokens and encryption key.`);
  hint('It is already gitignored and readable only by you. If you lose the encryption key, files already in Telegram cannot be decrypted.');
  blank();
}
