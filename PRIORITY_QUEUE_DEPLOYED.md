# Priority Queue Implementation - DEPLOYED 2026-04-27

## What Was Done

### Priority Queue for Telegram API
Implemented priority-based request queuing to prevent upload saturation from blocking thumbnail downloads during bulk mobile backups.

**Files Modified:**
- `immich-api-shim/src/assets.ts`

**Priority Levels:**
- **Priority 10 (Highest):** Thumbnail downloads (`handleThumbnail`) and original file downloads (`handleOriginal`)
- **Priority 5 (Medium):** Thumbnail generation during upload (sendPhoto/sendVideo)
- **Priority 1 (Lowest):** Chunk uploads (sendDocument)

**How It Works:**
```typescript
class RequestQueue {
  async acquire(signal?: AbortSignal, priority: number = 0) {
    // Higher priority items inserted at front of queue
    // When slot available, highest priority item runs first
  }
}
```

**Expected Behavior:**
- During bulk uploads, if queue is full (10 concurrent), new download requests jump ahead of upload chunks
- User sees thumbnails load even during heavy backup operations
- Upload chunks get processed after downloads complete

**Deployment:**
- Worker Version: `db7e03ff-6750-4880-b998-df6353b3a83c`
- Deployed: 2026-04-27 at ~19:30
- Status: ✅ LIVE

---

## Testing Needed

1. **Bulk Upload Test:**
   - Start mobile backup with 100+ photos
   - While uploading, open gallery on web
   - **Expected:** Thumbnails should load immediately despite ongoing uploads
   - **Previous Behavior:** Thumbnails timeout/fail during bulk uploads

2. **Normal Operation Test:**
   - Upload 10 photos normally
   - Verify they appear in gallery with thumbnails
   - **Expected:** No regression, works as before

---

## Remaining Issues & Next Steps

### High Priority (Must Fix for 1000+ Photos)
1. **Memory Leak - PARTIALLY FIXED**
   - ✅ Cache eviction implemented in helpers.ts
   - ✅ Object URL cleanup in daemonclient-drive.ts
   - ⚠️ Need to verify with stress test (1000+ photos)

2. **Timeline Pagination - NOT STARTED**
   - Timeline still loads ALL photos into memory
   - Need to add `?limit=1000&cursor=lastDocId` pagination
   - Files: `immich-api-shim/src/timeline.ts`, `immich/web/src/lib/managers/timeline-manager/`

3. **Service Worker Resilience - NOT STARTED**
   - Add offline mode cache fallback
   - Fix stale cache issues (reduce cleanup from 5min to 30sec)
   - File: `immich/web/src/service-worker/index.ts`

4. **Frontend Performance - NOT STARTED**
   - GalleryViewer intersection optimization (throttle scroll checks)
   - Request queue tuning (6→12 concurrent, 80ms→40ms delay)
   - Remove duplicate Telegram downloads in ImageThumbnail.svelte

### Medium Priority (Quality of Life)
1. **Retroactive Live Photo Linking - IMPLEMENTED, NOT TESTED**
   - Endpoint exists: `POST /api/admin/link-live-photos`
   - Need to call it once for existing users
   - File: `immich-api-shim/src/link-live-photos.ts`

2. **Zero-Cost Features - NOT STARTED**
   - Trash with 30-day TTL
   - Public share links with password protection
   - Bulk ZIP download
   - File: Create `immich-api-shim/src/trash.ts`, `shared-links.ts`

### Low Priority (Nice to Have)
1. **Migrate to Svelte 5 - IN PROGRESS**
   - Many files already use Svelte 5 syntax
   - Some still use Svelte 4 (e.g., GalleryViewer.svelte)
   - Need systematic migration

---

## Known Bugs (FIXED)
- ✅ Video thumbnails not generating for mobile uploads → Fixed with sendVideo
- ✅ Live photos showing as videos in gallery → Fixed, now show static image
- ✅ Screenshots detected as live photos → Fixed with 0.5-4s duration check
- ✅ Archive search not working → Fixed field name (visibility vs isArchived)
- ✅ Token refresh race condition → Fixed by removing failed attempts from cache
- ✅ Frontend cache issues → Fixed with no-cache headers in firebase.json

