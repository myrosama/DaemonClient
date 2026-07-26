// One schema, imported by both provisioners.
//
// The bug these tests exist to prevent has already happened once. The schema
// lived inline in `deployment-service/src/index.ts`; a second copy sat unused in
// `immich-api-shim/src/migrations.ts`; and the self-host CLI recovered the real
// one by scraping the TypeScript with string indexes. The two provisioning paths
// then diverged over the row that decides whether photos are encrypted, and
// nothing failed loudly enough to notice.
//
// So these tests assert the *shape*, not just today's contents: one module, both
// sides importing it, and no scraper anywhere on the live CLI path.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { MIGRATION_SQL, DRIVE_MIGRATION_SQL, splitStatements } from '../../schema/schema.mjs';

const REPO = path.join(import.meta.dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');

describe('the schema has exactly one definition', () => {
  test('the shared module really holds a schema (not an empty string)', () => {
    assert.match(MIGRATION_SQL, /CREATE TABLE photos \(/);
    assert.match(MIGRATION_SQL, /CREATE TABLE config \(/);
    assert.match(MIGRATION_SQL, /CREATE TABLE IF NOT EXISTS files \(/);
    assert.ok(splitStatements(MIGRATION_SQL).length > 10, 'splits into real statements');
  });

  test('the deployment service imports it instead of declaring its own', () => {
    const deploy = read('deployment-service/src/index.ts');
    assert.match(deploy, /import \{ MIGRATION_SQL \} from '\.\.\/\.\.\/schema\/schema\.mjs'/);
    // The literal it used to declare must be gone, or there are two again.
    assert.ok(!/const MIGRATION_SQL = `/.test(deploy), 'deployment service still declares a schema');
    assert.ok(!/const DRIVE_MIGRATION_SQL = `/.test(deploy), 'deployment service still declares the drive schema');
    // And it must still be the value that gets executed when provisioning.
    assert.match(deploy, /executeD1Query\([^)]*MIGRATION_SQL\)/);
  });

  test('the CLI imports it too, so both run byte-identical SQL', () => {
    for (const file of ['selfhost/src/commands/setup.mjs', 'selfhost/src/commands/update.mjs']) {
      const src = read(file);
      assert.match(src, /import \{ MIGRATION_SQL, splitStatements \} from '\.\.\/\.\.\/\.\.\/schema\/schema\.mjs'/,
        `${file} imports the shared schema`);
      assert.match(src, /splitStatements\(MIGRATION_SQL\)/, `${file} runs it`);
    }
  });

  test('nothing on the live CLI path scrapes the deployment service any more', () => {
    // deploy.mjs is excluded on purpose: it has zero importers — nothing in
    // bin/, src/ or test/ loads it — so its copy of the scraper cannot run. The
    // files listed here are the ones `daemonclient` actually executes.
    for (const file of [
      'selfhost/src/build.mjs',
      'selfhost/src/commands/setup.mjs',
      'selfhost/src/commands/update.mjs',
      'selfhost/src/commands/doctor.mjs',
    ]) {
      const src = read(file);
      assert.ok(!/deployment-service/.test(src.replace(/^\s*\/\/.*$/gm, '')),
        `${file} still reaches into deployment-service`);
      assert.ok(!/readMigrationSql/.test(src), `${file} still uses the scraper`);
    }
  });

  test('the never-executed second copy is gone', () => {
    assert.ok(!fs.existsSync(path.join(REPO, 'immich-api-shim/src/migrations.ts')),
      'immich-api-shim/src/migrations.ts is a second schema copy and must not return');
  });

  test('the drive migration stays a suffix of the full schema', () => {
    // /admin/force-update hands DRIVE_MIGRATION_SQL to workers provisioned
    // before Drive existed. If it drifts from the copy inside MIGRATION_SQL,
    // old and new installs get different Drive tables.
    assert.ok(MIGRATION_SQL.includes(DRIVE_MIGRATION_SQL),
      'DRIVE_MIGRATION_SQL is no longer contained in MIGRATION_SQL');
  });

  test('the schema seeds the key rows empty, which is why the CLI must fill them', () => {
    // This is the join between task 1.2b and task 1.3. If someone ever changes
    // the seed to hold real key material, that is a far bigger change than it
    // looks (identical keys for every install) and this test should stop them.
    assert.match(MIGRATION_SQL, /\('zke_password',''\),\('zke_salt',''\)/);
  });
});
