// node --test src/zke-unlock.test.mjs
//
// Unlocking a custom encryption password must never accept a wrong one: files
// uploaded under a wrong key could never be opened with the real password.
// Uses the real crypto.js (Web Crypto is built into Node).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveKey, encryptChunk, decryptChunk, generateSalt } from './crypto.js'
import { pickProbe, unlockCustomKey, UnlockError } from './zke-unlock.js'

const enc = new TextEncoder()

async function setup() {
  const salt = generateSalt()
  const realKey = await deriveKey('correct horse battery staple', salt)
  const chunk = await encryptChunk(enc.encode('hello from an encrypted file').buffer, realKey)
  return { salt, chunk }
}

test('the right password unlocks, after a test decrypt of an existing file', async () => {
  const { salt, chunk } = await setup()
  let fetched = 0
  const key = await unlockCustomKey({
    password: 'correct horse battery staple', salt, deriveKey, decryptChunk,
    probe: { messages: [{ file_id: 'f' }] },
    fetchFirstChunk: async () => { fetched++; return chunk },
  })
  assert.equal(fetched, 1)
  const plain = await decryptChunk(chunk, key)
  assert.equal(new TextDecoder().decode(plain), 'hello from an encrypted file')
})

test('a wrong password is refused — no key is handed out', async () => {
  const { salt, chunk } = await setup()
  await assert.rejects(
    unlockCustomKey({
      password: 'correct horse battery stapel', salt, deriveKey, decryptChunk,
      probe: { messages: [{ file_id: 'f' }] },
      fetchFirstChunk: async () => chunk,
    }),
    (err) => err instanceof UnlockError && /does not open your files/.test(err.message),
  )
})

test('with nothing encrypted yet, the password is accepted without a download', async () => {
  const salt = generateSalt()
  const key = await unlockCustomKey({
    password: 'anything at all', salt, deriveKey, decryptChunk, probe: null,
    fetchFirstChunk: async () => { throw new Error('must not download') },
  })
  assert.ok(key)
})

test('an empty password is refused before any work', async () => {
  await assert.rejects(unlockCustomKey({ password: '', salt: generateSalt(), deriveKey, decryptChunk, probe: null, fetchFirstChunk: async () => null }), UnlockError)
})

test('a download failure is not mistaken for a wrong password', async () => {
  const { salt } = await setup()
  await assert.rejects(
    unlockCustomKey({
      password: 'correct horse battery staple', salt, deriveKey, decryptChunk,
      probe: { messages: [{ file_id: 'f' }] },
      fetchFirstChunk: async () => { throw new Error('Proxy fetch failed: 502') },
    }),
    (err) => !(err instanceof UnlockError) && /502/.test(err.message),
  )
})

test('the probe is the smallest encrypted file that has chunks; folders and plain files are skipped', () => {
  const items = [
    { id: 'folder', type: 'folder', encrypted: true, messages: [{ file_id: 'x' }], fileSize: 1 },
    { id: 'plain', encrypted: false, messages: [{ file_id: 'x' }], fileSize: 2 },
    { id: 'big', encrypted: true, messages: [{ file_id: 'x' }], fileSize: 900 },
    { id: 'small', encrypted: true, messages: [{ file_id: 'x' }], fileSize: 30 },
    { id: 'nochunks', encrypted: true, messages: [], fileSize: 3 },
  ]
  assert.equal(pickProbe(items).id, 'small')
  assert.equal(pickProbe([]), null)
  assert.equal(pickProbe(undefined), null)
})
