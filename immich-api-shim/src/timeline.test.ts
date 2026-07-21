import { describe, it, expect } from 'vitest';
import { handleTimeline } from './timeline';

// A signed-session-free auth token: requireAuth(decodeSession) just base64-decodes
// the cookie value as JSON. APP_IDENTIFIER is unset so the "has a dot" signed path
// is skipped and decodeSession() is used directly.
function sessionCookie(): string {
  const payload = {
    uid: 'u1',
    email: 'u1@example.com',
    // idToken: a JWT whose middle segment decodes to {exp: <far future>} so the
    // refresh path in requireAuth is not taken.
    idToken: 'a.' + btoa(JSON.stringify({ exp: 4102444800 })) + '.c',
    refreshToken: 'r',
    exp: 4102444800000,
  };
  return btoa(JSON.stringify(payload));
}

// Two photos in the library; only photo p1 belongs to album A1.
const PHOTOS = [
  { id: 'p1', ownerId: 'u1', fileName: 'a.jpg', mimeType: 'image/jpeg', fileSize: 1, fileCreatedAt: '2024-03-10T00:00:00.000Z', uploadedAt: '2024-03-10T00:00:00.000Z' },
  { id: 'p2', ownerId: 'u1', fileName: 'b.jpg', mimeType: 'image/jpeg', fileSize: 1, fileCreatedAt: '2024-03-12T00:00:00.000Z', uploadedAt: '2024-03-12T00:00:00.000Z' },
];

const ALBUM_MEMBERS: Record<string, string[]> = { A1: ['p1'] };

// Minimal D1 stub: routes the two SELECTs we care about.
//  - `SELECT * FROM photos ...`        → all library photos
//  - `SELECT assetId FROM album_assets WHERE albumId = ?` → that album's members
function makeDb() {
  return {
    prepare: (sql: string) => ({
      bind: (...args: any[]) => ({
        all: async () => {
          if (/FROM album_assets/i.test(sql)) {
            const albumId = args[0];
            const ids = ALBUM_MEMBERS[albumId] || [];
            return { results: ids.map((assetId) => ({ assetId })) };
          }
          return { results: PHOTOS };
        },
        first: async () => null,
        run: async () => ({}),
      }),
    }),
  };
}

function makeEnv(): any {
  return { DB: makeDb(), APP_IDENTIFIER: '', FIREBASE_API_KEY: '' };
}

function req(qs: string): Request {
  return new Request(`https://worker.test${qs}`, {
    headers: { Cookie: `immich_access_token=${sessionCookie()}` },
  });
}

describe('timeline album filtering', () => {
  it('buckets?albumId=A1 returns only the album member, not the whole library', async () => {
    const env = makeEnv();
    const url = new URL('https://worker.test/api/timeline/buckets?albumId=A1');
    const res = await handleTimeline(req(url.pathname + url.search), env, url.pathname, url);
    const body = (await res.json()) as Array<{ timeBucket: string; count: number }>;
    const total = body.reduce((n, b) => n + b.count, 0);
    expect(total).toBe(1); // only p1, NOT both p1 and p2
  });

  it('bucket?albumId=A1 returns only the album member asset id', async () => {
    const env = makeEnv();
    const url = new URL('https://worker.test/api/timeline/bucket?albumId=A1&timeBucket=2024-03-01T00:00:00.000Z');
    const res = await handleTimeline(req(url.pathname + url.search), env, url.pathname, url);
    const body = (await res.json()) as { id: string[] };
    expect(body.id).toEqual(['p1']);
  });

  it('without albumId, buckets returns the whole library', async () => {
    const env = makeEnv();
    const url = new URL('https://worker.test/api/timeline/buckets');
    const res = await handleTimeline(req(url.pathname + url.search), env, url.pathname, url);
    const body = (await res.json()) as Array<{ timeBucket: string; count: number }>;
    const total = body.reduce((n, b) => n + b.count, 0);
    expect(total).toBe(2); // p1 + p2
  });

  it('unsupported facet (personId) returns an empty bucket set, not the whole library', async () => {
    const env = makeEnv();
    const url = new URL('https://worker.test/api/timeline/buckets?personId=does-not-exist');
    const res = await handleTimeline(req(url.pathname + url.search), env, url.pathname, url);
    const body = (await res.json()) as Array<{ timeBucket: string; count: number }>;
    const total = body.reduce((n, b) => n + b.count, 0);
    expect(total).toBe(0);
  });
});
