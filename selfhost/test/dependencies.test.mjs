// The supply chain of a script strangers pipe into a shell.
//
// This package used to have a hard rule: NO dependencies, enforced by a CI
// step. The reason was that `selfhost/` ran straight from a bare clone, so a
// dependency meant an `npm install` that could fail behind a corporate proxy
// or on a fresh machine before the user ever saw a prompt.
//
// `install.sh` changed that — it runs `npm ci` before any of our code executes,
// so dependencies are now legal. But the RISK the old rule was really guarding
// against did not go away, it just changed shape: every package here is code
// that runs on a stranger's machine, fetched by a command they were told to
// pipe into a shell, at the moment they are handing over a Cloudflare API token
// and a Telegram bot token. So the rule is replaced rather than deleted.
//
// Nothing here is a style preference. Each test names the failure it prevents.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const HERE = path.join(import.meta.dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(HERE, 'package.json'), 'utf8'));
const lockPath = path.join(HERE, 'package-lock.json');

// Doubling the current tree. Chosen so ordinary patch churn passes and anything
// that meaningfully widens the surface has to be a deliberate act: raising this
// number is a diff a reviewer will ask about, which is the entire point.
const BUDGET = 12;

describe('the lockfile', () => {
  test('exists — install.sh runs `npm ci`, which refuses without one', () => {
    // Not a nicety. `npm ci` exits non-zero with no lockfile, so a missing one
    // does not degrade to a slower install; it stops every new user at the
    // hand-over step, after Node has already been downloaded.
    assert.ok(fs.existsSync(lockPath), 'selfhost/package-lock.json must be committed');
  });

  test('agrees with package.json about every dependency', () => {
    // `npm ci` also fails when the two disagree. That is a one-line diff to
    // package.json away, and the failure surfaces on a stranger's machine
    // rather than here.
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    const root = lock.packages?.[''] ?? {};
    assert.deepEqual(root.dependencies ?? {}, pkg.dependencies ?? {},
      'run `npm install` and commit the lockfile');
  });
});

describe('the size of what we install on someone else’s machine', () => {
  test(`stays within ${BUDGET} packages`, () => {
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    const count = Object.keys(lock.packages ?? {}).filter((k) => k !== '').length;
    assert.ok(count <= BUDGET,
      `selfhost installs ${count} packages (budget ${BUDGET}). Raising this is allowed, but say why in the commit — every one of these runs on a stranger's machine while they paste in a Cloudflare token.`);
  });

  test('has no build scripts, which run before anyone can inspect anything', () => {
    // A package with an install script executes arbitrary code during
    // `npm ci` — before the wizard has printed its first word, and on a
    // machine whose owner ran a one-line curl command.
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    const withScripts = Object.entries(lock.packages ?? {})
      .filter(([name, meta]) => name !== '' && meta.hasInstallScript)
      .map(([name]) => name);
    assert.deepEqual(withScripts, [],
      'these run arbitrary code at install time on a stranger’s machine');
  });
});

describe('what we ask npm to resolve', () => {
  test('every dependency is pinned to an exact version', () => {
    // install.sh promises that two people running the same command on the same
    // day get the same bytes — it refuses to clone `main` for exactly this
    // reason. A `^` range in here would quietly break that promise on the
    // other side of the hand-over, where nobody is looking.
    const ranged = Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })
      .filter(([, range]) => !/^\d+\.\d+\.\d+$/.test(String(range)));
    assert.deepEqual(ranged, [],
      'use `npm install --save-exact`; a range means two users can get different code');
  });

  test('declares no version of its own', () => {
    // There is ONE version number in this project and it is the tracked
    // `VERSION` file at the repo root — that is the whole thesis of the P11
    // work. This package.json used to carry `"version": "1.0.0"`, a third
    // number that agreed with nothing and that `BUILD_VERSION` had already
    // been caught reading. A private package does not need one.
    assert.equal(pkg.version, undefined,
      'the version lives in the root VERSION file; see selfhost/src/version.mjs');
    assert.equal(pkg.private, true, 'and this package is not published');
  });
});
