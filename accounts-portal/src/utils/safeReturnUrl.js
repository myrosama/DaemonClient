// Where it is safe to send someone after they sign in, or null.
//
// The same rule as the sign-in hub's (auth-worker/src/policy.ts) — the portal
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
