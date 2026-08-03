import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./cached-config', () => ({
  getCachedConfig: async () => ({ botToken: 'T', channelId: '-1' }),
}));

import { requireOwner, __resetOwnerCache } from './owner-gate';
import { requireAuth } from './helpers';
import { testSessionToken, testAuthEnv } from './test-session';

// One install belongs to one person. This is THE boundary, not a supplement to
// one: the config table on a per-user worker is worker-global, not scoped by
// uid, and Firebase signup is open by default — so on a self-hosted install any
// account that could register in the owner's Firebase project could read
// /api/server/zke-config (the key to every photo) or overwrite the install's
// bot token via /api/drive/config.

const OWNER = 'owner-uid';

function db(ownerValue: string | null, opts: { failReads?: boolean } = {}) {
  const inserted: string[] = [];
  const d: any = {
    inserted,
    prepare: (sql: string) => ({
      bind: (...args: any[]) => ({
        first: async () => {
          if (opts.failReads) throw new Error('D1 unavailable');
          return ownerValue === null ? null : { value: ownerValue };
        },
        run: async () => {
          if (sql.startsWith('INSERT')) inserted.push(String(args[1]));
          return {};
        },
        all: async () => ({ results: [] }),
      }),
    }),
  };
  return d;
}

beforeEach(() => __resetOwnerCache());

describe('the owner gate', () => {
  it('lets the owner through', async () => {
    await expect(requireOwner({ DB: db(OWNER) } as any, OWNER)).resolves.toBeUndefined();
  });

  it('REFUSES anybody else', async () => {
    await expect(requireOwner({ DB: db(OWNER) } as any, 'someone-else')).rejects.toThrow();
  });

  it('gives a stranger the same message as a missing session', async () => {
    // Confirming "right install, wrong account" tells a prober they found a
    // real target. The wording must not distinguish the two.
    await expect(requireOwner({ DB: db(OWNER) } as any, 'stranger')).rejects.toThrow('Not authenticated');
  });

  it('claims an unowned install for its first authenticated user', async () => {
    const d = db(null);
    await requireOwner({ DB: d } as any, 'first-user');
    expect(d.inserted).toContain('first-user');
  });

  it('claims with INSERT OR IGNORE, so a race cannot overwrite the winner', async () => {
    const d = db(null);
    await requireOwner({ DB: d } as any, 'a');
    // The statement itself must be the non-destructive form.
    let sql = '';
    const probe: any = { prepare: (s: string) => { sql = s; return { bind: () => ({ run: async () => ({}), first: async () => null }) }; } };
    __resetOwnerCache();
    await requireOwner({ DB: probe } as any, 'b').catch(() => {});
    expect(sql.toUpperCase()).toContain('INSERT OR IGNORE');
  });

  it('does nothing on the central worker, which owns no data', async () => {
    await expect(requireOwner({} as any, 'anyone')).resolves.toBeUndefined();
  });
});

describe('when the ownership read itself fails', () => {
  it('self-host fails CLOSED — an open install is a real exposure', async () => {
    const env: any = { DB: db(OWNER, { failReads: true }), SELF_HOST: '1' };
    await expect(requireOwner(env, OWNER)).rejects.toThrow(/ownership/i);
  });

  it('hosted fails OPEN — a D1 blip must not lock someone out of their photos', async () => {
    // Hosted is one worker per person and already contained by its own
    // SESSION_SECRET, so the trade runs the other way here.
    const env: any = { DB: db(OWNER, { failReads: true }) };
    await expect(requireOwner(env, OWNER)).resolves.toBeUndefined();
  });

  it('a failed read is not cached as "no owner"', async () => {
    let fail = true;
    const d: any = {
      prepare: () => ({
        bind: () => ({
          first: async () => { if (fail) throw new Error('down'); return { value: OWNER }; },
          run: async () => ({}),
        }),
      }),
    };
    const env: any = { DB: d };
    await requireOwner(env, 'stranger');   // read fails → hosted lets it pass
    fail = false;
    // Once D1 recovers, the gate must work — not stay stuck on a cached null.
    await expect(requireOwner(env, 'stranger')).rejects.toThrow();
  });
});

describe('it is enforced for EVERY authenticated request, not per route', () => {
  it('requireAuth itself refuses a non-owner', async () => {
    const req = new Request('https://worker.test/api/anything', {
      headers: { Authorization: `Bearer ${await testSessionToken('not-the-owner')}` },
    });
    const env: any = testAuthEnv({ DB: db(OWNER) });
    await expect(requireAuth(req, env)).rejects.toThrow();
  });

  it('and admits the owner', async () => {
    const req = new Request('https://worker.test/api/anything', {
      headers: { Authorization: `Bearer ${await testSessionToken(OWNER)}` },
    });
    const env: any = testAuthEnv({ DB: db(OWNER) });
    const session = await requireAuth(req, env);
    expect(session.uid).toBe(OWNER);
  });
});

describe('mayClaim=false — a fleet-wide credential must never claim an install', () => {
  // A Firebase ID token verifies on EVERY worker, because one Firebase project
  // serves the whole fleet. If such a token could claim an unowned install, the
  // first stranger to find the URL would permanently own someone's photos,
  // ZKE key and bot token. Only a session token signed with THIS worker's own
  // secret proves rightful possession, so only that may claim.
  it('refuses an unowned install rather than claiming it', async () => {
    __resetOwnerCache();
    await expect(requireOwner({ DB: db(null) } as any, 'stranger-uid', false)).rejects.toThrow('Not authenticated');
  });

  it('still lets the recorded owner through', async () => {
    __resetOwnerCache();
    await expect(requireOwner({ DB: db(OWNER) } as any, OWNER, false)).resolves.toBeUndefined();
  });

  it('still rejects a different account on a claimed install', async () => {
    __resetOwnerCache();
    await expect(requireOwner({ DB: db(OWNER) } as any, 'stranger', false)).rejects.toThrow('Not authenticated');
  });
});
