// Where a self-hosted install keeps its settings.
//
// The format is a plain .env, because that is something people can open,
// understand and fix. The LOCATION is deliberately not the repository:
//
//   wrangler loads a .env from the working directory on every single command
//   and injects it into the environment. A CLOUDFLARE_API_TOKEN sitting in the
//   project's .env therefore silently overrides a browser sign-in, and blocks
//   re-logging-in entirely, with an error that names neither the file nor the
//   variable. Keeping our config in ~/.config also means `git pull` and
//   `rm -rf` on the clone cannot destroy someone's install.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const APP_DIR = 'daemonclient';
export const FILENAME = 'config.env';

/** Keys we know about. `secret: true` means never print it, anywhere. */
export const KEYS = {
  TELEGRAM_BOT_TOKEN: { secret: true },
  TELEGRAM_BOT_USERNAME: {},
  TELEGRAM_CHANNEL_ID: {},
  TELEGRAM_CHANNEL_TITLE: {},

  FIREBASE_PROJECT_ID: {},
  FIREBASE_API_KEY: {},
  FIREBASE_AUTH_EMAIL: {},
  FIREBASE_USER_ID: {},

  CLOUDFLARE_ACCOUNT_ID: {},
  // Deliberately NOT called CLOUDFLARE_API_TOKEN: that name is picked up by
  // wrangler from the ambient environment and would override browser sign-in.
  DC_CF_TOKEN: { secret: true },
  WORKER_NAME: {},
  WORKER_URL: {},
  D1_DATABASE_ID: {},
  D1_DATABASE_NAME: {},

  SESSION_SECRET: { secret: true },

  PROCESSOR_URL: {},
  DASHBOARD_URL: {},
  PHOTOS_URL: {},
  DRIVE_URL: {},
  ALLOWED_ORIGINS: {},
  UPDATE_REPO: {},
};

export const SECRET_KEYS = new Set(
  Object.entries(KEYS).filter(([, v]) => v.secret).map(([k]) => k),
);

/** Variables that hijack wrangler if they are set anywhere it can see them. */
export const HOSTILE_ENV_VARS = [
  'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_API_KEY', 'CLOUDFLARE_EMAIL',
  'CF_API_TOKEN', 'CF_API_KEY', 'CF_EMAIL',
];

export function configDir() {
  if (process.env.DAEMONCLIENT_CONFIG) return path.dirname(process.env.DAEMONCLIENT_CONFIG);
  const base = process.env.XDG_CONFIG_HOME
    || (os.platform() === 'win32' ? process.env.APPDATA : null)
    || path.join(os.homedir(), '.config');
  return path.join(base, APP_DIR);
}

export function configPath() {
  return process.env.DAEMONCLIENT_CONFIG || path.join(configDir(), FILENAME);
}

// ── Parsing ─────────────────────────────────────────────────────────────────

/** dotenv-compatible parse. Reports problems by line, because "your Telegram
 *  token is invalid" is a terrible way to learn you left a comment on the end
 *  of an unquoted value. */
export function parseEnv(text) {
  const values = {};
  const problems = [];
  const lines = String(text).split(/\r?\n/);

  lines.forEach((raw, i) => {
    const lineNo = i + 1;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) return;

    const body = trimmed.replace(/^export\s+/, '');
    const eq = body.indexOf('=');
    if (eq < 0) {
      problems.push(`line ${lineNo}: expected NAME=value`);
      return;
    }
    const key = body.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      problems.push(`line ${lineNo}: "${key}" is not a valid name`);
      return;
    }

    let rest = body.slice(eq + 1).trim();
    let value;
    if (rest.startsWith('"')) {
      const end = findClosing(rest, '"');
      if (end < 0) { problems.push(`line ${lineNo}: unterminated double quote`); return; }
      value = rest.slice(1, end).replace(/\\n/g, '\n').replace(/\\"/g, '"');
      const tail = rest.slice(end + 1).trim();
      if (tail && !tail.startsWith('#')) problems.push(`line ${lineNo}: unexpected text after the closing quote`);
    } else if (rest.startsWith("'")) {
      const end = rest.indexOf("'", 1);
      if (end < 0) { problems.push(`line ${lineNo}: unterminated single quote`); return; }
      value = rest.slice(1, end);
    } else {
      // Unquoted: a # begins a comment, which is exactly the case a naive
      // parser gets wrong.
      const hash = rest.indexOf(' #');
      value = (hash >= 0 ? rest.slice(0, hash) : rest).trim();
    }
    values[key] = value;
  });

  return { values, problems };
}

function findClosing(s, quote) {
  for (let i = 1; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue; }
    if (s[i] === quote) return i;
  }
  return -1;
}

