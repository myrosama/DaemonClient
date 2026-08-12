// BUILD_ORDER P11 — the version a worker stamps into BUILD_VERSION.
//
// This is the delivery channel, not a cosmetic field. A self-hosted worker
// compares BUILD_VERSION against the newest GitHub release tag once a day
// (immich-api-shim/src/update-check.ts) and shows an update banner when the tag
// is newer. It is the ONLY way a self-hoster learns a fix exists — we can push
// to managed installs because we hold their Cloudflare token, and we
// deliberately cannot push to theirs.
//
// It was broken in both directions, which is why these tests exist:
//
//   `setup` stamped readVersion(REPO_ROOT), which read the ROOT package.json —
//   a gitignored file. A fresh clone has none, so every new install stamped
//   '0.0.0'.
//
//   `update` stamped the git short SHA. The worker parses with
//   /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/, so 'a1b2c3d' fails to parse and the
//   comparison returns false, while '3e2db37' parses as major version 3 and
//   compares ABOVE every real tag. Either way: no banner, ever. The first time
//   anyone ran `daemonclient update`, their install stopped reporting updates
//   permanently.
//
// So the tests below assert the property that actually matters — whatever we
// stamp must survive the WORKER's parser and still compare correctly — rather
// than just checking the file is read.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readVersion, buildVersion, REPO_ROOT } from '../src/version.mjs';
import { workerBindings } from '../src/bindings.mjs';

