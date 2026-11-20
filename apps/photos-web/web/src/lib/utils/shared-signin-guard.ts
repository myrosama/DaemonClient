// The login page first tries to adopt the shared *.daemonclient.uz session. If
// the app then sends the user straight back here (their worker refused the
// session), trying again would loop forever. So: at most one shared attempt per
// tab per minute — the second visit shows the password form.

export const SHARED_SIGNIN_RETRY_MS = 60_000;
const KEY = 'dc-shared-signin-tried';

type Store = Pick<Storage, 'getItem' | 'setItem'>;

export function mayTrySharedSignIn(storage: Store | null, now = Date.now()): boolean {
  if (!storage) return true;
  try {
    const last = Number(storage.getItem(KEY));
    if (Number.isFinite(last) && last > 0 && last <= now && now - last < SHARED_SIGNIN_RETRY_MS) {
      return false;
    }
    storage.setItem(KEY, String(now));
  } catch {
    // unusable storage: behave as before
  }
  return true;
}
