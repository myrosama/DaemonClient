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
  onWaiting,
  signal: cancel,              // abort to stop waiting, e.g. when the page unmounts
} = {}) {
  const origin = originOf(workerUrl)
  if (!origin) return { ready: false, reason: 'invalid-url', attempts: 0, waitedMs: 0 }

  const started = now()
  let attempts = 0
  const aborted = () => ({ ready: false, reason: 'aborted', attempts, waitedMs: now() - started })

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
