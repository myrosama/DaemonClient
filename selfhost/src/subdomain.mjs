// Making sure the account has a workers.dev subdomain — the address the whole
// install is reached at.
//
// Why this is its own module rather than four lines in setup.mjs:
//
//   `registerSubdomain` already existed in api/cloudflare.mjs, complete and
//   correct, and was called from nowhere. Setup only ever *read* the subdomain
//   and fell back to null, so on an account that had never had one the install
//   finished with a cheerful summary and no address. Putting the logic behind
//   a function makes it testable against a fake Cloudflare, which four lines
//   inline in an interactive wizard are not.

import crypto from 'node:crypto';

// Cloudflare's real rule, from wrangler's own source: max 63 characters, and
// it may not begin or end with a dash.
//
// The first version of this was /^[a-z0-9][a-z0-9-]{1,54}$/ — it permitted a
// TRAILING dash and capped at 55. A Gate 3 review caught it, and also caught
// that the test asserting this pattern was byte-identical to the pattern
// itself: it proved the function agreed with itself, not with workers.dev.
const LEGAL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

// Cloudflare's subdomain error codes, taken from wrangler
// (packages/deploy-helpers/src/triggers/subdomain.ts), not guessed.
//
// The first version of this module keyed retries on 10035, which is
// "Multiple attempts to modify a resource at the same time" — a CONCURRENCY
// error, not a name collision. So on a real collision (10031) the check was
// false, the loop rethrew on the first candidate, and the install died. The
// retry existed on paper and was dead in practice. Worse, the unit test
// manufactured a 10035 error, so the suite was green precisely because the
// test agreed with the mistake.
export const CF = {
  NO_SUBDOMAIN: 10007,   // the account has never registered one
  TAKEN: 10031,          // that name belongs to someone else
  AVAILABLE: 10032,      // the name is free
  ALREADY_HAS_ONE: 10036,// this account already has a subdomain
  CONCURRENT: 10035,     // retry the SAME name, do not pick a new one
};

/**
 * A neutral, legal, unlikely-to-collide subdomain candidate.
 *
 * **Deliberately derives nothing from the account.** The previous version built
 * it from the Cloudflare account name, whose default on a personal signup is
 * `<your email>'s Account` — so a self-hoster ended up with
 * `contact-example-com-s-account-a1b2c3.workers.dev`: their email address,
 * permanently, in public DNS and in Certificate Transparency logs, on a product
 * whose whole pitch is that nothing about them leaves their control. And
 * `doctor` prints the resulting URL in a report it labels safe to share.
 *
 * A random label leaks nothing and costs the user nothing — they are shown it
 * and can choose their own.
 */
export function suggestSubdomain() {
  return `daemonclient-${crypto.randomBytes(4).toString('hex')}`;
}

/** Is this a name workers.dev will accept? Used to validate what a user types. */
export function isLegalSubdomain(name) {
  return typeof name === 'string' && name.length <= 63 && LEGAL.test(name);
}

function classify(e) {
  const code = e?.code;
  if (code === CF.TAKEN) return 'taken';
  if (code === CF.CONCURRENT) return 'retry-same';
  // No message-text matching. The old version treated anything containing
  // "not available" as a collision, which swallowed real failures —
  // "This feature is not available on your plan" burned every candidate and
  // then told the user to go pick a name in the dashboard, which would not
  // have helped them at all.
  return 'fatal';
}

/**
 * Guarantee the account has a workers.dev subdomain, and return it.
 *
 * Reads before writing: registering over a subdomain the operator already uses
 * would rename every other worker on their account.
 *
 * **Throws rather than returning null.** Returning null is precisely what
 * produced a "successful" install with no address.
 *
 * @param {object} cf   the Cloudflare API module (injected so it can be faked)
 * @param {string} auth API token
 * @param {string} accountId
 * @param {{desired?:string, candidates?:string[]}} opts
 * @returns {Promise<string>} the subdomain now in effect
 */
export async function ensureSubdomain(cf, auth, accountId, { desired, candidates = [] } = {}) {
  const existing = await cf.getSubdomain(auth, accountId);
  // Guard the empty string as well as null: a falsy-but-present value would
  // otherwise fall through to a PUT over a subdomain that already exists.
  if (existing) return existing;

  const tried = [];
  for (const name of [desired, ...candidates].filter(Boolean)) {
    tried.push(name);

    // One retry for the concurrency error, with the SAME name — re-rolling a
    // new one there would discard a perfectly good candidate.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await cf.registerSubdomain(auth, accountId, name);
        // Prefer what the API says it registered over what we asked for, in
        // case Cloudflare normalises it. Falling back to `name` keeps older
        // fakes and any endpoint that returns no body working.
        return res?.subdomain || res?.result?.subdomain || name;
      } catch (e) {
        const kind = classify(e);
        if (kind === 'retry-same' && attempt === 0) continue;
        if (kind === 'taken') break;       // next candidate
        throw e;                            // fatal: token, permission, outage
      }
    }
  }

  throw new Error(
    `Could not register a workers.dev subdomain for this account (tried: ${tried.join(', ') || 'none'}). ` +
    `Your worker has nowhere to be reached at. Pick one manually at ` +
    `https://dash.cloudflare.com → Workers & Pages → your subdomain, then run setup again.`,
  );
}
