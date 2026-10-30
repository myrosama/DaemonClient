// Decrypts parts that dc-core (Rust) encrypted, using the PRODUCTION
// JavaScript (drive/src/crypto.js). Exits non-zero on any mismatch.
//   cargo run -q --example emit_vectors | node verify-rust-output.mjs
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = process.env.DC_REPO_ROOT ?? path.resolve(here, '../../..');
const js = await import(pathToFileURL(path.join(repo, 'drive/src/crypto.js')).href);
let input = '';
for await (const chunk of process.stdin) input += chunk;
const v = JSON.parse(input);
if (v.parts?.length !== 5) { console.log('FAIL expected 5 parts'); process.exit(1); }
const key = await js.deriveKey(v.password, Uint8Array.from(Buffer.from(v.salt_b64, 'base64')));
let failures = 0;
for (const p of v.parts) {
  const plain = new Uint8Array(await js.decryptChunk(Uint8Array.from(Buffer.from(p.part_b64, 'base64')).buffer, key));
  const ok = plain.length === p.plaintext_len && plain.every((b, i) => b === (i * 31 + 7) % 251);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${p.plaintext_len} bytes`);
  if (!ok) failures++;
}
process.exit(failures ? 1 : 0);
