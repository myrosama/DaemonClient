// Cloudflare access.
//
// Shape of this module, and why:
//
//   wrangler owns the OAuth dance and nothing else. It uses CLOUDFLARE'S OWN
//   OAuth client, so no application of ours is involved and a self-hosted
//   install depends on nothing we run. After sign-in the token sits in
//   wrangler's global config, and we read it and call the REST API ourselves.
//
//   We do NOT drive wrangler for data work. `wrangler d1 execute` has no way to
//   bind parameters, so the only way to use it would be to paste values into
//   SQL — with a Telegram bot token among them. REST takes real bound params.
//
//   Every wrangler invocation is serialised. Its token refresh rotates the
//   refresh token with no locking, so two concurrent processes can permanently
//   break the login. That exact bug already cost this project a month of
//   stalled fleet updates; it is not a theoretical concern.

import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { promisify } from 'node:util';

import { HOSTILE_ENV_VARS } from '../config.mjs';

const execFileAsync = promisify(execFile);
const API = 'https://api.cloudflare.com/client/v4';
export const OAUTH_PORT = 8976;

/** Permissions a hand-made token needs. Browser sign-in grants these already. */
export const REQUIRED_TOKEN_PERMISSIONS = [
  'Account · Workers Scripts · Edit',
  'Account · D1 · Edit',
  'Account · Account Settings · Read',
  'Account · Cloudflare Pages · Edit   (only for the optional dashboard)',
];

// ── Child processes ─────────────────────────────────────────────────────────

/** A deliberately minimal environment for child processes.
 *
 *  Inheriting the whole environment is how someone's shell-exported
 *  CLOUDFLARE_API_TOKEN silently deploys this to the wrong account. Anything
 *  that can hijack authentication is stripped unless the caller asked for it.
 */
export function childEnv({ token = null, accountId = null } = {}) {
  const keep = ['PATH', 'HOME', 'SHELL', 'LANG', 'LC_ALL', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'APPDATA', 'USERPROFILE', 'ComSpec'];
  const env = {};
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k];
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('XDG_') || /_PROXY$/i.test(k) || /^NPM_/.test(k)) env[k] = v;
  }
  for (const k of HOSTILE_ENV_VARS) delete env[k];

  env.WRANGLER_SEND_METRICS = 'false';
  if (accountId) env.CLOUDFLARE_ACCOUNT_ID = accountId;
  // Only when the user explicitly chose the pasted-token path.
  if (token) env.CLOUDFLARE_API_TOKEN = token;
  return env;
}

// One wrangler at a time, process-wide. See the header.
let wranglerQueue = Promise.resolve();
function serialise(fn) {
  const next = wranglerQueue.then(fn, fn);
  wranglerQueue = next.then(() => {}, () => {});
  return next;
}

export function wrangler(args, ctx = {}, opts = {}) {
  return serialise(async () => {
    try {
      const { stdout } = await execFileAsync('npx', ['wrangler', ...args], {
        cwd: ctx.cwd || process.cwd(),
        env: childEnv(ctx),
        maxBuffer: 64 * 1024 * 1024,
        ...opts,
      });
      return stdout;
    } catch (e) {
      throw new Error(cleanError(`${e.stderr || ''}${e.stdout || ''}`) || e.message);
    }
  });
}

function cleanError(text) {
  const lines = String(text).split('\n').map((l) => l.replace(/\x1b\[[0-9;]*m/g, '').trim());
  const err = lines.find((l) => /^(✘|✗|Error|error:)/i.test(l) && l.length > 8);
  return (err || lines.find((l) => l.length > 8) || '').replace(/^[✘✗]\s*\[?ERROR\]?\s*/i, '');
}

/** Run wrangler with a structured-output file and return the parsed entries.
 *  Deploy URLs come from here rather than from scraping stdout, which changes
 *  between versions and wraps in narrow terminals. */
export async function wranglerStructured(args, ctx = {}) {
  const file = path.join(os.tmpdir(), `dc-wrangler-${process.pid}-${Date.now()}.ndjson`);
  try {
    await wrangler(args, ctx, { env: { ...childEnv(ctx), WRANGLER_OUTPUT_FILE_PATH: file } });
  } finally {
    // The command may have succeeded or failed; either way read what it wrote.
  }
  const entries = [];
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (line.trim()) { try { entries.push(JSON.parse(line)); } catch {} }
    }
  } catch {}
  try { fs.unlinkSync(file); } catch {}
  return entries;
}

