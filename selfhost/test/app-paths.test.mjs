// The web apps the CLI builds must exist where it looks for them.
//
// The 2026-11-20 regroup moved accounts-portal/, immich/web/ and drive/ under
// apps/, and `daemonclient web` and `daemonclient dashboard` kept the old paths:
// both failed on a fresh clone and no test noticed. These tests pin every
// folder the commands use to a real package in the repository.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APPS } from '../src/commands/web.mjs';
import { PORTAL } from '../src/commands/dashboard.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('every app `daemonclient web` builds is a package in the repo', () => {
  for (const [name, app] of Object.entries(APPS)) {
    const pkg = path.join(ROOT, app.dir, 'package.json');
    assert.ok(fs.existsSync(pkg), `${name}: no package.json at ${app.dir}`);
  }
});

test('`daemonclient dashboard` points at the accounts web app', () => {
  assert.ok(fs.existsSync(path.join(PORTAL, 'package.json')), `no package.json at ${PORTAL}`);
});
