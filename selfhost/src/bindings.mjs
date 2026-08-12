// The bindings a self-hosted worker is deployed with — one definition, used by
// both `setup` and `update`.
//
// Why this is its own module rather than an array in each command:
//
//   The two arrays were duplicated and had already drifted in ordering. More
//   importantly, a Gate 3 review demonstrated that the tests guarding
//   BUILD_VERSION could be defeated by *renaming* things: they matched source
//   text (`/name: 'BUILD_VERSION', text: head/`) rather than asserting
//   behaviour, so re-introducing both original bugs under different function
//   names passed a fully green 79-test suite.
//
//   A text assertion cannot survive a rename. A behavioural one can — but only
//   if there is something to call. This function is that something: the tests
//   build the real binding list and assert what BUILD_VERSION actually holds.
//
// If you add a binding, add it here, and remember every value lands in a
// worker the user owns and can read in their own Cloudflare dashboard. Only
// `secret_text` is hidden there.

import { buildVersion } from './version.mjs';

/**
 * @param {object} state  the install's saved state
 * @param {object} [opts]
 * @param {string} [opts.repoRoot]  where to read VERSION from
 * @returns {Array<object>} Cloudflare worker bindings
 */
export function workerBindings(state, { repoRoot } = {}) {
  return [
    { type: 'd1', name: 'DB', id: state.databaseId },
    { type: 'plain_text', name: 'SELF_HOST', text: '1' },
    { type: 'plain_text', name: 'APP_IDENTIFIER', text: 'selfhost' },

    // Their Firebase project, never ours.
    { type: 'plain_text', name: 'FIREBASE_API_KEY', text: state.firebaseApiKey || '' },
    { type: 'plain_text', name: 'FIREBASE_PROJECT_ID', text: state.firebaseProjectId || '' },

    // Empty on purpose: the managed value points at OUR relay worker. With D1
    // bound, the worker proxies through itself instead.
    { type: 'plain_text', name: 'TELEGRAM_PROXY', text: '' },

    // So the worker never hands their users an address of ours.
    { type: 'plain_text', name: 'EXTERNAL_DOMAIN', text: state.dashboardUrl || '' },

    { type: 'plain_text', name: 'ALLOWED_ORIGINS', text: state.allowedOrigins || 'http://localhost:5173' },
    { type: 'plain_text', name: 'UPDATE_REPO', text: state.updateRepo || 'myrosama/DaemonClient' },

    // The release this install is on. Compared daily against the GitHub
    // releases feed — the only channel by which a self-hoster learns a fix
    // exists. See version.mjs for why it must never be a git SHA.
    { type: 'plain_text', name: 'BUILD_VERSION', text: buildVersion(repoRoot) },

    // Reusing the SAME secret is essential: a new session secret signs everyone
    // out. secret_text also keeps it out of the dashboard's plain-text listing.
    { type: 'secret_text', name: 'SESSION_SECRET', text: state.sessionSecret },
  ];
}
