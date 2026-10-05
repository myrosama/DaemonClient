// Whether an upload may start, given the encryption state.
//
// Encryption is on unless the user turned it off, and its key arrives a moment
// after the page opens (or, for a custom password, only once the user enters
// it). An upload that started before then used to go up UNENCRYPTED, silently.
// So: wait while the settings load, refuse while the key is missing, and only
// send plaintext when encryption is explicitly off.
//
//   'wait'   — encryption settings still loading; try again when they arrive
//   'locked' — encryption is on but there is no key; the user must unlock
//   'go'     — safe to upload (with the key when encryption is on)
export function uploadGate({ zkeLoading, zkeEnabled, hasKey }) {
  if (zkeLoading) return 'wait'
  if (zkeEnabled !== false && !hasKey) return 'locked'
  return 'go'
}

export const LOCKED_MESSAGE =
  'Uploads are paused: your files are encrypted, and the encryption key is not unlocked. ' +
  'If you use your own encryption password, enter it in Settings — the uploads continue on their own.'
