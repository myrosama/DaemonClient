// Sign-in on the hosted Drive goes through the accounts portal
// (accounts.daemonclient.uz), which has Turnstile and sets the shared session
// that Photos uses too. Drive itself has no password form there.

const DRIVE = 'https://drive.daemonclient.uz';
const PORTAL = 'https://accounts.daemonclient.uz';

// Where a signed-out visitor goes. The portal sends them back to the dashboard
// with `sso=1`, so a return trip that still can't sign in shows a retry screen
// instead of redirecting again (no loop, and no storage needed to know it).
export function portalSignInUrl() {
  return `${PORTAL}/login?return_url=${encodeURIComponent(`${DRIVE}/dashboard?sso=1`)}`;
}

// Signing out ends the portal's own session and the shared one, then comes
// back to Drive's sign-in page.
export function portalSignOutUrl() {
  return `${PORTAL}/logout?return_url=${encodeURIComponent(`${DRIVE}/login`)}`;
}

/**
 * What the sign-in screen does next.
 * signedOut: the person just signed out here; don't sign them back in.
 * rejections: how many of this page's sessions the worker has refused (401);
 *   one is re-exchanged silently, a second stops, so a bad key can't loop.
 * sharedSignedIn: the shared-session exchange succeeded.
 * returnedFromPortal: this page load came back from the portal (sso=1).
 * → 'signedOut' | 'failed' | 'done' | 'portal'
 */
export function signInStep({ signedOut, rejections, sharedSignedIn, returnedFromPortal }) {
  if (signedOut) return 'signedOut';
  if (rejections >= 2) return 'failed';
  if (sharedSignedIn) return 'done';
  return returnedFromPortal ? 'failed' : 'portal';
}

// A shared-session sign-in carries an ID token that lasts an hour, and the worker
// reads the Telegram settings with it the first time; after that hour it answers
// "not configured". So "not configured" gets one re-check with a fresh session
// before the setup screen shows. Self-hosted builds sign in with a password.
export function recheckNotConfigured({ configured, selfHost, alreadyRechecked }) {
  return !configured && !selfHost && !alreadyRechecked;
}

