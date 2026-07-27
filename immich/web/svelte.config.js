import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import dotenv from 'dotenv';

dotenv.config({ quiet: true });

process.env.PUBLIC_IMMICH_BUY_HOST = process.env.PUBLIC_IMMICH_BUY_HOST || 'https://buy.immich.app';
process.env.PUBLIC_IMMICH_PAY_HOST = process.env.PUBLIC_IMMICH_PAY_HOST || 'https://pay.futo.org';
// The worker the Photos app talks to before it knows the user's per-user worker
// URL (pre-login server config, and the login POST itself). Hosted builds use the
// shared entry point; a self-hosted build sets this to the operator's OWN worker.
//
// Fail SAFE, not open: a self-hosted build (PUBLIC_SELF_HOST=1) that forgets to
// set the URL must NOT silently default to our host — that would send the user's
// email+password login POST to us. So the hosted default only applies when this is
// NOT a self-hosted build; a self-hosted build with the URL unset gets '' (same as
// Drive/accounts-portal), which breaks obviously against its own origin instead of
// leaking to us. `$env/static/public` still always has a (possibly empty) value.
process.env.PUBLIC_DAEMONCLIENT_WORKER_URL =
  process.env.PUBLIC_DAEMONCLIENT_WORKER_URL ||
  (process.env.PUBLIC_SELF_HOST === '1' ? '' : 'https://api.daemonclient.uz');
// The Firebase project this install authenticates against — shown in the HEIC
// processor setup so the user sets FIREBASE_PROJECT_ID on their own processor to
// match (the processor verifies each token's `aud` against it). Public, not a
// secret. Hosted = the managed project; a self-host build sets its own.
process.env.PUBLIC_DAEMONCLIENT_FIREBASE_PROJECT_ID =
  process.env.PUBLIC_DAEMONCLIENT_FIREBASE_PROJECT_ID ||
  (process.env.PUBLIC_SELF_HOST === '1' ? '' : 'daemonclient-c0625');

/** @type {import('@sveltejs/kit').Config} */
const config = {
  compilerOptions: {
    // TODO pending `@immich/ui` to enable it
    // runes: true,
  },
  preprocess: vitePreprocess(),
  kit: {
    version: {
      name: process.env.IMMICH_BUILD || '1.0.0',
    },
    paths: {
      relative: false,
    },
    adapter: adapter({
      fallback: 'app.html',
      precompress: true,
    }),
    alias: {
      $lib: 'src/lib',
      '$lib/*': 'src/lib/*',
      $tests: 'src/../tests',
      '$tests/*': 'src/../tests/*',
      '@test-data': 'src/test-data',
      $i18n: '../i18n',
      'chromecast-caf-sender': './node_modules/@types/chromecast-caf-sender/index.d.ts',
    },
  },
};

export default config;
