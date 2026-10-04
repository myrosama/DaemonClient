// Who gets the dashboard's "your private cloud is finishing setup" treatment.
//
// Only a freshly set-up account can be waiting on Cloudflare to issue the TLS
// certificate for its new workers.dev subdomain (see waitForWorker.js). An
// established account whose worker is unreachable for some other reason — an
// old deploy, a carrier blocking workers.dev, an ad blocker — must never be told
// its cloud is "finishing setup", nor have its links held.

// Cloudflare has issued the certificate within a couple of minutes in every
// observed case; fifteen leaves a wide margin without catching old accounts.
export const FRESH_SETUP_WINDOW_MS = 15 * 60_000
const CLOCK_SKEW_MS = 2 * 60_000

function toMillis(t) {
  if (!t) return NaN
  if (typeof t === 'string') return Date.parse(t)
  if (typeof t === 'number') return t
  if (typeof t.toMillis === 'function') return t.toMillis()
  return NaN
}

// `setupTimestamp` is written by deployment-service when it provisions the
// worker (both the pasted-token and the one-button path).
export function isFreshSetup(setupTimestamp, now = Date.now(), windowMs = FRESH_SETUP_WINDOW_MS) {
  const t = toMillis(setupTimestamp)
  if (!Number.isFinite(t)) return false
  const age = now - t
  return age > -CLOCK_SKEW_MS && age < windowMs
}

export function appHosts(urls) {
  const hosts = []
  for (const u of urls) {
    try { if (u) hosts.push(new URL(u).hostname) } catch { /* unconfigured or malformed: skip */ }
  }
  return hosts
}

// Hold a click on a Photos/Drive link while the cloud is still being checked or
// is known to be unreachable; it would only open an error page.
export function shouldHoldLink(href, { cloud, hosts }) {
  if (cloud !== 'checking' && cloud !== 'starting') return false
  let host
  try { host = new URL(href).hostname } catch { return false }
  return hosts.includes(host)
}
