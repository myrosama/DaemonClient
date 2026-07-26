import { describe, it, expect } from 'vitest';
import { testSessionToken, TEST_SCOPE } from './test-session';
import { handleSyncStream } from './sync';

// requireAuth just base64-decodes the cookie as JSON when APP_IDENTIFIER is unset
// (the signed-token path is skipped). idToken's middle segment decodes to a far
// future {exp} so requireAuth never takes the refresh path.
async function sessionCookie(): Promise<string> {
  return testSessionToken('u1', 'u1@example.com');
}
async function req(): Promise<Request> {
  return new Request('https://worker.test/api/sync/stream', {
    headers: { Cookie: `immich_access_token=${await sessionCookie()}` },
  });
}

// Minimal D1 stub. Routes:
//  - main photo SELECT (has `ORDER BY fileCreatedAt`) → the library
//  - queryPhotos isTrashed=1 (tombstones)            → none
//  - `SELECT value FROM config`                       → configStore
//  - `INSERT OR REPLACE INTO config`                  → writes configStore
function makeEnv(photos: any[], configStore: Record<string, string> = {}): any {
  const DB = {
    prepare: (sql: string) => ({
      bind: (...args: any[]) => ({
        all: async () => (/ORDER BY fileCreatedAt/i.test(sql) ? { results: photos } : { results: [] }),
        first: async () => {
          if (/SELECT value FROM config/i.test(sql)) {
            const v = configStore[args[0]];
            return v !== undefined ? { value: v } : null;
          }
          return null;
        },
        run: async () => {
          if (/INSERT OR REPLACE INTO config/i.test(sql)) configStore[args[0]] = args[1];
          return {};
        },
      }),
    }),
  };
  return { env: { DB, APP_IDENTIFIER: 'test-app', SESSION_SECRET: TEST_SCOPE, FIREBASE_API_KEY: '' }, configStore };
}

function photo(id: string, checksum: string, date: string, extra: Record<string, any> = {}) {
  return { id, ownerId: 'u1', checksum, fileName: `${id}.jpg`, mimeType: 'image/jpeg', fileSize: 1, width: 1, height: 1, fileCreatedAt: date, uploadedAt: date, ...extra };
}

