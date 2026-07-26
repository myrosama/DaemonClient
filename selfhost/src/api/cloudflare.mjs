// Cloudflare access, two ways.
//
// Preferred: `wrangler login`. It opens a browser, the user clicks Allow, and
// the token is stored by wrangler on their own machine. That uses Cloudflare's
// OWN OAuth application — we register nothing, we see nothing, and there is no
// token for anyone to paste, mistype, or over-scope. It is also the flow every
// Cloudflare developer already knows.
//
// Fallback: an API token in the environment, for headless machines, CI, or
// anyone who would rather not sign in through a browser. When a token is
// present we talk to the REST API directly.
//
// Either way the credential stays on the user's machine and is only ever sent
// to api.cloudflare.com.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const API = 'https://api.cloudflare.com/client/v4';

/** Permissions a hand-made token needs. Browser sign-in grants these already. */
export const REQUIRED_TOKEN_PERMISSIONS = [
  'Account · Workers Scripts · Edit',
  'Account · D1 · Edit',
  'Account · Account Settings · Read',
  'Account · Cloudflare Pages · Edit  (only if you want the dashboard)',
];

function wranglerEnv(ctx) {
  const env = { ...process.env, WRANGLER_SEND_METRICS: 'false' };
  if (ctx?.apiToken) env.CLOUDFLARE_API_TOKEN = ctx.apiToken;
  if (ctx?.accountId) env.CLOUDFLARE_ACCOUNT_ID = ctx.accountId;
  return env;
}

/** Run a wrangler command, returning stdout. Throws with wrangler's own
 *  message, which is usually more specific than anything we could invent. */
export async function wrangler(args, ctx = {}, opts = {}) {
  try {
    const { stdout } = await run('npx', ['wrangler', ...args], {
      cwd: ctx.cwd || process.cwd(),
      env: wranglerEnv(ctx),
      maxBuffer: 64 * 1024 * 1024,
      ...opts,
    });
    return stdout;
  } catch (e) {
    const text = `${e.stderr || ''}${e.stdout || ''}`.trim();
    throw new Error(firstUsefulLine(text) || e.message);
  }
}

function firstUsefulLine(text) {
  const lines = String(text).split('\n').map((l) => l.replace(/\x1b\[[0-9;]*m/g, '').trim());
  const err = lines.find((l) => /^(✘|Error|error:)/i.test(l) && l.length > 8);
  return (err || lines.find((l) => l.length > 8) || '').replace(/^[✘✗]\s*\[?ERROR\]?\s*/i, '');
}

/** Who wrangler is currently signed in as, or null. */
export async function whoami() {
  try {
    const out = await wrangler(['whoami']);
    const email = out.match(/associated with the email ([^\s.]+@[^\s.]+\.[^\s]+)/i)?.[1] || null;
    // The account table prints as │ Name │ id │ rows.
    const accounts = [...out.matchAll(/│\s*([^│]+?)\s*│\s*([0-9a-f]{32})\s*│/g)]
      .map((m) => ({ name: m[1].trim(), id: m[2] }))
      .filter((a) => a.name.toLowerCase() !== 'account name');
    if (!accounts.length) return null;
    return { email, accounts };
  } catch {
    return null;
  }
}

/** Open the browser and wait for the user to click Allow. */
export async function login() {
  // Inherit stdio: wrangler prints the URL and waits on its own callback
  // server, and the user may need to copy the link manually.
  await new Promise((resolve, reject) => {
    const child = execFile('npx', ['wrangler', 'login'], { env: wranglerEnv({}) });
    child.stdout?.pipe(process.stdout);
    child.stderr?.pipe(process.stderr);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('sign-in was cancelled or failed'))));
    child.on('error', reject);
  });
  return whoami();
}

// ── REST, used when an API token is supplied ────────────────────────────────

async function cf(token, path, { method = 'GET', body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!data) throw new Error(`Cloudflare returned ${res.status} with an unreadable body`);
  if (!data.success) {
    const err = (data.errors || [])[0] || {};
    throw Object.assign(new Error(err.message || `Cloudflare returned ${res.status}`), { code: err.code, status: res.status });
  }
  return data.result;
}

/** Check a pasted token and say specifically what it cannot do.
 *
 *  A token missing one permission otherwise fails much later, mid-deploy, with
 *  a bare 403 — so each capability is probed here and reported by name.
 */
export async function verifyToken(token) {
  const result = await cf(token, '/user/tokens/verify');
  if (result.status !== 'active') throw new Error(`This token's status is "${result.status}".`);

  const accounts = await cf(token, '/accounts').catch(() => {
    throw new Error('This token cannot list accounts — it needs "Account Settings: Read".');
  });
  if (!accounts.length) throw new Error('This token can see no accounts — it needs "Account Settings: Read".');

  const accountId = accounts[0].id;
  const missing = [];
  await cf(token, `/accounts/${accountId}/d1/database?per_page=1`).catch(() => missing.push('D1: Edit'));
  await cf(token, `/accounts/${accountId}/workers/scripts`).catch(() => missing.push('Workers Scripts: Edit'));
  if (missing.length) {
    throw new Error(`This token is missing: ${missing.join(', ')}. Create a new one with all of them.`);
  }
  return { accounts };
}

export async function listAccounts(token) {
  return cf(token, '/accounts');
}

// ── Resources. Each takes a ctx of { apiToken?, accountId, cwd? } ───────────

export async function listD1(ctx) {
  if (ctx.apiToken) return cf(ctx.apiToken, `/accounts/${ctx.accountId}/d1/database?per_page=100`);
  const out = await wrangler(['d1', 'list', '--json'], ctx);
  return JSON.parse(out || '[]');
}

export async function createD1(ctx, name) {
  if (ctx.apiToken) {
    return cf(ctx.apiToken, `/accounts/${ctx.accountId}/d1/database`, { method: 'POST', body: { name } });
  }
  const out = await wrangler(['d1', 'create', name], ctx);
  const id = out.match(/database_id\s*=\s*"([0-9a-f-]{36})"/i)?.[1]
    || out.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)?.[1];
  if (!id) throw new Error('created the database but could not read its id from wrangler output');
  return { uuid: id, name };
}

/** Run SQL against D1. Used for migrations and for reading config back. */
export async function queryD1(ctx, databaseId, sql, params = []) {
  if (ctx.apiToken) {
    return cf(ctx.apiToken, `/accounts/${ctx.accountId}/d1/database/${databaseId}/query`, {
      method: 'POST',
      body: { sql, params },
    });
  }
  // wrangler binds parameters positionally with repeated --param flags.
  const args = ['d1', 'execute', databaseId, '--remote', '--json', '--command', sql];
  for (const p of params) args.push('--param', String(p));
  const out = await wrangler(args, ctx);
  try {
    return JSON.parse(out.slice(out.indexOf('[')));
  } catch {
    return [];
  }
}

export async function getWorkersSubdomain(ctx) {
  if (ctx.apiToken) {
    const r = await cf(ctx.apiToken, `/accounts/${ctx.accountId}/workers/subdomain`).catch(() => null);
    return r?.subdomain || null;
  }
  try {
    const out = await wrangler(['subdomain', 'get'], ctx);
    return out.match(/([a-z0-9-]+)\.workers\.dev/i)?.[1] || null;
  } catch {
    return null;
  }
}

export const REST = { cf };
