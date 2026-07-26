// Configuration lives in one .env file.
//
// Not a bespoke state format: a .env is something people already understand,
// can open in any editor, can copy to another machine, and can fix by hand when
// something is wrong. The setup reads it on every run, checks each value
// against the real service, and only asks for what is missing or broken.
//
// It holds live credentials, so it is written 0600 and gitignored, and the CLI
// says so plainly rather than assuming anyone reads documentation.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const ENV_FILENAME = '.env';

/** Every key the CLI knows about, in the order they are written to the file. */
export const KEYS = {
  TELEGRAM_BOT_TOKEN: { secret: true, label: 'Telegram bot token' },
  TELEGRAM_BOT_USERNAME: { secret: false, label: 'Telegram bot username' },
  TELEGRAM_CHANNEL_ID: { secret: false, label: 'Telegram channel id' },
  TELEGRAM_CHANNEL_TITLE: { secret: false, label: 'Telegram channel name' },

  FIREBASE_PROJECT_ID: { secret: false, label: 'Firebase project id' },
  FIREBASE_API_KEY: { secret: false, label: 'Firebase Web API key' },
  FIREBASE_AUTH_EMAIL: { secret: false, label: 'Sign-in email' },
  FIREBASE_USER_ID: { secret: false, label: 'Your Firebase user id' },

  CLOUDFLARE_ACCOUNT_ID: { secret: false, label: 'Cloudflare account id' },
  CLOUDFLARE_API_TOKEN: { secret: true, label: 'Cloudflare API token (only if not using browser sign-in)' },
  WORKER_NAME: { secret: false, label: 'Worker name' },
  WORKER_URL: { secret: false, label: 'Worker URL' },
  D1_DATABASE_ID: { secret: false, label: 'D1 database id' },
  D1_DATABASE_NAME: { secret: false, label: 'D1 database name' },

  SESSION_SECRET: { secret: true, label: 'Session signing secret' },
  STORAGE_KEY: { secret: true, label: 'File encryption key' },

  PROCESSOR_URL: { secret: false, label: 'Media processor URL' },
  DASHBOARD_URL: { secret: false, label: 'Dashboard URL' },
  PHOTOS_URL: { secret: false, label: 'Photos app URL' },
  DRIVE_URL: { secret: false, label: 'Drive app URL' },
  ALLOWED_ORIGINS: { secret: false, label: 'Browser origins allowed to call the API' },
  UPDATE_REPO: { secret: false, label: 'Repository to check for updates' },
};

export const SECRET_KEYS = new Set(
  Object.entries(KEYS).filter(([, v]) => v.secret).map(([k]) => k),
);

export function envPath(dir = process.cwd()) {
  return path.join(dir, ENV_FILENAME);
}

/** Parse a .env. Tolerates comments, blank lines, quotes and `export`. */
export function parseEnv(text) {
  const out = {};
  for (const raw of String(text).split('\n')) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const line = trimmed.replace(/^export\s+/, '');
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

export function loadEnv(dir = process.cwd()) {
  const file = envPath(dir);
  if (!fs.existsSync(file)) return {};
  try {
    return parseEnv(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

const SECTIONS = [
  ['Telegram — where your files are stored', ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_BOT_USERNAME', 'TELEGRAM_CHANNEL_ID', 'TELEGRAM_CHANNEL_TITLE']],
  ['Firebase — how you sign in', ['FIREBASE_PROJECT_ID', 'FIREBASE_API_KEY', 'FIREBASE_AUTH_EMAIL', 'FIREBASE_USER_ID']],
  ['Cloudflare — where the API runs', ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'WORKER_NAME', 'WORKER_URL', 'D1_DATABASE_ID', 'D1_DATABASE_NAME']],
  ['Secrets — losing these is unrecoverable', ['SESSION_SECRET', 'STORAGE_KEY']],
  ['Your apps', ['PROCESSOR_URL', 'DASHBOARD_URL', 'PHOTOS_URL', 'DRIVE_URL', 'ALLOWED_ORIGINS', 'UPDATE_REPO']],
];

/** Write the file, grouped and commented so it reads like a config file a
 *  person would have written. Unknown keys are preserved at the end. */
export function saveEnv(values, dir = process.cwd()) {
  const file = envPath(dir);
  const lines = [
    '# DaemonClient — your self-hosted install.',
    '#',
    '# KEEP THIS FILE SAFE. It holds live credentials, and STORAGE_KEY is the',
    '# only thing that can decrypt files already in your Telegram channel — if',
    '# you lose it, those files cannot be recovered. Back it up somewhere private.',
    '#',
    '# It is gitignored and readable only by you. Edit by hand if you like; the',
    '# setup re-checks every value each time it runs.',
    '',
  ];

  const written = new Set();
  for (const [title, keys] of SECTIONS) {
    const present = keys.filter((k) => values[k] !== undefined && values[k] !== '');
    if (!present.length) continue;
    lines.push(`# ${title}`);
    for (const k of present) {
      lines.push(`${k}=${quote(values[k])}`);
      written.add(k);
    }
    lines.push('');
  }

  const extra = Object.keys(values).filter((k) => !written.has(k) && values[k] !== undefined && values[k] !== '');
  if (extra.length) {
    lines.push('# Other');
    for (const k of extra) lines.push(`${k}=${quote(values[k])}`);
    lines.push('');
  }

  // Create with restrictive permissions from the outset: writing and then
  // chmod-ing leaves a window where the credentials are world-readable.
  const fd = fs.openSync(file, 'w', 0o600);
  try {
    fs.writeFileSync(fd, lines.join('\n'));
  } finally {
    fs.closeSync(fd);
  }
  try { fs.chmodSync(file, 0o600); } catch {}
  return file;
}

function quote(value) {
  const s = String(value);
  return /[\s#"'$]/.test(s) ? JSON.stringify(s) : s;
}

/** Warn if anyone else on this machine can read the credentials. */
export function checkPermissions(dir = process.cwd()) {
  const file = envPath(dir);
  if (!fs.existsSync(file) || os.platform() === 'win32') return null;
  const mode = fs.statSync(file).mode & 0o777;
  if (mode & 0o077) {
    return `${ENV_FILENAME} is mode ${mode.toString(8)} — it holds live credentials. Run: chmod 600 ${file}`;
  }
  return null;
}

/** A copy with every secret replaced — safe to print or paste into an issue. */
export function redact(values) {
  const out = {};
  for (const [k, v] of Object.entries(values)) {
    out[k] = SECRET_KEYS.has(k) && v ? '<redacted>' : v;
  }
  return out;
}
