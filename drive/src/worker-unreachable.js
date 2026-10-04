// Telling "your worker could not be reached at all" apart from real errors.
//
// A brand-new account's worker is unreachable from the browser for its first
// minute or two: Cloudflare has not yet issued the TLS certificate for the
// account's new workers.dev subdomain, so fetch() rejects (Chrome logs
// ERR_SSL_VERSION_OR_CIPHER_MISMATCH). Drive used to show that as
// "Configuration Error … Failed to fetch". It is not something the user did or
// can fix — it fixes itself — so the app says "still being created" and retries.

export const WORKER_UNREACHABLE = 'WORKER_UNREACHABLE'

export function isWorkerUnreachable(err) {
  return !!err && err.code === WORKER_UNREACHABLE
}

// fetch() that turns "could not connect" (TLS, DNS, network, or a Cloudflare error
// page without CORS headers — fetch rejects with a TypeError for all of them) into
// a recognisable error. That is broader than "new account": hence the capped wait
// below, so a persistent failure is not presented as "still being created" forever. A response of any status is passed
// through untouched: the worker is there. Our own cancellations stay AbortErrors.
export async function fetchWorker(fetchImpl, url, init) {
  try {
    return await fetchImpl(url, init)
  } catch (cause) {
    if (cause && cause.name === 'AbortError') throw cause
    const err = new Error("Your private cloud can't be reached right now")
    err.code = WORKER_UNREACHABLE
    err.cause = cause
    throw err
  }
}

// Cap the "still being created" screen. Cloudflare has issued a new subdomain's
// certificate within a few minutes in every observed case; past this, the cause
// is something else (a network blocking workers.dev, an ad blocker, a deleted
// worker), so the screen stops reloading and says that instead.
export const WAIT_CAP_MS = 5 * 60_000 // same as the dashboard's give-up
const WAIT_KEY = 'dc-cloud-wait-started'

// When the current wait began, kept across the screen's own reloads. null when
// storage is unusable — the screen must then not auto-reload, since it could
// never tell when to stop.
export function waitStartedAt(storage, now = Date.now()) {
  try {
    const raw = storage.getItem(WAIT_KEY)
    // A start in the future (clock moved back, tampering) would never reach the
    // cap — treat it as a fresh start instead.
    if (raw !== null && Number.isFinite(Number(raw)) && Number(raw) <= now) return Number(raw)
    storage.setItem(WAIT_KEY, String(now))
    return now
  } catch {
    return null
  }
}

export function waitedTooLong(storage, now = Date.now()) {
  try {
    const raw = storage.getItem(WAIT_KEY)
    return raw !== null && Number.isFinite(Number(raw)) && now - Number(raw) >= WAIT_CAP_MS
  } catch {
    return false
  }
}

export function clearWait(storage) {
  try { storage.removeItem(WAIT_KEY) } catch { /* nothing to clear */ }
}

// sessionStorage, or null when the browser refuses access (reading the property
// itself can throw when site data is blocked). Callers treat null as "can't keep
// a clock" and retry only by hand.
export function sessionStore(get = () => sessionStorage) {
  try { return get() ?? null } catch { return null }
}
