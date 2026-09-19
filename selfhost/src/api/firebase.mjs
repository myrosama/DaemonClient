// BUILD_ORDER P9 — the Firebase project, provisioned instead of clicked.
//
// Today `setup` stops and hands the user a five-step console errand: create a
// project, turn Analytics off, enable Email/Password, add a user, register a
// web app — then copy a project id and an API key back into the terminal. The
// locked decision in EXECUTION_STATUS.md calls that not acceptable, and it is
// the reason the first release is still unpublished. Four of those five steps
// happen here. The fifth (the Email/Password switch) has no CLI command and no
// documented Admin API, so it stays manual — but `firebaseConfig.providersUrl`
// at least opens the exact page.
//
// WHY THIS SHELLS OUT INSTEAD OF IMPORTING firebase-tools.
//
// firebase-tools is 70 direct dependencies and 5.8 MB unpacked, against this
// package's budget of 12 packages total (test/dependencies.test.mjs). It can
// never be a dependency of an installer strangers pipe into a shell. It is
// invoked as a subprocess, at the moment it is needed, through the same
// resolution `web.mjs` already uses: a global `firebase` if there is one, else
// `npx --yes firebase-tools`.
//
// THREE THINGS ABOUT THIS CLI THAT ARE NOT IN ITS DOCS, all confirmed against
// firebase-tools 14.11.2 and a real project rather than assumed:
//
//   1. `--json` is what makes any of this automatable. Its own help says it
//      "outputs JSON instead of text, ALSO TRIGGERS NON-INTERACTIVE MODE".
//      Without it these commands wait on prompts no installer will answer.
//   2. stdout is clean JSON; stderr carries a node punycode deprecation
//      warning and the spinner frames. Anything that merges them (`2>&1`)
//      breaks every parse in this file.
//   3. `apps:sdkconfig WEB` WITHOUT an app id fails the moment a project has
//      more than one web app — "Project <id> has multiple apps, must specify
//      an app id" — and under --json it cannot prompt its way out. That is not
//      an edge case: it is what a second run of setup produces, and it is
//      reproducible on this project's own Firebase account today. Every
//      sdkconfig call here passes the app id explicitly.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
// firebase-tools prints a lot on a deploy; 64 MB is what web.mjs already uses.
const BIG = { maxBuffer: 64 * 1024 * 1024 };

/**
 * Where the Firebase CLI is, if it is anywhere. A global install first, then
 * `npx --yes firebase-tools`.
 *
 * ONE definition, imported by both `web.mjs` (Hosting) and the provisioning
 * above. It was private to web.mjs; a second copy here would be a second
 * thing to fix when the resolution changes, and this project has been bitten
 * repeatedly by fixing the copy that never runs.
 */
export async function firebaseCli(cwd = process.cwd()) {
  try {
    await execFileAsync('firebase', ['--version'], BIG);
    return { available: true, cmd: 'firebase', args: [] };
  } catch { /* fall through to npx */ }
  try {
    await execFileAsync('npx', ['--yes', 'firebase-tools', '--version'], { cwd, ...BIG });
    return { available: true, cmd: 'npx', args: ['--yes', 'firebase-tools'] };
  } catch {
    return { available: false };
  }
}

/**
 * A runner for the functions above: takes CLI arguments, returns **stdout
 * only**.
 *
 * The stdout-only part is load-bearing, not tidiness. firebase-tools writes a
 * node punycode deprecation warning and its spinner frames to stderr; merge
 * the two and every `unwrap()` in this file fails on output that looks like
 * "- Preparing the list of your Firebase projects".
 */
export function cliRunner(cli, cwd = process.cwd()) {
  return async (args) => {
    const { stdout } = await execFileAsync(cli.cmd, [...cli.args, ...args], { cwd, ...BIG });
    return stdout;
  };
}

/** True when the CLI holds credentials at all — distinct from being able to
 *  see one particular project, which is what `web.mjs` needs before a deploy.
 *  Provisioning happens BEFORE any project exists, so it can only ask this. */
export async function isSignedIn(run) {
  try {
    unwrap(await run(['projects:list', '--json']));
    return true;
  } catch {
    return false;
  }
}