// Copied verbatim from immich-api-shim/src/update-check.ts:37. Duplicated on
// purpose: this test has to fail if the WORKER's parser and the CLI's stamp
// ever stop agreeing, and importing the TypeScript here is not possible
// without a build step.
function isNewerVersion(latest, current) {
  const parse = (v) => {
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

const tmpRoot = (contents) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-version-'));
  if (contents !== null) fs.writeFileSync(path.join(dir, 'VERSION'), contents);
  return dir;
};

describe('the version file is the single source', () => {
  test('reads the tracked VERSION file at the repository root', () => {
    const v = readVersion();
    assert.ok(v, 'VERSION exists at the repo root and parses');
    assert.match(v, /^\d+(\.\d+){0,2}$/);
  });

  test('VERSION is tracked by git, unlike the root package.json it replaces', () => {
    // The whole bug was reading a gitignored file, so this has to assert
    // TRACKED — not "exists" and not "no matching line in .gitignore".
    //
    // The first version of this test checked exactly those two weaker things
    // and passed while VERSION was untracked, which is the same class of
    // mistake as the bug it guards. `git ls-files` is the only answer that
    // means what the test name says.
    assert.ok(fs.existsSync(path.join(REPO_ROOT, 'VERSION')), 'VERSION is on disk');

    const tracked = spawnSync('git', ['ls-files', '--error-unmatch', 'VERSION'], {
      cwd: REPO_ROOT, encoding: 'utf8',
    });
    assert.equal(tracked.status, 0, 'VERSION is tracked by git — a fresh clone must have it');

    const ignored = spawnSync('git', ['check-ignore', '-q', 'VERSION'], { cwd: REPO_ROOT });
    assert.notEqual(ignored.status, 0, 'VERSION is not matched by any gitignore rule');
  });

  test('rejects junk rather than passing it through', () => {
    assert.equal(readVersion(tmpRoot('not-a-version')), null);
    assert.equal(readVersion(tmpRoot('')), null);
    assert.equal(readVersion(tmpRoot(null)), null, 'missing file');
  });

  test('rejects a version large enough to outrank every future release', () => {
    // Raised by the Gate 3 security review. A looser regex guarantees the stamp
    // PARSES but not that it COMPARES sanely: a date-style or fat-fingered
    // version sits above every real tag forever, which is the same permanent
    // banner suppression as stamping a git SHA. Verified below against the
    // worker's own comparator.
    for (const huge of ['20260812.1', '9999999999', '99999999999999999999', '1000.0.0']) {
      assert.equal(readVersion(tmpRoot(huge)), null, `${huge} must not be stamped`);
    }
    assert.equal(
      isNewerVersion('v2.1.0', '20260812.1'), false,
      'sanity: this really would suppress the banner, which is why it is rejected',
    );
  });

  test('requires all three components, so a partial version cannot drift', () => {
    assert.equal(readVersion(tmpRoot('2')), null);
    assert.equal(readVersion(tmpRoot('2.1')), null);
    assert.equal(readVersion(tmpRoot('2.1.0')), '2.1.0');
  });

  test('tolerates trailing whitespace, which a text editor will add', () => {
    assert.equal(readVersion(tmpRoot('2.1.0\n')), '2.1.0');
  });
});

describe('what gets stamped survives the worker\'s parser', () => {
  test('a stamped version compares correctly against a newer release tag', () => {
    const stamped = buildVersion();
    const [maj, min = 0, patch = 0] = stamped.split('.').map(Number);
    const newer = `v${maj}.${min}.${patch + 1}`;
    assert.equal(isNewerVersion(newer, stamped), true, 'a newer tag shows the banner');
    assert.equal(isNewerVersion(`v${stamped}`, stamped), false, 'the same version does not');
  });

  test('a git SHA is NEVER what we stamp — this is the regression that shipped', () => {
    // Both shapes a short SHA can take, and both break the comparison:
    //   leading letter -> parse() returns null -> isNewerVersion is false
    //   leading digit  -> parses as a huge major version -> also false
    for (const sha of ['a1b2c3d', '3e2db37', '9f5d87c', '755dd1e']) {
      assert.notEqual(buildVersion(), sha);
      assert.equal(
        isNewerVersion('v2.1.0', sha), false,
        `sanity: ${sha} really does defeat the comparison, which is why we must not stamp it`,
      );
    }
  });

  test('falls back to 0.0.0, not a SHA, when VERSION cannot be read', () => {
    // 0.0.0 is older than every release, so a bad read OVER-notifies. A SHA
    // never notifies at all. Only one of those failure modes is recoverable by
    // the user, so the fallback is chosen deliberately.
    const fallback = buildVersion(tmpRoot('garbage'));
    assert.equal(fallback, '0.0.0');
    assert.equal(isNewerVersion('v2.1.0', fallback), true, 'still sees updates');
  });
});

describe('both deploy paths stamp the same source', () => {
  // These were TEXT assertions over the source of setup.mjs and update.mjs. A
  // Gate 3 review defeated them by re-introducing both original bugs under
  // different function names — `pkgVersion()` instead of `readVersion()`,
  // `String(head)` instead of `head` — and got a fully green 79-test suite
  // while every install stamped 0.0.0 from a gitignored file and every update
  // stamped a SHA.
  //
  // A regex over source cannot survive a rename. So both commands now build
  // their bindings through one exported function, and these assertions call it
  // and inspect what BUILD_VERSION actually holds. To break this you have to
  // change the value, not the spelling.
  const fakeState = {
    databaseId: 'db-1', firebaseApiKey: 'k', firebaseProjectId: 'p',
    dashboardUrl: 'https://example.test', allowedOrigins: 'https://example.test',
    sessionSecret: 'x'.repeat(32),
  };
  const bindingNamed = (name, opts) =>
    workerBindings(fakeState, opts).find((b) => b.name === name);

  test('BUILD_VERSION is exactly what version.mjs decided', () => {
    assert.equal(bindingNamed('BUILD_VERSION').text, buildVersion());
  });

  test('BUILD_VERSION is a semver, never a git SHA', () => {
    const stamped = bindingNamed('BUILD_VERSION').text;
    assert.match(stamped, /^\d{1,3}\.\d{1,3}\.\d{1,3}$/);
    for (const sha of ['a1b2c3d', '3e2db37', '9f5d87c', '755dd1e']) {
      assert.notEqual(stamped, sha);
    }
  });

  test('a broken VERSION still yields a stampable value, not undefined', () => {
    // Zero-state: the binding must always exist and always be a string, or the
    // Cloudflare deploy fails with a far less obvious error than a wrong version.
    const b = bindingNamed('BUILD_VERSION', { repoRoot: tmpRoot('garbage') });
    assert.equal(typeof b.text, 'string');
    assert.equal(b.text, '0.0.0');
  });

  test('the secret stays secret_text so it is hidden in the dashboard', () => {
    assert.equal(bindingNamed('SESSION_SECRET').type, 'secret_text');
  });

  test('a self-hosted worker is never handed an operator address', () => {
    // TELEGRAM_PROXY empty on purpose — the managed value points at our relay.
    assert.equal(bindingNamed('TELEGRAM_PROXY').text, '');
    for (const b of workerBindings(fakeState)) {
      if (typeof b.text === 'string') {
        assert.ok(!/daemonclient\.uz|sadrikov49/.test(b.text), `${b.name} carries an operator address`);
      }
    }
  });
});
