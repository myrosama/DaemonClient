import type { Env } from './index';

// Self-hosted installs run the SAME stack as the managed service: the user's
// own Cloudflare Worker + D1, the user's own Telegram bot and channel, and the
// user's own Firebase project for authentication. Nothing is swapped out, so
// there is no second auth implementation to keep in step — a self-hosted worker
// simply points FIREBASE_API_KEY and FIREBASE_PROJECT_ID at the operator's own
// project, and every existing login/refresh path works unchanged.
//
// What remains here is the one thing that genuinely differs between installs:
// the secret that signs session tokens.

export function isSelfHost(env: Env): boolean {
  const v = (env as any).SELF_HOST;
  return v === '1' || v === 'true' || v === true;
}

/** The HMAC scope that signs and verifies session tokens.
 *
 *  This MUST be a per-install secret. Sessions used to be signed with
 *  APP_IDENTIFIER ("default-daemon-client") — a constant committed to a public
 *  repository and injected into every worker — so anyone who read the source
 *  could mint a valid session for any account, and a session issued for one
 *  user verified on everybody else's worker.
 *
 *  Managed workers now receive a generated SESSION_SECRET from the deployment
 *  service; self-hosted ones get theirs from the setup CLI. The APP_IDENTIFIER
 *  fallback survives ONLY for managed workers that have not been redeployed
 *  yet — without it every existing user would be logged out the moment this
 *  shipped. Delete that branch once the fleet has rolled over.
 */
export function sessionScope(env: Env): string {
  const secret = (env as any).SESSION_SECRET;
  if (typeof secret === 'string' && secret.length >= 32) return secret;

  if (isSelfHost(env)) {
    // Never fall back on a self-hosted install: the CLI always provisions a
    // secret, so a missing one means something is wrong, and issuing a
    // forgeable session would be worse than refusing to issue one.
    throw new Error(
      'SESSION_SECRET missing or too short: this worker needs a 32+ character random secret to sign sessions. Re-run the setup CLI to generate one.',
    );
  }
  return env.APP_IDENTIFIER || 'default';
}
