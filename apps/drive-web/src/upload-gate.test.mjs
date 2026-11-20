// node --test src/upload-gate.test.mjs
//
// A file must never be uploaded unencrypted just because the key wasn't there
// yet. These pin when an upload may start.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { uploadGate, GATE_MESSAGES } from './upload-gate.js'

test('while the encryption settings load, uploads wait (the key may be on its way)', () => {
  for (const zkeEnabled of [true, false]) {
    for (const hasKey of [true, false]) {
      assert.equal(uploadGate({ zkeLoading: true, zkeEnabled, hasKey }), 'wait')
    }
  }
})

test('encryption on but no key (custom password not entered, or the key failed) — refused, not sent in the clear', () => {
  assert.equal(uploadGate({ zkeLoading: false, zkeEnabled: true, hasKey: false }), 'locked')
})

test('a missing or odd enabled flag counts as ON: only an explicit false allows plaintext', () => {
  for (const zkeEnabled of [undefined, null, 'false', 0]) {
    assert.equal(uploadGate({ zkeLoading: false, zkeEnabled, hasKey: false }), 'locked', String(zkeEnabled))
  }
})

test('encryption on with its key — go', () => {
  assert.equal(uploadGate({ zkeLoading: false, zkeEnabled: true, hasKey: true }), 'go')
})

test('settings that could not be loaded hold the queue, even for auto-mode users', () => {
  for (const hasKey of [true, false]) {
    assert.equal(uploadGate({ zkeLoading: false, zkeError: true, zkeEnabled: true, hasKey }), 'unavailable')
  }
})

test('every paused state has a message for the user', () => {
  for (const state of ['locked', 'unavailable']) assert.ok(GATE_MESSAGES[state].length > 20, state)
})

test('encryption explicitly off — go, unencrypted by the user\'s choice', () => {
  assert.equal(uploadGate({ zkeLoading: false, zkeEnabled: false, hasKey: false }), 'go')
})