// ── Where wrangler keeps its OAuth token ────────────────────────────────────

export function wranglerConfigPath() {
  const legacy = path.join(os.homedir(), '.wrangler');
  if (fs.existsSync(legacy)) return path.join(legacy, 'config', 'default.toml');
  const base = os.platform() === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Preferences')
    : os.platform() === 'win32'
      ? path.join(process.env.APPDATA || os.homedir(), 'xdg.config')
      : (process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'));
  return path.join(base, '.wrangler', 'config', 'default.toml');
}

/** The stored OAuth access token, or null. */
export function storedOAuthToken() {
  try {
    const text = fs.readFileSync(wranglerConfigPath(), 'utf8');
    return text.match(/^\s*oauth_token\s*=\s*"([^"]+)"/m)?.[1] || null;
  } catch {
    return null;
  }
}

/** True when TCP :8976 is already taken — wrangler has no error handler for
 *  that and dies with a raw Node stack trace. */
export function oauthPortBusy() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(true));
    server.once('listening', () => server.close(() => resolve(false)));
    server.listen(OAUTH_PORT, '127.0.0.1');
  });
}

/** No display and no browser — sign-in will print a URL and then time out. */
export function looksHeadless() {
  if (os.platform() === 'win32' || os.platform() === 'darwin') return false;
  return !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
}

/** Run `wrangler login`, inheriting stdio so the user sees the URL. */
export function login() {
  return serialise(() => new Promise((resolve, reject) => {
    const child = spawn('npx', ['wrangler', 'login'], { env: childEnv({}), stdio: 'inherit' });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('Cloudflare sign-in did not complete.'))));
    child.on('error', reject);
  }));
}

// ── REST ────────────────────────────────────────────────────────────────────

