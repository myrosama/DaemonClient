// npm test
//
// Who gets the "your private cloud is finishing setup" treatment, and which
// clicks are held. Only a FRESH account can be waiting on its certificate; an
// established account whose worker happens to be unreachable must never be told
// its cloud is "finishing setup" or have its links swallowed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isFreshSetup, shouldHoldLink, appHosts, FRESH_SETUP_WINDOW_MS } from './cloudStartup.js'

const NOW = Date.parse('2026-10-04T13:00:00Z')

test('an account set up a minute ago is fresh', () => {
  assert.equal(isFreshSetup('2026-10-04T12:59:00Z', NOW), true)
})

test('an account set up long ago is not fresh — established users are never held', () => {
  assert.equal(isFreshSetup('2026-10-04T12:00:00Z', NOW), false)
  assert.equal(isFreshSetup('2026-06-01T00:00:00Z', NOW), false)
})

test('the window is exactly FRESH_SETUP_WINDOW_MS', () => {
  assert.equal(isFreshSetup(new Date(NOW - FRESH_SETUP_WINDOW_MS + 1).toISOString(), NOW), true)
  assert.equal(isFreshSetup(new Date(NOW - FRESH_SETUP_WINDOW_MS).toISOString(), NOW), false)
})

test('a missing or unreadable timestamp is not fresh (old accounts have none)', () => {
  for (const t of [undefined, null, '', 'yesterday', {}]) assert.equal(isFreshSetup(t, NOW), false, String(t))
})

test('a Firestore Timestamp is read too, not only an ISO string', () => {
  assert.equal(isFreshSetup({ toMillis: () => NOW - 30_000 }, NOW), true)
})

test('a timestamp slightly in the future (clock skew) still counts as fresh; far in the future does not', () => {
  assert.equal(isFreshSetup(new Date(NOW + 30_000).toISOString(), NOW), true)
  assert.equal(isFreshSetup(new Date(NOW + 10 * 60_000).toISOString(), NOW), false)
})

const hosts = appHosts(['https://photos.daemonclient.uz', 'https://drive.daemonclient.uz/', '', 'not a url'])

test('app hosts come from the configured URLs; blank or broken ones are dropped', () => {
  assert.deepEqual(hosts, ['photos.daemonclient.uz', 'drive.daemonclient.uz'])
})

test('Photos and Drive links are held while the cloud is checking or starting', () => {
  for (const cloud of ['checking', 'starting']) {
    assert.equal(shouldHoldLink('https://photos.daemonclient.uz/auth/login', { cloud, hosts }), true, cloud)
    assert.equal(shouldHoldLink('https://drive.daemonclient.uz/login', { cloud, hosts }), true, cloud)
  }
})

test('nothing is held once the cloud is ready, after giving up, or when no check is running', () => {
  for (const cloud of ['ready', 'unknown', 'idle']) {
    assert.equal(shouldHoldLink('https://photos.daemonclient.uz/auth/login', { cloud, hosts }), false, cloud)
  }
})

test('other links are never held, including look-alike hosts', () => {
  for (const href of [
    'https://accounts.daemonclient.uz/profile',
    'https://photos.daemonclient.uz.evil.example/',
    'https://evil.example/?u=https://photos.daemonclient.uz',
    'mailto:help@daemonclient.uz',
    'not a url',
  ]) assert.equal(shouldHoldLink(href, { cloud: 'starting', hosts }), false, href)
})