async function streamEvents(res: Response): Promise<any[]> {
  const text = await res.text();
  return text.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// Learn the current SYNC_RESET_EPOCH value (without hardcoding it) by running a
// sync once and reading the epoch the worker records.
async function currentEpoch(): Promise<string> {
  const probe = makeEnv([photo('p0', 'Z', '2024-01-01T00:00:00Z')]);
  await streamEvents(await handleSyncStream(await req(), probe.env));
  return probe.configStore.syncResetEpoch;
}

describe('handleSyncStream — duplicate-checksum dedup', () => {
  it('emits AssetV1 for the first of a duplicate-checksum pair and AssetDeleteV1 for the rest', async () => {
    const photos = [
      photo('p1', 'X', '2024-03-12T00:00:00Z'),
      photo('p2', 'X', '2024-03-12T00:00:00Z'), // duplicate checksum of p1
      photo('p3', 'Y', '2024-03-11T00:00:00Z'),
    ];
    // Seed the current epoch so the stream does a normal full sync (not a reset).
    const { env } = makeEnv(photos, { syncResetEpoch: await currentEpoch() });
    const events = await streamEvents(await handleSyncStream(await req(), env));

    const assetIds = events.filter((e) => e.type === 'AssetV1').map((e) => e.data.id);
    const deletedIds = events.filter((e) => e.type === 'AssetDeleteV1').map((e) => e.data.assetId);
    expect(assetIds).toEqual(['p1', 'p3']);      // p2 NOT emitted as an asset
    expect(deletedIds).toContain('p2');          // p2 told to be removed (no ghost)
    // Every emitted checksum is unique → the app's UNIQUE(owner_id, checksum) holds.
    const checksums = events.filter((e) => e.type === 'AssetV1').map((e) => e.data.checksum);
    expect(new Set(checksums).size).toBe(checksums.length);
  });

  it('deletes the duplicate BEFORE emitting the survivor that takes over its checksum', async () => {
    // The phone upserts remote assets keyed by id, under a partial unique index
    // UQ_remote_assets_owner_checksum. If the loser row is already on the phone
    // holding checksum X and we send the winner's AssetV1 (also checksum X)
    // first, that insert violates the index, the sync isolate throws, and ALL
    // remote sync aborts — on every subsequent sync too, since the stream
    // replays identically. The delete has to land first.
    const photos = [
      photo('p1', 'X', '2024-03-12T00:00:00Z'),
      photo('p2', 'X', '2024-03-12T00:00:00Z'),
    ];
    const { env } = makeEnv(photos, { syncResetEpoch: await currentEpoch() });
    const events = await streamEvents(await handleSyncStream(await req(), env));

    const deleteIdx = events.findIndex((e) => e.type === 'AssetDeleteV1' && e.data.assetId === 'p2');
    const winnerIdx = events.findIndex((e) => e.type === 'AssetV1' && e.data.id === 'p1');
    expect(deleteIdx).toBeGreaterThanOrEqual(0);
    expect(winnerIdx).toBeGreaterThanOrEqual(0);
    expect(deleteIdx).toBeLessThan(winnerIdx);
  });

  it('repoints a still at the surviving copy when its motion loses the dedup', async () => {
    // still1 links to mov_dup, which shares a checksum with mov_keep and loses
    // the dedup. Emitting the still with a livePhotoVideoId that the very same
    // stream deletes leaves a dangling reference; the survivor must inherit the
    // link, and must be hidden from the grid because it is now the companion.
    const photos = [
      photo('mov_keep', 'V', '2024-03-12T00:00:02Z', { mimeType: 'video/quicktime' }),
      photo('mov_dup', 'V', '2024-03-12T00:00:01Z', { mimeType: 'video/quicktime' }),
      photo('still1', 'I', '2024-03-12T00:00:00Z', { livePhotoVideoId: 'mov_dup' }),
    ];
    const { env } = makeEnv(photos, { syncResetEpoch: await currentEpoch() });
    const events = await streamEvents(await handleSyncStream(await req(), env));

    const assets = events.filter((e) => e.type === 'AssetV1');
    const deletedIds = events.filter((e) => e.type === 'AssetDeleteV1').map((e) => e.data.assetId);
    const still = assets.find((e) => e.data.id === 'still1')!;
    const survivor = assets.find((e) => e.data.id === 'mov_keep')!;

    expect(deletedIds).toContain('mov_dup');
    expect(still.data.livePhotoVideoId).toBe('mov_keep'); // remapped, not dangling
    expect(survivor.data.visibility).toBe('hidden');      // inherits companion status
  });

  it('never emits an AssetV1 whose livePhotoVideoId is deleted in the same stream', async () => {
    const photos = [
      photo('mov_keep', 'V', '2024-03-12T00:00:02Z', { mimeType: 'video/quicktime' }),
      photo('mov_dup', 'V', '2024-03-12T00:00:01Z', { mimeType: 'video/quicktime' }),
      photo('still1', 'I', '2024-03-12T00:00:00Z', { livePhotoVideoId: 'mov_dup' }),
    ];
    const { env } = makeEnv(photos, { syncResetEpoch: await currentEpoch() });
    const events = await streamEvents(await handleSyncStream(await req(), env));

    const deleted = new Set(events.filter((e) => e.type === 'AssetDeleteV1').map((e) => e.data.assetId));
    for (const e of events.filter((x) => x.type === 'AssetV1')) {
      if (e.data.livePhotoVideoId) expect(deleted.has(e.data.livePhotoVideoId)).toBe(false);
    }
  });
});

describe('handleSyncStream — Dart strict-parse safety', () => {
  it('clamps an unknown visibility to timeline instead of emitting it verbatim', async () => {
    // AssetVisibility.fromJson(...)! throws on an unrecognised string, and one
    // throw aborts parsing of the entire stream — so a single row with a junk
    // visibility (PUT /api/assets accepts arbitrary strings) would kill sync
    // for the whole library until that row was fixed by hand.
    const photos = [
      photo('p1', 'X', '2024-03-12T00:00:00Z', { visibility: 'wat-is-this' }),
      photo('p2', 'Y', '2024-03-11T00:00:00Z', { visibility: 'archive' }),
    ];
    const { env } = makeEnv(photos, { syncResetEpoch: await currentEpoch() });
    const events = await streamEvents(await handleSyncStream(await req(), env));
    const byId = Object.fromEntries(
      events.filter((e) => e.type === 'AssetV1').map((e) => [e.data.id, e.data])
    );
    expect(byId.p1.visibility).toBe('timeline'); // junk clamped
    expect(byId.p2.visibility).toBe('archive');  // valid value preserved
  });

  it('emits booleans as real booleans even when D1 hands back integers', async () => {
    const photos = [photo('p1', 'X', '2024-03-12T00:00:00Z', { isFavorite: 1 })];
    const { env } = makeEnv(photos, { syncResetEpoch: await currentEpoch() });
    const events = await streamEvents(await handleSyncStream(await req(), env));
    const asset = events.find((e) => e.type === 'AssetV1')!;
    expect(asset.data.isFavorite).toBe(true);
    expect(typeof asset.data.isFavorite).toBe('boolean');
  });
});

describe('handleSyncStream — live-photo companion videos', () => {
  it('emits the motion (hidden) AND the still (linked), so backup tracks it but the grid hides it', async () => {
    const photos = [
      photo('still1', 'I', '2024-03-12T00:00:00Z', { livePhotoVideoId: 'mov1' }),
      photo('mov1', 'V', '2024-03-12T00:00:00Z', { mimeType: 'video/quicktime' }),
    ];
    const { env } = makeEnv(photos, { syncResetEpoch: await currentEpoch() });
    const events = await streamEvents(await handleSyncStream(await req(), env));
    const assets = events.filter((e) => e.type === 'AssetV1');
    const still = assets.find((e) => e.data.id === 'still1');
    const mov = assets.find((e) => e.data.id === 'mov1');

    expect(mov).toBeTruthy();                          // motion IS emitted (not skipped → no re-upload)
    expect(mov!.data.visibility).toBe('hidden');       // ...but hidden from the timeline grid
    expect(still!.data.visibility).toBe('timeline');
    expect(still!.data.livePhotoVideoId).toBe('mov1'); // still links to its motion
  });
});

describe('handleSyncStream — server-initiated reset', () => {
  it('emits SyncResetV1 (and no assets) when the stored epoch is stale, then records the new epoch', async () => {
    const photos = [photo('p1', 'X', '2024-03-12T00:00:00Z')];
    // No stored epoch → worker owes one reset.
    const { env, configStore } = makeEnv(photos);
    const events = await streamEvents(await handleSyncStream(await req(), env));

    expect(events.some((e) => e.type === 'SyncResetV1')).toBe(true);
    expect(events.some((e) => e.type === 'AssetV1')).toBe(false); // assets come on the re-sync
    expect(configStore.syncResetEpoch).toBeTruthy();              // epoch recorded → no loop
  });

  it('does a normal full sync (no reset) once the current epoch is already recorded', async () => {
    const photos = [photo('p1', 'X', '2024-03-12T00:00:00Z')];
    // Pre-seed the CURRENT epoch so no reset is owed. Run once to learn the epoch value.
    const probe = makeEnv([photo('p0', 'Z', '2024-01-01T00:00:00Z')]);
    await streamEvents(await handleSyncStream(await req(), probe.env));
    const currentEpoch = probe.configStore.syncResetEpoch;

    const { env } = makeEnv(photos, { syncResetEpoch: currentEpoch });
    const events = await streamEvents(await handleSyncStream(await req(), env));
    expect(events.some((e) => e.type === 'SyncResetV1')).toBe(false);
    expect(events.filter((e) => e.type === 'AssetV1').map((e) => e.data.id)).toEqual(['p1']);
  });
});
