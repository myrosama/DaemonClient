// Building the worker bundle from source.
//
// The repo ships TypeScript, and Cloudflare's upload API wants one JavaScript
// module. wrangler already knows how to produce exactly that, and it is a
// dependency of immich-api-shim, so we drive it rather than shipping a second
// bundler that could disagree with what the maintainers build and test.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export async function buildWorkerBundle(repoRoot) {
  const shimDir = path.join(repoRoot, 'immich-api-shim');
  const outDir = path.join(shimDir, 'dist');
  const outFile = path.join(outDir, 'index.js');

  if (!fs.existsSync(path.join(shimDir, 'node_modules'))) {
    throw new Error('immich-api-shim/node_modules is missing — run "npm install" in that folder first');
  }

  await run('npx', ['wrangler', 'deploy', '--dry-run', '--outdir', 'dist'], {
    cwd: shimDir,
    maxBuffer: 32 * 1024 * 1024,
    // A build should never wait on an interactive login prompt.
    env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' },
  });

  if (!fs.existsSync(outFile)) throw new Error('the build produced no dist/index.js');
  return fs.readFileSync(outFile, 'utf8');
}

/** The canonical schema, read from the deployment service so self-hosted
 *  installs and managed ones always create identical tables. */
export function readMigrationSql(repoRoot) {
  const source = path.join(repoRoot, 'deployment-service', 'src', 'index.ts');
  const text = fs.readFileSync(source, 'utf8');

  const grab = (name) => {
    const start = text.indexOf(`const ${name} = \``);
    if (start < 0) return '';
    const from = text.indexOf('`', start) + 1;
    const to = text.indexOf('`', from);
    return to > from ? text.slice(from, to) : '';
  };

  const photos = grab('MIGRATION_SQL');
  if (!photos) throw new Error('could not read MIGRATION_SQL from deployment-service');
  const drive = grab('DRIVE_MIGRATION_SQL');

  // The users table exists only in self-hosted installs (managed accounts live
  // in Firebase), so it is defined here rather than in the shared schema.
  const users = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  passwordHash TEXT NOT NULL,
  name TEXT,
  isAdmin INTEGER DEFAULT 0,
  createdAt TEXT NOT NULL,
  updatedAt TEXT
);
CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT
);`;

  return [photos, drive, users].filter(Boolean).join('\n');
}
