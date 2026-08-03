import type { Env } from './index';
import { isSelfHost } from './selfhost-auth';

// One install belongs to one person.
//
// The operator ruled out multi-user for both flavours on 2026-07-26: one
// storage per user. That makes this the security boundary rather than a
// supplement to one, and it is why the per-row owner filters were demoted to
// defence in depth — a boundary in ONE place is easier to get right and to
// audit than a filter repeated at twenty-seven call sites, any one of which can
// be forgotten by the next person.
//
// The hole it closes: a per-user worker's `config` table is worker-global, not
// scoped by uid (`d1-adapter.getConfig` is `SELECT value FROM config WHERE key
// = ?`). Firebase email/password signup is open by default, so on a self-hosted
// install ANY account that can register in the owner's Firebase project could
// log in and read `/api/server/zke-config` — the key that decrypts every photo
// — or overwrite the install's bot token through `/api/drive/config`
// (FINDINGS §16). Hosted is contained by the per-worker SESSION_SECRET; a
// self-hosted install has exactly one, shared by everyone.

const OWNER_KEY = 'owner_uid';

/** Isolate-lifetime cache. The owner never changes, so re-reading it on every
 *  authenticated request would be a D1 query for no information. */
let cachedOwner: string | null | undefined;

/** Test seam — the cache is module state and would otherwise leak between cases. */
export function __resetOwnerCache(): void {
  cachedOwner = undefined;
}

async function readOwner(env: Env): Promise<string | null | undefined> {
  if (cachedOwner !== undefined) return cachedOwner;
  try {
    const row: any = await env.DB!
      .prepare('SELECT value FROM config WHERE key = ? LIMIT 1')
      .bind(OWNER_KEY)
      .first();
    const value = typeof row?.value === 'string' ? row.value.trim() : '';
    cachedOwner = value || null;
  } catch {
    // A failed read is NOT "there is no owner". Treating it as such would open
    // the install every time D1 hiccuped. Leave it uncached and UNDEFINED —
    // distinct from null — so the caller can tell "nobody owns this yet" from
    // "we could not find out", and so the next request tries again.
    return undefined;
  }
  return cachedOwner;
}

/** Claim the install for its first authenticated user, once, never overwriting.
 *
 *  Installs provisioned before this existed have no owner recorded. A
 *  self-hoster logs into their own install before publishing its URL, so
 *  first-login is the owner in practice — and once claimed it is fixed. */
async function claimOwner(env: Env, uid: string): Promise<void> {
  try {
    // INSERT OR IGNORE, so a concurrent request cannot overwrite the winner.
    await env.DB!
      .prepare('INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)')
      .bind(OWNER_KEY, uid)
      .run();
    cachedOwner = undefined; // re-read; another request may have won the race
  } catch { /* claiming is best effort — the gate below still decides */ }
}

/**
 * Throws unless `uid` may use this install.
 *
 * Called for every authenticated request on a worker that has its own database,
 * so a route added next year is covered without anyone remembering to cover it.
 */
export async function requireOwner(env: Env, uid: string, mayClaim = true): Promise<void> {
  // The central worker has no database of its own and holds nobody's photos —
  // it authenticates and proxies. Nothing to own.
  if (!env.DB) return;

  const owner = await readOwner(env);

  if (owner === undefined) {
    // The read itself failed. Fail closed on self-host, where an open install
    // is a real exposure; leave hosted alone, where a D1 blip must not lock a
    // user out of their own photos.
    if (isSelfHost(env)) throw new Error('Could not verify install ownership');
    return;
  }

  if (owner === null) {
    // `mayClaim` is false for credentials that do NOT prove this install is
    // yours. A Firebase ID token is minted by a project shared with every other
    // install, so it verifies everywhere — letting one claim an unowned worker
    // would hand the first stranger to arrive the ZKE key, the bot token and
    // every photo, permanently. Only a session token signed with THIS worker's
    // own secret proves rightful possession, so only that may claim.
    if (!mayClaim) throw new Error('Not authenticated');
    await claimOwner(env, uid);
    return;
  }

  if (owner !== uid) {
    // Deliberately the same wording a missing record would produce. Confirming
    // "right install, wrong account" tells a prober they found a real target.
    throw new Error('Not authenticated');
  }
}
