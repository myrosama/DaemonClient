/**
 * ZKE (Zero-Knowledge Encryption) module for DaemonClient.
 *
 * Byte-compatible with:
 *   - The web app's crypto.js
 *   - The Python CLI's crypto.py
 *
 * Uses AES-256-GCM with PBKDF2 key derivation (SHA-256, 100,000 iterations).
 * Chunk format: [IV 12 bytes][ciphertext + GCM tag 16 bytes]
 */

import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';

// Must match crypto.js / crypto.py constants exactly
const SALT_LENGTH = 16; // 128 bits
const IV_LENGTH = 12; // 96 bits (recommended for GCM)
const KEY_LENGTH_BYTES = 32; // 256 bits
const PBKDF2_ITERATIONS = 100_000;
const AUTH_TAG_LENGTH = 16; // 128 bits

/**
 * Derive a 256-bit AES key from a password and salt using PBKDF2-SHA256.
 * Produces the same raw key bytes as the JS and Python implementations.
 */
export function deriveKey(password: string, salt: Buffer): Buffer {
  return pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, KEY_LENGTH_BYTES, 'sha256');
}

/**
 * Generate a random salt for key derivation.
 */
export function generateSalt(): Buffer {
  return randomBytes(SALT_LENGTH);
}

/**
 * Encrypt a chunk with AES-256-GCM.
 * Returns `iv || ciphertext_with_tag` — identical layout to the JS/Python implementations.
 */
export function encryptChunk(plaintext: Buffer, key: Buffer): Buffer {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key, iv);

  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Layout: [IV 12 bytes][ciphertext][auth tag 16 bytes]
  return Buffer.concat([iv, encrypted, authTag]);
}

/**
 * Decrypt a chunk produced by `encryptChunk` (or the JS/Python equivalents).
 * Expects `iv || ciphertext_with_tag`.
 */
export function decryptChunk(data: Buffer, key: Buffer): Buffer {
  const iv = data.subarray(0, IV_LENGTH);
  const authTag = data.subarray(data.length - AUTH_TAG_LENGTH);
  const ciphertext = data.subarray(IV_LENGTH, data.length - AUTH_TAG_LENGTH);

  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * Encrypt a full file buffer, returning the encrypted buffer.
 * The entire file is treated as one chunk (suitable for files up to ~19 MB).
 * For larger files, chunk externally and call encryptChunk per chunk.
 */
export function encryptBuffer(plaintext: Buffer, key: Buffer): Buffer {
  return encryptChunk(plaintext, key);
}

/**
 * Decrypt a full file buffer.
 */
export function decryptBuffer(data: Buffer, key: Buffer): Buffer {
  return decryptChunk(data, key);
}

/**
 * Get or derive the encryption key from environment variables.
 * Uses DAEMON_ZKE_PASSWORD and DAEMON_ZKE_SALT.
 * If not set, returns null (encryption disabled).
 */
export function getEncryptionKey(): Buffer | null {
  const password = process.env.DAEMON_ZKE_PASSWORD;
  const saltBase64 = process.env.DAEMON_ZKE_SALT;

  if (!password || !saltBase64) {
    return null;
  }

  const salt = Buffer.from(saltBase64, 'base64');
  return deriveKey(password, salt);
}

export { SALT_LENGTH, IV_LENGTH, KEY_LENGTH_BYTES, PBKDF2_ITERATIONS };
