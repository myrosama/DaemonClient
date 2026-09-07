// BUILD_ORDER P10 — the account, created rather than hand-made in a console.
//
// Manual step 3 of the five: "Authentication → Users → Add user". setup.mjs
// signs IN today but has never created anything, so a user who skipped that
// click reaches a sign-in that cannot succeed. This creates the account and
// then proves it by signing in — the contract asks for the round-trip because
// a created account that cannot log in is exactly the failure a self-hoster
// cannot diagnose.
//
// The error strings below came off the live Identity Toolkit API, not the
// docs. Two things that matters for:
//
//   * codes arrive bare (`INVALID_LOGIN_CREDENTIALS`) or with a useful detail
//     appended (`WEAK_PASSWORD : Password should be at least 6 characters`) —
//     that detail is worth keeping, it is the actionable half.
//   * a bad API key does NOT produce `API_KEY_INVALID`; it produces "API key
//     not valid. Please pass a valid API key." setup.mjs has a map entry for
//     the code that therefore never fires. Matching has to tolerate both.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { explainIdentityError, createAccount, signIn, ensureAccount } from '../src/api/identity.mjs';

/** A fake Identity Toolkit. Records what it was sent, replays canned bodies. */
function fakeIdentity(byMethod) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const method = String(url).match(/accounts:(\w+)/)?.[1];
    const body = JSON.parse(init.body);
    calls.push({ method, body, url: String(url) });
    const reply = byMethod[method];
    if (!reply) throw new Error(`unexpected call to ${method}`);
    const payload = typeof reply === 'function' ? reply(body) : reply;
    return { ok: !payload.error, status: payload.error ? 400 : 200, json: async () => payload };
  };
  return { fetchImpl, calls };
}

const ok = (uid) => ({ localId: uid, idToken: 'tok', email: 'a@b.co' });
const err = (message) => ({ error: { code: 400, message } });

describe('explaining what went wrong', () => {
  test('the switch nobody flipped', () => {
    // Named in BUILD_ORDER as the single most likely human error in the whole
    // flow: P9 opens the console page and waits for Enter, and pressing Enter
    // is easier than flipping the switch. The message has to say THAT, not
    // "OPERATION_NOT_ALLOWED".
    const msg = explainIdentityError('OPERATION_NOT_ALLOWED');
    assert.match(msg, /email/i);
    assert.match(msg, /password/i);
    assert.match(msg, /enable|turn (it )?on|switch/i, 'says what to do, not what happened');
    assert.ok(!/OPERATION_NOT_ALLOWED/.test(msg), 'the raw code helps nobody');
  });

  test('keeps the actionable half of a code that carries detail', () => {
    // Real: "WEAK_PASSWORD : Password should be at least 6 characters".
    // Dropping the tail loses the only part that says what to do.
    const msg = explainIdentityError('WEAK_PASSWORD : Password should be at least 6 characters');
    assert.match(msg, /6 characters/);
  });

  test('an existing account is not an error at this layer', () => {
    assert.match(explainIdentityError('EMAIL_EXISTS'), /already/i);
  });

  test('a bad key, whose real message does not contain the documented code', () => {
    const msg = explainIdentityError('API key not valid. Please pass a valid API key.');
    assert.match(msg, /API key/i);
  });

  test('anything unrecognised survives as itself', () => {
    assert.match(explainIdentityError('SOMETHING_NEW_FROM_GOOGLE'), /SOMETHING_NEW_FROM_GOOGLE/);
  });
});

describe('the password never travels anywhere it should not', () => {
  const SECRET = 'correct-horse-battery-staple';

  test('it is not in any thrown message', async () => {
    const { fetchImpl } = fakeIdentity({ signUp: err('WEAK_PASSWORD : Password should be at least 6 characters') });
    await assert.rejects(
      () => createAccount('AIzaKey', 'a@b.co', SECRET, { fetchImpl }),
      (e) => {
        assert.ok(!e.message.includes(SECRET), `the password leaked into an error: ${e.message}`);
        return true;
      },
    );
  });

  test('it is not in a message built from a NETWORK failure either', async () => {
    // The API-error path above and this one are different branches, and this
    // is the one where a careless hand reaches for context to attach — the
    // request body is right there. A mutation that interpolated the password
    // into this exact message survived the first version of these tests.
    const fetchImpl = async () => { throw new Error('ECONNRESET'); };
    for (const fn of [createAccount, signIn]) {
      await assert.rejects(
        () => fn('AIzaKey', 'a@b.co', SECRET, { fetchImpl }),
        (e) => {
          assert.ok(!e.message.includes(SECRET), `${fn.name} leaked the password on the network path: ${e.message}`);
          return true;
        },
      );
    }
  });

  test('it is not in the URL, where it would reach logs and history', async () => {
    // The API key goes in the query string because Google requires it. The
    // password must not follow it there — query strings end up in proxy logs,
    // shell history and error reports.
    const { fetchImpl, calls } = fakeIdentity({ signUp: ok('uid-1'), signInWithPassword: ok('uid-1') });
    await ensureAccount('AIzaKey', 'a@b.co', SECRET, { fetchImpl });
    for (const c of calls) {
      assert.ok(!c.url.includes(SECRET), `the password was put in a URL: ${c.url}`);
    }
  });
});

