// node --test src/*.test.mjs
//
// A brand-new account's worker cannot be reached from the browser for its first
// minute or two (no TLS certificate yet for the new workers.dev subdomain), and
// Drive used to answer that with "Configuration Error … Failed to fetch". These
// pin the classification that lets it say "still being created" instead.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fetchWorker, isWorkerUnreachable } from './worker-unreachable.js'

test('a fetch that cannot connect at all (TLS/DNS/network) becomes a recognisable "unreachable" error', async () => {
  const cause = new TypeError('Failed to fetch')
  await assert.rejects(
    fetchWorker(async () => { throw cause }, 'https://dc-a.sub.workers.dev/api/drive/config'),
    (err) => {
      assert.equal(isWorkerUnreachable(err), true)
      assert.equal(err.cause, cause, 'the original failure is kept for the console')
      return true
    },
  )
})

test('an answer from the worker — even an error status — is NOT "unreachable": the worker is there', async () => {
  for (const status of [200, 401, 404, 500, 503]) {
    const res = await fetchWorker(async () => ({ status, ok: status < 300 }), 'https://x')
    assert.equal(res.status, status)
  }
})

test('a request we cancelled ourselves stays an AbortError, not "unreachable"', async () => {
  const abort = new DOMException('aborted', 'AbortError')
  await assert.rejects(fetchWorker(async () => { throw abort }, 'https://x'), (err) => {
    assert.equal(err, abort)
    assert.equal(isWorkerUnreachable(err), false)
    return true
  })
})

test('ordinary errors are not mistaken for "unreachable"', () => {
  for (const e of [undefined, null, new Error('Request failed (500)'), Object.assign(new Error('x'), { code: 'NO_WORKER' })]) {
    assert.equal(isWorkerUnreachable(e), false, String(e && e.message))
  }
})

test('the request is passed through unchanged', async () => {
  let seen
  await fetchWorker(async (u, i) => { seen = [u, i]; return { status: 200 } }, 'https://u', { method: 'POST' })
  assert.deepEqual(seen, ['https://u', { method: 'POST' }])
})

// The "still being created" screen must not loop forever: an established user
// whose worker is unreachable for another reason would be told "nothing is
// wrong" indefinitely.
import { waitStartedAt, waitedTooLong, clearWait, WAIT_CAP_MS } from './worker-unreachable.js'
const store = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) } }

test('the wait start is remembered across the screen\'s reloads', () => {
  const s = store()
  assert.equal(waitStartedAt(s, 0), 0)
  assert.equal(waitStartedAt(s, 5000), 0)
})

test('it gives up after WAIT_CAP_MS, not before', () => {
  const s = store(); waitStartedAt(s, 0)
  assert.equal(waitedTooLong(s, WAIT_CAP_MS - 1), false)
  assert.equal(waitedTooLong(s, WAIT_CAP_MS), true)
})

test('reaching the cloud clears the clock', () => {
  const s = store(); waitStartedAt(s, 0); clearWait(s)
  assert.equal(waitStartedAt(s, 7), 7)
})

test('unusable storage reports no start time (retry only by hand) and never throws', () => {
  const broken = { getItem() { throw new Error('x') }, setItem() { throw new Error('x') }, removeItem() { throw new Error('x') } }
  assert.equal(waitStartedAt(broken, 1), null)
  assert.equal(waitedTooLong(broken, 1e12), false)
  assert.doesNotThrow(() => clearWait(broken))
})

import { sessionStore } from './worker-unreachable.js'

test('a start time in the future is treated as a fresh start, so the cap still applies', () => {
  const s = store(); s.setItem('dc-cloud-wait-started', String(1e15))
  assert.equal(waitStartedAt(s, 1000), 1000)
  assert.equal(waitedTooLong(s, 1000 + WAIT_CAP_MS), true)
})

test('sessionStore() returns null instead of throwing when the browser blocks storage', () => {
  assert.equal(sessionStore(() => { throw new Error('SecurityError') }), null)
  const s = store()
  assert.equal(sessionStore(() => s), s)
})