/** Google's rules: 6–30 chars, lowercase alphanumerics and hyphens, starts
 *  with a letter, does not end with one. Checked here so an illegal id costs
 *  nothing instead of a round trip and a 400. */
export function isLegalProjectId(id) {
  return typeof id === 'string' && PROJECT_ID.test(id);
}

/**
 * A legal project id that is unlikely to be taken.
 *
 * Deliberately NOT derived from anything about the user. P8 shipped that exact
 * mistake for the Cloudflare subdomain — it built a public name out of the
 * account name, whose personal-signup default is "<email>'s Account", and put
 * a user's email into public DNS and Certificate Transparency logs. A Firebase
 * project id is just as public: it becomes the authDomain host. The `seed`
 * argument exists only so callers can pass one without it mattering.
 *
 * Project ids are unique across ALL of Google Cloud, not just one account, so
 * a plain "daemonclient" was gone years ago. Random suffix, every time.
 */
export function suggestProjectId(_seed) {
  const suffix = Math.random().toString(36).slice(2, 8).replace(/[^a-z0-9]/g, '0');
  return `daemonclient-${suffix.padEnd(6, '0')}`;
}

/** The `{status, result}` envelope, or the CLI's own error message. */
export function unwrap(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    // Usually means stderr got merged in, or the CLI died before printing.
    // Say that, rather than surfacing a JSON position error at the user.
    throw new Error(`the Firebase CLI did not return JSON: ${String(stdout).trim().slice(0, 160)}`);
  }
  if (parsed?.status === 'error' || parsed?.error) {
    throw new Error(typeof parsed.error === 'string' ? parsed.error : 'the Firebase CLI reported an error');
  }
  return parsed?.result;
}

/** The web app THIS installer made, from an `apps:list WEB` result. */
export function pickWebApp(apps, displayName) {
  if (!Array.isArray(apps)) return null;
  return apps.find((a) => a?.platform === 'WEB' && a?.displayName === displayName) ?? null;
}

/** The four fields the dashboard needs, from an `apps:sdkconfig` result.
 *  Note the nesting: `result.sdkConfig`, not `result`. */
export function readSdkConfig(payload) {
  const cfg = payload?.sdkConfig ?? {};
  const out = {
    projectId: cfg.projectId,
    appId: cfg.appId,
    apiKey: cfg.apiKey,
    authDomain: cfg.authDomain,
  };
  // A half-read config is worse than none: setup would carry on and the
  // failure would surface as "Not authenticated" at the user's first login,
  // a long way from the cause.
  const missing = Object.entries(out).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    throw new Error(`the Firebase web config is missing ${missing.join(', ')} — cannot sign anyone in without it`);
  }
  return out;
}

/**
 * The real reason a CLI call failed.
 *
 * Where that lives is not where you would look. Captured from a genuine
 * failure (`apps:sdkconfig WEB` with no app id, firebase-tools 14.11.2):
 *
 *   e.message → "Command failed: firebase apps:sdkconfig WEB --project …"
 *   e.stdout  → {"status":"error","error":"Project … has multiple apps, …"}
 *   e.stderr  → "(node:49148) [DEP0040] DeprecationWarning: punycode …"
 *
 * So the useful text is on STDOUT, wrapped in the JSON envelope, while stderr
 * holds a node deprecation warning that has nothing to do with anything. An
 * `e.stderr || e.stdout || e.message` chain — which is what this file had, and
 * what reads perfectly naturally — shows the user the punycode warning at the
 * exact moment they need the real reason. Order matters here, and it is the
 * opposite of the obvious one.
 */
export function cliErrorText(e) {
  const stdout = String(e?.stdout ?? '').trim();
  if (stdout) {
    try {
      const parsed = JSON.parse(stdout);
      const err = parsed?.error;
      if (typeof err === 'string' && err) return err;
      // Some Google CLIs shape `error` as an object. Not what firebase-tools
      // 14.11.2 does, but the cost of being wrong is that the raw JSON
      // envelope gets shown to the user as if it were a sentence.
      if (err && typeof err === 'object') {
        const inner = err.message ?? err.status ?? err.code;
        if (inner) return String(inner);
      }
    } catch { /* not the envelope; fall through */ }
  }
  const stderr = String(e?.stderr ?? '')
    // Node's own deprecation chatter is never the reason a deploy failed.
    .split('\n')
    .filter((l) => !/DeprecationWarning|--trace-deprecation|^\(node:\d+\)/.test(l))
    .join('\n')
    .trim();
  if (stderr) return stderr;
  if (stdout) return stdout;
  return String(e?.message ?? e ?? '').trim();
}