async function rest(auth, endpoint, { method = 'GET', body } = {}) {
  // FormData must go through untouched: stringifying it would send "[object
  // FormData]", and setting Content-Type by hand would omit the multipart
  // boundary fetch generates. Uploading a worker script is the only caller that
  // needs it, and it is exactly the caller that was missing.
  const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
  const headers = { Authorization: `Bearer ${auth}` };
  if (!isForm) headers['Content-Type'] = 'application/json';

  const res = await fetch(`${API}${endpoint}`, {
    method,
    headers,
    body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!data) throw new Error(`Cloudflare returned ${res.status} with an unreadable body`);
  if (!data.success) {
    const first = (data.errors || [])[0] || {};
    throw Object.assign(new Error(first.message || `Cloudflare returned ${res.status}`), {
      code: first.code, status: res.status,
    });
  }
  return data.result;
}

/** The bearer this install should use: an explicit token, else wrangler's. */
export function bearer(cfg) {
  const token = cfg.DC_CF_TOKEN || storedOAuthToken();
  if (!token) throw new Error('Not signed in to Cloudflare. Run the setup again.');
  return token;
}

export async function memberships(auth) {
  const result = await rest(auth, '/memberships');
  return (result || [])
    .filter((m) => m.status === 'accepted' && m.account)
    .map((m) => ({ id: m.account.id, name: m.account.name }));
}

/** Verify a pasted token and name exactly which permission is missing —
 *  otherwise the first failure is a bare 403 in the middle of a deploy. */
export async function verifyToken(token) {
  const status = await rest(token, '/user/tokens/verify');
  if (status.status !== 'active') throw new Error(`This token's status is "${status.status}".`);

  let accounts;
  try {
    accounts = await memberships(token);
  } catch {
    throw new Error('This token cannot list accounts — it needs "Account Settings: Read".');
  }
  if (!accounts.length) throw new Error('This token can see no accounts — it needs "Account Settings: Read".');

  const missing = [];
  await rest(token, `/accounts/${accounts[0].id}/d1/database?per_page=1`).catch(() => missing.push('D1: Edit'));
  await rest(token, `/accounts/${accounts[0].id}/workers/scripts`).catch(() => missing.push('Workers Scripts: Edit'));
  if (missing.length) throw new Error(`This token is missing: ${missing.join(' and ')}.`);
  return accounts;
}

// ── Resources ───────────────────────────────────────────────────────────────

export const listD1 = (auth, accountId) =>
  rest(auth, `/accounts/${accountId}/d1/database?per_page=100`);

export const createD1 = (auth, accountId, name) =>
  rest(auth, `/accounts/${accountId}/d1/database`, { method: 'POST', body: { name } });

/** Real bound parameters — the reason this goes over REST rather than through
 *  `wrangler d1 execute`, which cannot bind and would need values inlined into
 *  SQL (including a Telegram bot token). */
export const queryD1 = (auth, accountId, databaseId, sql, params = []) =>
  rest(auth, `/accounts/${accountId}/d1/database/${databaseId}/query`, {
    method: 'POST',
    body: { sql, params },
  });

/** The account's workers.dev subdomain, or null when it has never had one.
 *  A brand-new account has none, and a deploy fails on it non-interactively. */
export async function getSubdomain(auth, accountId) {
  try {
    const r = await rest(auth, `/accounts/${accountId}/workers/subdomain`);
    return r?.subdomain || null;
  } catch (e) {
    if (e.code === 10007) return null; // never registered
    throw e;
  }
}

export const registerSubdomain = (auth, accountId, subdomain) =>
  rest(auth, `/accounts/${accountId}/workers/subdomain`, { method: 'PUT', body: { subdomain } });

/** Pages needs its project to exist before a deploy, or the deploy prompts —
 *  and prompting in a non-interactive context throws. */
export async function ensurePagesProject(ctx, name) {
  try {
    await wrangler(['pages', 'project', 'create', name, '--production-branch', 'main'], ctx);
  } catch (e) {
    if (!/already exists/i.test(e.message)) throw e;
  }
}

// ── Deploying the worker ────────────────────────────────────────────────────
//
// These two were called by `setup` and `update` but never existed: the
// Cloudflare layer was rewritten in 63141e1 and the commands were not updated
// with it, so `daemonclient setup` threw `cf.deployWorker is not a function`
// partway through provisioning. Nothing caught it because no test drove the
// real command — the whole self-host entry point was broken.
//
// Deliberately the REST multipart upload rather than shelling out to
// `wrangler deploy`: wrangler needs a wrangler.toml on disk naming the D1
// binding, which would mean writing the user's database id into a temp file,
// and it reads `.env` from the working directory on every invocation — the
// documented way a stray CLOUDFLARE_API_TOKEN silently overrides the browser
// sign-in. The same PUT the hosted provisioner uses
// (deployment-service/src/cloudflare-api.ts:23-59) has neither problem.

/**
 * Upload a module worker with its bindings.
 * @param {object} auth   token or OAuth context, as everything else here takes
 * @param {string} accountId
 * @param {string} name   worker script name
 * @param {string} code   the bundled ES module
 * @param {Array<{type: string, name: string, text?: string, id?: string}>} bindings
 */
export async function deployWorker(auth, accountId, name, code, bindings = []) {
  const form = new FormData();
  form.append(
    'worker.js',
    new Blob([code], { type: 'application/javascript+module' }),
    'worker.js',
  );
  form.append(
    'metadata',
    new Blob(
      [JSON.stringify({
        main_module: 'worker.js',
        compatibility_date: '2025-11-25',
        compatibility_flags: ['nodejs_compat'],
        bindings: bindings.map((b) =>
          b.type === 'plain_text' || b.type === 'secret_text'
            ? { type: b.type, name: b.name, text: b.text }
            : { type: b.type, name: b.name, id: b.id },
        ),
      })],
      { type: 'application/json' },
    ),
  );

  return rest(auth, `/accounts/${accountId}/workers/scripts/${name}`, {
    method: 'PUT',
    body: form,
  });
}

/** Put the worker on `<name>.<subdomain>.workers.dev`.
 *
 *  A freshly uploaded script is not reachable until this is set, so a setup
 *  that skipped it produced a worker that existed and answered nothing. */
export const enableWorkersDev = (auth, accountId, name) =>
  rest(auth, `/accounts/${accountId}/workers/scripts/${name}/subdomain`, {
    method: 'POST',
    body: { enabled: true },
  });
