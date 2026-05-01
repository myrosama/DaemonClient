import type { Env } from './index';
import { firestoreGet, firestoreSet } from './helpers';
import { D1Adapter } from './d1-adapter';

// D1-first config reader with Firestore fallback. On per-user workers (where
// env.DB is bound) we want every config read to hit D1, not Firestore — that
// keeps active users off the Firestore free-tier read budget. The first read
// after a worker upgrade still falls back to Firestore so existing accounts
// don't lose their config, then writes the value through to D1 so subsequent
// reads stay local. Once a user has been migrated, Firestore is never touched.
export async function getCachedConfig<T = any>(
  env: Env,
  uid: string,
  idToken: string,
  key: string
): Promise<T | null> {
  if (env.DB) {
    const adapter = new D1Adapter(env.DB);
    const local = await adapter.getJsonConfig<T>(key);
    if (local !== null) return local;
    const remote = await firestoreGet(env, uid, `config/${key}`, idToken);
    if (remote) {
      try { await adapter.setJsonConfig(key, remote); } catch { /* best effort */ }
      return remote as T;
    }
    return null;
  }
  return await firestoreGet(env, uid, `config/${key}`, idToken);
}

// D1-first config writer. On per-user workers we write to D1 only — Firestore
// writes for setup-time docs (config/telegram, config/cloudflare) are still
// done by accounts-portal so Firebase Function triggers (admin alerts) keep
// firing. Per-user runtime updates stay in D1, where they belong.
export async function setCachedConfig(
  env: Env,
  uid: string,
  idToken: string,
  key: string,
  value: Record<string, any>,
  options: { mergeExisting?: boolean; alsoFirestore?: boolean } = {}
): Promise<void> {
  if (env.DB) {
    const adapter = new D1Adapter(env.DB);
    let next = value;
    if (options.mergeExisting) {
      const prev = (await adapter.getJsonConfig<Record<string, any>>(key)) || {};
      next = { ...prev, ...value };
    }
    await adapter.setJsonConfig(key, next);
    if (options.alsoFirestore) {
      try { await firestoreSet(env, uid, `config/${key}`, value, idToken); } catch { /* best effort */ }
    }
    return;
  }
  await firestoreSet(env, uid, `config/${key}`, value, idToken);
}
