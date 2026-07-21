import { describe, it, expect } from 'vitest';
import { handleSyncStream } from './sync';

// requireAuth just base64-decodes the cookie as JSON when APP_IDENTIFIER is unset
// (the signed-token path is skipped). idToken's middle segment decodes to a far
// future {exp} so requireAuth never takes the refresh path.
function sessionCookie(): string {
  return btoa(JSON.stringify({
    uid: 'u1', email: 'u1@example.com',
    idToken: 'a.' + btoa(JSON.stringify({ exp: 4102444800 })) + '.c',
    refreshToken: 'r', exp: 4102444800000,
  }));
}
function req(): Request {
  return new Request('https://worker.test/api/sync/stream', {
    headers: { Cookie: `immich_access_token=${sessionCookie()}` },
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
  return { env: { DB, APP_IDENTIFIER: '', FIREBASE_API_KEY: '' }, configStore };
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
  await streamEvents(await handleSyncStream(req(), probe.env));
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
    const events = await streamEvents(await handleSyncStream(req(), env));

    const assetIds = events.filter((e) => e.type === 'AssetV1').map((e) => e.data.id);
    const deletedIds = events.filter((e) => e.type === 'AssetDeleteV1').map((e) => e.data.assetId);
    expect(assetIds).toEqual(['p1', 'p3']);      // p2 NOT emitted as an asset
    expect(deletedIds).toContain('p2');          // p2 told to be removed (no ghost)
    // Every emitted checksum is unique → the app's UNIQUE(owner_id, checksum) holds.
    const checksums = events.filter((e) => e.type === 'AssetV1').map((e) => e.data.checksum);
    expect(new Set(checksums).size).toBe(checksums.length);
  });
});

describe('handleSyncStream — live-photo companion videos', () => {
  it('emits the motion (hidden) AND the still (linked), so backup tracks it but the grid hides it', async () => {
    const photos = [
      photo('still1', 'I', '2024-03-12T00:00:00Z', { livePhotoVideoId: 'mov1' }),
      photo('mov1', 'V', '2024-03-12T00:00:00Z', { mimeType: 'video/quicktime' }),
    ];
    const { env } = makeEnv(photos, { syncResetEpoch: await currentEpoch() });
    const events = await streamEvents(await handleSyncStream(req(), env));
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
    const events = await streamEvents(await handleSyncStream(req(), env));

    expect(events.some((e) => e.type === 'SyncResetV1')).toBe(true);
    expect(events.some((e) => e.type === 'AssetV1')).toBe(false); // assets come on the re-sync
    expect(configStore.syncResetEpoch).toBeTruthy();              // epoch recorded → no loop
  });

  it('does a normal full sync (no reset) once the current epoch is already recorded', async () => {
    const photos = [photo('p1', 'X', '2024-03-12T00:00:00Z')];
    // Pre-seed the CURRENT epoch so no reset is owed. Run once to learn the epoch value.
    const probe = makeEnv([photo('p0', 'Z', '2024-01-01T00:00:00Z')]);
    await streamEvents(await handleSyncStream(req(), probe.env));
    const currentEpoch = probe.configStore.syncResetEpoch;

    const { env } = makeEnv(photos, { syncResetEpoch: currentEpoch });
    const events = await streamEvents(await handleSyncStream(req(), env));
    expect(events.some((e) => e.type === 'SyncResetV1')).toBe(false);
    expect(events.filter((e) => e.type === 'AssetV1').map((e) => e.data.id)).toEqual(['p1']);
  });
});
