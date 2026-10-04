// npm test  (node --test src/utils/waitForWorker.test.mjs)
//
// The bug these pin down: a brand-new account's worker is unreachable from the
// browser for the first minute or two (Cloudflare has not issued the TLS
// certificate for the new *.workers.dev subdomain yet), but the user was sent on
// to the dashboard and from there into Photos and Drive, which then failed.
//
// The probe asks "can this browser connect at all?", not "does the worker answer
// correctly": it is sent with mode 'no-cors', so ANY response — even one a CORS
// check would reject, or an error page — proves the TLS handshake worked. Only a
// rejected fetch (TLS / DNS / network failure) means "still starting".
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { waitForWorker } from './waitForWorker.js'

// A fake clock: sleep() advances it instead of waiting, so a five-minute
// timeout runs in milliseconds and the arithmetic is exact.
function clock() {
  let t = 0
  return { now: () => t, sleep: async (ms) => { t += ms }, advance: (ms) => { t += ms } }
}

const ok = () => ({ ok: true, status: 200 })
const tlsFailure = () => { throw new TypeError('Failed to fetch') } // what a missing cert looks like to fetch()

test('a worker that already answers is ready on the first try, without waiting', async () => {
  const c = clock()
  const urls = []
  const r = await waitForWorker('https://dc-a.sub.workers.dev', {
    fetchImpl: async (u) => { urls.push(u); return ok() }, now: c.now, sleep: c.sleep,
  })
  assert.equal(r.ready, true)
  assert.equal(r.attempts, 1)
  assert.equal(c.now(), 0, 'must not sleep when the first probe succeeds')
  assert.deepEqual(urls, ['https://dc-a.sub.workers.dev/api/health'])
})

test('keeps waiting while the browser cannot reach the worker (no certificate yet), then reports ready', async () => {
  const c = clock()
  let calls = 0
  const waited = []
  const r = await waitForWorker('https://dc-a.sub.workers.dev', {
    fetchImpl: async () => { calls++; if (calls <= 2) tlsFailure(); return ok() },
    now: c.now, sleep: c.sleep, intervalMs: 3000,
    onWaiting: (s) => waited.push(s.attempts),
  })
  assert.equal(r.ready, true)
  assert.equal(r.attempts, 3)
  assert.deepEqual(waited, [1, 2], 'the UI hears about every failed attempt')
  assert.equal(r.waitedMs, 6000)
})

test('any answer at all means reachable — an opaque no-cors response, an error status, a page CORS would block', async () => {
  // An existing worker deployed before the accounts origin was in its
  // ALLOWED_ORIGINS answers fine but fails a CORS check; it must not be held.
  for (const res of [{ type: 'opaque', ok: false, status: 0 }, { ok: false, status: 404 }, { ok: false, status: 500 }]) {
    const r = await waitForWorker('https://dc-a.sub.workers.dev', { fetchImpl: async () => res })
    assert.equal(r.ready, true, JSON.stringify(res))
    assert.equal(r.attempts, 1)
  }
})

test('gives up after the timeout and says so, rather than spinning forever', async () => {
  const c = clock()
  const r = await waitForWorker('https://dc-a.sub.workers.dev', {
    fetchImpl: async () => tlsFailure(), now: c.now, sleep: c.sleep,
    timeoutMs: 60_000, intervalMs: 3000,
  })
  assert.equal(r.ready, false)
  assert.equal(r.reason, 'timeout')
  assert.ok(r.waitedMs >= 60_000, 'waited at least the timeout')
  assert.ok(r.waitedMs < 60_000 + 3000, 'but not a full interval past it')
})

test('a missing or non-https worker URL is refused at once, with no request made', async () => {
  for (const bad of [undefined, null, '', 'http://dc-a.sub.workers.dev', 'not a url']) {
    let fetched = false
    const r = await waitForWorker(bad, { fetchImpl: async () => { fetched = true; return ok() } })
    assert.equal(r.ready, false, String(bad))
    assert.equal(r.reason, 'invalid-url', String(bad))
    assert.equal(fetched, false, String(bad))
  }
})

test('a trailing slash on the worker URL does not produce //api/health', async () => {
  const urls = []
  await waitForWorker('https://dc-a.sub.workers.dev///', {
    fetchImpl: async (u) => { urls.push(u); return ok() },
  })
  assert.deepEqual(urls, ['https://dc-a.sub.workers.dev/api/health'])
})

