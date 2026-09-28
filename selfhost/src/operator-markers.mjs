// What must never appear in a self-host build.
//
// `daemonclient web` builds the three web apps from this checkout and deploys
// them to the user's own Firebase. If a self-host env var fails to apply, the
// build silently falls back to the operator's values and the user ships a app
// that sends their data to us. That is the leak this module exists to catch.
//
// Note on the API key: the operator's key is deliberately NOT listed here.
// Naming a credential in open-source code is the very thing this guard exists
// to prevent, and a literal would go stale the moment the key is rotated.
// Instead we invert the test — every Google API key in the bundle must equal
// the user's OWN key. Any other key is, by definition, not theirs.

// The operator's Firebase project. Not a credential: it is a public identifier
// that appears in every hosted URL. Listing it is safe and it never rotates.
export const OPERATOR_PROJECT_ID = 'daemonclient-c0625';

const GOOGLE_API_KEY = /AIza[0-9A-Za-z_-]{35}/g;

// Returns a list of human-readable reasons this text must not ship. Empty
// means clean. Each reason is pushed at most once, so no de-duplication is
// needed — the key loop breaks on its first hit.
//
// Fails CLOSED: when the user's own apiKey is unknown we cannot tell their key
// from the operator's, so every key found is reported rather than waved through.
export function findOperatorMarkers(text, { apiKey, projectId, host } = {}) {
  const hits = [];

  if (host && text.includes(host)) {
    hits.push(`routes data to the operator host ${host}`);
  }

  if (text.includes(OPERATOR_PROJECT_ID) && projectId !== OPERATOR_PROJECT_ID) {
    hits.push(`names the operator Firebase project ${OPERATOR_PROJECT_ID}`);
  }

  for (const found of text.match(GOOGLE_API_KEY) ?? []) {
    if (found !== apiKey) {
      // Deliberately no fragment of the key: this string reaches logs.
      hits.push('contains a Google API key that is not yours');
      break;
    }
  }

  return hits;
}
