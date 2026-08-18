#!/usr/bin/env node
// Every widget in the UI kit, on one screen, so it can be judged by eye.
//
//   node scripts/ui-demo.mjs
//
// BUILD_ORDER P5 asks for exactly this: "a demo script exercising every widget,
// run by eye once". It is not a test — the tests are in `test/ui-kit.test.mjs`
// and assert behaviour. This is for the things a test cannot judge: whether the
// spacing reads well, whether the wording sounds like a person, whether a
// failed step is obviously a failed step.
//
// It also stands in for the wizard until P15 rewrites `setup.mjs`, so the kit
// can be changed with something to look at.
//
// Answer nothing and press Ctrl-C at any point: that is the cancellation path,
// and seeing it is the point of having it.

import {
  intro, outro, note, log, text, password, confirm, select,
  spinner, taskList, setResumeHint, interactiveProblem,
} from '../src/ui-kit.mjs';

const problem = interactiveProblem();
if (problem) {
  console.error(problem);
  console.error('Run this from a terminal: node scripts/ui-demo.mjs');
  process.exit(1);
}

setResumeHint('node scripts/ui-demo.mjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

intro('DaemonClient · UI kit');

note([
  'Nothing here talks to a real service.',
  'Press Ctrl-C at any prompt to see the cancellation path.',
], 'This is a demo');

const name = await text('What should we call this install?', {
  placeholder: 'my-cloud',
  validate: (v) => (/^[a-z0-9-]+$/.test(v) ? undefined : 'Lowercase letters, digits and hyphens only.'),
});

const token = await password('Paste a token (it is discarded immediately)');
log.info(`Read ${token.length} characters, and none of them were echoed.`);

const where = await select('Where should this live?', [
  { value: 'cf', label: 'Cloudflare Workers', hint: 'free tier, no card' },
  { value: 'other', label: 'Somewhere else', hint: 'not supported yet' },
]);

const proceed = await confirm(`Set up "${name}" on ${where === 'cf' ? 'Cloudflare' : 'somewhere else'}?`);
if (!proceed) {
  outro('Nothing was done.');
  process.exit(0);
}

const s = spinner('Checking the token');
await sleep(700);
s.update('Reading your account');
await sleep(700);
s.succeed('Token looks good');

await taskList([
  { title: 'Creating the database', task: async () => { await sleep(600); return 'Database created'; } },
  { title: 'Running migrations', task: async (msg) => { await sleep(400); msg('3 of 7'); await sleep(600); return 'Schema at 1.2.0'; } },
  { title: 'Already deployed', task: async () => 'skipped', enabled: false },
  { title: 'Deploying the worker', task: async () => { await sleep(900); return 'Worker deployed'; } },
]);

log.warn('This is what a warning looks like.');
log.error('And this is an error that did not stop anything.');

// The failure path, on purpose — the most important thing to judge by eye,
// because it is what people actually see when something goes wrong.
try {
  await taskList([
    { title: 'Attaching the image processor', task: async () => { await sleep(700); throw new Error('Vercel returned 403'); } },
  ]);
} catch (err) {
  log.error(err.message);
}

note([
  'Photos   https://example-photos.web.app',
  'Drive    https://example-drive.web.app',
], 'Your cloud is live');

outro('Done — this was a demo, nothing was created.');
