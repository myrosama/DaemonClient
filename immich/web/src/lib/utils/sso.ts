import { PUBLIC_DAEMONCLIENT_AUTH_URL, PUBLIC_DAEMONCLIENT_WORKER_URL } from '$env/static/public';

// Single sign-on across the dashboard, Photos and Drive.
//
// Firebase persists its session per ORIGIN, so signing in on
// accounts.daemonclient.uz leaves Photos looking signed-out and asking for a
// password again. The shared hub (auth.daemonclient.uz) holds one HttpOnly
// cookie for *.daemonclient.uz; we ask it for a short-lived Firebase ID token
// and trade that for a normal session at the worker.
//
// The exchange deliberately uses an ABSOLUTE url. The service worker intercepts
// same-origin `/api/*` and rebuilds the headers from its own stored token —
// which does not exist yet on the login page — so a relative call would arrive
// with no Authorization at all. Cross-origin requests bypass the SW entirely.

type ExchangedUser = {
  accessToken: string;
  workerUrl?: string | null;
  userEmail?: string;
};

/**
 * Try to sign in from the shared session. Returns the user on success, or null
 * when there is no shared session — in which case the caller shows the normal
 * login form. Never throws: SSO is an optimisation, not a dependency.
 */
export async function trySharedSignIn(): Promise<ExchangedUser | null> {
  const hub = PUBLIC_DAEMONCLIENT_AUTH_URL?.replace(/\/+$/, '');
  const api = PUBLIC_DAEMONCLIENT_WORKER_URL?.replace(/\/+$/, '');
  if (!hub || !api) return null; // self-host build, or nothing configured

  try {
    // `credentials: 'include'` is what sends the shared cookie; the hub answers
    // 401 when there is no session, which is the ordinary "not signed in" case.
    const hubRes = await fetch(`${hub}/session-token`, { credentials: 'include' });
    if (!hubRes.ok) return null;
    const { idToken } = (await hubRes.json()) as { idToken?: string };
    if (!idToken) return null;

    const res = await fetch(`${api}/api/auth/exchange`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${idToken}` },
    });
    if (!res.ok) return null;

    const user = (await res.json()) as ExchangedUser;
    return user.accessToken ? user : null;
  } catch {
    return null;
  }
}

/**
 * Store an exchanged session exactly as a password login does, so everything
 * downstream is unchanged. Cookies must be written here rather than relying on
 * the worker's Set-Cookie: that response comes from the worker's own origin, so
 * its cookies would not apply to this one.
 */
export function persistSession(user: ExchangedUser): void {
  const maxAge = 7 * 24 * 60 * 60;
  document.cookie = `immich_access_token=${user.accessToken}; Path=/; SameSite=Lax; Secure; Max-Age=${maxAge}`;
  document.cookie = `immich_is_authenticated=true; Path=/; SameSite=Lax; Secure; Max-Age=${maxAge}`;
  navigator.serviceWorker?.controller?.postMessage({ type: 'SET_TOKEN', token: user.accessToken });
  if (user.workerUrl) {
    navigator.serviceWorker?.controller?.postMessage({ type: 'SET_WORKER_URL', workerUrl: user.workerUrl });
  }
}

/** Sign out of the shared session too, so one logout ends all three apps. */
export async function endSharedSession(): Promise<void> {
  const hub = PUBLIC_DAEMONCLIENT_AUTH_URL?.replace(/\/+$/, '');
  if (!hub) return;
  try {
    await fetch(`${hub}/logout`, { credentials: 'include', redirect: 'manual' });
  } catch {
    /* best effort — the local session is cleared regardless */
  }
}
