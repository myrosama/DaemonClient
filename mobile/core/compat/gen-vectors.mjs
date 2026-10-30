// Produces test vectors for dc-core's crypto from the PRODUCTION JavaScript
// (drive/src/crypto.js — the module the website and Drive use), so the Rust
// port is checked against the real thing, not against itself.
//   DC_REPO_ROOT=<DaemonClient checkout> node gen-vectors.mjs > vectors.json
import { webcrypto, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = process.env.DC_REPO_ROOT ?? path.resolve(here, '../../..');
const js = await import(pathToFileURL(path.join(repo, 'drive/src/crypto.js')).href);
const zke = await import(pathToFileURL(path.join(repo, 'drive/src/zke-unlock.js')).href);
const subtle = webcrypto.subtle;

const hex = (u8) => Buffer.from(u8).toString('hex');
const b64 = (u8) => Buffer.from(u8).toString('base64');
const PART = 19 * 1024 * 1024;

// Deterministic plaintext: byte i = (i * 31 + 7) mod 251. Rust rebuilds it.
const pattern = (n) => { const u = new Uint8Array(n); for (let i = 0; i < n; i++) u[i] = (i * 31 + 7) % 251; return u; };

const keys = [];
for (const [password, saltB64] of [
  ['correct horse battery staple', 'c2FsdC1zYWx0LXNhbHQhIQ=='],
  ['пароль-密码-🔑', b64(new Uint8Array(16).map((_, i) => i))],
  ['', 'AAAAAAAAAAAAAAAAAAAAAA=='],
]) {
  const key = await js.deriveKey(password, Uint8Array.from(Buffer.from(saltB64, 'base64')));
  keys.push({ password, salt_b64: saltB64, key_hex: hex(new Uint8Array(await subtle.exportKey('raw', key))) });
}

// encryptChunk output from production code (random IV): Rust must decrypt it.
const key0 = await subtle.importKey('raw', Buffer.from(keys[0].key_hex, 'hex'), 'AES-GCM', true, ['encrypt', 'decrypt']);
const js_parts = [];
for (const n of [0, 1, 15, 16, 17, 1000, 4096]) {
  const part = new Uint8Array(await js.encryptChunk(pattern(n).buffer, key0));
  js_parts.push({ plaintext_len: n, part_b64: b64(part) });
}

// Fixed-IV known answers (WebCrypto directly — encryptChunk picks its own IV):
// Rust's encrypt with the same IV must produce identical bytes. The full-size
// part is stored as a SHA-256 so the file stays small.
const fixed = [];
for (const n of [0, 33, PART]) {
  const iv = Uint8Array.from({ length: 12 }, (_, i) => 0xa0 + i);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key0, pattern(n)));
  const part = new Uint8Array(12 + ct.length); part.set(iv); part.set(ct, 12);
  fixed.push({ plaintext_len: n, iv_hex: hex(iv), part_sha256: createHash('sha256').update(part).digest('hex'), part_len: part.length });
}

// The Drive key check stored with the settings (R§2), made by the production code.
const check = await zke.makeKeyCheck(key0, { encryptChunk: js.encryptChunk, bytesToBase64: js.bytesToBase64 });

console.log(JSON.stringify({
  source: 'drive/src/crypto.js',
  sha256_of_source: createHash('sha256').update(readFileSync(path.join(repo, 'drive/src/crypto.js'))).digest('hex'),
  sha256_of_key_check_source: createHash('sha256').update(readFileSync(path.join(repo, 'drive/src/zke-unlock.js'))).digest('hex'),
  keys, js_parts, fixed, drive_key_check: { key_index: 0, check_b64: check },
}, null, 2));
