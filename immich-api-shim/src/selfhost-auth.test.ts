import { describe, it, expect, beforeEach } from 'vitest';
import {
  hashPassword,
  verifyPassword,
  parsePasswordRecord,
  isSelfHost,
  sessionScope,
  verifyLocalCredentials,
  PASSWORD_ITERATIONS,
} from './selfhost-auth';

// A self-hosted install has no Firebase. Accounts live in the operator's own D1
// and passwords are verified by the worker itself, so this module is the entire
// security boundary of a self-hosted deployment: every one of these properties
// is load-bearing.

function makeDb(users: any[]) {
  const calls: string[] = [];
  return {
    calls,
    db: {
      prepare(sql: string) {
        calls.push(sql);
        return {
          bind: (...args: any[]) => ({
            first: async () => {
              if (/FROM users/i.test(sql)) {
                const email = String(args[0] || '').toLowerCase();
                return users.find(u => u.email === email) || null;
              }
              return null;
            },
            all: async () => ({ results: users }),
            run: async () => ({}),
          }),
        };
      },
    } as any,
  };
}

describe('password hashing', () => {
  it('produces a verifiable record with a real work factor', async () => {
    const rec = await hashPassword('correct horse battery staple');
    const parsed = parsePasswordRecord(rec);
    expect(parsed).not.toBeNull();
    expect(parsed!.algorithm).toBe('pbkdf2-sha256');
    // OWASP's floor for PBKDF2-HMAC-SHA256 is 600k; never silently weaken it.
    expect(parsed!.iterations).toBe(PASSWORD_ITERATIONS);
    expect(PASSWORD_ITERATIONS).toBeGreaterThanOrEqual(600_000);
    expect(await verifyPassword('correct horse battery staple', rec)).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const rec = await hashPassword('hunter2');
    expect(await verifyPassword('hunter3', rec)).toBe(false);
    expect(await verifyPassword('', rec)).toBe(false);
    expect(await verifyPassword('HUNTER2', rec)).toBe(false);
  });

  it('salts every hash, so identical passwords never share a digest', async () => {
    const a = await hashPassword('same-password');
    const b = await hashPassword('same-password');
    expect(a).not.toBe(b);
    expect(await verifyPassword('same-password', a)).toBe(true);
    expect(await verifyPassword('same-password', b)).toBe(true);
  });

  it('refuses malformed or truncated records instead of accepting them', async () => {
    for (const bad of ['', 'garbage', 'pbkdf2-sha256$100', 'pbkdf2-sha256$abc$salt$hash', '$$$']) {
      expect(await verifyPassword('anything', bad)).toBe(false);
    }
  });

  it('does not accept a record whose algorithm we do not implement', async () => {
    const rec = await hashPassword('pw');
    const swapped = rec.replace('pbkdf2-sha256', 'md5');
    expect(await verifyPassword('pw', swapped)).toBe(false);
  });
});

describe('mode detection and session scope', () => {
  it('treats SELF_HOST=1 as self-hosted and anything else as managed', () => {
    expect(isSelfHost({ SELF_HOST: '1' } as any)).toBe(true);
    expect(isSelfHost({ SELF_HOST: 'true' } as any)).toBe(true);
    expect(isSelfHost({ SELF_HOST: '0' } as any)).toBe(false);
    expect(isSelfHost({} as any)).toBe(false);
  });

  it('signs self-hosted sessions with the install secret, not the public app id', () => {
    const env: any = { SELF_HOST: '1', SESSION_SECRET: 'a-very-long-random-install-secret', APP_IDENTIFIER: 'default-daemon-client' };
    expect(sessionScope(env)).toBe('a-very-long-random-install-secret');
  });

  it('keeps the existing scope for managed installs so live sessions stay valid', () => {
    const env: any = { APP_IDENTIFIER: 'default-daemon-client' };
    expect(sessionScope(env)).toBe('default-daemon-client');
  });

  it('never falls back to a guessable scope when self-hosted without a secret', () => {
    // A blank/short secret would make session forgery trivial, so signing must
    // fail loudly rather than quietly using a public constant.
    expect(() => sessionScope({ SELF_HOST: '1', APP_IDENTIFIER: 'default' } as any)).toThrow(/SESSION_SECRET/);
    expect(() => sessionScope({ SELF_HOST: '1', SESSION_SECRET: 'short' } as any)).toThrow(/SESSION_SECRET/);
  });
});

describe('verifyLocalCredentials', () => {
  let record: string;
  beforeEach(async () => {
    record = await hashPassword('s3cret-password');
  });

  it('accepts the right password and returns the account', async () => {
    const { db } = makeDb([{ id: 'u1', email: 'me@example.com', passwordHash: record, name: 'Me', isAdmin: 1 }]);
    const user = await verifyLocalCredentials(db, 'me@example.com', 's3cret-password');
    expect(user).toMatchObject({ id: 'u1', email: 'me@example.com', isAdmin: true });
  });

  it('is case-insensitive on the email, as users expect', async () => {
    const { db } = makeDb([{ id: 'u1', email: 'me@example.com', passwordHash: record, isAdmin: 1 }]);
    expect(await verifyLocalCredentials(db, 'ME@Example.COM', 's3cret-password')).toBeTruthy();
  });

  it('rejects a wrong password', async () => {
    const { db } = makeDb([{ id: 'u1', email: 'me@example.com', passwordHash: record, isAdmin: 1 }]);
    expect(await verifyLocalCredentials(db, 'me@example.com', 'wrong')).toBeNull();
  });

  it('rejects an unknown account without leaking that it is unknown', async () => {
    const { db } = makeDb([{ id: 'u1', email: 'me@example.com', passwordHash: record, isAdmin: 1 }]);
    expect(await verifyLocalCredentials(db, 'nobody@example.com', 's3cret-password')).toBeNull();
  });

  it('does a real hash comparison for unknown users too, so timing does not reveal existence', async () => {
    const { db, calls } = makeDb([]);
    const t0 = Date.now();
    await verifyLocalCredentials(db, 'nobody@example.com', 'whatever');
    const elapsed = Date.now() - t0;
    // The dummy verification must actually run: 600k PBKDF2 rounds is never
    // instant. If this is ~0ms the timing side-channel is back.
    expect(elapsed).toBeGreaterThan(5);
    expect(calls.some(c => /FROM users/i.test(c))).toBe(true);
  });

  it('rejects an account row with no usable password hash', async () => {
    const { db } = makeDb([{ id: 'u1', email: 'me@example.com', passwordHash: '', isAdmin: 1 }]);
    expect(await verifyLocalCredentials(db, 'me@example.com', '')).toBeNull();
  });
});
