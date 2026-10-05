// node --test src/utils/safeReturnUrl.test.mjs
//
// After signing in, the portal follows `return_url` from the address bar. These
// pin that it only ever goes to our own pages.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { safeReturnUrl, isAbsoluteUrl } from './safeReturnUrl.js'

test('our own paths and origins are kept', () => {
  assert.equal(safeReturnUrl('/dashboard'), '/dashboard')
  assert.equal(safeReturnUrl('/setup?step=2'), '/setup?step=2')
  assert.equal(safeReturnUrl('https://photos.daemonclient.uz'), 'https://photos.daemonclient.uz/')
  assert.equal(safeReturnUrl('https://drive.daemonclient.uz/dashboard'), 'https://drive.daemonclient.uz/dashboard')
  assert.equal(safeReturnUrl('https://PHOTOS.daemonclient.uz/x'), 'https://photos.daemonclient.uz/x')
})

test('every way off-site is refused', () => {
  const evil = [
    'https://evil.example', '//evil.example', '/\\evil.example', '\\\\evil.example',
    '/\t/evil.example', 'https://drive.daemonclient.uz.evil.example/',
    'https://user:pass@drive.daemonclient.uz/', 'https://drive.daemonclient.uz@evil.example/',
    'http://drive.daemonclient.uz/', 'javascript:alert(1)', 'JaVaScRiPt:alert(1)',
    'data:text/html,x', 'https://drive.daemonclient.uz:8443/', 'evil.example', 'dashboard',
    '', '   ', null, undefined, 42, '/' + 'a'.repeat(3000),
  ]
  for (const v of evil) assert.equal(safeReturnUrl(v), null, JSON.stringify(v))
})

test('a full URL is opened as a page load, a path through the router', () => {
  assert.equal(isAbsoluteUrl(safeReturnUrl('https://drive.daemonclient.uz/')), true)
  assert.equal(isAbsoluteUrl(safeReturnUrl('/dashboard')), false)
  assert.equal(isAbsoluteUrl(null), false)
})
