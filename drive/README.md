# drive — the Drive web app

Deployed to `drive.daemonclient.uz`. React + Vite + Tailwind. Not a fork —
unlike Photos, this is ours from scratch.

General file storage on top of the same per-user Telegram channel Photos uses:
folders, uploads of any size, previews, search, and a WebDAV endpoint that lets
the whole thing mount as a normal drive in Windows Explorer, macOS Finder, or
any file manager.

## What is different about Drive

**Drive is genuinely zero-knowledge.** The AES-256-GCM key is derived in the
browser from a password the user sets, and it never leaves. The worker stores
metadata and ciphertext, and cannot read a file even in principle.

Photos, by contrast, encrypts on the user's own worker — which is what lets it
generate thumbnails, extract EXIF, and deduplicate. The two use **separate key
material**: Drive's lives under `drive_zke`, Photos' under `zke_password`.

The one exception is WebDAV. A file manager cannot decrypt, so the worker
decrypts on the way out for that path only.

## Layout

| File | What it is |
|---|---|
| `src/App.jsx` | the application — file tree, uploads, previews, sharing |
| `src/LandingPage.jsx` | the marketing page shown to signed-out visitors |
| `src/crypto.js` | PBKDF2 + AES-GCM in the browser |
| `src/manifest-sync.js` | keeps the local chunk manifest in step with the worker |
| `src/idb-store.js` | IndexedDB cache |
| `src/api.js` | worker client; `VITE_API_BASE` overrides the endpoint for self-host builds |
| `public/sw.js` | service worker — fetches chunks straight from Telegram and decrypts locally |

## Running it

```bash
npm install
npm run dev
npm run build     # what CI runs
```

Self-host build: `VITE_SELF_HOST=1 VITE_API_BASE=<their worker> npm run build`.

## Known duplication

`src/crypto.js` and the chunking in `src/App.jsx` are independent
reimplementations of what the worker and the Photos app also do — the storage
primitive exists four times across this repository, and `19 * 1024 * 1024`
appears twice in `App.jsx` alone. A bug in chunking has to be fixed in every
copy. Consolidating this is the most valuable refactor available; see
[../docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md#known-sharp-edges).
