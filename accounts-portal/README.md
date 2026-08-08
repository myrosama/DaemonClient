# accounts-portal — sign-up, setup wizard, dashboard

Deployed to `accounts.daemonclient.uz`. React + Vite + Tailwind.

Three jobs:

1. **Sign up and sign in.** Firebase Auth, gated by Cloudflare Turnstile.
2. **The setup wizard.** Walks a new user through creating their Telegram bot
   and channel, connecting Cloudflare, and provisioning their worker and
   database — then hands ownership of the bot and channel to them.
3. **The dashboard.** Storage used, real photo counts and recent thumbnails,
   the links into Photos and Drive, and the account's security controls.

## Layout

| Path | What it is |
|---|---|
| `src/App.jsx` | the whole app — routing, auth, dashboard, setup. Large, and the place most changes land |
| `src/pages/SetupWorker.jsx` | the Cloudflare provisioning step |
| `src/pages/SetupProcessor.jsx` | the optional HEIC processor step |
| `src/components/Turnstile.jsx` | explicit-render Turnstile widget; tokens are single-use, so it exposes a reset |
| `src/components/TokenInput.jsx` | Cloudflare API token entry and validation |
| `src/components/DeploymentProgress.jsx` | live provisioning progress |
| `src/hooks/useWorkerSetup.ts` | the provisioning state machine |
| `src/config/firebase.js` | Firebase client config; reads `VITE_FIREBASE_*` for self-host builds |
| `src/icloud.css` | the card and wallpaper system — see the comment at the top before changing it |
| `src/assets/wallpaper.js` | the layered SVG wallpaper, inlined |

## Running it

```bash
npm install
npm run dev
npm run build     # what CI runs
```

## Self-host builds

The same app serves a self-hosted install, pointed at that person's own
infrastructure at build time:

```bash
VITE_SELF_HOST=1 \
VITE_API_BASE=<their worker> \
VITE_FIREBASE_API_KEY=… VITE_FIREBASE_AUTH_DOMAIN=… VITE_FIREBASE_PROJECT_ID=… \
VITE_PHOTOS_URL=… VITE_DRIVE_URL=… \
npx vite build --mode selfhost
```

`daemonclient web` does this for the user. A self-host build must never fall
back to an operator host — that is asserted at build time.

## The design

The dashboard's card and wallpaper system is copied verbatim from a reference,
not reinvented, and two details are load-bearing:

- the wallpaper is a **layered SVG** with its colour composited in
  `mix-blend-mode: hard-light`, which a plain CSS gradient cannot reproduce;
- the cards are **darker** than the wallpaper, not lighter. Contrast comes from
  dark translucent panels on a bright field. Light cards on a dark page have no
  contrast at all, which reads as flat.

`src/icloud.css` says the same thing at the point of use. Read it before
changing colours.
