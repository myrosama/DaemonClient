// DaemonClient Drive — API client for the per-user architecture.
//
// Auth + provisioning stay central (Firebase Auth, validated by the central
// worker; bot/worker provisioning at accounts.daemonclient.uz). But all FILE
// DATA lives on the user's OWN Cloudflare Worker + D1. The flow:
//   1. login(email,password) → central worker validates against Firebase Auth,
//      mints a signed session token, and returns the user's own `workerUrl`.
//   2. Every file operation goes DIRECTLY to that per-user worker via driveApi().
//
// The session token (7-day, carries a refresh token the worker rotates server
// side) is kept in localStorage so reloads stay logged in — same model as the
// Photos (Immich) web client.

// The worker this app logs in through. Hosted builds use the shared central
// worker; a self-hosted build points at the operator's OWN worker via
// VITE_API_BASE (the setup script writes this at build time). Mirrors the
// convention in accounts-portal/src/config/firebase.js so both apps configure
// self-hosting the same way — set VITE_SELF_HOST=1 and VITE_API_BASE=<worker>.
const IS_SELF_HOST = import.meta.env.VITE_SELF_HOST === '1';
const CENTRAL_API = (
  import.meta.env.VITE_API_BASE || (IS_SELF_HOST ? '' : 'https://immich-api.sadrikov49.workers.dev')
).replace(/\/+$/, '');
const SESSION_KEY = 'dc_drive_session';

let _session = loadSession();
const _listeners = new Set();

function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (s.exp && s.exp < Date.now()) { localStorage.removeItem(SESSION_KEY); return null; }
    return s;
  } catch { return null; }
}

function persist(s) {
  _session = s;
  if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
  else localStorage.removeItem(SESSION_KEY);
  _configCache = null;
  _listeners.forEach(cb => { try { cb(s); } catch (e) { console.error('[auth] listener', e); } });
}

export function getSession() { return _session; }
export function getUid() { return _session?.uid || null; }
export function getUserEmail() { return _session?.email || null; }
export function getWorkerUrl() { return _session?.workerUrl || null; }
export function isAuthenticated() { return !!_session; }

// Subscribe to login/logout. Returns an unsubscribe fn.
export function onAuthChange(cb) { _listeners.add(cb); return () => _listeners.delete(cb); }

export async function login(email, password) {
  const res = await fetch(`${CENTRAL_API}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: email.trim(), password }),
  });
  let data = {};
  try { data = await res.json(); } catch {}
  if (!res.ok) throw new Error(data.message || 'Invalid email or password');
  const session = {
    token: data.accessToken,
    // Hosted: the central worker returns the user's per-user workerUrl. Self-host:
    // there is only ONE worker (the one we just logged into), and it does no
    // Firestore lookup, so it returns no workerUrl — fall back to CENTRAL_API,
    // which IS that worker. Never fall back on hosted: CENTRAL_API is the shared
    // login worker there (no DB), so a null workerUrl must surface as an error.
    workerUrl: data.workerUrl || (IS_SELF_HOST ? CENTRAL_API : null),
    uid: data.userId,
    email: data.userEmail || email.trim(),
    name: data.name || '',
    exp: Date.now() + 7 * 24 * 60 * 60 * 1000,
  };
  persist(session);
  return session;
}

export function logout() { persist(null); }

// Call the user's OWN per-user worker (workerUrl from login) with the session
// token. Throws { code:'NO_WORKER' } if the account hasn't been provisioned yet
// (→ send the user to accounts.daemonclient.uz onboarding).
export async function driveApi(path, opts = {}) {
  const s = _session;
  if (!s) throw new Error('Not authenticated');
  if (!s.workerUrl) { const e = new Error('No storage provisioned'); e.code = 'NO_WORKER'; throw e; }
  const headers = { 'Authorization': 'Bearer ' + s.token, ...(opts.headers || {}) };
  if (opts.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${s.workerUrl}${path}`, { ...opts, headers });
  if (res.status === 401) { logout(); throw new Error('Session expired — please sign in again'); }
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = text; }
  if (!res.ok) throw new Error((body && body.message) || `Request failed (${res.status})`);
  return body;
}

// Telegram bot config (the user's own bot), used for the client's direct
// upload/download to Telegram. Cached for the session.
let _configCache = null;
export async function getDriveConfig(force = false) {
  if (_configCache && !force) return _configCache;
  _configCache = await driveApi('/api/drive/config');
  return _configCache;
}

// WebDAV mount ("Connect as a drive"): status, generate the mount token (the
// password is shown ONCE), or revoke. The worker serves the mount at its own
// /dav, so `url` already points at the user's per-user worker.
export async function getDavStatus() {
  return driveApi('/api/drive/dav'); // { enabled, url, username }
}
export async function createDavMount() {
  return driveApi('/api/drive/dav', { method: 'POST' }); // { token, username, url }
}
export async function revokeDavMount() {
  return driveApi('/api/drive/dav', { method: 'DELETE' }); // { enabled: false }
}
