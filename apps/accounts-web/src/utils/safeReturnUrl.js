// Where it is safe to send someone after they sign in, or null.
//
// The same rule as the sign-in hub's (workers/auth/src/policy.ts) — the portal
// checks too, because it also reads `return_url` straight from the address bar.
// Allowed: a same-site path ("/dashboard"), or an https URL on one of our own
// origins. Refused: "//host" and "/\host" (both leave the site), credentials in
// the URL, other schemes, look-alike hosts, control characters.

const ALLOWED_ORIGINS = new Set([
  'https://accounts.daemonclient.uz',
  'https://photos.daemonclient.uz',
  'https://drive.daemonclient.uz',
  'https://daemonclient.uz',
  'https://www.daemonclient.uz',
])

export function safeReturnUrl(raw) {
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  if (!value || value.length > 2048) return null
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(value)) return null

  if (value.startsWith('/')) {
    if (value.startsWith('//')) return null
    return value
  }

  let url
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== 'https:') return null
  if (url.username || url.password) return null
  if (!ALLOWED_ORIGINS.has(url.origin)) return null
  return url.href
}

/** True for a full URL (another of our apps), false for a path in this one. */
export function isAbsoluteUrl(safe) {
  return typeof safe === 'string' && safe.startsWith('https://')
}

// The other app (Photos, Drive) a `return_url` points to, or null. Used to send
// an already signed-in visitor straight back instead of to the dashboard.
export function appReturnUrl(raw) {
  const url = safeReturnUrl(raw)
  return isAbsoluteUrl(url) && !url.startsWith('https://accounts.daemonclient.uz') ? url : null
}

// Whether the page that sent someone here (document.referrer) is one of our
// other apps. Used so a stranger's page can't sign a visitor out with a link.
export function cameFromOurApp(referrer) {
  try {
    const { origin } = new URL(referrer)
    return origin === 'https://drive.daemonclient.uz' || origin === 'https://photos.daemonclient.uz'
  } catch {
    return false
  }
}
