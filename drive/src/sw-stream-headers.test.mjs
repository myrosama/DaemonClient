// node --test src/sw-stream-headers.test.mjs
//
// Drive's service worker serves the user's own files at /stream/<id> on the
// drive origin — the origin that holds their session. A file that can run
// script there (an uploaded .html or .svg, or any file whose stored type says
// text/html) must never be served as itself. These load the real public/sw.js
// in a sandbox and pin the headers it sends.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8')
const self = {
  addEventListener() {},
  skipWaiting() {},
  clients: { claim() {} },
  location: { origin: 'https://drive.daemonclient.uz' },
}
const ctx = vm.createContext({ self, console, URL, setTimeout, clearTimeout })
vm.runInContext(source, ctx)
const headersFor = (fileName, fileType = '') => ctx.streamHeadersFor({ fileName, fileType })

test('every response forbids type sniffing', () => {
  for (const name of ['a.jpg', 'a.mp4', 'a.pdf', 'a.html', 'a.svg', 'a.bin', 'noext']) {
    assert.equal(headersFor(name)['X-Content-Type-Options'], 'nosniff', name)
  }
})

test('photos, video, audio and PDF are served as themselves, unsandboxed', () => {
  for (const [name, type] of [['a.jpg', 'image/jpeg'], ['a.png', 'image/png'], ['a.webp', 'image/webp'],
    ['a.mp4', 'video/mp4'], ['a.mov', 'video/quicktime'], ['a.mp3', 'audio/mpeg'], ['a.pdf', 'application/pdf']]) {
    const h = headersFor(name)
    assert.equal(h['Content-Type'], type, name)
    assert.equal(h['Content-Security-Policy'], undefined, name)
    assert.equal(h['Content-Disposition'], undefined, name)
  }
})

test('HTML, XML and scripts are shown as plain text, sandboxed', () => {
  for (const name of ['page.html', 'page.htm', 'feed.xml', 'notes.txt', 'data.json', 'sheet.csv', 'readme.md']) {
    const h = headersFor(name)
    assert.equal(h['Content-Type'], 'text/plain; charset=utf-8', name)
    assert.match(h['Content-Security-Policy'], /^sandbox;/, name)
  }
})

test('the stored type cannot smuggle HTML in: an unknown extension typed text/html is text', () => {
  for (const type of ['text/html', 'TEXT/HTML; charset=utf-8', 'application/xhtml+xml', 'text/javascript', 'image/svg+xml']) {
    const h = headersFor('file.unknownext', type)
    assert.notEqual(h['Content-Type'], 'text/html', type)
    assert.match(h['Content-Security-Policy'], /^sandbox;/, type)
  }
})

test('SVG keeps its type (so <img> still shows it) but is sandboxed if opened directly', () => {
  const h = headersFor('logo.svg')
  assert.equal(h['Content-Type'], 'image/svg+xml')
  assert.match(h['Content-Security-Policy'], /^sandbox;/)
  assert.match(h['Content-Security-Policy'], /default-src 'none'/)
})

test('unknown binaries download instead of rendering, with the file name kept', () => {
  const h = headersFor('archive.weird')
  assert.equal(h['Content-Type'], 'application/octet-stream')
  assert.equal(h['Content-Disposition'], "attachment; filename*=UTF-8''archive.weird")
  assert.equal(headersFor('Отчёт 2026.bin')['Content-Disposition'], "attachment; filename*=UTF-8''%D0%9E%D1%82%D1%87%D1%91%D1%82%202026.bin")
  assert.match(headersFor('', '')['Content-Disposition'], /filename\*=UTF-8''download$/)
})

test('a stored media type is honoured only as media — never upgraded to something that runs', () => {
  assert.equal(headersFor('clip', 'video/webm')['Content-Type'], 'video/webm')
  assert.equal(headersFor('clip', 'video/webm')['Content-Security-Policy'], undefined)
})