describe('creating the account', () => {
  test('returns the uid the owner claim needs', async () => {
    // state.adminUserId is what owner.mjs writes into the install's config
    // table. Wrong or missing, and the dashboard cannot claim the install —
    // which is the P0 bug this repo already fixed once.
    const { fetchImpl, calls } = fakeIdentity({ signUp: ok('uid-abc') });
    assert.equal(await createAccount('AIzaKey', 'a@b.co', 'pw123456', { fetchImpl }), 'uid-abc');
    assert.equal(calls[0].method, 'signUp');
    assert.equal(calls[0].body.returnSecureToken, true);
  });

  test('lowercases the email, since that is what gets stored and compared', async () => {
    const { fetchImpl, calls } = fakeIdentity({ signUp: ok('uid-abc') });
    await createAccount('AIzaKey', 'A@B.Co', 'pw123456', { fetchImpl });
    assert.equal(calls[0].body.email, 'a@b.co');
  });
});

describe('ensureAccount — the round trip the contract asks for', () => {
  test('creates, then proves it by signing in', async () => {
    const { fetchImpl, calls } = fakeIdentity({ signUp: ok('uid-new'), signInWithPassword: ok('uid-new') });
    const out = await ensureAccount('AIzaKey', 'a@b.co', 'pw123456', { fetchImpl });
    assert.deepEqual(out, { uid: 'uid-new', created: true });
    assert.deepEqual(calls.map((c) => c.method), ['signUp', 'signInWithPassword'],
      'a created account that cannot sign in is the failure a self-hoster cannot diagnose');
  });

  test('an account left over from a previous run signs in instead', async () => {
    // The resume path. Setup is resumable at every boundary, so the second run
    // must not treat "already there" as a failure.
    const { fetchImpl, calls } = fakeIdentity({
      signUp: err('EMAIL_EXISTS'),
      signInWithPassword: ok('uid-old'),
    });
    const out = await ensureAccount('AIzaKey', 'a@b.co', 'pw123456', { fetchImpl });
    assert.deepEqual(out, { uid: 'uid-old', created: false });
    assert.deepEqual(calls.map((c) => c.method), ['signUp', 'signInWithPassword']);
  });

  test('an existing account with a DIFFERENT password fails loudly', async () => {
    // Someone re-running setup with a new password against the same email.
    // Silently continuing would leave them with an install whose owner is an
    // account they cannot log into.
    const { fetchImpl } = fakeIdentity({
      signUp: err('EMAIL_EXISTS'),
      signInWithPassword: err('INVALID_LOGIN_CREDENTIALS'),
    });
    await assert.rejects(() => ensureAccount('AIzaKey', 'a@b.co', 'wrong-pw', { fetchImpl }),
      /already exists|rejected|password/i);
  });

  test('the un-flipped switch surfaces as the switch, not as a code', async () => {
    const { fetchImpl } = fakeIdentity({ signUp: err('OPERATION_NOT_ALLOWED') });
    await assert.rejects(() => ensureAccount('AIzaKey', 'a@b.co', 'pw123456', { fetchImpl }),
      /enable|turn (it )?on|switch/i);
  });

  test('a uid that never arrives is an error, not an undefined passed onward', async () => {
    // owner.mjs refuses a blank uid — but it should never get the chance.
    const { fetchImpl } = fakeIdentity({ signUp: { idToken: 'tok' } });
    await assert.rejects(() => ensureAccount('AIzaKey', 'a@b.co', 'pw123456', { fetchImpl }), /user id/i);
  });

  test('sign-in returning a different uid than sign-up is caught', async () => {
    // Should be impossible; if it ever happens the install would be claimed
    // for an account other than the one the person just made.
    const { fetchImpl } = fakeIdentity({ signUp: ok('uid-a'), signInWithPassword: ok('uid-b') });
    await assert.rejects(() => ensureAccount('AIzaKey', 'a@b.co', 'pw123456', { fetchImpl }), /different account|mismatch/i);
  });
});

describe('the network can always fail', () => {
  test('every call carries a timeout', async () => {
    // The lesson from tg.getMe: the one call without an AbortSignal is the one
    // that hangs setup forever behind a firewall that drops packets.
    let seen;
    const fetchImpl = async (_url, init) => {
      seen = init.signal;
      return { ok: true, status: 200, json: async () => ok('uid-1') };
    };
    await createAccount('AIzaKey', 'a@b.co', 'pw123456', { fetchImpl });
    assert.ok(seen instanceof AbortSignal, 'no AbortSignal reached fetch');
  });

  test('a network throw is reported as a network problem', async () => {
    const fetchImpl = async () => { throw new Error('fetch failed'); };
    await assert.rejects(() => createAccount('AIzaKey', 'a@b.co', 'pw123456', { fetchImpl }),
      /could not reach|network|fetch failed/i);
  });
});
