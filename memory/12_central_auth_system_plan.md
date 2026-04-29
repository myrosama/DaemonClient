# DaemonClient Central Authentication System Implementation Plan

## Context

This plan addresses building a **Google Account-style central authentication system** for the DaemonClient ecosystem. Currently, DaemonClient has:
- **photos.daemonclient.uz** (Immich-based photo management)
- **app.daemonclient.uz** (Drive/file storage)
- Separate Firebase email/password auth in each service
- HMAC-signed session tokens (7-day expiry)
- Firestore for user data storage
- Cloudflare Workers for API proxying

**The Goal**: Create a unified auth system like Google Accounts where:
1. **accounts.daemonclient.uz** - Central login/signup portal with account dashboard (services overview, storage stats, activity logs)
2. **daemonclient.uz** - Landing page showcasing all services with perfect SEO
3. OAuth-style redirect flow - services redirect to accounts portal for auth, then redirect back
4. Cross-domain session tokens that work across all subdomains
5. Enhanced CLI with Claude Code-inspired terminal UI

**User Vision** (from screenshot):
- Unified login/signup process that creates Telegram bot infrastructure behind the scenes
- Perfect, non-AI-looking interface design
- Multi-service ecosystem with single account (Photos, Drive, future services)
- SEO-optimized landing page
- Zero-cost infrastructure (Firebase free tier + Cloudflare Workers free tier)

## Folder Structure

We will create **three new projects** in separate folders to avoid mixing with existing code:

```
DaemonClient/
├── accounts-portal/              # NEW: Central auth & account management UI
│   ├── src/
│   │   ├── pages/
│   │   │   ├── Login.jsx
│   │   │   ├── Signup.jsx
│   │   │   ├── Dashboard.jsx    # Account overview
│   │   │   ├── Profile.jsx
│   │   │   └── Security.jsx     # Activity log
│   │   ├── components/
│   │   │   ├── ServiceCard.jsx
│   │   │   ├── StorageWidget.jsx
│   │   │   └── ActivityLog.jsx
│   │   ├── utils/
│   │   │   ├── firebase.js
│   │   │   └── auth.js
│   │   └── App.jsx
│   ├── public/
│   ├── package.json
│   ├── vite.config.js
│   └── firebase.json
│
├── landing-page/                 # NEW: Public marketing site (daemonclient.uz)
│   ├── src/
│   │   ├── pages/
│   │   │   ├── Home.jsx
│   │   │   ├── Features.jsx
│   │   │   └── About.jsx
│   │   ├── components/
│   │   │   ├── Hero.jsx
│   │   │   ├── ServiceShowcase.jsx
│   │   │   └── Footer.jsx
│   │   └── App.jsx
│   ├── public/
│   │   ├── robots.txt
│   │   ├── sitemap.xml
│   │   └── og-image.png
│   ├── package.json
│   ├── vite.config.js
│   └── firebase.json
│
├── auth-worker/                  # NEW: OAuth redirect handler (Cloudflare Worker)
│   ├── src/
│   │   ├── index.ts             # Main OAuth flow logic
│   │   ├── session.ts           # Session token creation/validation
│   │   └── redirect.ts          # Cross-domain redirect logic
│   ├── wrangler.toml
│   └── package.json
│
├── daemon-cli/                   # EXISTING: CLI - will enhance UI
│   └── src/daemonclient/
│       └── cli.py               # Current: basic Typer + Rich
│
├── frontend/                     # EXISTING: Drive app (minimal changes)
├── immich/                       # EXISTING: Photos app (minimal changes)
└── immich-api-shim/             # EXISTING: API worker (extend for global scope)
```

## Architecture Overview

```
USER JOURNEY (First Time):
┌────────────────┐
│ daemonclient.uz│ Landing page → "Get Started" button
└───────┬────────┘
        ↓ Redirects to accounts portal
┌──────────────────────┐
│ accounts.            │ Signup → Bot creation (existing backend)
│ daemonclient.uz      │
│ /signup              │
└───────┬──────────────┘
        ↓ After setup completion
┌──────────────────────┐
│ Dashboard            │ Shows: Photos card, Drive card, Storage stats
│ /dashboard           │ Click "Open Photos" or "Open Drive"
└───────┬──────────────┘
        ↓ Redirects to service with session token
┌──────────────────────┐
│ photos.daemonclient.uz│ OR app.daemonclient.uz
│ (authenticated)       │
└────────────────────────┘

USER JOURNEY (Returning, Not Authenticated):
┌──────────────────────┐
│ photos.              │ Detects no session cookie
│ daemonclient.uz      │
└───────┬──────────────┘
        ↓ Redirects with return_url
┌──────────────────────┐
│ accounts.            │ Login form
│ daemonclient.uz      │
│ /login?return_url=…  │
└───────┬──────────────┘
        ↓ After Firebase auth
┌──────────────────────┐
│ auth.daemonclient.uz │ Worker creates session token
│ (Cloudflare Worker) │ Sets cross-domain cookie
└───────┬──────────────┘
        ↓ Redirects back
┌──────────────────────┐
│ photos.daemonclient.uz│ Now authenticated
└────────────────────────┘
```

