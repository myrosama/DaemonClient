// A function nobody calls.
//
// This repo has shipped that three times now, and each one cost real debugging:
// `registerSubdomain` was complete, correct and called from nowhere, so a fresh
// Cloudflare account finished setup with no address; `interactiveProblem` was
// written for a case it then never guarded; and `explainFirebaseError` outlived
// the rewrite that replaced its only caller, leaving a second, subtly different
// error vocabulary sitting next to the live one.
//
// Every time, every behavioural test passed — because the dead code was fine.
// What was wrong was that nothing reached it, and a grep for the symbol found
// it and looked satisfied. That is the specific way a grep starts lying to you.
//
// So: a declared function whose name appears exactly once in the whole package
// is a function nobody calls.
//
// KNOWN BLIND SPOT: a function with a short, common name (`load`, `save`,
// `redact`) will collide with unrelated words elsewhere and never trip this,
// even when it is genuinely unreferenced. So this catches the distinctive
// names — which, going by the three that have actually bitten here, is the
// shape the real ones take. It is a net, not a proof.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');

function jsFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.mjs')) out.push(full);
    }
  };
  walk(dir);
  return out;
}

describe('nothing is declared and then left unreachable', () => {
  test('every declared function is referenced somewhere', () => {
    const files = [
      ...jsFiles(path.join(ROOT, 'src')),
      ...jsFiles(path.join(ROOT, 'test')),
      ...jsFiles(path.join(ROOT, 'bin')),
      ...jsFiles(path.join(ROOT, 'scripts')),
    ];
    const corpus = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');

    // Deliberately parked, not forgotten. Each line is a decision someone can
    // see and argue with in review, which is the point: adding to this list is
    // visible, letting dead code accumulate silently is not.
    const PARKED = new Set([
      // The one-button Cloudflare OAuth flow, blocked on the operator
      // registering an OAuth app (daemonclient-ops/docs/CLOUDFLARE_OAUTH.md).
      // The wizard pastes an API token instead, for now.
      'oauthPortBusy', 'wranglerStructured',
      // Written for the Pages deploy path in dashboard.mjs, which currently
      // calls `wrangler pages deploy` directly and lets it create the project.
      'ensurePagesProject',
      // Hostile-environment checks from the config hardening; the callers were
      // removed when setup stopped reading ambient env.
      'findHostileDotEnvFiles', 'findHostileAmbientVars',
    ]);

    const dead = [];
    for (const file of jsFiles(path.join(ROOT, 'src'))) {
      const body = fs.readFileSync(file, 'utf8');
      for (const m of body.matchAll(/^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm)) {
        const name = m[1];
        // Every mention anywhere in the package: its own declaration, plus any
        // call, import, re-export or test. One mention means the declaration
        // is the only one.
        const uses = corpus.match(new RegExp(`\\b${name}\\b`, 'g'))?.length ?? 0;
        if (uses <= 1 && !PARKED.has(name)) dead.push(`${path.relative(ROOT, file)} → ${name}()`);
      }
    }

    assert.deepEqual(dead, [],
      'declared but never referenced — delete it, or wire it up if it was meant to run');
  });
});