/** Turn the CLI's shouty output into the next thing to do. Anything
 *  unrecognised is returned as itself — mapping unknown errors to "something
 *  went wrong" is how a fixable problem becomes an unfixable one. */
export function explainFirebaseError(text) {
  const msg = String(text ?? '');
  if (/quota/i.test(msg)) {
    // Keeps the word "quota": it is what Google's own error says and what the
    // user will search for. A rephrasing that drops it leaves them unable to
    // connect this message to the one behind it.
    return 'Google caps how many projects one account may have (a project quota), and this account is at the cap. '
      + 'Delete an unused project at console.cloud.google.com/cloud-resource-manager, or request an increase, then run setup again.';
  }
  if (/already exists|already in use|requested entity already exists/i.test(msg)) {
    return 'That project id is already taken — Firebase ids are unique across all of Google Cloud, not just your account. '
      + 'Run setup again to try another one.';
  }
  if (/has not been used|SERVICE_DISABLED|is disabled|not been enabled/i.test(msg)) {
    const api = msg.match(/([a-z]+\.googleapis\.com)/i)?.[1] ?? 'a Google API';
    return `${api} is not enabled on this Google account yet. Open the link in the error above, enable it, then run setup again.`;
  }
  if (/failed to authenticate|have you run firebase login|not authenticated|no currently active account/i.test(msg)) {
    return 'The Firebase CLI is not signed in. Run `firebase login` — it opens a browser and signs in to YOUR Google account, '
      + 'which we never see — then run setup again.';
  }
  return msg.trim();
}

/**
 * The project, created if it is not already there.
 *
 * @param {(args: string[]) => Promise<string>} run  invokes the CLI, returns stdout ONLY
 */
export async function ensureProject(run, { projectId, displayName }) {
  if (!isLegalProjectId(projectId)) {
    throw new Error(
      `"${projectId}" is not a legal Firebase project id: 6–30 characters, lowercase letters, digits and hyphens, `
      + 'starting with a letter and not ending with a hyphen.',
    );
  }
  let stdout;
  try {
    stdout = await run(['projects:create', projectId, '--display-name', displayName, '--json']);
  } catch (e) {
    throw new Error(explainFirebaseError(cliErrorText(e)));
  }
  const result = unwrap(stdout);
  return result?.projectId ?? projectId;
}

/**
 * The web app and its config — reusing the one from a previous run if there is
 * one, because creating a second is what makes `apps:sdkconfig` unusable.
 */
export async function ensureWebApp(run, { projectId, displayName }) {
  const call = async (args) => {
    try {
      return await run(args);
    } catch (e) {
      throw new Error(explainFirebaseError(cliErrorText(e)));
    }
  };

  const existing = pickWebApp(unwrap(await call(['apps:list', 'WEB', '--project', projectId, '--json'])), displayName);

  let appId = existing?.appId;
  if (!appId) {
    appId = unwrap(await call(['apps:create', 'WEB', displayName, '--project', projectId, '--json']))?.appId;
    if (!appId) throw new Error('Firebase created the web app but returned no app id, so its config cannot be read');
  }

  // The app id is never omitted here — see the header.
  return readSdkConfig(unwrap(await call(['apps:sdkconfig', 'WEB', appId, '--project', projectId, '--json'])));
}

export const firebaseConfig = {
  /** The one page the user still has to visit. Enabling the Email/Password
   *  provider has no CLI command and no documented Admin API — the decision
   *  to stop looking for one is recorded in docs/plan/QUESTIONS.md. */
  providersUrl: (projectId) => `https://console.firebase.google.com/project/${projectId}/authentication/providers`,
};
