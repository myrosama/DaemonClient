// The product version, from one tracked file, for every path that stamps a
// worker with BUILD_VERSION.
//
// Why this exists: `BUILD_VERSION` is not decoration. A self-hosted worker
// compares it against the newest GitHub release tag once a day
// (`immich-api-shim/src/update-check.ts`) and shows an update banner when the
// tag is newer. That check is the ONLY way a self-hoster learns a fix exists —
// we can push to managed installs because we hold their Cloudflare token, and
// we deliberately cannot push to theirs.
//
// It was broken in both directions:
//
//   `setup` wrote `readVersion(REPO_ROOT)`, which read the ROOT package.json —
//   a file that is gitignored, so a fresh clone has none and every new install
//   stamped itself '0.0.0'.
//
//   `update` wrote the git short SHA. `isNewerVersion` parses with
//   /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/, so 'a1b2c3d' fails to parse entirely and
//   returns false, while '3e2db37' parses as major version 3 and compares
//   ABOVE every real tag. Either way the answer is the same: no banner, ever.
//   The first time someone ran `daemonclient update`, their install stopped
//   reporting updates permanently.
//
// So: one tracked `VERSION` file at the repo root, read by both. Cutting a
// release means bumping that file and tagging the commit with the same
// number, and the two can no longer drift apart.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '../..');

/**
 * Semver `major.minor.patch`, or null when the file is missing or junk.
 *
 * All three components are REQUIRED and each is capped at three digits. Both
 * halves of that matter, and a looser regex was caught in review:
 *
 *   `/^\d+(\.\d+){0,2}$/` guarantees the stamp *parses*. It does not guarantee
 *   it *compares sanely*. A date-style `20260812.1`, or a fat-fingered
 *   `9999999999`, sails through and then sits ABOVE every real tag forever —
 *   `isNewerVersion('v2.1.0', '20260812.1')` is false. That is structurally the
 *   same bug as stamping a git SHA that happens to start with a digit: a
 *   version nothing can ever exceed, so the banner never appears again.
 *
 * Three digits per component allows 999.999.999, which this project will not
 * reach, and rejects every shape that could outrank a real release.
 */
const SEMVER = /^\d{1,3}\.\d{1,3}\.\d{1,3}$/;

export function readVersion(root = REPO_ROOT) {
  try {
    const raw = fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim();
    return SEMVER.test(raw) ? raw : null;
  } catch {
    return null;
  }
}

/**
 * What to stamp into BUILD_VERSION.
 *
 * Falls back to '0.0.0' rather than a git SHA on purpose. '0.0.0' is older
 * than every release, so a broken read means the user is over-notified about
 * updates; a SHA means they are never notified at all. Of the two failure
 * modes, only one is recoverable by the user.
 */
export function buildVersion(root = REPO_ROOT) {
  return readVersion(root) || '0.0.0';
}

/**
 * The message to show when the version could not be read, or null when it
 * could. Returned rather than printed: both callers stamp the version from
 * inside a running spinner, which repaints with \r every 80ms and wipes its
 * line on stop, so anything written there is overprinted or mangled. A warning
 * nobody can read is the silent fallback it was meant to fix.
 *
 * The fallback direction is still deliberate — 0.0.0 is older than every
 * release, so a bad read over-notifies rather than going quiet. But '0.0.0'
 * also passes the validator, which makes a genuine 0.0.0 and a failed read
 * indistinguishable from the dashboard. Without this message the operator sees
 * a banner, updates, sees it again, and concludes the update mechanism is
 * broken — losing the channel in the direction that costs them security fixes.
 */
export function versionWarning(root = REPO_ROOT) {
  if (readVersion(root)) return null;
  return `Could not read a valid version from ${path.join(root, 'VERSION')} — stamping 0.0.0, `
    + `so this install will report an update available for every release. Expected three numbers, e.g. 2.1.0.`;
}
