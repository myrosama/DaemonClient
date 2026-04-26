# DaemonClient Gallery: Project Scope & Technical Roadmap

## 1. Vision & Architecture
The DaemonClient Gallery is a **Zero-Cost, Serverless** transformation of the Immich photo platform. By decoupling the frontend from the traditional Docker backend, we achieve a stateless, highly scalable, and cost-free infrastructure.

### Core Pillars:
- **Frontend**: SvelteKit (Svelte 5) hosted on **Firebase Hosting**.
- **Metadata**: **Firestore** (replacing PostgreSQL).
- **Binary Storage**: **Telegram** (replacing local disk/S3) for unlimited, free storage.
- **API Bridge**: **Cloudflare Workers** acting as a shim to translate Immich SDK calls to Firestore/Telegram.

---

## 2. Current Implementation Status

### ✅ Completed Features:
- **Decoupled Auth**: Session-less authentication via Firebase/Firestore tokens.
- **Serverless Timeline**: Lightning-fast timeline loading directly from Firestore.
- **Telegram Binary Proxy**: Automatic encryption/decryption and streaming of assets from Telegram.
- **Mobile Upload Normalization**: Intercepting official Immich Mobile App uploads to ensure high-quality thumbnails are captured/generated server-side.
- **Premium UX Core**: Blurry-to-sharp image transitions using Thumbhashes.

### 🛠️ Recent Optimizations:
- **Paced Request Queue**: Implemented a global concurrency limiter on the frontend to avoid Telegram "429 Too Many Requests" errors.
- **Debounced Lazy Loading**: Timeline thumbnails only load when the user stops scrolling, preserving bandwidth and network reliability.
- **Exponential Backoff Retries**: Automatic 3-stage retry policy for all failed image loads.

---

## 3. Known Challenges & Solutions

### A. Telegram Rate Limits
Telegram's `getFile` API is sensitive to high-frequency requests.
- **Solution**: The **RequestQueue** utility on the frontend paces requests with a small delay (80ms) and limits concurrent fetches to 6.

### B. Mobile App Discrepancies
The official mobile app does not upload thumbnails separately.
- **Solution**: The API Shim (Worker) detects single-file uploads and uses a `sendPhoto` fallback to force Telegram to generate a high-quality thumbnail `file_id`.

### C. UX Latency
Serverless cold starts and multi-hop network fetches (Browser -> Worker -> Telegram -> Worker -> Browser) can introduce lag.
- **Solution**: Permanent visibility of the **Thumbhash** placeholder until the next quality level is 100% loaded.

---

## 4. Future Roadmap

1. **Retroactive Thumbnailing**: Script to generate `telegramThumbId` for legacy assets.
2. **Svelte 5 Refactoring**: Resolving local state reference warnings for better reactivity performance.
3. **Video Playback Purity**: Strengthening the chunked streaming logic for large videos (20MB+ chunks).
4. **Offline Mode**: Enhanced Service Worker caching for instant offline access to recently viewed thumbnails.

---

> This document serves as the Source of Truth for the DaemonClient Gallery development cycle.
