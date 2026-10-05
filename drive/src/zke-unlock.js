// Unlock a custom encryption password on this device.
//
// A custom password is never stored, so after every reload the key has to be
// derived again from the password and the salt saved with the settings. A wrong
// password derives a different key just as happily — and new uploads under it
// could never be read with the real one — so the key is first tried on the
// smallest file the user already encrypted: AES-GCM refuses to decrypt with the
// wrong key. With nothing encrypted yet there is nothing to disagree with.

export class UnlockError extends Error {}

/** The smallest encrypted file with stored chunks, or null. */
export function pickProbe(items) {
  let best = null
  for (const item of items || []) {
    if (!item || item.type === 'folder' || !item.encrypted) continue
    if (!Array.isArray(item.messages) || !item.messages[0]?.file_id) continue
    if (!best || (item.fileSize || 0) < (best.fileSize || 0)) best = item
  }
  return best
}

export async function unlockCustomKey({ password, salt, deriveKey, probe, fetchFirstChunk, decryptChunk }) {
  if (!password) throw new UnlockError('Enter your encryption password.')
  const key = await deriveKey(password, salt)
  if (probe) {
    const bytes = await fetchFirstChunk(probe)
    try {
      await decryptChunk(bytes, key)
    } catch {
      throw new UnlockError('That password does not open your files. Use the same password you set before.')
    }
  }
  return key
}
