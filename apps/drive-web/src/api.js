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

import { fetchWorker } from './worker-unreachable.js';
import { portalSignOutUrl } from './sign-in.js';

// The worker this app logs in through. Hosted builds use the shared central
// worker; a self-hosted build points at the operator's OWN worker via
// VITE_API_BASE (the setup script writes this at build time). Mirrors the
// convention in apps/accounts-web/src/config/firebase.js so both apps configure
// self-hosting the same way — set VITE_SELF_HOST=1 and VITE_API_BASE=<worker>.
const IS_SELF_HOST = import.meta.env.VITE_SELF_HOST === '1';
const CENTRAL_API = (
  // api.daemonclient.uz is the same worker as its workers.dev address, which
  // some mobile carriers block.
  import.meta.env.VITE_API_BASE || (IS_SELF_HOST ? '' : 'https://api.daemonclient.uz')
).replace(/\/+$/, '');
const SESSION_KEY = 'dc_drive_session';
// The shared sign-in hub (one HttpOnly cookie for *.daemonclient.uz, set by the
// accounts portal). Hosted only; a self-hosted build signs in with its own form.
const AUTH_HUB = IS_SELF_HOST ? '' : 'https://auth.daemonclient.uz';
// Set on sign-out so the next screen doesn't sign the person straight back in.
export const SIGNED_OUT_KEY = 'dc_drive_signed_out';
export const isSelfHost = IS_SELF_HOST;

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
  return persistAuthResponse(data, email.trim());
}

// A login or exchange response → the stored session.
function persistAuthResponse(data, emailFallback) {
  const session = {
    token: data.accessToken,
    // Hosted: the central worker returns the user's per-user workerUrl. Self-host:
    // there is only ONE worker (the one we just logged into), and it does no
    // Firestore lookup, so it returns no workerUrl — fall back to CENTRAL_API,
    // which IS that worker. Never fall back on hosted: CENTRAL_API is the shared
    // login worker there (no DB), so a null workerUrl must surface as an error.
    workerUrl: data.workerUrl || (IS_SELF_HOST ? CENTRAL_API : null),
    uid: data.userId,
    email: data.userEmail || emailFallback,
    name: data.name || '',
    exp: Date.now() + 7 * 24 * 60 * 60 * 1000,
  };
  persist(session);
  return session;
}

/**
 * Sign in from the shared session the accounts portal set (as Photos does):
 * the hub hands out a short-lived Firebase ID token, the central worker trades
 * it for a Drive session. Returns the session, or null when there is no shared
 * session or anything fails; never throws.
 */
export async function trySharedSignIn() {
  if (!AUTH_HUB) return null;
  try {
    const hubRes = await fetch(`${AUTH_HUB}/session-token`, { credentials: 'include' });
    if (!hubRes.ok) return null;
    const { idToken } = await hubRes.json();
    if (!idToken) return null;
    const res = await fetch(`${CENTRAL_API}/api/auth/exchange`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${idToken}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.accessToken) return null;
    return persistAuthResponse(data, '');
  } catch {
    return null;
  }
}

// Sign out. Hosted: the local session goes first, then the portal's /logout
// ends the portal's own sign-in and the shared session and comes back to Drive's
// sign-in page, which shows "signed out" (the flag) instead of signing back in.
// Self-hosted: there is only the local session.
export function logout() {
  if (AUTH_HUB) {
    try { sessionStorage.setItem(SIGNED_OUT_KEY, '1'); } catch { /* private mode */ }
  }
  persist(null);
  if (AUTH_HUB) window.location.replace(portalSignOutUrl());
}

// How many of this page's sessions the worker has refused (401). Kept in
// memory: a reload starts over. The sign-in screen re-exchanges silently once.
let _rejections = 0;
export function sessionRejections() { return _rejections; }

// Call the user's OWN per-user worker (workerUrl from login) with the session
// token. Throws { code:'NO_WORKER' } if the account hasn't been provisioned yet
// (→ send the user to accounts.daemonclient.uz onboarding).
export async function driveApi(path, opts = {}) {
  const s = _session;
  if (!s) throw new Error('Not authenticated');
  if (!s.workerUrl) { const e = new Error('No storage provisioned'); e.code = 'NO_WORKER'; throw e; }
  const headers = { 'Authorization': 'Bearer ' + s.token, ...(opts.headers || {}) };
  if (opts.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  // A brand-new account's worker can't be reached for its first minute or two
  // (no TLS certificate yet) — fetchWorker flags that as WORKER_UNREACHABLE.
  const res = await fetchWorker(fetch, `${s.workerUrl}${path}`, { ...opts, headers });
  if (res.status === 401) {
    // Only this app's session ends; the shared one may still be good, and the
    // sign-in screen exchanges it again. Not logout(): that signs out everywhere.
    // A late refusal of an older token must not end a newer session.
    if (_session?.token === s.token) { _rejections++; persist(null); }
    throw new Error('Session expired — please sign in again');
  }
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = text; }
  if (!res.ok) throw new Error((body && body.message) || `Request failed (${res.status})`);
  if (_session?.token === s.token) _rejections = 0;
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