// ── Reading and writing ─────────────────────────────────────────────────────

export function load() {
  const file = configPath();
  if (!fs.existsSync(file)) return { values: {}, problems: [], existed: false };
  const { values, problems } = parseEnv(fs.readFileSync(file, 'utf8'));
  return { values, problems, existed: true };
}

const SECTIONS = [
  ['Telegram — stores your files', ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_BOT_USERNAME', 'TELEGRAM_CHANNEL_ID', 'TELEGRAM_CHANNEL_TITLE']],
  ['Firebase — signs you in', ['FIREBASE_PROJECT_ID', 'FIREBASE_API_KEY', 'FIREBASE_AUTH_EMAIL', 'FIREBASE_USER_ID']],
  ['Cloudflare — runs the API', ['CLOUDFLARE_ACCOUNT_ID', 'DC_CF_TOKEN', 'WORKER_NAME', 'WORKER_URL', 'D1_DATABASE_ID', 'D1_DATABASE_NAME']],
  ['Keys', ['SESSION_SECRET']],
  ['Your apps', ['PROCESSOR_URL', 'DASHBOARD_URL', 'PHOTOS_URL', 'DRIVE_URL', 'ALLOWED_ORIGINS', 'UPDATE_REPO']],
];

export function save(values) {
  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch {}

  const out = [
    '# DaemonClient — your self-hosted install.',
    '#',
    '# Back this file up somewhere private: it holds live credentials.',
    '#',
    '# It does NOT hold your encryption keys. This file used to advertise a',
    '# STORAGE_KEY as "the only thing that can decrypt your files" — that key',
    '# was shipped to the worker as ENCRYPTION_MASTER_KEY, which the worker',
    '# never read. It protected nothing, and the warning pointed at the wrong',
    '# thing entirely.',
    '#',
    '# What actually decrypts your photos is zke_password and zke_salt in the',
    '# `config` table of your D1 database. Losing THOSE loses your files, and',
    '# no copy of them exists outside that database. Run',
    '# `daemonclient doctor --show-keys` to print them, and keep them somewhere',
    '# safe.',
    '#',
    '# Edit it by hand if you like — the setup re-checks every value when it runs.',
    '',
  ];

  const written = new Set();
  for (const [title, keys] of SECTIONS) {
    const present = keys.filter((k) => values[k]);
    if (!present.length) continue;
    out.push(`# ${title}`);
    for (const k of present) { out.push(`${k}=${quote(values[k])}`); written.add(k); }
    out.push('');
  }
  const extra = Object.keys(values).filter((k) => !written.has(k) && values[k] && !k.startsWith('__'));
  if (extra.length) {
    out.push('# Other');
    for (const k of extra) out.push(`${k}=${quote(values[k])}`);
    out.push('');
  }

  // 0600 from creation: writing first and chmod-ing after leaves a window in
  // which the credentials are world-readable.
  const file = configPath();
  const fd = fs.openSync(file, 'w', 0o600);
  try { fs.writeFileSync(fd, out.join('\n')); } finally { fs.closeSync(fd); }
  try { fs.chmodSync(file, 0o600); } catch {}
  return file;
}

function quote(v) {
  const s = String(v);
  return /[\s#"'$]/.test(s) ? JSON.stringify(s) : s;
}

// ── Safety checks ───────────────────────────────────────────────────────────

export function checkPermissions() {
  const file = configPath();
  if (!fs.existsSync(file) || os.platform() === 'win32') return null;
  const mode = fs.statSync(file).mode & 0o777;
  return (mode & 0o077)
    ? `${file} is mode ${mode.toString(8)} — it holds live credentials. Run: chmod 600 ${file}`
    : null;
}

/** A .env inside the repo will be read by wrangler and can silently override
 *  the user's Cloudflare sign-in. Find them so the CLI can refuse to continue. */
export function findHostileDotEnvFiles(repoRoot) {
  const found = [];
  for (const rel of ['.env', path.join('immich-api-shim', '.env')]) {
    const file = path.join(repoRoot, rel);
    if (!fs.existsSync(file)) continue;
    const { values } = parseEnv(fs.readFileSync(file, 'utf8'));
    const hostile = HOSTILE_ENV_VARS.filter((k) => values[k]);
    if (hostile.length) found.push({ file, vars: hostile });
  }
  return found;
}

/** Ambient variables that will hijack wrangler regardless of our config. */
export function findHostileAmbientVars() {
  return HOSTILE_ENV_VARS.filter((k) => process.env[k]);
}

export function redact(values) {
  const out = {};
  for (const [k, v] of Object.entries(values)) {
    if (k.startsWith('__')) continue;
    out[k] = SECRET_KEYS.has(k) && v ? '<redacted>' : v;
  }
  return out;
}
