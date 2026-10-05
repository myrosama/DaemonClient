// Who may call which part of the sign-in hub, and where it may send people.
// Kept free of Worker APIs so the rules can be tested on their own
// (`npm test`): every check here guards a credential.

/** The apps that hold a session: only they may read a fresh ID token. */
export const APP_ORIGINS: ReadonlySet<string> = new Set([
  'https://accounts.daemonclient.uz',
  'https://photos.daemonclient.uz',
  'https://drive.daemonclient.uz',
])

/** The marketing site only asks "is this browser signed in?". */
const SITE_ORIGINS: ReadonlySet<string> = new Set([
  'https://daemonclient.uz',
  'https://www.daemonclient.uz',
])

/** Sessions are created only by the accounts portal's sign-in and sign-up. */
export const SESSION_CREATOR_ORIGIN = 'https://accounts.daemonclient.uz'

/** Where the Turnstile widget is rendered, and the action it declares. */
export const TURNSTILE_HOSTNAME = 'accounts.daemonclient.uz'
export const TURNSTILE_ACTION = 'turnstile-spin-v2'

const DEFAULT_ORIGIN = 'https://accounts.daemonclient.uz'

/**
 * The origin to echo in Access-Control-Allow-Origin for this route. Anything not
 * allowed for the route gets the accounts origin, which the browser then
 * refuses to share the response with.
 */
export function corsOriginFor(pathname: string, origin: string | null): string {
  if (!origin) return DEFAULT_ORIGIN
  if (APP_ORIGINS.has(origin)) return origin
  if (pathname === '/check-session' && SITE_ORIGINS.has(origin)) return origin
  return DEFAULT_ORIGIN
}

/** True when an app origin sent the request (browsers always send Origin on fetch). */
export function isAppOrigin(origin: string | null): boolean {
  return !!origin && APP_ORIGINS.has(origin)
}

/** A JSON body, not a form: cross-site forms cannot send application/json. */
export function isJsonRequest(contentType: string | null): boolean {
  return !!contentType && /^application\/json\s*(;|$)/i.test(contentType.trim())
}

/**
 * Where it is safe to send someone after signing in, or null.
 *
 * Allowed: a same-site path ("/dashboard", "/setup?x=1"), or an https URL on one
 * of our own origins. Everything else is refused — a protocol-relative "//host",
 * "/\host" (browsers treat the backslash as a slash), credentials in the URL,
 * other schemes, look-alike hosts such as drive.daemonclient.uz.example.com,
 * and control characters a browser would silently strip.
 */
export function safeReturnUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  if (!value || value.length > 2048) return null
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(value)) return null

  if (value.startsWith('/')) {
    if (value.startsWith('//')) return null
    return value
  }

  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== 'https:') return null
  if (url.username || url.password) return null
  if (!APP_ORIGINS.has(url.origin) && !SITE_ORIGINS.has(url.origin)) return null
  return url.href
}

/**
 * A Turnstile siteverify result is good only when it succeeded on our own page
 * for our own widget — a token solved on another site that uses the same
 * widget type, or replayed from a different action, is refused.
 */
export function turnstileResultOk(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false
  const r = result as { success?: unknown; hostname?: unknown; action?: unknown }
  return r.success === true && r.hostname === TURNSTILE_HOSTNAME && r.action === TURNSTILE_ACTION
}
