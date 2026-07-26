// Encryption key material for a self-hosted install.
//
// The schema (`schema/schema.mjs`) seeds `zke_mode='server'`, `zke_enabled='1'`,
// and then `zke_password=''`, `zke_salt=''` — encryption switched on with
// nothing to encrypt with. Filling those last two rows is a separate step. The
// hosted provisioner runs it (`deployment-service/src/index.ts`); the CLI never
// did, so every self-hosted install had empty key material. The worker now
// refuses uploads in that state rather than writing plaintext to Telegram
// (`immich-api-shim/src/assets.ts`, `getEncryptionKey`), which means an install
// with empty keys cannot upload at all until this runs. That is why `update`
// and `doctor` call it too, not only `setup`: installs already in that state
// need a repair path that is not "start over".
//
// The dangerous direction is the other one. Writing a key over an existing one
// makes every photo already in the Telegram channel permanently undecryptable —
// there is no backup, the ciphertext is all there is. So this module is built
// around one rule: WRITE ONLY WHEN WE KNOW THE KEYS ARE ABSENT. Not when we
// suspect it, not when the read failed and absent seems likely. A read that
// errors, times out, or comes back in a shape we do not recognise means
// "unknown", and unknown writes nothing.

import crypto from 'node:crypto';

const PASSWORD_KEY = 'zke_password';
const SALT_KEY = 'zke_salt';

/** 16 bytes of salt and 32 of password, in STANDARD base64 — not base64url.
 *  The worker decodes the salt with `atob()` (`assets.ts`, `deriveKey`), which
 *  rejects the url alphabet, so a base64url value here derives a wrong key or
 *  throws at upload time. The hosted provisioner uses `btoa()` for the same
 *  reason; these two have to agree byte for byte. */
const randomB64 = (bytes) => crypto.randomBytes(bytes).toString('base64');

/** Rows from one D1 REST query, or a thrown error.
 *
 *  Cloudflare answers `POST /d1/database/{id}/query` with an array of per-
 *  statement results. `cf.queryD1` has already thrown on a transport failure or
 *  a top-level `success:false`, but a statement inside a successful envelope can
 *  still have failed. Anything that is not recognisably "this statement ran and
 *  here are its rows" is an error, deliberately: the one interpretation this
 *  function must never reach for is "no rows, so there is no key". */
function rowsFrom(result) {
  const first = Array.isArray(result) ? result[0] : result;
  if (!first || typeof first !== 'object') {
    throw new Error('the database returned an answer this version does not understand');
  }
  if (first.success === false) {
    throw new Error(first.error || 'the database rejected the query');
  }
  if (!Array.isArray(first.results)) {
    throw new Error('the database returned no result set');
  }
  return first.results;
}

/** What the config table currently holds for the two key rows.
 *  Throws — never guesses — when the read does not clearly succeed. */
export async function readKeyMaterial(query) {
  const rows = rowsFrom(await query(
    'SELECT key, value FROM config WHERE key IN (?, ?)',
    [PASSWORD_KEY, SALT_KEY],
  ));
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return {
    password: typeof byKey[PASSWORD_KEY] === 'string' ? byKey[PASSWORD_KEY] : '',
    salt: typeof byKey[SALT_KEY] === 'string' ? byKey[SALT_KEY] : '',
  };
}

/** Generate and store key material, but only if there demonstrably is none.
 *
 *  `query(sql, params)` is injected rather than imported so the call sites can
 *  hand over their own Cloudflare credentials — and so the tests can prove the
 *  no-write cases by counting writes that never happen.
 *
 *  Returns `{ seeded: true }` when it wrote, or `{ seeded: false, reason }` when
 *  the keys were already there. Anything else throws: an install whose key state
 *  could not be established is a problem for the operator to see, not something
 *  to paper over.
 */
export async function ensureEncryptionKeys({ query }) {
  const current = await readKeyMaterial(query);

  // A password already present is the end of it. Not "check whether the salt
  // looks right", not "top up the missing half" — any write here risks the
  // one irreversible mistake in this codebase.
  if (current.password) return { seeded: false, reason: 'already-set' };

  // Reaching here means no password, so nothing was ever encrypted with the
  // salt either: `getEncryptionKey` refuses to encrypt while EITHER row is
  // empty. That is what makes replacing a stray leftover salt safe.
  const salt = randomB64(16);
  const password = randomB64(32);

  // Salt first, password last, and never in one batch. Interrupted midway, the
  // password stays empty, the worker stays fail-closed, and the next run reads
  // an empty password and seeds both again. The reverse order would leave a
  // password with no salt: still fail-closed, but now every later run sees a
  // non-empty password and declines to touch it — an install wedged forever.
  await query('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)', [SALT_KEY, salt]);
  await query('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)', [PASSWORD_KEY, password]);

  // INSERT OR REPLACE rather than UPDATE because the rows can be missing
  // outright — an UPDATE would report success while changing nothing.
  return { seeded: true, reason: current.salt ? 'replaced-orphan-salt' : 'was-empty' };
}
