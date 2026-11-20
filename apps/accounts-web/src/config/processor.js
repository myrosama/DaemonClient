// Config for the optional HEIC-processor onboarding step.
//
// A HEIC photo is the one format Telegram will not thumbnail, so without a
// converter iPhone photos land in the grid with no thumbnail until they are
// healed. The converter is a tiny free serverless function each user deploys to
// THEIR OWN Vercel account (repo `processor/`), pinned to their own account —
// the user's plaintext photo bytes must never reach shared infrastructure.

// The deployment-service brokers the attach: the browser only holds a Firebase
// ID token, but the user's worker authenticates with its own signed session, so
// the service mints one and calls the worker's POST /api/server/processor (the
// single validator). Same host as the Cloudflare OAuth exchange.
import { DEPLOYMENT_WORKER } from './cloudflareOauth'
export const PROCESSOR_ATTACH_ENDPOINT = `${DEPLOYMENT_WORKER}/processor`

// A one-click Vercel "Deploy" of the processor from the public repo. Vercel can
// pre-fill env var NAMES but never values (by design), so the step shows the
// user the two values to paste: FIREBASE_PROJECT_ID and their OWNER_UID.
const PROCESSOR_REPO_URL =
  import.meta.env.VITE_PROCESSOR_REPO_URL || 'https://github.com/myrosama/DaemonClient'

export const PROCESSOR_DEPLOY_URL =
  'https://vercel.com/new/clone' +
  `?repository-url=${encodeURIComponent(PROCESSOR_REPO_URL)}` +
  '&root-directory=processor' +
  '&project-name=daemonclient-processor' +
  '&repository-name=daemonclient-processor' +
  '&env=FIREBASE_PROJECT_ID,OWNER_UID' +
  `&envDescription=${encodeURIComponent('Copy both values from the setup page — they pin this converter to only YOU')}`