test('each probe is no-cors, uncached and credential-free, and carries a time limit', async () => {
  let init
  await waitForWorker('https://dc-a.sub.workers.dev', { fetchImpl: async (_u, i) => { init = i; return ok() } })
  assert.equal(init.mode, 'no-cors', 'reachability must not depend on the worker\'s CORS list')
  assert.equal(init.cache, 'no-store')
  assert.equal(init.credentials, 'omit', 'no cookies to the worker')
  assert.ok(init.signal, 'an AbortSignal is passed')
})

test('a probe that hangs is cut off after its own time limit, and the wait carries on', async () => {
  let calls = 0
  const r = await waitForWorker('https://dc-a.sub.workers.dev', {
    probeTimeoutMs: 30, intervalMs: 1,
    fetchImpl: (_u, init) => {
      calls++
      if (calls > 1) return Promise.resolve(ok())
      return new Promise((_res, rej) => init.signal.addEventListener('abort', () => rej(new DOMException('t', 'TimeoutError'))))
    },
  })
  assert.equal(r.ready, true)
  assert.equal(calls, 2, 'the hung probe was abandoned and a new one sent')
})

test('stops probing as soon as the caller aborts (the dashboard was closed), instead of polling for minutes', async () => {
  const c = clock()
  const ac = new AbortController()
  let calls = 0
  const r = await waitForWorker('https://dc-a.sub.workers.dev', {
    fetchImpl: async () => { calls++; if (calls === 2) ac.abort(); tlsFailure() },
    now: c.now, sleep: c.sleep, signal: ac.signal,
  })
  assert.equal(r.ready, false)
  assert.equal(r.reason, 'aborted')
  assert.equal(calls, 2, 'no probe after the abort')
})

test('an already-aborted signal makes no request at all', async () => {
  const ac = new AbortController(); ac.abort()
  let fetched = false
  const r = await waitForWorker('https://dc-a.sub.workers.dev', { fetchImpl: async () => { fetched = true; return ok() }, signal: ac.signal })
  assert.equal(r.reason, 'aborted')
  assert.equal(fetched, false)
})

test('only a bare https origin is accepted — credentials, query, fragment, path or a backslash trick are refused', async () => {
  for (const bad of [
    'https://u:p@dc-a.sub.workers.dev',
    'https://dc-a.sub.workers.dev?x=1',
    'https://dc-a.sub.workers.dev#frag',
    'https://dc-a.sub.workers.dev/some/path',
    'https://evil.example\\@dc-a.sub.workers.dev',
  ]) {
    let fetched = false
    const r = await waitForWorker(bad, { fetchImpl: async () => { fetched = true; return ok() } })
    assert.equal(r.reason, 'invalid-url', bad)
    assert.equal(fetched, false, bad)
  }
})

test('the probe goes to the parsed origin, never to a string the URL merely contains', async () => {
  const urls = []
  await waitForWorker('https://DC-A.Sub.Workers.Dev', { fetchImpl: async (u) => { urls.push(u); return ok() } })
  assert.deepEqual(urls, ['https://dc-a.sub.workers.dev/api/health'])
})

test('an abort that lands while a probe is in flight wins over that probe succeeding', async () => {
  const ac = new AbortController()
  const r = await waitForWorker('https://dc-a.sub.workers.dev', {
    fetchImpl: async () => { ac.abort(); return ok() },
    signal: ac.signal,
  })
  assert.equal(r.reason, 'aborted')
})

test('aborting the wait cancels the request that is in flight, instead of letting it run on', async () => {
  const ac = new AbortController()
  let probeSignal
  const p = waitForWorker('https://dc-a.sub.workers.dev', {
    probeTimeoutMs: 60_000,
    fetchImpl: (_u, init) => {
      probeSignal = init.signal
      return new Promise((_res, rej) => init.signal.addEventListener('abort', () => rej(init.signal.reason)))
    },
    signal: ac.signal,
  })
  setTimeout(() => ac.abort(), 10)
  const r = await p
  assert.equal(r.reason, 'aborted')
  assert.equal(probeSignal.aborted, true, 'the probe itself was cancelled')
})

test('an abort during the pause between probes ends the wait at once, not after the pause', async () => {
  const ac = new AbortController()
  const started = Date.now()
  const p = waitForWorker('https://dc-a.sub.workers.dev', {
    fetchImpl: async () => tlsFailure(), signal: ac.signal, intervalMs: 60_000,
  })
  setTimeout(() => ac.abort(), 20)
  const r = await p
  assert.equal(r.reason, 'aborted')
  assert.ok(Date.now() - started < 5000, 'did not sit out the 60 s pause')
})
