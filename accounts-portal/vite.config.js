import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// Building this portal for your own deployment? Set VITE_SELF_HOST=1 and the
// variables below. The check exists because the failure it prevents is nasty:
// without it, a missing variable falls back to the hosted service's Firebase
// project, the build succeeds, and you only discover on the deployed site that
// you are signing in against somebody else's backend. Better to stop here.
const SELF_HOST_REQUIRED = [
  ['VITE_FIREBASE_API_KEY', 'Web API key from your Firebase project settings'],
  ['VITE_FIREBASE_AUTH_DOMAIN', 'usually <project-id>.firebaseapp.com'],
  ['VITE_FIREBASE_PROJECT_ID', 'your Firebase project id'],
  ['VITE_API_BASE', 'your worker URL, e.g. https://daemonclient-abc.you.workers.dev'],
]

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')

  if (env.VITE_SELF_HOST === '1') {
    const missing = SELF_HOST_REQUIRED.filter(([name]) => !env[name])
    if (missing.length) {
      const list = missing.map(([name, hint]) => `  ${name}  — ${hint}`).join('\n')
      throw new Error(
        `\nThis is a self-hosted build (VITE_SELF_HOST=1) but these are not set:\n\n${list}\n\n` +
        `Put them in accounts-portal/.env, or let the setup CLI do it:\n` +
        `  node selfhost/bin/daemonclient.mjs dashboard\n\n` +
        `Refusing to build, because the missing values would silently fall back\n` +
        `to the hosted service's Firebase project.\n`,
      )
    }
  }

  return {
    plugins: [react()],
    server: { port: 5174 },
  }
})
