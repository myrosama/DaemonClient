// Sign-in on the hosted Drive goes through the accounts portal
// (accounts.daemonclient.uz), which has Turnstile and sets the shared session
// that Photos uses too. Drive itself has no password form there.

export const PORTAL_RETRY_MS = 60_000;

// Where a signed-out visitor goes; the portal sends them back to the dashboard.
export function portalSignInUrl() {
  return `https://accounts.daemonclient.uz/login?return_url=${encodeURIComponent('https://drive.daemonclient.uz/dashboard')}`;
}

// The portal redirects a signed-in person straight back. If the shared sign-in
// then still fails (say the worker is down), redirecting again would loop, so
// only one automatic redirect per minute. `lastAt` is the stored time of the
// last one, as a string; anything unreadable or in the future doesn't block.
export function portalRedirectAllowed(lastAt, now) {
  const t = Number(lastAt);
  if (!lastAt || !Number.isFinite(t) || t > now) return true;
  return now - t >= PORTAL_RETRY_MS;
}
