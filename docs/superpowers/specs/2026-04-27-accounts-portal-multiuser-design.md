# Accounts Portal Multi-User Design

## Overview

Redesign accounts.daemonclient.uz as the central account management hub for DaemonClient ecosystem (Photos + Drive). New users sign up here, go through automated Telegram bot/channel setup, and manage their account.

## Architecture

### User Flow
1. **Sign up** at accounts.daemonclient.uz (email + password via Firebase Auth)
2. **Automated Telegram setup** — Render backend creates bot + channel via userbots
3. **Ownership transfer** — User starts bot, joins channel, backend transfers ownership
4. **Cloudflare Worker setup** — User provides Cloudflare API token, we deploy their worker
5. **Dashboard** — Manage services (Photos, Drive), profile, security

### Pages
- `/login` — Sign in
- `/signup` — Create account
- `/setup` — Telegram bot/channel setup (automated + manual)
- `/setup/ownership` — Bot start + channel join + ownership transfer
- `/setup/cloudflare` — Cloudflare Worker deployment
- `/dashboard` — Service cards (Photos, Drive) with stats
- `/profile` — Name, email, avatar
- `/security` — Password change, activity log, sessions

### Tech Stack (unchanged)
- React 19 + React Router 7
- Tailwind CSS 3.4 with existing Linear-style dark theme
- Firebase Auth + Firestore
- Framer Motion for animations
- Vite build → Firebase Hosting

### Design System
- Background: #0D0E11
- Surface: #1C1D22
- Purple accent: #5E6AD2 → #7C3AED hover
- Text: #FAFAFA primary, #A1A1AA secondary
- Font: Inter, -apple-system
- No AI-looking design — clean, Linear/Vercel inspired

### Setup Flow (copied from Drive frontend)
- `SetupView` — Automated setup (POST to Render /startSetup) + Manual setup option
- `OwnershipView` — Step 1: Start bot, Step 2: Join channel, Step 3: Finalize transfer
- Both use existing Render backend at daemonclient-elnj.onrender.com

### Cloudflare Setup (new)
- User provides Cloudflare API token + account ID
- We deploy the immich-api-shim worker to their account
- Store worker URL in Firestore config

### Auth Flow
- Firebase Auth for signup/login
- Session cookie via auth.daemonclient.uz (HMAC-signed, domain-wide)
- Cross-subdomain SSO via .daemonclient.uz cookie
