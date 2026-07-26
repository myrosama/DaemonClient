import type { Env } from './index';

// Authentication for self-hosted installs.
//
// A managed DaemonClient account authenticates against the operator's Firebase
// project. A self-hosted one has no operator and no Firebase: the worker owns
// its accounts outright, in the same D1 database that holds the photo index.
// That makes this file the entire security boundary of a self-hosted install.
//
// Deliberate choices:
//   * PBKDF2-HMAC-SHA256 at OWASP's recommended work factor. WebCrypto gives
//     Workers PBKDF2 but neither scrypt nor argon2, and a hand-rolled memory-
//     hard KDF in JS would be both slower and easier to get wrong.
//   * No signup endpoint anywhere. The setup CLI writes the first account
//     straight into D1 over the operator's own Cloudflare credentials, so a
//     fresh install has no window in which an unauthenticated request can
//     create an admin.
//   * Sessions reuse the existing signed-token format, so every other route
//     keeps working unchanged — only the issuer and the verifier differ.

// OWASP Password Storage Cheat Sheet (2023): 600,000 iterations for
// PBKDF2-HMAC-SHA256. Raising this later is safe (records store their own
// iteration count); lowering it silently would weaken every future password.
export const PASSWORD_ITERATIONS = 600_000;
const SALT_BYTES = 16;
const KEY_BITS = 256;
const ALGORITHM = 'pbkdf2-sha256';

function toB64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromB64(s: string): Uint8Array | null {
  try {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    key,
    KEY_BITS,
  );
  return new Uint8Array(bits);
}

/** `pbkdf2-sha256$<iterations>$<salt-b64>$<hash-b64>` — self-describing, so the
 *  work factor can be raised without invalidating existing passwords. */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derive(password, salt, PASSWORD_ITERATIONS);
  return `${ALGORITHM}$${PASSWORD_ITERATIONS}$${toB64(salt)}$${toB64(hash)}`;
}

export interface PasswordRecord {
  algorithm: string;
  iterations: number;
  salt: Uint8Array;
  hash: Uint8Array;
}

export function parsePasswordRecord(record: string): PasswordRecord | null {
  if (typeof record !== 'string') return null;
  const parts = record.split('$');
  if (parts.length !== 4) return null;
  const [algorithm, iterStr, saltB64, hashB64] = parts;
  if (algorithm !== ALGORITHM) return null;
  const iterations = Number(iterStr);
  if (!Number.isInteger(iterations) || iterations < 1) return null;
  const salt = fromB64(saltB64);
  const hash = fromB64(hashB64);
  if (!salt || !hash || salt.length === 0 || hash.length === 0) return null;
  return { algorithm, iterations, salt, hash };
}

/** Constant-time comparison — a fast-exit memcmp leaks the hash byte by byte. */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function verifyPassword(password: string, record: string): Promise<boolean> {
  const parsed = parsePasswordRecord(record);
  if (!parsed) return false;
  const candidate = await derive(password, parsed.salt, parsed.iterations);
  return timingSafeEqual(candidate, parsed.hash);
}

// ── Mode ────────────────────────────────────────────────────────────────────

export function isSelfHost(env: Env): boolean {
  const v = (env as any).SELF_HOST;
  return v === '1' || v === 'true' || v === true;
}

/** The HMAC scope that signs and verifies session tokens.
 *
 *  This MUST be a per-install secret. APP_IDENTIFIER ("default-daemon-client")
 *  is a constant committed to a public repository and injected into every
 *  worker, so signing with it meant anyone who read the source could mint a
 *  valid session for any account — which is exactly what an audit found.
 *
 *  Managed workers now receive a generated SESSION_SECRET from the deployment
 *  service. The APP_IDENTIFIER fallback survives ONLY for workers that have not
 *  yet been redeployed with one; without it, every existing user would be
 *  locked out the moment this shipped. Once the fleet has rolled over, delete
 *  the fallback branch.
 */
export function sessionScope(env: Env): string {
  const secret = (env as any).SESSION_SECRET;
  if (typeof secret === 'string' && secret.length >= 32) return secret;

  if (isSelfHost(env)) {
    // Never fall back on a self-hosted install: the CLI always provisions a
    // secret, so a missing one means something is wrong and issuing a
    // forgeable session would be worse than failing.
    throw new Error(
      'SESSION_SECRET missing or too short: a self-hosted worker needs a 32+ character random secret to sign sessions. Re-run the setup CLI to generate one.',
    );
  }
  return env.APP_IDENTIFIER || 'default';
}

// ── Accounts ────────────────────────────────────────────────────────────────

export interface LocalUser {
  id: string;
  email: string;
  name: string;
  isAdmin: boolean;
}

export const USERS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  passwordHash TEXT NOT NULL,
  name TEXT,
  isAdmin INTEGER DEFAULT 0,
  createdAt TEXT NOT NULL,
  updatedAt TEXT
);`;

// Verifying a password for an account that does not exist must cost the same as
// verifying one that does — otherwise response time answers "is this address
// registered?" for anyone who asks. This record is a real hash of a random
// value, so the dummy path runs the identical PBKDF2 work.
const DUMMY_RECORD =
  `${ALGORITHM}$${PASSWORD_ITERATIONS}$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=`;

export async function verifyLocalCredentials(
  db: any,
  email: string,
  password: string,
): Promise<LocalUser | null> {
  const normalized = String(email || '').trim().toLowerCase();
  let row: any = null;
  try {
    row = await db
      .prepare('SELECT id, email, passwordHash, name, isAdmin FROM users WHERE email = ? LIMIT 1')
      .bind(normalized)
      .first();
  } catch {
    row = null;
  }

  if (!row || !row.passwordHash) {
    await verifyPassword(password || 'x', DUMMY_RECORD); // equalise timing
    return null;
  }
  if (!(await verifyPassword(password, row.passwordHash))) return null;

  return {
    id: row.id,
    email: row.email,
    name: row.name || String(row.email).split('@')[0],
    isAdmin: !!row.isAdmin,
  };
}

export async function getLocalUserById(db: any, id: string): Promise<LocalUser | null> {
  try {
    const row: any = await db
      .prepare('SELECT id, email, name, isAdmin FROM users WHERE id = ? LIMIT 1')
      .bind(id)
      .first();
    if (!row) return null;
    return {
      id: row.id,
      email: row.email,
      name: row.name || String(row.email).split('@')[0],
      isAdmin: !!row.isAdmin,
    };
  } catch {
    return null;
  }
}

export async function changeLocalPassword(
  db: any,
  userId: string,
  currentPassword: string,
  newPassword: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (typeof newPassword !== 'string' || newPassword.length < 10) {
    return { ok: false, error: 'New password must be at least 10 characters.' };
  }
  const row: any = await db
    .prepare('SELECT passwordHash FROM users WHERE id = ? LIMIT 1')
    .bind(userId)
    .first();
  if (!row?.passwordHash) return { ok: false, error: 'Account not found.' };
  if (!(await verifyPassword(currentPassword, row.passwordHash))) {
    return { ok: false, error: 'Current password is incorrect.' };
  }
  const next = await hashPassword(newPassword);
  await db
    .prepare('UPDATE users SET passwordHash = ?, updatedAt = ? WHERE id = ?')
    .bind(next, new Date().toISOString(), userId)
    .run();
  return { ok: true };
}
