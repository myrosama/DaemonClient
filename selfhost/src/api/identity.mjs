// BUILD_ORDER P10 — the account, created rather than hand-made in a console.
//
// `setup` signs IN today but has never created anything, so manual step 3 of
// the five — "Authentication → Users → Add user" — was load-bearing: skip that
// click and you reach a sign-in that cannot succeed, with nothing saying why.
// This creates the account, then signs in to prove it. The round trip is in
// the contract on purpose: an account that exists but cannot log in is exactly
// the failure a self-hoster has no way to diagnose.
//
// THE ERROR STRINGS HERE CAME OFF THE LIVE API, not the docs. Two findings
// that shaped this file:
//
//   * codes arrive bare (`INVALID_LOGIN_CREDENTIALS`) or with the useful half
//     appended (`WEAK_PASSWORD : Password should be at least 6 characters`).
//     The tail is the actionable part and is kept.
//   * a bad key does NOT return `API_KEY_INVALID`. It returns "API key not
//     valid. Please pass a valid API key." — a platform-level error, not an
//     Identity Toolkit one. setup.mjs's map has an entry for the code that
//     therefore never fires. Matching here tolerates both spellings.
//
// The password is a secret that must never reach disk (state.mjs NEVER_PERSIST)
// and must never reach a log. It travels in a POST body — never the query
// string, where the API key has to go and where proxy logs and shell history
// can see it — and no message built here ever interpolates it.

const ENDPOINT = 'https://identitytoolkit.googleapis.com/v1/accounts';
// Same 15s as every other network call in this CLI. The one call that lacked
// one (tg.getMe) is the one that hung setup forever behind a packet-dropping
// firewall.
export const REQUEST_TIMEOUT_MS = 15000;

const ADVICE = [
  // The switch nobody flipped. BUILD_ORDER names this the single most likely
  // human error in the whole flow, because P9 opens the console page and waits
  // for Enter — and pressing Enter is easier than flipping the switch.
  ['OPERATION_NOT_ALLOWED',
    'Email/Password sign-in is still switched off for this Firebase project, so no account can be created in it yet. '
    + 'Open Authentication → Sign-in method, enable Email/Password, then run setup again.'],
  ['EMAIL_EXISTS', 'An account with that email already exists in this project.'],
  ['EMAIL_NOT_FOUND', 'No account with that email exists in this project.'],
  ['INVALID_LOGIN_CREDENTIALS', 'That email and password were rejected. Check both.'],
  ['INVALID_PASSWORD', 'Wrong password for that account.'],
  ['USER_DISABLED', 'That account is disabled in the Firebase console.'],
  ['INVALID_EMAIL', 'That is not a valid email address.'],
  ['TOO_MANY_ATTEMPTS_TRY_LATER', 'Google is rate-limiting this project after too many attempts. Wait a few minutes, then run setup again.'],
  ['WEAK_PASSWORD', 'That password is too weak.'],
  ['API_KEY_INVALID', 'That Firebase Web API key is not valid for this project.'],
  // The real spelling of the same thing — see the header.
  ['API key not valid', 'That Firebase Web API key is not valid for this project.'],
];

/** What to do about it, in words, keeping any detail Google appended. */
export function explainIdentityError(message) {
  const raw = String(message ?? '').trim();
  for (const [code, advice] of ADVICE) {
    if (!raw.includes(code)) continue;
    // "WEAK_PASSWORD : Password should be at least 6 characters" — the tail is
    // the only part that says what to change.
    const detail = raw.split(':').slice(1).join(':').trim();
    return detail && !detail.includes(code) ? `${advice} ${detail}.` : advice;
  }
  return raw;
}

async function call(method, apiKey, body, { fetchImpl = fetch } = {}) {
  let res;
  try {
    res = await fetchImpl(`${ENDPOINT}:${method}?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (e) {
    // Never let the password ride along in whatever the network layer said.
    throw new Error(`could not reach Google to sign in: ${String(e?.message ?? e).slice(0, 120)}`);
  }
  const payload = await res.json().catch(() => ({}));
  if (payload?.error) throw new Error(explainIdentityError(payload.error.message));
  return payload;
}

/** Create the account. Returns the uid — which is what owner.mjs writes as the
 *  install's `owner_uid`, so a wrong or missing one is the P0 bug again. */
export async function createAccount(apiKey, email, password, deps = {}) {
  const payload = await call('signUp', apiKey, {
    email: String(email).toLowerCase(),
    password,
    returnSecureToken: true,
  }, deps);
  if (!payload?.localId) throw new Error('Firebase created the account but returned no user id');
  return payload.localId;
}

/** Sign in. The proof half of the contract. */
export async function signIn(apiKey, email, password, deps = {}) {
  const payload = await call('signInWithPassword', apiKey, {
    email: String(email).toLowerCase(),
    password,
    returnSecureToken: true,
  }, deps);
  if (!payload?.localId) throw new Error('Firebase signed in but returned no user id');
  return payload.localId;
}

/**
 * The account, created if it is not already there, and proven either way.
 *
 * A second run of setup finds the account it made the first time. Treating
 * that as a failure would make the wizard un-resumable at the one step people
 * are most likely to repeat — so EMAIL_EXISTS falls through to a sign-in.
 * But only a SUCCESSFUL sign-in counts: someone re-running with a different
 * password must not end up owning an install they cannot log into.
 */
export async function ensureAccount(apiKey, email, password, deps = {}) {
  let uid;
  let created = true;
  try {
    uid = await createAccount(apiKey, email, password, deps);
  } catch (e) {
    if (!/already exists/i.test(e.message)) throw e;
    created = false;
  }

  const signedIn = await signIn(apiKey, email, password, deps);

  if (created && uid && signedIn !== uid) {
    // Should be impossible. If it ever happens, the install would be claimed
    // for an account other than the one the person in front of us just made.
    throw new Error('Firebase signed in as a different account than the one just created — refusing to continue');
  }
  return { uid: signedIn, created };
}
