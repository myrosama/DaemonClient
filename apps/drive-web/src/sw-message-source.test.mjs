// node --test src/sw-message-source.test.mjs
//
// The current app's service worker (scope /) keeps file registrations: the bot
// token, the worker URL and the file's decryption key. Only the current app's
// own pages may register files; the new app at /next/ shares the origin and
// must never be able to.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8')
const self = {
  addEventListener() {},
  skipWaiting() {},
  clients: { claim() {} },
  location: { origin: 'https://drive.daemonclient.uz', protocol: 'https:' },
}
const ctx = vm.createContext({ self, console, URL, setTimeout, clearTimeout })
vm.runInContext(source, ctx)
const from = (source) => ctx.mayRegisterFiles({ source })

test("the current app's pages may register files", () => {
  for (const path of ['/dashboard', '/login', '/dashboard?sso=1'])
    assert.equal(from({ type: 'window', url: `https://drive.daemonclient.uz${path}` }), true, path)
})

test('the new app under /next/, other origins, workers and unknown senders may not', () => {
  for (const url of ['https://drive.daemonclient.uz/next', 'https://drive.daemonclient.uz/next/', 'https://drive.daemonclient.uz/next/files/x', 'https://evil.example/dashboard', 'blob:https://drive.daemonclient.uz/abc'])
    assert.equal(from({ type: 'window', url }), false, url)
  assert.equal(from({ type: 'worker', url: 'https://drive.daemonclient.uz/dashboard' }), false)
  assert.equal(from(null), false)
  assert.equal(from({ type: 'window', url: 'not a url' }), false)
})
