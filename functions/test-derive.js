const crypto = require('crypto').webcrypto;

const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const KEY_LENGTH = 256;
const PBKDF2_ITERATIONS = 100000;

async function deriveKey(password, saltStr) {
  const salt = Uint8Array.from(atob(saltStr), c => c.charCodeAt(0));
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits', 'deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: KEY_LENGTH },
    false,
    ['encrypt', 'decrypt']
  );
}

deriveKey('zZ&9FBP!TDcmiPaaHkjSomGD9dMdXPVs', 'Rb2chxfzfMl8PVwLEXj6ZA==')
  .then(key => console.log('Successfully derived key:', key))
  .catch(err => console.error('Failed to derive key:', err));