**Session Token Flow**:
- Firebase Auth provides idToken (1 hour expiry) + refreshToken
- auth-worker creates HMAC-signed token: `{uid, email, idToken, refreshToken, exp, scope: 'global'}`
- Cookie set with `Domain=.daemonclient.uz` (all subdomains can read)
- Cookie options: `HttpOnly`, `Secure`, `SameSite=Lax`, `Max-Age=604800` (7 days)

## Tech Stack Decisions

**accounts-portal/** and **landing-page/**:
- React 19 + Vite (consistency with existing `frontend/`)
- Tailwind CSS (existing pattern)
- Framer Motion (existing pattern)
- React Router v7 (existing pattern)
- Firebase SDK (reuse existing config)

**landing-page/** SEO:
- Vite Static Site Generation (pre-render at build time)
- Inline critical CSS
- Generate sitemap.xml + robots.txt
- Structured data (JSON-LD)
- WebP images with fallbacks

**auth-worker/**:
- TypeScript + Cloudflare Workers (same as `immich-api-shim`)
- Reuse HMAC session token logic from `immich-api-shim/src/helpers.ts`

**daemon-cli/** enhancements:
- Keep Typer + Rich (current foundation)
- Add: `rich.panel`, `rich.progress`, `rich.live` for Claude Code-style UI
- Add: Custom themes with gradient borders, status indicators
- Add: Spinners, progress bars, live-updating status panels

## Firestore Schema Extensions

**New collections** (under `artifacts/default-daemon-client/users/{uid}/`):

```
config/
  └── account_settings           # NEW
      ├── displayName: string
      ├── avatarUrl: string
      ├── createdAt: timestamp
      └── lastLoginAt: timestamp

services/                        # NEW
  ├── photos/
  │   ├── enabled: true
  │   ├── lastAccessed: timestamp
  │   └── totalAssets: number
  └── drive/
      ├── enabled: true
      ├── lastAccessed: timestamp
      └── totalFiles: number

storage/                         # NEW
  ├── quotaBytes: 0 (unlimited)
  ├── usedBytes: number
  ├── photosBytes: number
  └── driveBytes: number

activity/                        # NEW: Immutable security logs
  └── {logId}/
      ├── timestamp: timestamp
      ├── action: "login" | "logout" | "service_access"
      ├── service: "photos" | "drive" | "accounts"
      ├── ipAddress: string (hashed)
      └── userAgent: string
```

**Firestore rules update**:
```javascript
match /artifacts/{appId}/users/{userId} {
  match /{document=**} {
    allow read, write: if request.auth != null && request.auth.uid == userId;
  }
  
  match /activity/{logId} {
    allow create: if request.auth != null && request.auth.uid == userId;
    allow read: if request.auth != null && request.auth.uid == userId;
    allow update, delete: if false; // Immutable
  }
}
```

## OAuth Redirect Flow Specification

**1. Service-Initiated Auth (photos or app)**:
```javascript
// Check for session cookie on page load
const token = getCookie('__session');
if (!token) {
  const returnUrl = encodeURIComponent(window.location.href);
  window.location.href = `https://accounts.daemonclient.uz/login?return_url=${returnUrl}`;
}
```

**2. Accounts Portal Login**:
```javascript
// After Firebase signInWithEmailAndPassword
const idToken = await user.getIdToken();
const returnUrl = new URLSearchParams(window.location.search).get('return_url') || '/dashboard';

// Call auth worker to create session
await fetch('https://auth.daemonclient.uz/create-session', {
  method: 'POST',
  body: JSON.stringify({ idToken, refreshToken: user.refreshToken, returnUrl })
});
```

**3. Auth Worker Session Creation**:
```typescript
// POST /create-session
// 1. Verify Firebase idToken
// 2. Create HMAC-signed session token
// 3. Set cookie: Domain=.daemonclient.uz, HttpOnly, Secure, SameSite=Lax
// 4. Log activity to Firestore
// 5. Return { redirectUrl }
```

**4. Logout Flow**:
```typescript
// GET /logout on auth-worker
// 1. Clear session cookie (Max-Age=0)
// 2. Redirect to daemonclient.uz landing page
```

## Implementation Work Units

Below are **20 independent work units** that can be built in parallel. Each unit is self-contained and can be implemented in an isolated git worktree.

**User Decision**: Build ALL 20 units in parallel for maximum speed. All agents will work simultaneously in isolated worktrees.

### Group A: Foundation (5 units)

1. **auth-worker: Session management endpoints**
   - Files: `auth-worker/src/index.ts`, `auth-worker/src/session.ts`
   - Task: Create `/create-session` and `/logout` endpoints
   - Copy HMAC logic from `immich-api-shim/src/helpers.ts`
   - Implement cross-domain cookie setting with `.daemonclient.uz` domain

2. **auth-worker: Firebase token verification**
   - Files: `auth-worker/src/firebase.ts`
   - Task: Implement `verifyFirebaseToken()` function
   - Call Firebase REST API: `identitytoolkit.googleapis.com/v1/accounts:lookup`
   - Extract uid, email from response

3. **auth-worker: Activity logging**
   - Files: `auth-worker/src/activity.ts`
   - Task: Write activity logs to Firestore on login/logout
   - Hash IP addresses (SHA-256 with salt)
   - Store: timestamp, action, service, ipAddress (hashed), userAgent

4. **auth-worker: Deployment config**
   - Files: `auth-worker/wrangler.toml`, `auth-worker/package.json`
   - Task: Configure Cloudflare Worker with TypeScript
   - Set environment variables: `SESSION_SECRET`, `FIREBASE_API_KEY`, `FIREBASE_PROJECT_ID`
   - Custom domain route: `auth.daemonclient.uz/*`

5. **Firestore schema migration**
   - Files: `scripts/migrate-firestore-schema.js` (new)
   - Task: Create script to add new collections for existing users
   - Add: `services/photos`, `services/drive`, `storage/`, `config/account_settings`
   - Update security rules in `firestore.rules`

### Group B: Accounts Portal UI (8 units)

6. **accounts-portal: Project setup**
   - Files: `accounts-portal/package.json`, `accounts-portal/vite.config.js`, `accounts-portal/firebase.json`
   - Task: Initialize React + Vite project with dependencies
   - Install: `firebase`, `react-router-dom@7`, `framer-motion`, `tailwindcss`, `lucide-react`
   - Configure Tailwind + Firebase hosting target

7. **accounts-portal: Login page**
   - Files: `accounts-portal/src/pages/Login.jsx`
   - Task: Email/password form with Firebase Auth integration
   - Handle `?return_url` query parameter
   - Call auth-worker `/create-session` endpoint after successful login
   - Redirect to returnUrl after session creation

8. **accounts-portal: Signup page**
   - Files: `accounts-portal/src/pages/Signup.jsx`
   - Task: Account creation form with Firebase `createUserWithEmailAndPassword`
   - Terms of use checkbox
   - Redirect to setup flow (reuse existing backend endpoint: `https://daemonclient-elnj.onrender.com/startSetup`)

9. **accounts-portal: Dashboard page**
   - Files: `accounts-portal/src/pages/Dashboard.jsx`, `accounts-portal/src/components/ServiceCard.jsx`
   - Task: Account overview with service cards
   - Fetch from Firestore: `services/photos`, `services/drive`, `storage/`
   - Display: last accessed timestamps, storage usage
   - Service cards link to photos.daemonclient.uz and app.daemonclient.uz

10. **accounts-portal: Storage widget**
    - Files: `accounts-portal/src/components/StorageWidget.jsx`
    - Task: Visual storage usage display (pie chart or progress bar)
    - Fetch from Firestore: `storage/usedBytes`, `storage/photosBytes`, `storage/driveBytes`
    - Show breakdown by service

11. **accounts-portal: Activity log page**
    - Files: `accounts-portal/src/pages/Security.jsx`, `accounts-portal/src/components/ActivityLog.jsx`
    - Task: Table showing last 20 login/logout events
    - Fetch from Firestore: `activity/` collection (ordered by timestamp desc)
    - Display: timestamp, action, service, IP (hashed), device info

12. **accounts-portal: Profile settings page**
    - Files: `accounts-portal/src/pages/Profile.jsx`
    - Task: Edit display name, upload avatar
    - Update Firestore: `config/account_settings`
    - Firebase Storage for avatar uploads (optional)

13. **accounts-portal: Routing and layout**
    - Files: `accounts-portal/src/App.jsx`, `accounts-portal/src/components/Layout.jsx`
    - Task: React Router v7 setup with routes
    - Routes: `/login`, `/signup`, `/dashboard`, `/profile`, `/security`
    - Protected routes (redirect to /login if not authenticated)

### Group C: Landing Page (3 units)

14. **landing-page: Project setup + Hero section**
    - Files: `landing-page/package.json`, `landing-page/vite.config.js`, `landing-page/src/pages/Home.jsx`, `landing-page/src/components/Hero.jsx`
    - Task: Initialize React + Vite with SSG, create hero section
    - Design style: **Linear/Vercel aesthetic** - clean gradients, subtle animations, dark mode with high contrast
    - Hero: Modern SaaS design with gradient text, mesh gradients in background
    - CTA button: Glowing effect on hover, smooth transitions
    - "Get Started" → links to accounts.daemonclient.uz/signup

15. **landing-page: Service showcase**
    - Files: `landing-page/src/components/ServiceShowcase.jsx`
    - Task: Grid of service cards (Photos, Drive, future services)
    - Each card: icon, description, "Learn more" link
    - Framer Motion animations on scroll

16. **landing-page: SEO optimization**
    - Files: `landing-page/public/robots.txt`, `landing-page/public/sitemap.xml`, `landing-page/src/utils/seo.js`
    - Task: Generate SEO metadata
    - Add Open Graph tags, Twitter Cards
    - Structured data (JSON-LD) for organization/website
    - Optimize images (WebP conversion)

### Group D: Service Integration (2 units)

17. **Integrate photos.daemonclient.uz with central auth**
    - Files: `immich/web/src/routes/+layout.ts` (or equivalent auth check file)
    - Task: Add session cookie check on page load
    - If no `__session` cookie: redirect to `accounts.daemonclient.uz/login?return_url=...`
    - Update CORS in `immich-api-shim/src/auth.ts` to allow `accounts.daemonclient.uz`

18. **Integrate app.daemonclient.uz with central auth**
    - Files: `frontend/src/App.jsx`
    - Task: Add session cookie check in initial `useEffect`
    - If no `__session` cookie: redirect to `accounts.daemonclient.uz/login?return_url=...`
    - Validate session with API before proceeding to dashboard

### Group E: CLI Enhancements (2 units)

19. **daemon-cli: Claude Code-style UI overhaul**
    - Files: `daemon-cli/src/daemonclient/cli.py`, `daemon-cli/src/daemonclient/ui.py` (new)
    - Task: Enhance terminal UI with Rich advanced features
    - Add: `Panel` with gradient borders for command output
    - Add: `Progress` bars for upload/download (similar to Claude Code)
    - Add: `Live` updating status panels with spinners
    - Add: Custom theme with cyan/magenta accent colors (Linear/Vercel inspired)
    - Update all commands to use new UI components

20. **daemon-cli: Interactive file browser (TUI)**
    - Files: `daemon-cli/src/daemonclient/tui.py` (new), `daemon-cli/src/daemonclient/cli.py` (modify)
    - Task: Add `daemon browse` command with interactive file navigator
    - Use Rich `Live` + `Table` for file listing
    - Arrow keys: navigate up/down
    - Enter: download selected file
    - Del/Backspace: delete selected file (with confirmation)
    - q: quit browser
    - Style: Match Claude Code terminal (gradient borders, status bar)

## Critical Files to Reference

When implementing, reuse patterns from these existing files:

1. **`immich-api-shim/src/helpers.ts`** (lines 1-50)
   - HMAC session token creation pattern
   - Use `crypto.subtle` for HMAC-SHA256 signing

2. **`immich-api-shim/src/auth.ts`** (lines 1-200)
   - Session token validation pattern
   - Cookie setting with httpOnly, secure flags
   - Firebase ID token refresh logic

3. **`frontend/src/App.jsx`** (lines 1-100)
   - Firebase Auth integration pattern
   - `onAuthStateChanged` listener
   - Firestore real-time listeners with `onSnapshot`

4. **`functions/index.js`** (entire file)
   - Firebase Cloud Functions patterns
   - Firestore document operations with admin SDK
   - Telegram notification triggers

5. **`daemon-cli/src/daemonclient/cli.py`** (entire file)
   - Current Typer + Rich CLI structure
   - Enhance with `Panel`, `Progress`, `Live` components

## End-to-End Test Recipe

After implementing each unit, verify as follows:

### For auth-worker units (1-4):
```bash
# Start local worker
cd auth-worker
wrangler dev

# Test session creation
curl -X POST http://localhost:8787/create-session \
  -H "Content-Type: application/json" \
  -d '{"idToken":"test-token","refreshToken":"test-refresh","returnUrl":"https://photos.daemonclient.uz"}' \
  -v  # Check for Set-Cookie header

# Test logout
curl -X GET http://localhost:8787/logout -v
```

### For accounts-portal units (6-13):
```bash
cd accounts-portal
npm run dev
# Open http://localhost:5173
# Screenshot each page: /login, /signup, /dashboard, /profile, /security
# Test: Create account → Login → View dashboard → Check storage widget
```

### For landing-page units (14-16):
```bash
cd landing-page
npm run build  # Pre-render static pages
npm run preview
# Open http://localhost:4173
# Screenshot hero section, service showcase
# Check: View source → verify meta tags, structured data
# Run: lighthouse --view  # Target score: 100
```

### For service integration units (17-18):
```bash
# Clear browser cookies
# Visit https://photos.daemonclient.uz (or local dev)
# Verify: Redirects to accounts.daemonclient.uz/login
# Login → Verify: Redirects back to photos with session cookie
# Screenshot: Photos app loaded and authenticated
```

### For CLI units (19-20):
```bash
cd daemon-cli
source .venv/bin/activate

# Test visual improvements (unit 19)
python -m daemonclient.cli list
# Screenshot: Table output with gradient borders
python -m daemonclient.cli upload test.txt
# Screenshot: Progress bar during upload (Claude Code style)

# Test interactive browser (unit 20)
python -m daemonclient.cli browse
# Screenshot: TUI file browser with gradient borders
# Test: Arrow keys to navigate, Enter to download, Del to delete, q to quit
```

## Worker Instructions (Copied to Each Agent)

After you finish implementing the change:
1. **Simplify** — Invoke the `Skill` tool with `skill: "simplify"` to review and clean up your changes.
2. **Run unit tests** — Run the project's test suite (check for package.json scripts, Makefile targets, or common commands like `npm test`, `bun test`, `pytest`, `go test`). If tests fail, fix them.
3. **Test end-to-end** — Follow the e2e test recipe from the coordinator's prompt (above). If the recipe says to skip e2e for this unit, skip it.
4. **Commit and push** — Commit all changes with a clear message, push the branch, and create a PR with `gh pr create`. Use a descriptive title. If `gh` is not available or the push fails, note it in your final message.
5. **Report** — End with a single line: `PR: <url>` so the coordinator can track it. If no PR was created, end with `PR: none — <reason>`.

## Security Considerations

- Cross-domain cookies: `Domain=.daemonclient.uz`, `HttpOnly`, `Secure`, `SameSite=Lax`
- Session tokens: 7-day expiry, HMAC-SHA256 signature validation
- Activity logs: Hash IP addresses (SHA-256 with random salt), immutable writes
- Firestore rules: User-scoped access (uid-based), activity logs are write-once
- No tokens in URL (cookie-only)

## Cost Analysis

This entire system stays within **$0/month** infrastructure:
- Firebase Hosting: Free tier (10GB storage, 360MB/day transfer)
- Firestore: Free tier (1GB storage, 50k reads/day, 20k writes/day)
- Cloudflare Workers: Free tier (100k requests/day)
- Firebase Auth: Free tier (unlimited email/password auth)

## Deployment Checklist

**DNS Configuration**:
```
daemonclient.uz              → Firebase Hosting (landing-page)
accounts.daemonclient.uz     → Firebase Hosting (accounts-portal)
auth.daemonclient.uz         → Cloudflare Worker (auth-worker)
photos.daemonclient.uz       → Firebase Hosting (immich, existing)
app.daemonclient.uz          → Firebase Hosting (frontend, existing)
```

**Firebase Hosting Targets**:
```bash
firebase target:apply hosting landing daemonclient-main
firebase target:apply hosting accounts daemonclient-accounts
firebase deploy --only hosting:landing,hosting:accounts
```

**Cloudflare Worker Deploy**:
```bash
cd auth-worker
wrangler deploy
wrangler domains add auth.daemonclient.uz
```

---

This plan creates a production-ready, Google Account-style central authentication system that:
- Maintains zero-cost infrastructure
- Requires minimal changes to existing services
- Follows proven patterns from the current codebase
- Provides excellent UX with Claude Code-inspired CLI enhancements
- Ensures security with proper session token handling
- Scales to support future services (Mail, Calendar, etc.)
