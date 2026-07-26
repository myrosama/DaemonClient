// Password hashing for the setup CLI.
//
// This MUST produce records the worker can verify, so the format and every
// parameter mirror immich-api-shim/src/selfhost-auth.ts exactly:
//
//     pbkdf2-sha256$<iterations>$<salt-b64>$<hash-b64>
//
// Hashing here rather than sending the password to an endpoint means a fresh
// install has no bootstrap route for an attacker to race, and the plain
// password never travels anywhere: the CLI writes only the derived hash into
// the operator's own D1.

import crypto from 'node:crypto';

// Keep in lockstep with PASSWORD_ITERATIONS in selfhost-auth.ts.
export const PASSWORD_ITERATIONS = 600_000;
const SALT_BYTES = 16;
const KEY_BYTES = 32; // 256 bits

export function hashPasswordNode(password) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(SALT_BYTES);
    crypto.pbkdf2(password, salt, PASSWORD_ITERATIONS, KEY_BYTES, 'sha256', (err, derived) => {
      if (err) return reject(err);
      resolve(`pbkdf2-sha256$${PASSWORD_ITERATIONS}$${salt.toString('base64')}$${derived.toString('base64')}`);
    });
  });
}

/** Verify locally — used by tests to prove CLI and worker agree. */
export function verifyPasswordNode(password, record) {
  return new Promise((resolve) => {
    const parts = String(record).split('$');
    if (parts.length !== 4 || parts[0] !== 'pbkdf2-sha256') return resolve(false);
    const iterations = Number(parts[1]);
    if (!Number.isInteger(iterations) || iterations < 1) return resolve(false);
    const salt = Buffer.from(parts[2], 'base64');
    const expected = Buffer.from(parts[3], 'base64');
    crypto.pbkdf2(password, salt, iterations, expected.length, 'sha256', (err, derived) => {
      if (err) return resolve(false);
      resolve(derived.length === expected.length && crypto.timingSafeEqual(derived, expected));
    });
  });
}
