// Wait until the BROWSER can connect to a freshly provisioned worker at all.
//
// Why this exists: a first-time Cloudflare account gets a brand-new
// `<name>.workers.dev` subdomain during setup, and Cloudflare issues its TLS
// certificate (`*.<name>.workers.dev`, Let's Encrypt) a minute or two AFTER the
// deploy call has already returned. Until then every request from the browser
// fails the TLS handshake (Chrome: ERR_SSL_VERSION_OR_CIPHER_MISMATCH), so a new
// user who went from the dashboard into Photos saw "Error: 503" and Drive
// "Failed to fetch" — and both started working on their own minutes later.
// Observed 2026-10-04 on a fresh test account.
//
// What is probed is reachability, not correctness: `mode: 'no-cors'`, so any
// response at all — including one an older worker's CORS list would reject, or
// a Cloudflare error page — proves the handshake worked. Only a rejected fetch
// (TLS, DNS or network failure) counts as "not reachable yet". It runs in the
// browser on purpose: that is the path Photos and Drive take.

const DEFAULT_PROBE_TIMEOUT_MS = 10_000

// The worker's name is published some time after the deploy returns. A lookup
// before that gets "no such name", which the visitor's DNS may remember for up
// to 30 minutes (workers.dev's negative TTL), so the app stays unreachable long
// after the worker is up. So the browser doesn't touch the real name until
// public DNS answers for a random sibling under the account's subdomain: a name
// nobody will ask for again can't poison anything.
const DOH_URL = 'https://cloudflare-dns.com/dns-query'
const DEFAULT_DNS_TIMEOUT_MS = 3 * 60_000

// `<account>.workers.dev` for a per-account worker address, otherwise null.
function accountDomain(origin) {
  const { hostname } = new URL(origin)
  const labels = hostname.split('.')
  return labels.length === 4 && hostname.endsWith('.workers.dev') ? labels.slice(1).join('.') : null
}

// true or false once public DNS has answered; null if it can't be asked.
async function dnsPublished(domain, fetchImpl, cancel) {
  const name = `dns-probe-${crypto.randomUUID()}.${domain}`
  const probe = probeSignal(cancel, DEFAULT_PROBE_TIMEOUT_MS)
  try {
    const res = await fetchImpl(`${DOH_URL}?name=${encodeURIComponent(name)}&type=A`, {
      headers: { accept: 'application/dns-json' }, cache: 'no-store', credentials: 'omit', signal: probe.signal,
    })
    if (!res.ok) return null
    const { Status, Answer } = await res.json()
    return Status === 0 && Array.isArray(Answer) && Answer.length > 0
  } catch {
    return null
  } finally {
    probe.done()
  }
}

// A bare https origin and nothing else: no credentials, path, query or fragment.
// Parsed, never pattern-matched, so `https://a\@b` cannot pass as `b`.
function originOf(workerUrl) {
  if (typeof workerUrl !== 'string') return null
  let u
  try { u = new URL(workerUrl.trim()) } catch { return null }
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) return null
  if (u.pathname.replace(/\/+$/, '') !== '') return null
  return u.origin
}

// Combine the caller's cancel signal with a per-probe timeout, so aborting the
// wait also aborts the request in flight.
function probeSignal(cancel, timeoutMs) {
  const timeout = new AbortController()
  const timer = setTimeout(() => timeout.abort(new DOMException('probe timed out', 'TimeoutError')), timeoutMs)
  const onCancel = () => timeout.abort(cancel.reason)
  if (cancel) cancel.addEventListener('abort', onCancel, { once: true })
  return {
    signal: timeout.signal,
    done() { clearTimeout(timer); if (cancel) cancel.removeEventListener('abort', onCancel) },
  }
}

// A pause that ends early when the caller aborts.
function pause(ms, cancel, sleep) {
  if (sleep) return sleep(ms)
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    function done() { clearTimeout(timer); if (cancel) cancel.removeEventListener('abort', done); resolve() }
    if (cancel) cancel.addEventListener('abort', done, { once: true })
  })
}

export async function waitForWorker(workerUrl, {
  fetchImpl = (...args) => fetch(...args),
  sleep,                       // injected by tests; the real pause is abortable
  now = () => Date.now(),
  timeoutMs = 5 * 60_000,
  intervalMs = 3000,
  probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  dnsTimeoutMs = DEFAULT_DNS_TIMEOUT_MS,
  onWaiting,
  signal: cancel,              // abort to stop waiting, e.g. when the page unmounts
} = {}) {
  const origin = originOf(workerUrl)
  if (!origin) return { ready: false, reason: 'invalid-url', attempts: 0, waitedMs: 0 }

  const started = now()
  let attempts = 0
  const aborted = () => ({ ready: false, reason: 'aborted', attempts, waitedMs: now() - started })

  const domain = dnsTimeoutMs > 0 ? accountDomain(origin) : null
  while (domain) {
    if (cancel && cancel.aborted) return aborted()
    // Carry on when it's published, or when public DNS can't be asked at all.
    if ((await dnsPublished(domain, fetchImpl, cancel)) !== false) break
    if (cancel && cancel.aborted) return aborted()
    const waitedMs = now() - started
    if (waitedMs >= dnsTimeoutMs) break
    if (onWaiting) onWaiting({ attempts, waitedMs })
    await pause(Math.min(intervalMs, Math.max(0, dnsTimeoutMs - waitedMs)), cancel, sleep)
  }

  for (;;) {
    if (cancel && cancel.aborted) return aborted()
    attempts++
    const probe = probeSignal(cancel, probeTimeoutMs)
    let reached = false
    try {
      await fetchImpl(`${origin}/api/health`, {
        mode: 'no-cors', cache: 'no-store', credentials: 'omit', signal: probe.signal,
      })
      reached = true
    } catch {
      // Not reachable yet (or the probe timed out) — exactly what we wait out.
    } finally {
      probe.done()
    }
    if (cancel && cancel.aborted) return aborted()
    if (reached) return { ready: true, attempts, waitedMs: now() - started }

    const waitedMs = now() - started
    if (waitedMs >= timeoutMs) return { ready: false, reason: 'timeout', attempts, waitedMs }
    if (onWaiting) onWaiting({ attempts, waitedMs })
    await pause(Math.min(intervalMs, Math.max(0, timeoutMs - waitedMs)), cancel, sleep)
  }
}