---

## Performance Targets
- **Memory:** < 200MB with 1000+ photos (currently unknown)
- **Timeline load:** < 2s for 1000+ photos (currently ~5s+)
- **Scroll FPS:** 30+ FPS (currently ~15 FPS with 1000+ photos)
- **Thumbnail load:** < 7s for 1000 photos (currently 13s+)

---

## Architecture Notes

### Current Request Flow
1. Frontend → Service Worker → Worker API → Telegram
2. Priority queue sits at Worker API → Telegram boundary
3. Queue is per-bot-token (multi-user safe)
4. Abort signal support for cancelled requests

### Telegram API Limits
- Rate limit: ~1 request/100ms per bot
- Queue size: 10 concurrent requests
- Retry on 429 with exponential backoff (4 retries max)

### Live Photo Detection
- HEIC + MOV pairs within 2 seconds of fileCreatedAt
- MOV must be 0.5-4 seconds duration
- Only queries photos uploaded in last 5 seconds (Firestore filter)
- O(1) lookup instead of O(n) scan

---

## Next Session TODO

**Start here tomorrow:**

1. **Test Priority Queue (5 min)**
   - Upload 50 photos from mobile
   - While uploading, open web gallery
   - Verify thumbnails load immediately

2. **Implement Timeline Pagination (1-2h)**
   - Add cursor pagination to timeline.ts
   - Update frontend to request in chunks
   - Test with 5000 photos

3. **Frontend Performance (2h)**
   - Throttle GalleryViewer scroll checks
   - Tune request queue settings
   - Remove duplicate downloads

4. **Stress Test (1h)**
   - Create test user with 5000 photos
   - Measure memory, FPS, load times
   - Identify remaining bottlenecks

5. **Polish (2h)**
   - Run retroactive live photo linking
   - Add trash feature
   - Add share links

**Total Estimate:** 6-7 hours to complete all critical fixes

---

## Files Changed This Session

### Backend
- `immich-api-shim/src/assets.ts` (priority queue)
- `immich-api-shim/src/helpers.ts` (cache eviction, token refresh)
- `immich-api-shim/src/search.ts` (archive field fix)
- `immich-api-shim/src/link-live-photos.ts` (NEW - retroactive linking)

### Frontend
- `immich/web/src/lib/utils/daemonclient-drive.ts` (object URL cleanup)
- `immich/web/src/lib/services/asset.service.ts` (client-side download)
- `immich/web/src/lib/components/assets/thumbnail/Thumbnail.svelte` (live photo display)
- `immich/web/src/lib/utils/adaptive-image-loader.svelte.ts` (missing start() method)
- `firebase.json` (cache headers)

### Not Deployed Yet
- Frontend changes not deployed (last deploy was Apr 26)
- To deploy: `cd immich/web && npm run build && firebase deploy`

---

## Deployment Checklist

**Before deploying:**
- [ ] Worker deployed ✅
- [ ] Frontend built
- [ ] Frontend deployed
- [ ] Test upload
- [ ] Test download
- [ ] Test live photos
- [ ] Test bulk upload (priority queue)
- [ ] Check browser console for errors

**After deploying:**
- [ ] Monitor Cloudflare Worker logs
- [ ] Monitor Firestore read/write counts
- [ ] Monitor Telegram API rate limits
- [ ] User feedback on thumbnails during upload

---

## Cost Analysis

**Current Usage (Single User):**
- Firestore: ~500 reads/day, ~100 writes/day ($0.00/day)
- Cloudflare Workers: ~5K requests/day ($0.00/day)
- Telegram API: ~1K requests/day ($0.00/day)
- Firebase Hosting: ~100MB bandwidth/day ($0.00/day)

**Projected Usage (1000 Photos):**
- Firestore: Without pagination = 50K reads/day ($0.15/day) ❌
- Firestore: With pagination = 1K reads/day ($0.00/day) ✅
- Timeline load: 10K photos × 5 bytes = 50KB (negligible)

**Conclusion:** Pagination is CRITICAL for cost efficiency at scale.

