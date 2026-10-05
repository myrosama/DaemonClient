// Unlock a custom encryption password on this device.
//
// A custom password is never stored, so after every reload the key has to be
// derived again from the password and the salt saved with the settings. A wrong
// password derives a different key just as happily — and new uploads under it
// could never be read with the real one — so the key is first tried on files
// the user already encrypted under THIS password: AES-GCM refuses to decrypt
// with the wrong key.
//
// Which files: every change of mode or password mints a new salt, and files
// from before it stay encrypted under a key that can no longer be derived. So
// only files uploaded after the settings were last saved count — taken from the
// worker's list (this browser's cached list may be stale or another account's),
// newest first. With none, there is nothing to check against; the password was
// typed twice in Settings, the same check as when it was first set.

export class UnlockError extends Error {}

/** Allowance for the uploading device's clock running behind the worker's. */
export const CLOCK_SKEW_MS = 10 * 60_000

/** Up to `limit` newest encrypted files uploaded since the settings were saved. */
export function pickProbes(items, settingsSavedAt, limit = 3) {
  const since = Date.parse(settingsSavedAt)
  const time = (item) => Date.parse(item.uploadedAt)
  return (items || [])
    .filter((item) =>
      item && item.type !== 'folder' && item.encrypted &&
      Array.isArray(item.messages) && item.messages[0]?.file_id &&
      Number.isFinite(time(item)) &&
      (!Number.isFinite(since) || time(item) >= since - CLOCK_SKEW_MS))
    .sort((a, b) => time(b) - time(a))
    .slice(0, limit)
}

export async function unlockCustomKey({ password, salt, deriveKey, probes, fetchFirstChunk, decryptChunk }) {
  if (!password) throw new UnlockError('Enter your encryption password.')
  const key = await deriveKey(password, salt)
  let fetched = 0
  for (const probe of probes || []) {
    let bytes
    try {
      bytes = await fetchFirstChunk(probe)
    } catch {
      continue // one missing or unreachable file must not decide the answer
    }
    fetched++
    try {
      await decryptChunk(bytes, key)
      return key
    } catch {
      // not this key — try the next file
    }
  }
  if (fetched > 0) {
    throw new UnlockError('That password does not open your files. Use the same password you set before.')
  }
  if ((probes || []).length > 0) {
    // There were files to check against, but none could be fetched: refuse
    // rather than accept a password nobody checked.
    throw new Error("Couldn't check your password right now — please try again in a moment.")
  }
  return key
}
