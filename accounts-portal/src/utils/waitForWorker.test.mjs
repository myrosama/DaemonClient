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

// These tests are about the browser probe; the DNS step has its own below.
const waitNoDns = (url, opts) => waitForWorker(url, { dnsTimeoutMs: 0, ...opts })

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
  const r = await waitNoDns('https://dc-a.sub.workers.dev', {
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
  const r = await waitNoDns('https://dc-a.sub.workers.dev', {
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
    const r = await waitNoDns('https://dc-a.sub.workers.dev', { fetchImpl: async () => res })
    assert.equal(r.ready, true, JSON.stringify(res))
    assert.equal(r.attempts, 1)
  }
})

test('gives up after the timeout and says so, rather than spinning forever', async () => {
  const c = clock()
  const r = await waitNoDns('https://dc-a.sub.workers.dev', {
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
    const r = await waitNoDns(bad, { fetchImpl: async () => { fetched = true; return ok() } })
    assert.equal(r.ready, false, String(bad))
    assert.equal(r.reason, 'invalid-url', String(bad))
    assert.equal(fetched, false, String(bad))
  }
})

test('a trailing slash on the worker URL does not produce //api/health', async () => {
  const urls = []
  await waitNoDns('https://dc-a.sub.workers.dev///', {
    fetchImpl: async (u) => { urls.push(u); return ok() },
  })
  assert.deepEqual(urls, ['https://dc-a.sub.workers.dev/api/health'])
})

test('each probe is no-cors, uncached and credential-free, and carries a time limit', async () => {
  let init
  await waitNoDns('https://dc-a.sub.workers.dev', { fetchImpl: async (_u, i) => { init = i; return ok() } })
  assert.equal(init.mode, 'no-cors', 'reachability must not depend on the worker\'s CORS list')
  assert.equal(init.cache, 'no-store')
  assert.equal(init.credentials, 'omit', 'no cookies to the worker')
  assert.ok(init.signal, 'an AbortSignal is passed')
})

test('a probe that hangs is cut off after its own time limit, and the wait carries on', async () => {
  let calls = 0
  const r = await waitNoDns('https://dc-a.sub.workers.dev', {
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
  const r = await waitNoDns('https://dc-a.sub.workers.dev', {
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
  const r = await waitNoDns('https://dc-a.sub.workers.dev', { fetchImpl: async () => { fetched = true; return ok() }, signal: ac.signal })
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
    const r = await waitNoDns(bad, { fetchImpl: async () => { fetched = true; return ok() } })
    assert.equal(r.reason, 'invalid-url', bad)
    assert.equal(fetched, false, bad)
  }
})

test('the probe goes to the parsed origin, never to a string the URL merely contains', async () => {
  const urls = []
  await waitNoDns('https://DC-A.Sub.Workers.Dev', { fetchImpl: async (u) => { urls.push(u); return ok() } })
  assert.deepEqual(urls, ['https://dc-a.sub.workers.dev/api/health'])
})

test('an abort that lands while a probe is in flight wins over that probe succeeding', async () => {
  const ac = new AbortController()
  const r = await waitNoDns('https://dc-a.sub.workers.dev', {
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

// ── Public DNS first: a lookup before the name is published gets "no such
// name" remembered by the visitor's DNS for up to 30 minutes. ─────────────────
const NEW_WORKER = 'https://dc-abc.dc-e4557592.workers.dev'
const doh = (status, answers = 0) => new Response(JSON.stringify({ Status: status, Answer: answers ? [{ data: '1.1.1.1' }] : undefined }))
const isDoh = (u) => String(u).startsWith('https://cloudflare-dns.com/')

test("the worker's own address is not looked up until public DNS has the account's subdomain", async () => {
  const log = []
  let dnsCalls = 0
  const r = await waitForWorker(NEW_WORKER, {
    sleep: async () => {},
    fetchImpl: async (u) => {
      log.push(String(u))
      if (isDoh(u)) return ++dnsCalls < 3 ? doh(3) : doh(0, 2)
      return new Response('{}')
    },
  })
  assert.equal(r.ready, true)
  const firstWorker = log.findIndex((u) => !isDoh(u))
  assert.equal(firstWorker, 3, 'three DNS checks come first')
  assert.equal(log.filter((u) => !isDoh(u)).length, 1)
})

test('the DNS check asks about a new random name each time, never the real one', async () => {
  const names = []
  let n = 0
  await waitForWorker(NEW_WORKER, {
    sleep: async () => {},
    fetchImpl: async (u) => {
      if (!isDoh(u)) return new Response('{}')
      names.push(new URL(u).searchParams.get('name'))
      return ++n < 3 ? doh(3) : doh(0, 2)
    },
  })
  assert.equal(new Set(names).size, 3)
  for (const name of names) {
    assert.match(name, /^[a-z0-9-]{1,63}\.dc-e4557592\.workers\.dev$/)
    assert.notEqual(name, 'dc-abc.dc-e4557592.workers.dev')
  }
})

test('tells the page it is waiting while DNS catches up', async () => {
  let waits = 0
  let n = 0
  await waitForWorker(NEW_WORKER, {
    sleep: async () => {},
    onWaiting: () => { waits++ },
    fetchImpl: async (u) => (isDoh(u) ? (++n < 2 ? doh(3) : doh(0, 2)) : new Response('{}')),
  })
  assert.equal(waits, 1)
})

test('if public DNS cannot be asked, setup carries on to the normal check', async () => {
  for (const broken of [async () => { throw new Error('blocked') }, async () => new Response('nope', { status: 500 }), async () => new Response('not json')]) {
    let reached = 0
    const r = await waitForWorker(NEW_WORKER, {
      sleep: async () => {},
      fetchImpl: async (u) => { if (isDoh(u)) return broken(); reached++; return new Response('{}') },
    })
    assert.equal(r.ready, true)
    assert.equal(reached, 1)
  }
})

test('stops waiting on DNS when the page leaves', async () => {
  const ac = new AbortController()
  const r = await waitForWorker(NEW_WORKER, {
    signal: ac.signal,
    sleep: async () => { ac.abort() },
    fetchImpl: async (u) => { assert.ok(isDoh(u), 'the worker must not be contacted'); return doh(3) },
  })
  assert.equal(r.reason, 'aborted')
})

test('a DNS wait that runs out still tries the worker, rather than hanging', async () => {
  let t = 0
  let reached = 0
  const r = await waitForWorker(NEW_WORKER, {
    now: () => t,
    sleep: async (ms) => { t += ms },
    dnsTimeoutMs: 9000,
    intervalMs: 3000,
    fetchImpl: async (u) => { if (isDoh(u)) return doh(3); reached++; return new Response('{}') },
  })
  assert.equal(r.ready, true)
  assert.equal(reached, 1)
  assert.ok(t >= 9000)
})

test('an address that is not a per-account workers.dev name skips the DNS check', async () => {
  const seen = []
  await waitForWorker('https://api.example.com', { sleep: async () => {}, fetchImpl: async (u) => { seen.push(String(u)); return new Response('{}') } })
  assert.deepEqual(seen, ['https://api.example.com/api/health'])
})
