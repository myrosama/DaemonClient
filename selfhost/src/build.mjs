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

// The schema used to be recovered here, by scraping the template literal out of
// `deployment-service/src/index.ts` with string indexes. It now lives in
// `schema/schema.mjs`, which the deployment service imports too — so a
// self-hosted install and a hosted one create the same tables by construction
// rather than by two definitions happening to agree. Import it directly; the
// scraper is gone on purpose and should not come back.
