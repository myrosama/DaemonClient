// Setup state, so an interrupted run resumes instead of starting over.
//
// This file holds live credentials: the Cloudflare token, the Telegram bot
// token, the session secret. It is therefore written 0600 (owner read/write
// only) and listed in .gitignore. The CLI warns loudly if it ever finds the
// permissions loosened.
//
// It does NOT hold the encryption keys, despite an earlier comment here saying
// so. Those are the zke_password and zke_salt rows in the user's own D1, put
// there by zke.mjs and stored nowhere else — which is why `doctor --show-keys`
// reads the database rather than this file.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const STATE_FILENAME = '.daemonclient-selfhost.json';

// Keys whose values must never be printed, logged, or included in diagnostics.
// Most of these still have to be WRITTEN — the install cannot work without the
// Cloudflare token — so this set governs output only.
export const SECRET_KEYS = new Set([
  'cloudflareToken',
  'telegramBotToken',
  'sessionSecret',
  'storageKey',
  'adminPassword',
]);

// Keys that must never reach the disk at all, whatever the caller hands us.
//
// A strict subset of SECRET_KEYS, and the distinction is the point: redacting
// a value from `doctor` output does nothing about the cleartext copy sitting in
// the file. PRODUCT_SPEC §4 says the account password "never touches disk", and
// until now nothing enforced that — `saveState` serialised whatever object it
// was given, so one `state.adminPassword = pw` anywhere would have written a
// password in cleartext with no test to notice.
//
// The password is used within seconds of being typed, to create the Firebase
// account, and has no reason to survive the process. Not storing it also means
// a resumed run must ask again rather than proceeding with a blank — which is
// why the credential prompt is LAST in the wizard.
export const NEVER_PERSIST = new Set([
  'adminPassword',
  'storageKey', // dead: the old STORAGE_KEY the worker never read
]);

/** Deep copy with the never-persist keys removed. Does not mutate the input —
 *  the caller is still using those values in this run. */
function stripUnpersistable(value) {
  if (Array.isArray(value)) return value.map(stripUnpersistable);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (NEVER_PERSIST.has(k)) continue;
      out[k] = stripUnpersistable(v);
    }
    return out;
  }
  return value;
}

export function statePath(dir = process.cwd()) {
  return path.join(dir, STATE_FILENAME);
}

export function loadState(dir = process.cwd()) {
  const file = statePath(dir);
  if (!fs.existsSync(file)) return { version: 1, steps: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { version: 1, steps: {}, ...parsed };
  } catch {
    // A corrupt state file must not wedge setup; start fresh but keep a copy.
    try { fs.renameSync(file, `${file}.corrupt-${Date.now()}`); } catch {}
    return { version: 1, steps: {} };
  }
}

export function saveState(state, dir = process.cwd()) {
  const file = statePath(dir);
  // Strip before serialising, not after: a redaction pass over the string
  // would still have built the string containing the secret.
  const json = JSON.stringify(stripUnpersistable(state), null, 2);
  // Create with restrictive permissions from the outset — writing then
  // chmod-ing leaves a window where the secrets are world-readable.
  const fd = fs.openSync(file, 'w', 0o600);
  try {
    fs.writeFileSync(fd, json);
  } finally {
    fs.closeSync(fd);
  }
  try { fs.chmodSync(file, 0o600); } catch {}
  return file;
}

/** Warn if the state file is readable by anyone else on this machine. */
export function checkStatePermissions(dir = process.cwd()) {
  const file = statePath(dir);
  if (!fs.existsSync(file) || os.platform() === 'win32') return null;
  const mode = fs.statSync(file).mode & 0o777;
  if (mode & 0o077) {
    return `${STATE_FILENAME} is mode ${mode.toString(8)} — it holds live credentials. Run: chmod 600 ${file}`;
  }
  return null;
}

/** A copy of the state with every secret replaced, safe to print or attach to
 *  a bug report. */
export function redact(state) {
  const walk = (value) => {
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value)) {
        out[k] = SECRET_KEYS.has(k) ? (v ? '<redacted>' : v) : walk(v);
      }
      return out;
    }
    return value;
  };
  return walk(state);
}

export function markDone(state, step, data = {}) {
  state.steps[step] = { done: true, at: new Date().toISOString(), ...data };
  return state;
}

export function isDone(state, step) {
  return !!state.steps?.[step]?.done;
}
