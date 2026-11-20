// Whether an upload may start, given the encryption state.
//
// Encryption is on unless the user turned it off, and its key arrives a moment
// after the page opens (or, for a custom password, only once the user unlocks
// it on this device). An upload that started before then used to go up
// UNENCRYPTED, silently. So: wait while the settings load, hold the queue while
// they could not be loaded or the key is locked, and only send plaintext when
// encryption is explicitly off.
//
//   'wait'        — encryption settings still loading; try again when they arrive
//   'unavailable' — the settings could not be loaded; a reload retries
//   'locked'      — encryption is on but there is no key; the user must unlock
//   'go'          — safe to upload (with the key when encryption is on)
export function uploadGate({ zkeLoading, zkeError, zkeEnabled, hasKey }) {
  if (zkeLoading) return 'wait'
  if (zkeError) return 'unavailable'
  if (zkeEnabled !== false && !hasKey) return 'locked'
  return 'go'
}

export const GATE_MESSAGES = {
  locked:
    'Uploads are paused: your files are encrypted with your own password, and it is not unlocked on this device yet. ' +
    'Open Settings, enter the same password you set before and press Save — the uploads then continue on their own.',
  unavailable:
    'Uploads are paused: your encryption settings could not be loaded, and files are never uploaded unencrypted by accident. ' +
    'Reload the page to try again.',
}
