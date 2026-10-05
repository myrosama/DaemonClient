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

test('probes: only encrypted files with chunks from the allowed window; files since the save first, then smallest; at most 3', () => {
  const saved = '2026-10-05T10:00:00.000Z'
  const at = (min) => new Date(Date.parse(saved) + min * 60_000).toISOString()
  const items = [
    { id: 'folder', type: 'folder', encrypted: true, messages: [{ file_id: 'x' }], uploadedAt: at(5), fileSize: 1 },
    { id: 'plain', encrypted: false, messages: [{ file_id: 'x' }], uploadedAt: at(5), fileSize: 1 },
    { id: 'old-key', encrypted: true, messages: [{ file_id: 'x' }], uploadedAt: at(-60), fileSize: 1 },
    { id: 'skewed', encrypted: true, messages: [{ file_id: 'x' }], uploadedAt: at(-(CLOCK_SKEW_MS / 60_000) + 1), fileSize: 1 },
    { id: 'big', encrypted: true, messages: [{ file_id: 'x' }], uploadedAt: at(1), fileSize: 900 },
    { id: 'small', encrypted: true, messages: [{ file_id: 'x' }], uploadedAt: at(3), fileSize: 10 },
    { id: 'mid', encrypted: true, messages: [{ file_id: 'x' }], uploadedAt: at(2), fileSize: 50 },
    { id: 'nochunks', encrypted: true, messages: [], uploadedAt: at(9), fileSize: 1 },
    { id: 'nodate', encrypted: true, messages: [{ file_id: 'x' }], fileSize: 1 },
  ]
  const picked = pickProbes(items, saved)
  assert.deepEqual(picked.map((i) => i.id), ['small', 'mid', 'big'])
  assert.ok(picked.every((p) => p.canRefute === true))
  const all = pickProbes(items, saved, 10)
  assert.deepEqual(all.map((i) => [i.id, i.canRefute]), [['small', true], ['mid', true], ['big', true], ['skewed', false]])
  assert.deepEqual(pickProbes([], saved), [])
  assert.deepEqual(pickProbes(undefined, saved), [])
})

test('a file from just before the save (clock allowance) can confirm a password but never refute it', async () => {
  const salt = generateSalt()
  const oldKeyFile = await encryptedUnder('the previous password', generateSalt())
  // Only an allowance-window file exists, under the previous key: the right
  // new password must not be refused because of it.
  const key = await run({ salt, probes: [{ ...probe('w'), canRefute: false }], fetchFirstChunk: async () => oldKeyFile })
  assert.ok(key)
  // …but a file under THIS password still refutes a wrong one.
  const mine = await encryptedUnder(PASSWORD, salt)
  await assert.rejects(
    run({ password: 'wrong password!', salt, probes: [{ ...probe('m'), canRefute: true }, { ...probe('w'), canRefute: false }],
      fetchFirstChunk: async (p) => (p.id === 'm' ? mine : oldKeyFile) }),
    UnlockError,
  )
})

test('probes: with no saved-at time, every candidate can refute', () => {
  const items = [
    { id: 'a', encrypted: true, messages: [{ file_id: 'x' }], uploadedAt: '2026-01-01T00:00:00Z', fileSize: 5 },
    { id: 'b', encrypted: true, messages: [{ file_id: 'x' }], uploadedAt: '2026-02-01T00:00:00Z', fileSize: 1 },
  ]
  assert.deepEqual(pickProbes(items, undefined).map((i) => [i.id, i.canRefute]), [['b', true], ['a', true]])
})

test('if the files that could prove a password wrong cannot be fetched, it refuses — even when an older file was fetched', async () => {
  const oldKeyFile = await encryptedUnder('the previous password', generateSalt())
  await assert.rejects(
    run({
      salt: generateSalt(),
      probes: [{ ...probe('mine'), canRefute: true }, { ...probe('w'), canRefute: false }],
      fetchFirstChunk: async (p) => { if (p.id === 'mine') throw new Error('502'); return oldKeyFile },
    }),
    (err) => !(err instanceof UnlockError) && /try again/.test(err.message),
  )
})
