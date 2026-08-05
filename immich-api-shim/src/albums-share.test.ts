import { describe, it, expect } from 'vitest';
import { testSessionToken, TEST_SCOPE } from './test-session';
import { handleAlbums } from './albums';

async function sessionCookie(): Promise<string> {
  return testSessionToken('u1', 'u1@example.com');
}

const ALBUMS = [{ id: 'A1', albumName: 'Trip', createdAt: 't', updatedAt: 't', albumThumbnailAssetId: null }];

function makeDb() {
  // Some adapter methods call .all()/.first() directly on the prepared
  // statement (no .bind()); expose the ops at both levels.
  const ops = (sql: string) => ({
    all: async () => {
      if (/FROM albums/i.test(sql)) return { results: ALBUMS };
      return { results: [] };
    },
    first: async () => {
      if (/FROM albums WHERE id/i.test(sql)) return ALBUMS[0];
      if (/FROM photos WHERE id/i.test(sql)) return { id: 'p1' };
      if (/COUNT/i.test(sql)) return { c: 0 };
      return null;
    },
    run: async () => ({}),
  });
  return {
    prepare: (sql: string) => ({
      ...ops(sql),
      bind: (..._args: any[]) => ops(sql),
    }),
  };
}

function makeEnv(): any {
  return { DB: makeDb(), APP_IDENTIFIER: 'test-app', SESSION_SECRET: TEST_SCOPE, FIREBASE_API_KEY: '' };
}

async function req(path: string, method = 'GET'): Promise<Request> {
  return new Request(`https://worker.test${path}`, {
    method,
    headers: { Cookie: `immich_access_token=${await sessionCookie()}` },
  });
}

async function jsonReq(path: string, method: string, body: unknown): Promise<Request> {
  return new Request(`https://worker.test${path}`, {
    method,
    headers: {
      Cookie: `immich_access_token=${await sessionCookie()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

describe('album sharing graceful behavior', () => {
  it('GET /api/albums?shared=true returns [] (no album is shared here)', async () => {
    const res = await handleAlbums(await req('/api/albums?shared=true'), makeEnv(), '/api/albums');
    const body = (await res.json()) as any[];
    expect(body).toEqual([]);
  });

  it('GET /api/albums (no shared param) still returns the album list', async () => {
    const res = await handleAlbums(await req('/api/albums'), makeEnv(), '/api/albums');
    const body = (await res.json()) as any[];
    expect(body.length).toBe(1);
    expect(body[0].id).toBe('A1');
    expect(body[0].albumUsers[0].role).toBe('owner');
    expect(body[0].albumUsers[0].user.id).toBe('u1');
  });

  it('GET /api/albums?assetId=... keeps the asset filter', async () => {
    const res = await handleAlbums(await req('/api/albums?assetId=p1&shared=true'), makeEnv(), '/api/albums');
    expect(res.status).toBe(200);
    expect((await res.json() as any[]).map((album) => album.id)).toEqual(['A1']);
  });

  it('GET /api/albums/statistics is not treated as album id "statistics"', async () => {
    const res = await handleAlbums(await req('/api/albums/statistics'), makeEnv(), '/api/albums/statistics');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ owned: 1, shared: 0, notShared: 1 });
  });

  it('PUT /api/albums/assets uses the bulk response contract', async () => {
    const res = await handleAlbums(
      await jsonReq('/api/albums/assets', 'PUT', { albumIds: ['A1'], assetIds: ['p1'] }),
      makeEnv(),
      '/api/albums/assets',
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
  });

  it('PUT /api/albums/{id}/assets returns one result per asset', async () => {
    const res = await handleAlbums(
      await jsonReq('/api/albums/A1/assets', 'PUT', { ids: ['p1'] }),
      makeEnv(),
      '/api/albums/A1/assets',
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ id: 'p1', success: true }]);
  });

  it('PUT /api/albums/{id}/users returns a shaped album, not a 404', async () => {
    const res = await handleAlbums(await req('/api/albums/A1/users', 'PUT'), makeEnv(), '/api/albums/A1/users');
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.id).toBe('A1');
    expect(Array.isArray(body.albumUsers)).toBe(true);
  });

  it('DELETE /api/albums/{id}/user/{userId} returns 200, not a 404', async () => {
    const res = await handleAlbums(await req('/api/albums/A1/user/u2', 'DELETE'), makeEnv(), '/api/albums/A1/user/u2');
    expect(res.status).toBe(200);
  });
});
