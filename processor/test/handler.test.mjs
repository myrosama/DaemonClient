// Smoke test for the processor's Web-standard handler.
//
// Its real job is to prove two things that only bite at deploy time otherwise:
//   1. The module imports and runs under plain Node.js — which is exactly what
//      Vercel's Node.js runtime provides. If this passes locally, the Node
//      deploy serves the same handler. (Edge runtime was dropped because the
//      libheif WASM bundle exceeds the ~1 MB Edge cap on the free plan.)
//   2. The default export is the `{ fetch }` object form Vercel's Node runtime
//      dispatches — so a future change back to a bare `export default function`
//      (the Edge convention) or to `runtime: 'edge'` fails here, loudly.
//
// Run: `npm test` in processor/ (needs `npm install` first — it imports the
// libheif/jpeg WASM deps at module load, the same as a real deploy).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import mod, { handler } from '../api/convert.js';
import * as ns from '../api/convert.js';

test('default export is the Web `{ fetch }` form Vercel Node dispatches', () => {
  assert.equal(typeof mod, 'object');
  assert.equal(typeof mod.fetch, 'function');
  assert.equal(mod.fetch, handler, 'default.fetch must be the same handler');
});

test('no `config` export exists — the file must not opt back into the edge runtime', () => {
  // `export const config = { runtime: 'edge' }` would put this back on the Edge
  // runtime, which is not what serves the { fetch } form and is the wrong runtime
  // for a CPU-heavy WASM decode. Guarding the absence of the export catches that
  // directly (the default-export shape check above does not).
  assert.equal(ns.config, undefined);
});

test('GET /health identifies the processor and advertises HEIC only', async () => {
  const res = await handler(new Request('https://example.com/health'));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.service, 'daemonclient-processor');
  assert.equal(body.capabilities.heicThumbnail, true);
  // No video capability is claimed — the function is HEIC-only, and the docs
  // must not promise video thumbnails.
  assert.equal(body.capabilities.videoPoster, undefined);
});

test('POST without a bearer token is rejected before any decode', async () => {
  const res = await handler(
    new Request('https://example.com/convertHeicThumbnail', {
      method: 'POST',
      body: new Uint8Array([1, 2, 3]),
    }),
  );
  assert.equal(res.status, 401);
});

test('the { fetch } entry routes identically to the named handler', async () => {
  const res = await mod.fetch(new Request('https://example.com/health'));
  assert.equal(res.status, 200);
});
