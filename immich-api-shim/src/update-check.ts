import type { Env } from './index';
import { isSelfHost } from './selfhost-auth';

// How a self-hosted install learns that a new version exists.
//
// Managed workers are upgraded for their users by the deployment service. A
// self-hosted worker has no such service by design — nobody but its owner can
// deploy to it. So instead of pushing, we pull: the worker asks GitHub for the
// project's latest release tag, caches the answer in its own D1, and reports it
// to the dashboard, which shows a banner telling the owner to run one command.
//
// Constraints this respects:
//   * No token, no webhook, no callback to us. GitHub's releases endpoint is
//     public and anonymous, and nothing about the install is sent with the
//     request — an update check must not become telemetry.
//   * Cached for 12 hours in D1, so a busy server makes ~2 calls a day and
//     stays far inside GitHub's 60/hour anonymous rate limit.
//   * Never blocks or breaks a request: any failure just reports "unknown".
//   * The owner decides when to update. We never self-mutate.

const CACHE_KEY = 'updateCheck';
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const DEFAULT_REPO = 'myrosama/DaemonClient';

export interface UpdateStatus {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  releaseUrl: string | null;
  checkedAt: string;
  /** Present when the check could not complete; currentVersion is still valid. */
  error?: string;
}

/** Compare two dotted version strings ("1.4.0", "v1.10.2"). Returns true when
 *  `latest` is strictly newer than `current`. Unparseable input → false, so a
 *  malformed tag can never nag the user forever. */
export function isNewerVersion(latest: string, current: string): boolean {
  const parse = (v: string): number[] | null => {
    const m = String(v || '').trim().replace(/^v/i, '').match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
    if (!m) return null;
    return [Number(m[1] || 0), Number(m[2] || 0), Number(m[3] || 0)];
  };
  const a = parse(latest);
  const b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return false;
}

async function readCache(env: Env): Promise<{ value: UpdateStatus; at: number } | null> {
  if (!env.DB) return null;
  try {
    const row: any = await env.DB
      .prepare('SELECT value FROM config WHERE key = ? LIMIT 1')
      .bind(CACHE_KEY)
      .first();
    if (!row?.value) return null;
    const parsed = JSON.parse(row.value);
    if (!parsed || typeof parsed.at !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeCache(env: Env, value: UpdateStatus): Promise<void> {
  if (!env.DB) return;
  try {
    await env.DB
      .prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)')
      .bind(CACHE_KEY, JSON.stringify({ value, at: Date.now() }))
      .run();
  } catch {
    /* cache is an optimisation; a failure just means we check again sooner */
  }
}

export async function getUpdateStatus(env: Env, force = false): Promise<UpdateStatus> {
  const currentVersion = env.BUILD_VERSION || '0.0.0';

  // Managed installs are pushed to, never nagged.
  //
  // This check exists so a SELF-HOSTED operator finds out a fix shipped, since
  // we deliberately cannot deploy to them. A managed worker is redeployed for
  // its user by the deployment service, and its user has no CLI — so a banner
  // saying "update available" points at a command they cannot run.
  //
  // It was worse than useless. `buildShimBindings` sets neither BUILD_VERSION
  // nor UPDATE_REPO, and `repo` below falls back to DEFAULT_REPO, so every
  // hosted worker polled GitHub daily while reporting currentVersion '0.0.0'.
  // The first published release would have made updateAvailable TRUE for every
  // hosted user, permanently, and burned a request a day each doing it.
  if (!isSelfHost(env)) {
    return {
      currentVersion,
      latestVersion: null,
      updateAvailable: false,
      releaseUrl: null,
      checkedAt: new Date().toISOString(),
    };
  }

  if (!force) {
    const cached = await readCache(env);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      return { ...cached.value, currentVersion };
    }
  }

  const repo = env.UPDATE_REPO || DEFAULT_REPO;
  const base: UpdateStatus = {
    currentVersion,
    latestVersion: null,
    updateAvailable: false,
    releaseUrl: null,
    checkedAt: new Date().toISOString(),
  };

  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: {
        Accept: 'application/vnd.github+json',
        // GitHub rejects anonymous API calls without a User-Agent.
        'User-Agent': 'DaemonClient-SelfHosted',
      },
    });
    if (!res.ok) {
      // 404 simply means the project has published no releases yet.
      const status: UpdateStatus = { ...base, error: `GitHub responded ${res.status}` };
      await writeCache(env, status);
      return status;
    }
    const data = await res.json() as any;
    const latestVersion = typeof data?.tag_name === 'string' ? data.tag_name : null;
    const status: UpdateStatus = {
      ...base,
      latestVersion,
      updateAvailable: latestVersion ? isNewerVersion(latestVersion, currentVersion) : false,
      releaseUrl: typeof data?.html_url === 'string' ? data.html_url : null,
    };
    await writeCache(env, status);
    return status;
  } catch (e: any) {
    return { ...base, error: e?.message || 'update check failed' };
  }
}
