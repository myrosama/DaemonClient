// npm test  (node --experimental-strip-types --test src/policy.test.mjs)
//
// The sign-in hub's rules. Each one guards a credential, so each is pinned.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  corsOriginFor,
  isAppOrigin,
  isJsonRequest,
  safeReturnUrl,
  turnstileResultOk,
  SESSION_CREATOR_ORIGIN,
} from './policy.ts'

const ACCOUNTS = 'https://accounts.daemonclient.uz'
const PHOTOS = 'https://photos.daemonclient.uz'
const DRIVE = 'https://drive.daemonclient.uz'
const SITE = 'https://daemonclient.uz'
const WWW = 'https://www.daemonclient.uz'

test('only the three apps may read a fresh ID token', () => {
  for (const o of [ACCOUNTS, PHOTOS, DRIVE]) assert.equal(corsOriginFor('/session-token', o), o)
  for (const o of [SITE, WWW, 'https://evil.example', 'null', null, 'https://photos.daemonclient.uz.evil.com']) {
    assert.equal(corsOriginFor('/session-token', o), ACCOUNTS, String(o))
  }
})

test('the marketing site may ask whether the browser is signed in, and nothing more', () => {
  assert.equal(corsOriginFor('/check-session', SITE), SITE)
  assert.equal(corsOriginFor('/check-session', WWW), WWW)
  assert.equal(corsOriginFor('/check-session', PHOTOS), PHOTOS)
  for (const path of ['/create-session', '/session-token', '/logout']) {
    assert.equal(corsOriginFor(path, SITE), ACCOUNTS, path)
  }
})

test('origin matching is exact — no suffix, scheme or port tricks', () => {
  for (const o of ['http://accounts.daemonclient.uz', 'https://accounts.daemonclient.uz:444', 'https://ACCOUNTS.daemonclient.uz.evil.com', 'https://accounts.daemonclient.uz.']) {
    assert.equal(isAppOrigin(o), false, o)
  }
  assert.equal(isAppOrigin(PHOTOS), true)
  assert.equal(isAppOrigin(null), false)
})

test('sessions are created only from the accounts portal', () => {
  assert.equal(SESSION_CREATOR_ORIGIN, ACCOUNTS)
})

test('only a JSON body is accepted — a cross-site form cannot send one', () => {
  for (const t of ['application/json', 'application/json; charset=utf-8', 'Application/JSON']) assert.equal(isJsonRequest(t), true, t)
  for (const t of [null, '', 'text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data', 'application/jsonp', 'text/plain; application/json']) {
    assert.equal(isJsonRequest(t), false, String(t))
  }
})

test('return URLs: our own paths and origins are kept', () => {
  assert.equal(safeReturnUrl('/dashboard'), '/dashboard')
  assert.equal(safeReturnUrl('/setup?step=2#top'), '/setup?step=2#top')
  assert.equal(safeReturnUrl('https://photos.daemonclient.uz'), 'https://photos.daemonclient.uz/')
  assert.equal(safeReturnUrl('https://drive.daemonclient.uz/dashboard?x=1'), 'https://drive.daemonclient.uz/dashboard?x=1')
  assert.equal(safeReturnUrl('https://daemonclient.uz/'), 'https://daemonclient.uz/')
  assert.equal(safeReturnUrl('  /dashboard  '), '/dashboard')
})

test('return URLs: every way off-site is refused', () => {
  const evil = [
    'https://evil.example',
    '//evil.example',
    '//evil.example/dashboard',
    '/\\evil.example',
    '\\\\evil.example',
    '/\t/evil.example',
    '/\n/evil.example',
    'https://drive.daemonclient.uz.evil.example/',
    'https://evil.example/https://drive.daemonclient.uz',
    'https://user:pass@drive.daemonclient.uz/',
    'https://drive.daemonclient.uz@evil.example/',
    'http://drive.daemonclient.uz/',
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'https://drive.daemonclient.uz:8443/',
    'evil.example',
    'dashboard',
    '',
    '   ',
    null,
    undefined,
    42,
    { href: '/dashboard' },
    '/' + 'a'.repeat(3000),
  ]
  for (const v of evil) assert.equal(safeReturnUrl(v), null, JSON.stringify(v))
})

test('return URLs: an uppercase host on our own origin is normalised, not refused', () => {
  assert.equal(safeReturnUrl('https://PHOTOS.daemonclient.uz/x'), 'https://photos.daemonclient.uz/x')
})

test('Turnstile: success alone is not enough — it must be our page and our widget', () => {
  const good = { success: true, hostname: 'accounts.daemonclient.uz', action: 'turnstile-spin-v2' }
  assert.equal(turnstileResultOk(good), true)
  assert.equal(turnstileResultOk({ ...good, success: false }), false)
  assert.equal(turnstileResultOk({ ...good, success: 'true' }), false)
  assert.equal(turnstileResultOk({ ...good, hostname: 'evil.example' }), false)
  assert.equal(turnstileResultOk({ ...good, hostname: undefined }), false)
  assert.equal(turnstileResultOk({ ...good, action: 'other' }), false)
  assert.equal(turnstileResultOk({ success: true }), false)
  for (const r of [null, undefined, 'success', 1]) assert.equal(turnstileResultOk(r), false)
})
