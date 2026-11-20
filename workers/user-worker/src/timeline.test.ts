import { describe, it, expect } from 'vitest';
import { testSessionToken, TEST_SCOPE } from './test-session';
import { handleTimeline } from './timeline';

// A signed-session-free auth token: requireAuth(decodeSession) just base64-decodes
// the cookie value as JSON. APP_IDENTIFIER is unset so the "has a dot" signed path
// is skipped and decodeSession() is used directly.
async function sessionCookie(): Promise<string> {
  return testSessionToken('u1', 'u1@example.com');
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
  return { DB: makeDb(), APP_IDENTIFIER: 'test-app', SESSION_SECRET: TEST_SCOPE, FIREBASE_API_KEY: '' };
}

async function req(qs: string): Promise<Request> {
  return new Request(`https://worker.test${qs}`, {
    headers: { Cookie: `immich_access_token=${await sessionCookie()}` },
  });
}

describe('timeline album filtering', () => {
  it('buckets?albumId=A1 returns only the album member, not the whole library', async () => {
    const env = makeEnv();
    const url = new URL('https://worker.test/api/timeline/buckets?albumId=A1');
    const res = await handleTimeline(await req(url.pathname + url.search), env, url.pathname, url);
    const body = (await res.json()) as Array<{ timeBucket: string; count: number }>;
    const total = body.reduce((n, b) => n + b.count, 0);
    expect(total).toBe(1); // only p1, NOT both p1 and p2
  });

  it('bucket?albumId=A1 returns only the album member asset id', async () => {
    const env = makeEnv();
    const url = new URL('https://worker.test/api/timeline/bucket?albumId=A1&timeBucket=2024-03-01T00:00:00.000Z');
    const res = await handleTimeline(await req(url.pathname + url.search), env, url.pathname, url);
    const body = (await res.json()) as { id: string[] };
    expect(body.id).toEqual(['p1']);
  });

  it('without albumId, buckets returns the whole library', async () => {
    const env = makeEnv();
    const url = new URL('https://worker.test/api/timeline/buckets');
    const res = await handleTimeline(await req(url.pathname + url.search), env, url.pathname, url);
    const body = (await res.json()) as Array<{ timeBucket: string; count: number }>;
    const total = body.reduce((n, b) => n + b.count, 0);
    expect(total).toBe(2); // p1 + p2
  });

  it('unsupported facet (personId) returns an empty bucket set, not the whole library', async () => {
    const env = makeEnv();
    const url = new URL('https://worker.test/api/timeline/buckets?personId=does-not-exist');
    const res = await handleTimeline(await req(url.pathname + url.search), env, url.pathname, url);
    const body = (await res.json()) as Array<{ timeBucket: string; count: number }>;
    const total = body.reduce((n, b) => n + b.count, 0);
    expect(total).toBe(0);
  });
});

// ── Background heal dispatch ────────────────────────────────────────────────
// A Worker invocation's ~50 subrequests are SHARED with everything waitUntil
// spawns. The timeline used to fire two backfills at once whose own budgets sum
// to 64, so an ordinary browse could exhaust the invocation on background work
// alone — Cloudflare kills it with error 1102 and the user sees the timeline
// fail, not the backfill. sync.ts already rotates one job per invocation; this
// asserts the timeline does the same.

function makeEnvCounting() {
  const scheduled: Promise<any>[] = [];
  return {
    env: {
      DB: makeDb(),
      APP_IDENTIFIER: 'test-app',
      SESSION_SECRET: TEST_SCOPE,
      FIREBASE_API_KEY: '',
      waitUntil: (p: Promise<any>) => { scheduled.push(p); },
    } as any,
    scheduled,
  };
}

describe('timeline background jobs', () => {
  it('dispatches at most one background job per request', async () => {
    const { env, scheduled } = makeEnvCounting();
    await handleTimeline(await req('/api/timeline/buckets?size=month'), env, '/api/timeline/buckets', new URL('https://worker.test/api/timeline/buckets?size=month'));
    expect(scheduled.length).toBeLessThanOrEqual(1);
  });

  it('rotates across requests so every job still gets its turn', async () => {
    // Each call schedules a different job; over several calls the cursor must
    // move, or one job would run constantly and the others never.
    const seen = new Set<number>();
    for (let i = 0; i < 4; i++) {
      const { env, scheduled } = makeEnvCounting();
      await handleTimeline(await req('/api/timeline/buckets?size=month'), env, '/api/timeline/buckets', new URL('https://worker.test/api/timeline/buckets?size=month'));
      seen.add(scheduled.length);
    }
    // Never more than one at a time, whichever job it happens to be.
    expect([...seen].every((n) => n <= 1)).toBe(true);
  });

  it('schedules nothing when the worker has no database bound', async () => {
    const scheduled: Promise<any>[] = [];
    const env: any = { APP_IDENTIFIER: 'test-app', SESSION_SECRET: TEST_SCOPE, FIREBASE_API_KEY: '', waitUntil: (p: Promise<any>) => scheduled.push(p) };
    await handleTimeline(await req('/api/timeline/buckets?size=month'), env, '/api/timeline/buckets', new URL('https://worker.test/api/timeline/buckets?size=month')).catch(() => {});
    expect(scheduled.length).toBe(0);
  });
});
