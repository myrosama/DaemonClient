import type { Env } from './index';
import { requireAuth, firestoreQuery } from './helpers';
import { D1Adapter } from './d1-adapter';
import { backfillExifBatch, backfillChecksumBatch, backfillHeicThumbBatch, purgeExpiredTombstones } from './assets';
import { repairLivePhotoLinks } from './link-live-photos';

// Fire at most once per Worker isolate lifetime (typically 30 min – a few hours).
// Sync is called every few minutes by the mobile app, so this ensures long-lived
// sessions still get worker updates even when the user never re-logs in.
let lastAutoUpdateAttempt = 0;

// Round-robin cursor over the background heal jobs — one job per sync
// invocation (see the dispatch block at the end of handleSyncStream).
let healJobCursor = 0;

// The only visibility values the mobile app can parse. AssetVisibility.fromJson
// returns null for anything else and SyncAssetV1.fromJson force-unwraps it, so
// one unexpected string throws and takes the WHOLE sync down — for every asset,
// on every sync, until that row is repaired. PUT /api/assets stores whatever
// visibility a client sends, so this clamp is the last line of defence.
const VALID_VISIBILITY = new Set(['timeline', 'hidden', 'archive', 'locked']);
function safeVisibility(v: any): string {
  return typeof v === 'string' && VALID_VISIBILITY.has(v) ? v : 'timeline';
}

// Bump this to force every per-user worker to emit ONE SyncResetV1 (a client
// rebuild) on its next sync. Use after a data change that can leave the phone
// holding "ghost" asset rows — e.g. a dedup/heal that removed a duplicate whose
// checksum now belongs to a different surviving asset id, which violates the
// app's UNIQUE(owner_id, checksum) and aborts ALL sync. The worker records the
// epoch in its own D1 after firing, so it never loops and needs no external access.
const SYNC_RESET_EPOCH = '1';

