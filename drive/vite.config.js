import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

// Multi-page build:
//   index.html → the static marketing LANDING (served at `/` on drive.daemonclient.uz)
//   app.html   → the React SPA (served at `/login`, `/dashboard` via Firebase rewrites)
// The landing has no module script, so Vite leaves it as a static page (its inline
// shard-canvas animation + Google Fonts stay untouched); only app.html loads main.jsx.
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        app: resolve(__dirname, 'app.html'),
      },
    },
  },
})
