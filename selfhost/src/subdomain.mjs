// Making sure the account has a workers.dev subdomain — the address the whole
// install is reached at.
//
// Why this is its own module rather than four lines in setup.mjs:
//
//   `registerSubdomain` already existed in api/cloudflare.mjs, complete and
//   correct, and was called from nowhere. Setup only ever *read* the subdomain
//   and fell back to null, so on an account that had never had one the install
//   finished with a cheerful summary and no address:
//
//       Your API
//         (no workers.dev subdomain — check the Cloudflare dashboard)
//
//   A brand-new Cloudflare account is the expected state for a self-hoster, so
//   the configuration we most need to work was the one that silently didn't.
//   Putting the logic behind a function makes it testable against a fake
//   Cloudflare, which four lines inline in an interactive wizard are not.

import crypto from 'node:crypto';

/** workers.dev accepts lowercase letters, digits and dashes, and it is a
 *  GLOBAL namespace — so a plausible name is often already gone. */
const LEGAL = /^[a-z0-9][a-z0-9-]{1,54}$/;

/**
 * A legal, unlikely-to-collide subdomain candidate derived from a hint
 * (usually the Cloudflare account name).
 *
 * Always returns something usable. An account named `???`, or unnamed, must
 * still produce a valid candidate rather than an empty string the API would
 * reject with an error the user cannot act on.
 */
export function suggestSubdomain(hint) {
  const base = String(hint ?? '')
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')  // strip accents
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/, '');

  // A random suffix on every call, not just on collision: two attempts must
  // never propose the same name, or a retry re-proposes the one just refused.
  const suffix = crypto.randomBytes(3).toString('hex');
  const name = `${base || 'daemonclient'}-${suffix}`;
  return LEGAL.test(name) ? name : `daemonclient-${suffix}`;
}

/**
 * Guarantee the account has a workers.dev subdomain, and return it.
 *
 * Reads before writing: registering over a subdomain the operator already uses
 * would move every other worker on their account.
 *
 * **Throws rather than returning null.** Returning null is precisely what
 * produced a "successful" install with no address. A setup that cannot get an
 * address has failed, and must say so while the user is still watching.
 *
 * @param {object} cf     the Cloudflare API module (injected so it can be faked)
 * @param {string} auth   API token
 * @param {string} accountId
 * @param {{desired?:string, candidates?:string[]}} opts
 * @returns {Promise<string>} the subdomain now in effect
 */
export async function ensureSubdomain(cf, auth, accountId, { desired, candidates = [] } = {}) {
  const existing = await cf.getSubdomain(auth, accountId);
  if (existing) return existing;

  const tried = [];
  for (const name of [desired, ...candidates].filter(Boolean)) {
    tried.push(name);
    try {
      await cf.registerSubdomain(auth, accountId, name);
      return name;
    } catch (e) {
      // 10035 (and the "already exists" text) means the name is taken by
      // someone else's account — try the next one. Anything else is a real
      // failure: a bad token, a missing permission, an outage. Those must not
      // be retried into a confusing "ran out of names" message.
      const taken = e?.code === 10035 || /already exists|already taken|not available/i.test(e?.message || '');
      if (!taken) throw e;
    }
  }

  throw new Error(
    `Could not register a workers.dev subdomain for this account (tried: ${tried.join(', ') || 'none'}). ` +
    `Your worker has nowhere to be reached at. Pick one manually at ` +
    `https://dash.cloudflare.com → Workers & Pages → your subdomain, then run setup again.`,
  );
}
