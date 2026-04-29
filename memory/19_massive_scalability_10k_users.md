# Massive Scalability Architecture (10k+ Concurrent Users)

To achieve flawless performance for 10k+ simultaneous users, we need to eliminate the hidden bottlenecks inside the Cloudflare Worker API Shim. Currently, the worker hits Firestore for the Telegram bot config on *every single request* and shares a *single global concurrency limit* across all users connected to that Worker node.

By implementing isolated concurrency and memory caching, we will effectively decouple the infrastructure scaling from user demand.

## Proposed Changes

### 1. In-Memory Firestore Caching
**File: `immich-api-shim/src/helpers.ts`**
- Create a global `Map` instance: `const firestoreCache = new Map<string, { value: any; expires: number }>();`
- Update `firestoreGet` to check this cache first. Configs (`config/telegram`) will cache for 5 minutes, while asset metadata (`photos/`) will cache for 60 seconds.
- Update `firestoreSet` and `firestoreDelete` to instantly invalidate or update the cache.
- **Impact**: This drops our Firestore read operations from 20,000 requests/sec down to practically 0, saving massive database costs and reducing latency from 200ms to 1ms.

### 2. Per-Tenant Concurrency (Queue Isolation)
**File: `immich-api-shim/src/assets.ts`**
- The current `RequestQueue` limits Telegram API calls to 15 concurrent requests *globally* per Worker isolate. This means User A downloading photos blocks User B.
- **Fix**: Change the global `tgQueue` to a Map: `const queues = new Map<string, RequestQueue>();`
- When fetching a thumbnail or original file, we will dynamically instantiate or fetch the queue assigned to the user's specific Telegram `botToken`.
- **Impact**: 10,000 users will now have 10,000 separate queues, utilizing their own 15-request limits safely with Telegram, completely eliminating cross-user bottlenecks.

### 3. Edge-Tier Browser Caching
**File: `immich-api-shim/src/assets.ts`**
- Inject HTTP Headers: `Cache-Control: public, max-age=31536000, immutable` into the responses for `handleThumbnail` and `handleOriginal`.
- **Impact**: Once a single user downloads a thumbnail, their browser will *never* request it again. If multiple users view the same public album, Cloudflare's Edge nodes will intercept the request before the Worker even wakes up.

## Verification Plan
1. I will deploy the Cloudflare Worker with these changes.
2. We will analyze the network tab while scrolling wildly to confirm that responses return in under ~30ms (Cache Hit) and do not 429.
3. This sets the foundation perfectly before we begin touching the Flutter app's UI elements!
