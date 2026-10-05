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
// only files uploaded after the settings were last saved can prove a password
// wrong — taken from the worker's list (this browser's cached list may be stale
// or another account's), smallest first. With none, there is nothing to check
// against; the password was typed twice in Settings, the same check as when it
// was first set.

export class UnlockError extends Error {}

/** Allowance for the uploading device's clock running behind the worker's. */
export const CLOCK_SKEW_MS = 10 * 60_000

/**
 * Up to `limit` encrypted files to test a password on, smallest first (the test
 * downloads one chunk of each). Files uploaded since the settings were saved
 * are under this password and can prove it wrong (`canRefute`). Files from the
 * few minutes before — allowed for a device clock running behind — may be
 * under the previous key, so they can confirm a password but never refute it.
 */
export function pickProbes(items, settingsSavedAt, limit = 3) {
  const since = Date.parse(settingsSavedAt)
  const time = (item) => Date.parse(item.uploadedAt)
  return (items || [])
    .filter((item) =>
      item && item.type !== 'folder' && item.encrypted &&
      Array.isArray(item.messages) && item.messages[0]?.file_id &&
      Number.isFinite(time(item)) &&
      (!Number.isFinite(since) || time(item) >= since - CLOCK_SKEW_MS))
    .map((item) => ({ item, canRefute: !Number.isFinite(since) || time(item) >= since }))
    .sort((a, b) => (Number(b.canRefute) - Number(a.canRefute)) || ((a.item.fileSize || 0) - (b.item.fileSize || 0)))
    .slice(0, limit)
    .map(({ item, canRefute }) => ({ ...item, canRefute }))
}

export async function unlockCustomKey({ password, salt, deriveKey, probes, fetchFirstChunk, decryptChunk }) {
  if (!password) throw new UnlockError('Enter your encryption password.')
  const key = await deriveKey(password, salt)
  let fetchedRefuting = 0
  let refuted = false
  for (const probe of probes || []) {
    let bytes
    try {
      bytes = await fetchFirstChunk(probe)
    } catch {
      continue // one missing or unreachable file must not decide the answer
    }
    if (probe.canRefute !== false) fetchedRefuting++
    try {
      await decryptChunk(bytes, key)
      return key
    } catch {
      if (probe.canRefute !== false) refuted = true
    }
  }
  if (refuted) {
    throw new UnlockError('That password does not open your files. Use the same password you set before.')
  }
  if ((probes || []).some((p) => p.canRefute !== false) && fetchedRefuting === 0) {
    // There were files that could prove it wrong, but none could be fetched:
    // refuse rather than accept a password nobody checked.
    throw new Error("Couldn't check your password right now — please try again in a moment.")
  }
  // Nothing under this password yet (or only files that may predate it): the
  // password was typed twice in Settings, the same check as when it was set.
  return key
}
