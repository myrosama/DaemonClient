// Claiming the install for the person who set it up.
//
// THE BUG THIS FIXES. `owner_uid` is a row in the install's own D1 `config`
// table, read by `immich-api-shim/src/owner-gate.ts`. Nothing ever wrote it —
// the string appeared exactly once in the whole repository, as a key constant.
//
// An unclaimed install can only be claimed by a credential carrying `mayClaim`,
// and `helpers.ts` passes **false** for Firebase ID tokens. That is correct and
// must stay: one Firebase project serves the entire managed fleet, so such a
// token verifies on every install, and letting one claim an unowned worker
// would hand the first stranger to arrive the ZKE key, the bot token and every
// photo. Only a session token signed with THIS worker's own secret proves
// rightful possession.
//
// But the accounts dashboard presents nothing except Firebase ID tokens. So the
// documented happy path — `daemonclient web`, open the dashboard, sign in —
// returned "Not authenticated" on a brand-new install, permanently. It worked
// only if the user happened to open Photos first, which uses the worker's own
// password login. The install was reachable and unusable.
//
// The fix is not to weaken the gate. It is to claim the install here, where
// setup already knows the uid (`state.adminUserId`, from the sign-in it just
// performed) and where the person running it is demonstrably holding the
// Cloudflare token for that database — a far stronger proof of ownership than
// "arrived first".

const OWNER_KEY = 'owner_uid';

/** Rows from a D1 HTTP response, or a throw. Never guesses.
 *  Deliberately identical in spirit to zke.mjs: an answer we do not understand
 *  is UNKNOWN, and unknown must not be read as "empty". */
function rowsFrom(result) {
  const first = Array.isArray(result) ? result[0] : result;
  if (!first || typeof first !== 'object') {
    throw new Error('the database returned an answer this version does not understand');
  }
  if (first.success === false) {
    throw new Error(first.error || 'the database rejected the query');
  }
  if (Array.isArray(first.results)) return first.results;
  if (Array.isArray(first.result?.[0]?.results)) return first.result[0].results;
  throw new Error('the database returned no result set');
}

/**
 * Record the install's owner, once.
 *
 * @param {{query: (sql: string, params?: any[]) => Promise<any>}} db
 * @param {string} uid  the Firebase uid of the account setup just created
 * @returns {Promise<{claimed: boolean, reason?: string, owner: string}>}
 */
export async function claimInstallOwner(db, uid) {
  if (typeof uid !== 'string' || !uid.trim()) {
    // A blank owner_uid is worse than none: owner-gate trims and reads '' as
    // null, so the install would look unclaimed while carrying a row. A blank
    // value in a column that decides access is never intentional.
    throw new Error('refusing to claim the install: no uid for the account that was just created');
  }
  const owner = uid.trim();

  // Read first. A failed or unrecognised read means we do not know whether the
  // install is owned — and writing on a guess could hand someone else's install
  // to whoever ran setup last.
  const rows = rowsFrom(await db.query('SELECT value FROM config WHERE key = ? LIMIT 1', [OWNER_KEY]));
  const current = typeof rows[0]?.value === 'string' ? rows[0].value.trim() : '';
  if (current) {
    return { claimed: false, reason: 'already-owned', owner: current };
  }

  // OR IGNORE so a concurrent claim cannot overwrite the winner — the same
  // guarantee owner-gate.ts relies on for its own claim path.
  await db.query('INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)', [OWNER_KEY, owner]);
  return { claimed: true, owner };
}
