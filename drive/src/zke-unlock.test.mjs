// node --test src/zke-unlock.test.mjs
//
// Unlocking a custom encryption password must never accept a wrong one (files
// uploaded under a wrong key could never be opened with the real password), and
// must never refuse the right one because of files from an earlier password.
// Uses the real crypto.js (Web Crypto is built into Node).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveKey, encryptChunk, decryptChunk, generateSalt } from './crypto.js'
import { pickProbes, unlockCustomKey, UnlockError, CLOCK_SKEW_MS } from './zke-unlock.js'

const enc = new TextEncoder()
const PASSWORD = 'correct horse battery staple'

async function encryptedUnder(password, salt) {
  const key = await deriveKey(password, salt)
  return encryptChunk(enc.encode('hello from an encrypted file').buffer, key)
}
const probe = (id) => ({ id, messages: [{ file_id: id }] })
const run = (overrides) => unlockCustomKey({ password: PASSWORD, deriveKey, decryptChunk, ...overrides })

test('the right password unlocks after a test decrypt', async () => {
  const salt = generateSalt()
  const chunk = await encryptedUnder(PASSWORD, salt)
  const key = await run({ salt, probes: [probe('a')], fetchFirstChunk: async () => chunk })
  assert.equal(new TextDecoder().decode(await decryptChunk(chunk, key)), 'hello from an encrypted file')
})

test('a wrong password is refused — no key is handed out', async () => {
  const salt = generateSalt()
  const chunk = await encryptedUnder(PASSWORD, salt)
  await assert.rejects(
    run({ password: 'correct horse battery stapel', salt, probes: [probe('a')], fetchFirstChunk: async () => chunk }),
    (err) => err instanceof UnlockError && /does not open your files/.test(err.message),
  )
})

test('the right password still unlocks when one candidate is from another key', async () => {
  const salt = generateSalt()
  const mine = await encryptedUnder(PASSWORD, salt)
  const stray = await encryptedUnder('some earlier password', generateSalt())
  const chunks = { stray, mine }
  const key = await run({ salt, probes: [probe('stray'), probe('mine')], fetchFirstChunk: async (p) => chunks[p.id] })
  assert.ok(key)
})

test('a file that cannot be fetched is skipped, not mistaken for a wrong password', async () => {
  const salt = generateSalt()
  const chunk = await encryptedUnder(PASSWORD, salt)
  const key = await run({
    salt,
    probes: [probe('gone'), probe('ok')],
    fetchFirstChunk: async (p) => { if (p.id === 'gone') throw new Error('TG getFile error'); return chunk },
  })
  assert.ok(key)
})

test('when no candidate can be fetched at all, it refuses rather than accept an unchecked password', async () => {
  await assert.rejects(
    run({ salt: generateSalt(), probes: [probe('a'), probe('b')], fetchFirstChunk: async () => { throw new Error('502') } }),
    (err) => !(err instanceof UnlockError) && /try again/.test(err.message),
  )
})

test('with no files under this password yet, the (twice-typed) password is accepted without a download', async () => {
  const key = await run({ salt: generateSalt(), probes: [], fetchFirstChunk: async () => { throw new Error('must not download') } })
  assert.ok(key)
})

test('an empty password is refused before any work', async () => {
  await assert.rejects(run({ password: '', salt: generateSalt(), probes: [], fetchFirstChunk: async () => null }), UnlockError)
})

test('probes: only encrypted files with chunks, uploaded since the settings were saved, newest first, at most 3', () => {
  const saved = '2026-10-05T10:00:00.000Z'
  const at = (min) => new Date(Date.parse(saved) + min * 60_000).toISOString()
  const items = [
    { id: 'folder', type: 'folder', encrypted: true, messages: [{ file_id: 'x' }], uploadedAt: at(5) },
    { id: 'plain', encrypted: false, messages: [{ file_id: 'x' }], uploadedAt: at(5) },
    { id: 'old-key', encrypted: true, messages: [{ file_id: 'x' }], uploadedAt: at(-60) },
    { id: 'skewed', encrypted: true, messages: [{ file_id: 'x' }], uploadedAt: at(-(CLOCK_SKEW_MS / 60_000) + 1) },
    { id: 'n1', encrypted: true, messages: [{ file_id: 'x' }], uploadedAt: at(1) },
    { id: 'n3', encrypted: true, messages: [{ file_id: 'x' }], uploadedAt: at(3) },
    { id: 'n2', encrypted: true, messages: [{ file_id: 'x' }], uploadedAt: at(2) },
    { id: 'nochunks', encrypted: true, messages: [], uploadedAt: at(9) },
    { id: 'nodate', encrypted: true, messages: [{ file_id: 'x' }] },
  ]
  assert.deepEqual(pickProbes(items, saved).map((i) => i.id), ['n3', 'n2', 'n1'])
  assert.deepEqual(pickProbes(items, saved, 10).map((i) => i.id), ['n3', 'n2', 'n1', 'skewed'])
  assert.deepEqual(pickProbes([], saved), [])
  assert.deepEqual(pickProbes(undefined, saved), [])
})

test('probes: with no saved-at time, the newest encrypted files are used', () => {
  const items = [
    { id: 'a', encrypted: true, messages: [{ file_id: 'x' }], uploadedAt: '2026-01-01T00:00:00Z' },
    { id: 'b', encrypted: true, messages: [{ file_id: 'x' }], uploadedAt: '2026-02-01T00:00:00Z' },
  ]
  assert.deepEqual(pickProbes(items, undefined).map((i) => i.id), ['b', 'a'])
})
