import { describe, it, expect, afterEach, vi } from 'vitest';
import { getCachedConfig } from './cached-config';

// The Telegram relay checks bot tokens against the worker's local (D1) copy of
// the Telegram settings, so the routes that hand those settings to the app must
// not succeed without having saved that copy.

function d1(opts: { writeFails?: boolean }) {
  const store = new Map<string, string>();
  const statement = (sql: string, args: any[] = []) => ({
    bind: (...a: any[]) => statement(sql, a),
    first: async () => (/SELECT value FROM config/i.test(sql) && store.has(args[0]) ? { value: store.get(args[0]) } : null),
    run: async () => {
      if (/INSERT|REPLACE|UPDATE/i.test(sql)) {
        if (opts.writeFails) throw new Error('D1 write failed');
        store.set(args[0], args[1]);
      }
      return {};
    },
    all: async () => ({ results: [] }),
  });
  return { prepare: (sql: string) => statement(sql) } as any;
}

afterEach(() => vi.unstubAllGlobals());
const firestoreHas = (fields: Record<string, string>) =>
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, { stringValue: v }])) })));

describe('getCachedConfig with requireLocalCopy', () => {
  it('fails when the local copy could not be saved', async () => {
    firestoreHas({ botToken: 't' });
    const env: any = { DB: d1({ writeFails: true }), FIREBASE_PROJECT_ID: 'p' };
    await expect(getCachedConfig(env, 'u1', 'id', 'telegram', { requireLocalCopy: true })).rejects.toThrow(/write failed/);
  });
  it('without it, a failed local save stays best effort', async () => {
    firestoreHas({ botToken: 't' });
    const env: any = { DB: d1({ writeFails: true }), FIREBASE_PROJECT_ID: 'p' };
    expect(await getCachedConfig<any>(env, 'u1', 'id', 'telegram')).toMatchObject({ botToken: 't' });
  });
});
