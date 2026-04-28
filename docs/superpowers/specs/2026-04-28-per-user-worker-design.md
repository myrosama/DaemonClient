# Per-User Cloudflare Worker Architecture Design

**Date:** 2026-04-28  
**Status:** Draft  
**Author:** Claude (based on user requirements)

---

## Executive Summary

This design enables DaemonClient to scale to 10,000+ users at **$0 cost** by moving from a shared infrastructure model to a **per-user Cloudflare Worker** architecture. Each user brings their own Cloudflare account (free tier), gets their own Worker deployed automatically, and stores photo metadata in their own D1 database.

**Key Benefits:**
- ✅ True $0 scaling (each user = 100K requests/day + 5M D1 reads/day on free tier)
- ✅ No central bottlenecks (eliminates Firebase Firestore's 50K reads/day limit)
- ✅ Data sovereignty (users own their infrastructure)
- ✅ Maintains existing E2E encryption
- ✅ Automatic updates via centrally stored API tokens

---

## Problem Statement

### Current Bottleneck
**Firebase Firestore free tier:**
- 50K reads/day
- 20K writes/day

**At 10K users:** Only **5 reads per user per day** — completely inadequate for a photo gallery app.

### Requirements
1. Scale to 10,000+ users at $0 cost
2. Maintain end-to-end encryption (current ZKE implementation)
3. Simple onboarding (comparable to current Telegram bot setup)
4. Automatic updates (push worker code changes to all users)
5. No migration for existing users (new users only)

---

## Architecture Overview

### High-Level Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                    Central Infrastructure                         │
│                  (Platform Operator - You)                        │
│                                                                    │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │ Firebase (Central Registry)                                  │ │
│  │ - User accounts (uid, email)                                 │ │
│  │ - Telegram bot credentials (encrypted)                       │ │
│  │ - Cloudflare API tokens (encrypted, per user)                │ │
│  │ - Worker URLs (for discovery)                                │ │
│  │ - Feature flags                                              │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                                                                    │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │ Accounts Portal (accounts.daemonclient.uz)                   │ │
│  │ - Signup/login                                               │ │
│  │ - Telegram bot setup wizard                                  │ │
│  │ - Cloudflare worker setup wizard (NEW)                       │ │
│  │ - Update management                                          │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                                                                    │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │ Deployment Service (NEW)                                     │ │
│  │ - Auto-deploy workers to user accounts                       │ │
│  │ - Manage updates                                             │ │
│  │ - Health checks                                              │ │
│  └─────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
                              │
                              │ Setup / Updates
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│                  Per-User Infrastructure                          │
│            (User's Cloudflare Account - Free Tier)               │
│                                                                    │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │ Cloudflare Worker (user-abc123.workers.dev)                  │ │
│  │ - Same code as current immich-api-shim                       │ │
│  │ - Handles all /api/* requests                                │ │
│  │ - Encrypts/decrypts photos (ZKE)                             │ │
│  │ - Routes to user's D1 database                               │ │
│  │ - Connects to user's Telegram bot                            │ │
│  │ Limits: 100K requests/day                                    │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                              │                                     │
│                              ▼                                     │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │ Cloudflare D1 Database (photos-db)                           │ │
│  │ - Photos metadata (fileName, uploadedAt, width, etc.)        │ │
│  │ - Albums, tags, search indexes                               │ │
│  │ - ZKE encryption config (password, salt)                     │ │
│  │ - Upload sessions, feature flags                             │ │
│  │ Limits: 5M reads/day, 100K writes/day, 5GB storage           │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                                                                    │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │ Telegram Bot (User's Own)                                    │ │
│  │ - File storage (unchanged)                                   │ │
│  │ - Already configured in current setup                        │ │
│  └─────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
```

### Request Flow

**Photo Upload:**
```
1. User uploads photo in web client (photos.daemonclient.uz)
2. Client → User's Worker (user-abc123.workers.dev/api/assets)
3. Worker encrypts chunks (ZKE if enabled)
4. Worker → Telegram Bot API (upload encrypted chunks)
5. Worker → User's D1 database (save photo metadata + Telegram IDs)
6. Response → Client (photo uploaded)
```

**Photo Viewing:**
```
1. Client → User's Worker (GET /api/timeline/buckets)
2. Worker → User's D1 (query photos)
3. D1 → Worker (photo metadata list)
4. Worker → Client (timeline data)
5. Client requests thumbnail: GET /api/assets/{id}/thumbnail
6. Worker → Telegram Bot API (download file by file_id)
7. Worker decrypts (if ZKE enabled)
8. Worker → Client (image bytes)
```

---

## Data Architecture

### Central Firebase (What Stays)

**Purpose:** User account registry, infrastructure coordination, update management

**Schema:**

```typescript
// Firestore paths
artifacts/default-daemon-client/users/{uid}/

  // User account info
  profile/settings: {
    displayName: string
    email: string
    avatarColor: string
    createdAt: timestamp
  }

  // Telegram bot credentials (ENCRYPTED)
  config/telegram: {
    botToken: string (encrypted with master key)
    channelId: string
    botUsername: string
    invite_link: string
    setupTimestamp: timestamp
  }

  // Cloudflare API token (ENCRYPTED) - Option B-with-fallback
  config/cloudflare: {
    apiToken: string (encrypted with master key)
    accountId: string
    workerName: string
    workerUrl: string
    databaseName: string
    databaseId: string
    setupTimestamp: timestamp
    lastDeployedVersion: string
    autoUpdateEnabled: boolean (default: true)
  }

  // Activity log
  activity/{activityId}: {
    type: 'signup' | 'setup_telegram' | 'setup_worker' | 'worker_update' | 'login'
    timestamp: timestamp
    userAgent: string
    metadata: object
  }

  // Worker health status
  services/photos: {
    totalAssets: number (cached, updated periodically)
    lastAccessed: timestamp
    workerVersion: string
    healthStatus: 'healthy' | 'degraded' | 'down'
    lastHealthCheck: timestamp
  }
```

**Access Pattern:**
- Central Firebase accessed ONLY during:
  - Signup/login (accounts portal)
  - Initial setup (Telegram + Cloudflare)
  - Worker updates (deployment service)
  - Health checks

### User's D1 Database (What Moves)

**Purpose:** All photo-related data with high read frequency

**Schema:**

```sql
-- Photos table (replaces Firestore photos/{id})
CREATE TABLE photos (
  id TEXT PRIMARY KEY,
  ownerId TEXT NOT NULL,
  fileName TEXT NOT NULL,
  fileSize INTEGER NOT NULL,
  mimeType TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  duration TEXT,
  fileCreatedAt TEXT NOT NULL,
  uploadedAt TEXT NOT NULL,
  
  -- Telegram storage
  telegramOriginalId TEXT,
  telegramThumbId TEXT,
  telegramChunks TEXT, -- JSON array
  
  -- Encryption
  encryptionMode TEXT DEFAULT 'off', -- 'off' | 'server'
  thumbEncrypted INTEGER DEFAULT 0,
  
  -- Metadata
  checksum TEXT,
  isHeic INTEGER DEFAULT 0,
  livePhotoVideoId TEXT,
  
  -- User preferences
  isFavorite INTEGER DEFAULT 0,
  isTrashed INTEGER DEFAULT 0,
  visibility TEXT DEFAULT 'timeline', -- 'timeline' | 'archive'
  description TEXT,
  
  -- Location/dates
  city TEXT,
  country TEXT,
  
  -- Indexes
  UNIQUE(id),
  INDEX idx_uploadedAt ON photos(uploadedAt DESC),
  INDEX idx_fileCreatedAt ON photos(fileCreatedAt DESC),
  INDEX idx_livePhoto ON photos(livePhotoVideoId) WHERE livePhotoVideoId IS NOT NULL,
  INDEX idx_favorite ON photos(isFavorite) WHERE isFavorite = 1
);

-- Albums table
CREATE TABLE albums (
  id TEXT PRIMARY KEY,
  albumName TEXT NOT NULL,
  description TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  albumThumbnailAssetId TEXT,
  isActivityEnabled INTEGER DEFAULT 1,
  
  UNIQUE(id)
);

-- Album assets junction table
CREATE TABLE album_assets (
  albumId TEXT NOT NULL,
  assetId TEXT NOT NULL,
  addedAt TEXT NOT NULL,
  
  PRIMARY KEY (albumId, assetId),
  FOREIGN KEY (albumId) REFERENCES albums(id) ON DELETE CASCADE,
  FOREIGN KEY (assetId) REFERENCES photos(id) ON DELETE CASCADE
);

-- ZKE config table (replaces Firestore config/zke)
CREATE TABLE config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Insert ZKE config on setup
INSERT INTO config (key, value) VALUES 
  ('zke_mode', 'off'),
  ('zke_enabled', '0'),
  ('zke_password', ''),
  ('zke_salt', '');

-- Upload sessions table
CREATE TABLE upload_sessions (
  sessionId TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'active',
  createdAt TEXT NOT NULL,
  expiresAt TEXT NOT NULL
);
```

**Migration Strategy:**
- No migration needed (design is for NEW users only)
- Existing users continue using central Firestore worker
- Feature flag: `byoWorkerEnabled` (default: false for existing users)

---

## Security Model

### End-to-End Encryption (ZKE)

**Current Implementation (Preserved):**
```typescript
// Encryption happens in the Worker (not truly zero-knowledge)
// User's data is encrypted before storing in Telegram
// Worker has access to encryption keys stored in D1

// ZKE config stored in D1 config table
{
  zke_mode: 'server' | 'off',
  zke_enabled: boolean,
  zke_password: string (base64), // derived key material
  zke_salt: string (base64)      // PBKDF2 salt
}

// Encryption flow:
1. User enables encryption in UI
2. Worker generates random password + salt
3. Stores in D1 config table
4. For each upload:
   - Derive AES-GCM key from password + salt
   - Encrypt chunks before sending to Telegram
   - Store encrypted chunks in Telegram
5. For each download:
   - Retrieve encrypted chunks from Telegram
   - Decrypt using same key
   - Return to client
```

**Security Guarantees:**
- ✅ Data encrypted at rest in Telegram
- ✅ Encryption keys stored in user's D1 (not central Firebase)
- ✅ Worker code is open-source (user can audit)
- ✅ User owns infrastructure (Worker + D1 in their account)
- ⚠️ Worker CAN decrypt data (not true zero-knowledge)
- ⚠️ Cloudflare staff theoretically have access to Worker + D1

**Why This Is Acceptable:**
- User's threat model: prevent Telegram from reading photos ✅
- User's threat model: prevent platform operator from reading photos ✅ (data in user's account)
- Advanced threat model: prevent Cloudflare staff access ❌ (requires browser-side encryption - future feature)

### API Token Storage

**Option B Implementation (User's D1 + Encrypted Fallback in Firebase):**

**Primary Storage: User's D1**
```sql
-- Store deployment secret in D1
INSERT INTO config (key, value) VALUES 
  ('cf_api_token', '<encrypted_token>');
```

**Fallback Storage: Central Firebase (Encrypted)**
```typescript
// Only used for updates if D1 token is unavailable
users/{uid}/config/cloudflare: {
  apiToken: encrypt(token, MASTER_KEY), // AES-GCM encrypted
  accountId: string,
  // ... rest of config
}
```

**Encryption Implementation:**
```typescript
// Master key derived from environment variable
const MASTER_KEY = await crypto.subtle.importKey(
  'raw',
  new TextEncoder().encode(env.ENCRYPTION_MASTER_KEY),
  { name: 'AES-GCM', length: 256 },
  false,
  ['encrypt', 'decrypt']
);

async function encryptToken(token: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    MASTER_KEY,
    new TextEncoder().encode(token)
  );
  
  // Return: base64(iv + encrypted)
  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(encrypted), iv.length);
  return btoa(String.fromCharCode(...combined));
}
```

**Why Fallback Storage:**
- If user's D1 becomes inaccessible, we can still push critical security updates
- User explicitly opts in during setup: "Store encrypted token for automatic updates?"
- Cost: $0 (Firebase writes are cheap, tokens updated rarely)

**Access Control:**
```typescript
// Deployment service workflow:
1. Check user's D1 for token (PRIMARY)
2. If D1 fails, use encrypted Firebase token (FALLBACK)
3. Decrypt token using MASTER_KEY (stored in Worker secret)
4. Use token to deploy updated worker via Cloudflare API
5. Log deployment activity to Firebase
```

### Cloudflare API Token Permissions

**Required Scopes:**
- `Workers Scripts:Edit` (deploy worker code)
- `D1:Edit` (create database, run migrations)
- `Account Settings:Read` (verify account ID)

**Token Template for Setup Wizard:**
```javascript
// User creates token with these exact permissions
{
  "name": "DaemonClient Worker Deployment",
  "policies": [
    {
      "effect": "allow",
      "resources": {
        "com.cloudflare.api.account.*": "*"
      },
      "permission_groups": [
        { "id": "workers_scripts_write" },
        { "id": "d1_write" },
        { "id": "account_read" }
      ]
    }
  ]
}
```

---

## Onboarding User Experience

### Setup Flow (New Users)

**Step 1: Account Creation (Existing)**
```
1. User visits accounts.daemonclient.uz
2. Sign up with email + password
3. Firebase account created
4. Redirect to Setup Step 2
```

**Step 2: Telegram Bot Setup (Existing)**
```
1. "Create Your Storage" page
2. Options:
   - Automated: Click "Create Secure Storage" → backend creates bot + channel
   - Manual: Enter bot token + channel ID
3. Bot ownership transfer flow (existing)
4. Telegram credentials saved to Firebase (encrypted)
5. Redirect to Setup Step 3 (NEW)
```

**Step 3: Cloudflare Worker Setup (NEW)**

**UI Design:**
```
┌─────────────────────────────────────────────────────────────┐
│  [Logo] DaemonClient Account Setup                          │
│                                                              │
│  ✓ Account Created                                          │
│  ✓ Telegram Storage Connected                               │
│  ▶ Personal Backend Setup                     Step 3 of 3   │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐ │
│  │ 🚀 Your Private Backend                                 │ │
│  │                                                         │ │
│  │ To give you unlimited storage, we need to set up       │ │
│  │ your personal backend server. Don't worry - it's       │ │
│  │ completely free and takes 2 minutes!                   │ │
│  │                                                         │ │
│  │ What you get:                                          │ │
│  │ • 100,000 requests per day (just for you!)            │ │
│  │ • 5 million photo loads per day                       │ │
│  │ • 5GB database storage                                │ │
│  │ • Your own private server URL                         │ │
│  │ • Automatic updates & maintenance                     │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐ │
│  │ Step 1: Create Your Cloudflare Account                 │ │
│  │                                                         │ │
│  │ Cloudflare provides your free backend server.          │ │
│  │                                                         │ │
│  │ [Create Free Account →]  Already have one? [Skip]      │ │
│  │                                                         │ │
│  │ 📹 Watch video guide (1 min)                           │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐ │
│  │ Step 2: Get Your API Token                             │ │
│  │                                                         │ │
│  │ This lets us set up your server automatically.         │ │
│  │                                                         │ │
│  │ 1. Go to Cloudflare Dashboard                          │ │
│  │    [Open Dashboard →]                                   │ │
│  │                                                         │ │
│  │ 2. Click your profile icon → "API Tokens"              │ │
│  │                                                         │ │
│  │ 3. Click "Create Token"                                │ │
│  │                                                         │ │
│  │ 4. Use this template:                                  │ │
│  │    [Copy Template]                                      │ │
│  │                                                         │ │
│  │    Token Name: DaemonClient Worker                     │ │
│  │    Permissions:                                        │ │
│  │      - Workers Scripts (Edit)                          │ │
│  │      - D1 Database (Edit)                              │ │
│  │      - Account Settings (Read)                         │ │
│  │                                                         │ │
│  │ 5. Click "Continue to summary" → "Create Token"        │ │
│  │                                                         │ │
│  │ 6. Copy the token and paste it below                   │ │
│  │                                                         │ │
│  │ 📹 Step-by-step video (1 min)                          │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐ │
│  │ Paste Your API Token:                                  │ │
│  │                                                         │ │
│  │ [_____________________________________________]          │ │
│  │                                                         │ │
│  │ ✓ Token validated                                      │ │
│  │ ✓ Account ID: abc123xyz                                │ │
│  │                                                         │ │
│  │ ☐ Store encrypted token for automatic updates         │ │
│  │   (Recommended - keeps your backend up-to-date)        │ │
│  │                                                         │ │
│  │ [Deploy My Backend] ← Click when ready                 │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐ │
│  │ 🔒 Security & Privacy                                   │ │
│  │                                                         │ │
│  │ • Your photos stay in YOUR Telegram channel            │ │
│  │ • Your data stays in YOUR Cloudflare account           │ │
│  │ • We NEVER see your photos or data                     │ │
│  │ • API token is encrypted and stored securely           │ │
│  │ • You can revoke access anytime in Cloudflare          │ │
│  └────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

**Deployment Progress Modal:**
```
┌──────────────────────────────────────────┐
│  Deploying Your Backend...              │
│                                          │
│  [████████████────────] 60%              │
│                                          │
│  ✓ Connected to Cloudflare               │
│  ✓ Created D1 database (photos-db)       │
│  ▶ Deploying worker code...              │
│    Setting up encryption...              │
│    Configuring Telegram connection...    │
│                                          │
│  This takes about 30-45 seconds          │
└──────────────────────────────────────────┘
```

**Success Screen:**
```
┌─────────────────────────────────────────────────────────────┐
│  🎉 Your Backend is Ready!                                  │
│                                                              │
│  Your personal server is now running at:                    │
│  https://daemonclient-abc123.workers.dev                    │
│                                                              │
│  ✓ Database created and configured                          │
│  ✓ Encryption enabled                                       │
│  ✓ Connected to your Telegram storage                       │
│  ✓ Automatic updates enabled                                │
│                                                              │
│  [Start Using DaemonClient Photos →]                        │
│                                                              │
│  Need help? Check the FAQ or contact support                │
└─────────────────────────────────────────────────────────────┘
```

### Onboarding Optimizations

**Video Guides:**
- Embedded 60-second videos for each step
- Screen recordings with voiceover
- Hosted on Cloudflare R2 (free bandwidth)

**Token Template Auto-Fill:**
- "Copy Template" button opens Cloudflare with pre-filled permission form
- Deep link: `https://dash.cloudflare.com/profile/api-tokens?template=daemonclient`
- Requires Cloudflare to support custom templates (fallback: manual steps)

**Real-Time Validation:**
- Token validation happens on blur (instant feedback)
- Shows account ID immediately after validation
- Prevents deployment with invalid token

**Error Handling:**
- Clear error messages: "Token doesn't have Workers Scripts permission - go back and add it"
- Retry button for deployment failures
- Support chat widget for stuck users

---

## Update & Deployment Mechanism

### Version Management

**Worker Version Tracking:**
```typescript
// In worker code (src/index.ts)
export const WORKER_VERSION = '2.1.0';

// On every request, worker reports version in header
response.headers.set('X-Worker-Version', WORKER_VERSION);

// Central service tracks latest version
const LATEST_VERSION = '2.1.0';
```

### Update Detection

**Passive Detection (On User Login):**
```typescript
// In accounts portal, after login
async function checkWorkerVersion(uid: string) {
  const workerConfig = await getWorkerConfig(uid);
  const healthCheck = await fetch(`${workerConfig.workerUrl}/api/server-info`);
  const currentVersion = healthCheck.headers.get('X-Worker-Version');
  
  if (isOutdated(currentVersion, LATEST_VERSION)) {
    // Show update banner
    showUpdateBanner({
      current: currentVersion,
      latest: LATEST_VERSION,
      autoUpdate: workerConfig.autoUpdateEnabled
    });
    
    // If auto-update enabled, trigger deployment
    if (workerConfig.autoUpdateEnabled) {
      await queueWorkerUpdate(uid);
    }
  }
}
```

**Active Detection (Periodic Health Checks):**
```typescript
// Cloudflare Worker scheduled trigger (daily)
export default {
  async scheduled(event: ScheduledEvent, env: Env) {
    // Fetch all users from Firebase
    const users = await getAllUsersWithWorkers();
    
    for (const user of users) {
      if (user.autoUpdateEnabled && isOutdated(user.workerVersion, LATEST_VERSION)) {
        await queueWorkerUpdate(user.uid);
      }
    }
  }
};
```

### Deployment Process

**Update Queue (Cloudflare Queue):**
```typescript
// Queue message format
interface UpdateQueueMessage {
  uid: string;
  targetVersion: string;
  priority: 'low' | 'high' | 'critical';
  reason: 'scheduled' | 'manual' | 'security';
}

// Consumer processes updates sequentially
async function processUpdate(message: UpdateQueueMessage, env: Env) {
  const { uid, targetVersion, priority } = message;
  
  try {
    // 1. Fetch user's Cloudflare config
    const config = await firestoreGet(env, uid, 'config/cloudflare', adminIdToken);
    
    // 2. Decrypt API token
    let apiToken;
    try {
      // Try D1 first
      apiToken = await fetchTokenFromD1(config.workerUrl);
    } catch {
      // Fallback to encrypted Firebase token
      apiToken = await decryptToken(config.apiToken, env.ENCRYPTION_MASTER_KEY);
    }
    
    // 3. Deploy updated worker via Cloudflare API
    const deployment = await deployWorker({
      accountId: config.accountId,
      workerName: config.workerName,
      apiToken,
      workerCode: await fetchWorkerBundle(targetVersion),
      bindings: [
        { type: 'd1', name: 'DB', id: config.databaseId }
      ]
    });
    
    // 4. Run database migrations if needed
    if (requiresMigration(config.workerVersion, targetVersion)) {
      await runMigrations({
        workerUrl: config.workerUrl,
        fromVersion: config.workerVersion,
        toVersion: targetVersion
      });
    }
    
    // 5. Update version in Firebase
    await firestoreSet(env, uid, 'config/cloudflare', {
      lastDeployedVersion: targetVersion,
      lastDeployedAt: new Date().toISOString()
    }, adminIdToken);
    
    // 6. Log activity
    await logActivity(uid, 'worker_update', {
      fromVersion: config.workerVersion,
      toVersion: targetVersion,
      priority
    });
    
    console.log(`✓ Updated worker for ${uid}: ${config.workerVersion} → ${targetVersion}`);
    
  } catch (error) {
    console.error(`✗ Update failed for ${uid}:`, error);
    
    // Retry logic
    if (message.retryCount < 3) {
      await queueWorkerUpdate(uid, { retryCount: message.retryCount + 1 });
    } else {
      // Notify user of failed update
      await sendUpdateFailureEmail(uid, error);
    }
  }
}
```

### Deployment Scenarios

**Scenario A: Non-Breaking Update (Bug Fix / Feature)**
```
1. Deploy to staging worker
2. Run integration tests
3. Tag version in git (v2.1.1)
4. Build worker bundle
5. Queue updates for all users (low priority)
6. Process queue over 24 hours (rate limit: 100 deployments/hour)
7. Send "Updated!" notification to users
```

**Scenario B: Breaking Change (Schema Migration)**
```
1. Add migration script to worker code
2. Deploy to staging, test migration
3. Tag version (v3.0.0)
4. Queue updates with migration flag
5. Deployment process:
   - Deploy new worker code
   - Run migration: ALTER TABLE photos ADD COLUMN newField TEXT
   - Verify migration success
   - Mark as deployed
6. Require user confirmation for major updates?
   - No: auto-deploy (user opted in during setup)
   - Yes: show "Update Available" banner with changelog
```

**Scenario C: Critical Security Patch**
```
1. Identify vulnerability
2. Patch immediately
3. Tag version (v2.1.2-security)
4. Queue updates for ALL users (critical priority)
5. Process queue ASAP (rate limit: 500 deployments/hour)
6. Force update: disable old worker versions remotely
   - Set a kill switch in central Firebase
   - Old workers check version on startup, refuse to serve if outdated
7. Email all users: "Security update deployed"
```

### Migration Execution

**Migration System:**
```typescript
// migrations/v3.0.0.sql
ALTER TABLE photos ADD COLUMN blurhash TEXT;
CREATE INDEX idx_blurhash ON photos(blurhash) WHERE blurhash IS NOT NULL;

// Migration runner in worker
async function runMigrations(fromVersion: string, toVersion: string, db: D1Database) {
  const migrations = getMigrationsInRange(fromVersion, toVersion);
  
  for (const migration of migrations) {
    try {
      console.log(`Running migration ${migration.version}...`);
      await db.exec(migration.sql);
      console.log(`✓ Migration ${migration.version} complete`);
    } catch (error) {
      console.error(`✗ Migration ${migration.version} failed:`, error);
      throw error; // Rollback deployment
    }
  }
}
```

### User-Facing Update UI

**Update Banner (Accounts Portal):**
```jsx
{outdated && (
  <div className="bg-linear-purple/10 border border-linear-purple/30 rounded-lg p-4 mb-6">
    <div className="flex items-center gap-3">
      <RefreshCw className="text-linear-purple" size={20} />
      <div className="flex-1">
        <p className="text-sm font-medium text-linear-text">
          Update available: v{latestVersion}
        </p>
        <p className="text-xs text-linear-text-secondary mt-1">
          {autoUpdateEnabled 
            ? "Installing automatically..." 
            : "Install now to get the latest features"}
        </p>
      </div>
      {!autoUpdateEnabled && (
        <button 
          onClick={handleUpdateNow}
          className="px-4 py-2 bg-linear-purple text-white rounded-md text-sm"
        >
          Update Now
        </button>
      )}
    </div>
    
    {changelog && (
      <details className="mt-3">
        <summary className="text-xs text-linear-purple cursor-pointer">
          What's new?
        </summary>
        <ul className="mt-2 text-xs text-linear-text-secondary space-y-1">
          {changelog.map(item => <li key={item}>• {item}</li>)}
        </ul>
      </details>
    )}
  </div>
)}
```

---

## Error Handling & Fallbacks

### Worker Deployment Failures

**Scenario:** Cloudflare API returns 429 (rate limit) during deployment

**Handling:**
```typescript
async function deployWorker(config: DeployConfig): Promise<DeployResult> {
  let attempt = 0;
  const maxRetries = 5;
  
  while (attempt < maxRetries) {
    try {
      const response = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/workers/scripts/${config.workerName}`,
        {
          method: 'PUT',
          headers: {
            'Authorization': `Bearer ${config.apiToken}`,
            'Content-Type': 'application/javascript'
          },
          body: config.workerCode
        }
      );
      
      if (response.ok) {
        return { success: true };
      }
      
      if (response.status === 429) {
        const retryAfter = parseInt(response.headers.get('Retry-After') || '60');
        console.log(`Rate limited, retrying in ${retryAfter}s...`);
        await sleep(retryAfter * 1000);
        attempt++;
        continue;
      }
      
      throw new Error(`Deployment failed: ${response.status} ${await response.text()}`);
      
    } catch (error) {
      if (attempt === maxRetries - 1) throw error;
      await sleep(5000 * Math.pow(2, attempt)); // Exponential backoff
      attempt++;
    }
  }
  
  throw new Error('Max retries exceeded');
}
```

### D1 Token Retrieval Failures

**Scenario:** User's worker is down, can't fetch token from D1

**Handling:**
```typescript
async function getApiToken(uid: string, workerUrl: string, env: Env): Promise<string> {
  // Strategy 1: Fetch from user's D1 via worker endpoint
  try {
    const response = await fetch(`${workerUrl}/api/internal/config/cf-token`, {
      headers: { 'X-Admin-Key': env.ADMIN_SECRET }
    });
    
    if (response.ok) {
      const { token } = await response.json();
      return token;
    }
  } catch (error) {
    console.warn(`Failed to fetch token from D1 for ${uid}:`, error);
  }
  
  // Strategy 2: Fallback to encrypted Firebase token
  const config = await firestoreGet(env, uid, 'config/cloudflare', adminIdToken);
  if (config?.apiToken) {
    return await decryptToken(config.apiToken, env.ENCRYPTION_MASTER_KEY);
  }
  
  throw new Error('No API token available');
}
```

### User's Worker Goes Down

**Scenario:** User exceeded 100K requests/day, worker is throttled

**Detection:**
```typescript
// Health check endpoint in worker
export async function handleHealthCheck(request: Request, env: Env): Promise<Response> {
  const stats = {
    version: WORKER_VERSION,
    database: await checkDbConnection(env.DB),
    telegram: await checkTelegramConnection(env),
    timestamp: Date.now()
  };
  
  return json(stats);
}

// Periodic health checks from central service
async function checkWorkerHealth(uid: string, workerUrl: string) {
  try {
    const response = await fetch(`${workerUrl}/api/health`, { signal: AbortSignal.timeout(5000) });
    
    if (!response.ok) {
      await logHealthIssue(uid, 'unhealthy', response.status);
      await notifyUserOfDowntime(uid);
    }
    
  } catch (error) {
    await logHealthIssue(uid, 'down', error.message);
    await notifyUserOfDowntime(uid);
  }
}
```

**User Notification:**
```
Subject: Your DaemonClient Backend Needs Attention

Hi there!

We noticed your personal backend (worker-abc123.workers.dev) 
is currently unavailable. This might be because:

• You've exceeded the 100K requests/day free tier limit
• Your Cloudflare account has an issue
• The worker deployment failed

To resolve this:
1. Check your Cloudflare dashboard for alerts
2. If you exceeded limits, upgrade to Cloudflare Workers Paid ($5/month for 10M requests)
3. Or contact us for help debugging

Your photos are safe in Telegram - we'll restore access soon!

- DaemonClient Team
```

---

## Implementation Checklist

### Phase 1: Core Infrastructure
- [ ] Design D1 schema (SQL tables for photos, albums, config)
- [ ] Create migration tool to convert Firestore → D1 structure
- [ ] Build Cloudflare API client (deploy worker, create D1, manage bindings)
- [ ] Implement token encryption (AES-GCM with master key)
- [ ] Create deployment queue (Cloudflare Queue for update jobs)

### Phase 2: Accounts Portal Updates
- [ ] Add Step 3 to setup flow (Cloudflare worker setup)
- [ ] Build token input UI with validation
- [ ] Create deployment progress modal
- [ ] Add video guides (record, host on R2)
- [ ] Implement update banner in dashboard
- [ ] Add settings page: "Manage Backend" (view worker URL, toggle auto-updates)

### Phase 3: Worker Updates
- [ ] Modify worker to read from D1 instead of Firestore
- [ ] Add version constant and header
- [ ] Create internal admin endpoints (/api/internal/config/*)
- [ ] Add health check endpoint
- [ ] Implement migration runner system

### Phase 4: Deployment Service
- [ ] Create deployment service worker (processes queue)
- [ ] Implement retry logic with exponential backoff
- [ ] Add health check cron job
- [ ] Build version tracking system
- [ ] Create email notification templates

### Phase 5: Testing & Documentation
- [ ] End-to-end test: signup → setup → deploy → upload photo
- [ ] Test update mechanism with staging environment
- [ ] Test migration rollback scenarios
- [ ] Write user documentation (setup guide, FAQs)
- [ ] Create video tutorials

### Phase 6: Rollout
- [ ] Deploy to staging with test users
- [ ] Enable feature flag: `byoWorkerEnabled: true`
- [ ] Monitor first 100 users for issues
- [ ] Adjust onboarding based on feedback
- [ ] Full rollout for all new signups

---

## Open Questions

1. **Cloudflare API Rate Limits:** What's the rate limit for worker deployments via API? (Need to test)
2. **D1 Cross-Account Access:** Can a worker in account A access D1 in account B? (Answer: No, binding must be same account)
3. **Token Expiration:** Do Cloudflare API tokens expire? (Need to check docs)
4. **Worker Code Size Limit:** Max size for worker bundle? (Current: ~500KB, need to optimize)
5. **Deployment Costs:** Are there costs for deploying workers via API? (Need to verify)

---

## Future Enhancements

### True Zero-Knowledge Encryption
- Browser-based encryption before upload
- Worker never sees plaintext
- Requires significant frontend changes

### Multi-User Sharing
- Invite system (share albums with family)
- Shared worker access with per-user permissions
- Requires OAuth-like flow

### Worker Monitoring Dashboard
- Real-time metrics (requests/day, errors, latency)
- Usage alerts (approaching 100K limit)
- Cost estimation if user wants to upgrade

### Cloudflare Pages Integration
- Host photo viewer on user's Cloudflare Pages (free)
- Custom domain support
- Each user gets: `photos.username.daemonclient.uz`

---

## Conclusion

This design achieves true $0 scaling by distributing infrastructure costs to users while maintaining a simple onboarding experience comparable to the existing Telegram bot setup. The key innovation is **automatic deployment via stored API tokens**, which allows central management of updates without requiring users to manually redeploy.

**Success Criteria:**
- ✅ Scale to 10K+ users without central bottlenecks
- ✅ $0 cost for both platform and users
- ✅ <5 minute setup time for 90% of users
- ✅ <1% deployment failure rate
- ✅ Maintain existing encryption guarantees
- ✅ Push updates to all users within 24 hours

**Next Steps:**
1. Get user approval on design
2. Create detailed implementation plan
3. Build Phase 1 (Core Infrastructure)
4. Test with alpha users
5. Iterate and rollout
