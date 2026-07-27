import firebase from 'firebase/compat/app'
import 'firebase/compat/auth'
import 'firebase/compat/firestore'
import 'firebase/compat/storage'

// Set VITE_SELF_HOST=1 when building this portal for your own deployment. It
// does one important thing: it removes the fallbacks below. Without it, a
// missing VITE_FIREBASE_* value silently falls back to the hosted service's
// project — so a self-hoster who mistyped one variable would end up signing in
// against someone else's Firebase and wondering why their account did not
// exist. Failing loudly at build time is the whole point.
export const IS_SELF_HOST = import.meta.env.VITE_SELF_HOST === '1'

const HOSTED_DEFAULTS = {
  apiKey: 'AIzaSyBH5diC5M7MnOIuOWaNPmOB1AV6uJVZyS8',
  authDomain: 'daemonclient-c0625.firebaseapp.com',
  databaseURL: 'https://daemonclient-c0625-default-rtdb.firebaseio.com',
  projectId: 'daemonclient-c0625',
  storageBucket: 'daemonclient-c0625.firebasestorage.app',
  messagingSenderId: '424457448611',
  appId: '1:424457448611:web:bea9f7673fb40f137de316',
  measurementId: 'G-72V5NJ7F2C',
}

function read(name, fallbackKey) {
  const value = import.meta.env[`VITE_FIREBASE_${name}`]
  if (value) return value
  if (IS_SELF_HOST) {
    throw new Error(
      `VITE_FIREBASE_${name} is not set. A self-hosted build must point at your own ` +
      `Firebase project — see docs/SELF_HOSTING.md. (Refusing to fall back to the hosted project.)`,
    )
  }
  return HOSTED_DEFAULTS[fallbackKey]
}

const firebaseConfig = {
  apiKey: read('API_KEY', 'apiKey'),
  authDomain: read('AUTH_DOMAIN', 'authDomain'),
  projectId: read('PROJECT_ID', 'projectId'),
  // Optional everywhere: only used by features a self-hosted install does not need.
  databaseURL: import.meta.env.VITE_FIREBASE_DATABASE_URL || (IS_SELF_HOST ? undefined : HOSTED_DEFAULTS.databaseURL),
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || (IS_SELF_HOST ? undefined : HOSTED_DEFAULTS.storageBucket),
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || (IS_SELF_HOST ? undefined : HOSTED_DEFAULTS.messagingSenderId),
  appId: import.meta.env.VITE_FIREBASE_APP_ID || (IS_SELF_HOST ? undefined : HOSTED_DEFAULTS.appId),
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID || (IS_SELF_HOST ? undefined : HOSTED_DEFAULTS.measurementId),
}

// The Firebase project id this portal signs in against. The HEIC processor a
// user deploys must be pinned to THIS project (FIREBASE_PROJECT_ID) so it only
// trusts tokens minted here — the onboarding step shows it to the user to paste
// into their Vercel deploy.
export const FIREBASE_PROJECT_ID = firebaseConfig.projectId

// The API this portal talks to. Hosted builds use the shared entry point;
// a self-hosted build points at the operator's own worker.
export const API_BASE = (
  import.meta.env.VITE_API_BASE || (IS_SELF_HOST ? '' : 'https://api.daemonclient.uz')
).replace(/\/+$/, '')

// Where the two services live. Self-hosters set these to wherever they deployed
// the Photos and Drive apps; blank means "not deployed yet" and the dashboard
// shows the card as unavailable rather than linking somewhere wrong.
export const PHOTOS_URL = import.meta.env.VITE_PHOTOS_URL || (IS_SELF_HOST ? '' : 'https://photos.daemonclient.uz')
export const DRIVE_URL = import.meta.env.VITE_DRIVE_URL || (IS_SELF_HOST ? '' : 'https://drive.daemonclient.uz')

if (!firebase.apps.length) {
  firebase.initializeApp(firebaseConfig)
}

export const auth = firebase.auth()
export const db = firebase.firestore()
export const storage = firebase.storage()
export default firebase