export async function handleSyncStream(request: Request, env: Env): Promise<Response> {
  const session = await requireAuth(request, env);

  // Piggy-back the auto-update on sync rather than only on login.
  // Rate-limit to once per isolate to avoid hammering the deployment service.
  const now = Date.now();
  if (env.DEPLOYMENT_SERVICE_URL && env.waitUntil && now - lastAutoUpdateAttempt > 60 * 60 * 1000) {
    lastAutoUpdateAttempt = now;
    env.waitUntil(
      fetch(env.DEPLOYMENT_SERVICE_URL.replace(/\/$/, '') + '/auto-update', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${session.idToken}`, 'Content-Type': 'application/json' },
        body: '{}',
      }).catch(err => console.error('[auto-update/sync] dispatch failed:', err))
    );
  }

  let reqBody: any = {};
  if (request.method === 'POST' && request.headers.get('content-type')?.includes('json')) {
    reqBody = await request.json();
  }

  // Per-user workers (env.DB bound) read from D1; central worker still uses
  // Firestore. Without this branch, sync was always doing a full Firestore
  // collection scan on every page load — adding ~150-300ms to boot even when
  // the user had zero photos.
  // Include live-photo companion videos (a still's livePhotoVideoId) — they MUST
  // reach the phone's remote_asset_entity, or its backup-candidate query
  // (notExists remote checksum) treats them as un-backed-up and re-uploads each
  // motion as a standalone clip. We emit them with visibility:'hidden' below so
  // the timeline grid (which filters visibility=0) excludes them — exactly how
  // real Immich keeps motions tracked-but-hidden.
  // Narrow projection, deliberately NOT `SELECT *` + normalizeRow. The stream
  // below reads only these columns, while `SELECT *` also dragged in every
  // row's telegramChunks JSON — and normalizeRow JSON.parse'd it for EVERY row
  // plus spread each row into a fresh object. On a 1300-photo library that is
  // thousands of pointless parses/allocations on the single most-called
  // endpoint, and it counted against the same CPU/memory budget whose overrun
  // Cloudflare kills as error 1102 (the app then reports sync as failed).
  const photos = env.DB
    ? (await env.DB.prepare(
        `SELECT id, checksum, deviceAssetId, deviceId, mimeType, type, duration,
                fileCreatedAt, fileModifiedAt, uploadedAt, width, height,
                isFavorite, livePhotoVideoId, fileName, thumbhash, visibility
         FROM photos
         WHERE ownerId = ? AND (isTrashed = 0 OR isTrashed IS NULL)
         ORDER BY fileCreatedAt DESC, id ASC`
      ).bind(session.uid).all()).results.map((r: any) => ({ ...r, _id: r.id, originalFileName: r.fileName }))
    : await firestoreQuery(env, session.uid, 'photos', session.idToken, 'fileCreatedAt', 'DESCENDING');

  const adapter = env.DB ? new D1Adapter(env.DB) : null;

  // Has this worker already delivered the current reset epoch to the client? If
  // the stored epoch differs from SYNC_RESET_EPOCH, we owe it one SyncResetV1.
  const resetNeeded = adapter
    ? (await adapter.getJsonConfig<string>('syncResetEpoch')) !== SYNC_RESET_EPOCH
    : false;

  // Tombstones: soft-deleted rows (Telegram data gone, D1 row kept with isTrashed=1).
  // Emit AssetDeleteV1 for each so mobile removes them from its local DB on sync.
  // Only the id is needed for AssetDeleteV1 — same narrow-projection reasoning.
  const deletedPhotos = env.DB
    ? (await env.DB.prepare(
        `SELECT id FROM photos WHERE ownerId = ? AND isTrashed = 1`
      ).bind(session.uid).all()).results.map((r: any) => ({ _id: r.id }))
    : [];

  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: any) => {
        controller.enqueue(new TextEncoder().encode(JSON.stringify(obj) + '\n'));
      };

      if (reqBody.reset) {
        send({ type: 'SyncResetV1', data: {}, ack: 'SyncResetV1|reset' });
        controller.close();
        return;
      }

      // Server-initiated reset: emit SyncResetV1 so the app wipes its remote-entity
      // tables (clearing stale/ghost rows), then re-pulls the clean full set on the
      // follow-up sync it triggers. Record the epoch first so the re-sync doesn't loop.
      if (resetNeeded && adapter) {
        await adapter.setJsonConfig('syncResetEpoch', SYNC_RESET_EPOCH);
        send({ type: 'SyncResetV1', data: {}, ack: 'SyncResetV1|reset' });
        send({ type: 'SyncCompleteV1', data: {}, ack: `SyncCompleteV1|${new Date().toISOString()}` });
        controller.close();
        return;
      }

      // Pre-flight UserV1 sync to satisfy SQLite Foreign Key constraints for ownerId
      send({
        type: 'UserV1',
        data: {
          id: session.uid,
          email: session.email || 'user@example.com',
          name: (session.email || 'User').split('@')[0],
          avatarColor: 'primary',
          hasProfileImage: false,
          profileChangedAt: new Date().toISOString(),
          deletedAt: null
        },
        ack: `UserV1|${session.uid}`,
        ids: [session.uid]
      });

      // ── Pre-pass: resolve duplicates BEFORE emitting anything ─────────────
      // Two rows can share a checksum (legacy overload-era uploads, or a heal
      // that filled in a checksum matching an existing row). Exactly one may
      // reach the phone: its remote_asset table has a partial unique index on
      // (owner_id, checksum), and a violation throws inside the sync isolate,
      // which aborts ALL remote sync — permanently, because every later sync
      // replays the identical stream.
      //
      // Deciding winners up front buys two things the old inline loop could
      // not: the losers' AssetDeleteV1 can be emitted FIRST (so the phone frees
      // the checksum before the survivor claims it), and a still whose motion
      // lost can be repointed at the survivor instead of at an id this very
      // stream deletes.
      const winnerByChecksum = new Map<string, string>(); // checksum -> winning id
      const remap = new Map<string, string>();            // loser id -> winner id
      const loserIds: string[] = [];
      for (const p of photos) {
        if (!p) continue;
        const csum = p.checksum || p._id;
        const winner = winnerByChecksum.get(csum);
        if (winner === undefined) {
          winnerByChecksum.set(csum, p._id);
        } else {
          remap.set(p._id, winner);
          loserIds.push(p._id);
        }
      }

      // Companion motions, resolved through the remap so a still that pointed
      // at a losing duplicate marks the SURVIVOR as the hidden companion.
      const livePhotoVideoIds = new Set<string>();
      for (const p of photos) {
        if (!p?.livePhotoVideoId) continue;
        livePhotoVideoIds.add(remap.get(p.livePhotoVideoId) || p.livePhotoVideoId);
      }

      // Losers go out first — the phone must drop these ids (and release their
      // checksums) before any survivor arrives holding the same checksum.
      for (const id of loserIds) {
        send({ type: 'AssetDeleteV1', data: { assetId: id }, ack: `AssetDeleteV1|${id}`, ids: [id] });
      }

      const emitted = new Set<string>();
      // Send all assets
      for (const photo of photos) {
        if (!photo) continue;
        if (remap.has(photo._id)) continue; // duplicate loser, already deleted above
        if (emitted.has(photo._id)) continue;
        emitted.add(photo._id);

        // A companion motion video (some still's livePhotoVideoId points at it) is
        // emitted but marked hidden, so the phone tracks it (no re-upload) yet keeps
        // it out of the timeline grid.
        const isCompanionMotion = livePhotoVideoIds.has(photo._id);

        // Emit the real checksum so the app can merge the phone's local copy with
        // this remote one (matching base64(SHA-1)). Falling back to _id when it's
        // missing is only to keep the in-sync de-dup key stable for legacy rows
        // that haven't been backfilled yet — those still show twice until the next
        // upload backfills their checksum (see handleUpload).
        const csum = photo.checksum || photo._id;

        const isVideo = photo.mimeType?.startsWith('video/') || photo.type === 'VIDEO';
        const dateStr = photo.fileCreatedAt || photo.uploadedAt || new Date().toISOString();
        const assetData = {
          id: photo._id,
          deviceAssetId: photo.deviceAssetId || photo._id,
          deviceId: photo.deviceId || '',
          type: isVideo ? 'VIDEO' : 'IMAGE',
          checksum: csum,
          fileCreatedAt: dateStr,
          fileModifiedAt: photo.fileModifiedAt || dateStr,
          deletedAt: null,
          duration: (!photo.duration || photo.duration === '0' || photo.duration === '0.000' || photo.duration === '0:00:00.00000') ? null : photo.duration,
          height: photo.height || 0,
          isEdited: false,
          // MUST be a real boolean: D1 stores isFavorite as INTEGER (0/1).
          // `1 || false` evaluates to the number 1, and the native Dart app's
          // AssetV1.fromJson requires a bool — an int 1 throws in the sync
          // isolate (runInIsolateGentle) and aborts ALL remote sync, so no
          // photos load. `!!` coerces both D1 ints and Firestore bools correctly.
          isFavorite: !!photo.isFavorite,
          libraryId: null,
          // Through the remap: if this still's motion lost a checksum dedup,
          // point at the survivor rather than at an id deleted in this stream.
          livePhotoVideoId: photo.livePhotoVideoId
            ? (remap.get(photo.livePhotoVideoId) || photo.livePhotoVideoId)
            : null,
          localDateTime: dateStr,
          originalFileName: photo.originalFileName || photo.fileName || photo._id,
          ownerId: session.uid,
          stackId: null,
          thumbhash: photo.thumbhash || null,
          visibility: isCompanionMotion ? 'hidden' : safeVisibility(photo.visibility),
          width: photo.width || 0,
        };

        send({
          type: 'AssetV1',
          data: assetData,
          ack: `AssetV1|${photo._id}`,
          ids: [photo._id]
        });

        // NOTE: AssetExifV1 is intentionally NOT emitted here. Streaming it
        // interleaved with AssetV1 broke the mobile sync entirely — the native
        // app parses every event in a strict Dart isolate and a single bad
        // event (or unexpected interleaving with the exif checkpoint) aborts
        // ALL remote sync, so NO photos/videos load and backup appears dead.
        // EXIF still reaches the apps the safe ways: the web map + the asset
        // detail DTO (toAssetResponseDto.exifInfo), and the native app pulls
        // per-asset EXIF from /api/assets/:id when a photo is opened. Re-adding
        // EXIF to the sync stream must be verified against on-device sync logs
        // first (see docs/roadmap notes) — do NOT reintroduce blindly.
      }

      // Emit delete events for tombstoned assets (isTrashed=1 in D1).
      // Mobile's deleteAssetsV1 handler removes these from its local DB.
      for (const photo of deletedPhotos) {
        if (!photo?._id) continue;
        send({
          type: 'AssetDeleteV1',
          data: { assetId: photo._id },
          ack: `AssetDeleteV1|${photo._id}`,
          ids: [photo._id],
        });
      }

      // Finally send complete
      const nowId = new Date().toISOString();
      send({ type: 'SyncCompleteV1', data: {}, ack: `SyncCompleteV1|${nowId}` });

      controller.close();
    }
  });

  // ── Background heal jobs: ONE per invocation, round-robin ─────────────────
  // These used to all dispatch on every sync. A Worker invocation's ~50
  // subrequests and its CPU/memory budget are SHARED with everything waitUntil
  // spawns, so four jobs racing each other (each downloading and decrypting
  // Telegram chunks) could exhaust the budget on their own — Cloudflare kills
  // the whole invocation with error 1102 and the app sees the *sync* fail, not
  // the background work. Rotating means each job still runs regularly (sync
  // fires every few minutes during use) while any single invocation carries at
  // most one job's load. Each job additionally self-guards for completion and
  // overlap, so a finished job costs one cheap query before it bows out.
  if (env.DB && env.waitUntil) {
    const jobs: Array<{ name: string; run: () => Promise<void> }> = [
      { name: 'ChecksumBackfill', run: () => backfillChecksumBatch(env, session.uid, session.idToken) },
      { name: 'LivePhotoRepair', run: () => repairLivePhotoLinks(env, session.uid) },
      { name: 'ExifBackfill', run: () => backfillExifBatch(env, session.uid, session.idToken) },
      { name: 'HeicThumbBackfill', run: () => backfillHeicThumbBatch(env, session.uid, session.idToken) },
      { name: 'Tombstones', run: () => purgeExpiredTombstones(env, session.uid) },
    ];
    const job = jobs[healJobCursor % jobs.length];
    healJobCursor++;
    env.waitUntil(
      job.run().catch(err => console.log(`[${job.name}] dispatch failed:`, err?.message))
    );
  }

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/jsonlines+json',
      'Transfer-Encoding': 'chunked'
    }
  });
}
