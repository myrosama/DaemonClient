import { describe, it, expect } from 'vitest';
import { handleAlbums } from './albums';

function sessionCookie(): string {
  const payload = {
    uid: 'u1',
    email: 'u1@example.com',
    idToken: 'a.' + btoa(JSON.stringify({ exp: 4102444800 })) + '.c',
    refreshToken: 'r',
    exp: 4102444800000,
  };
  return btoa(JSON.stringify(payload));
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
  return { DB: makeDb(), APP_IDENTIFIER: '', FIREBASE_API_KEY: '' };
}

function req(path: string, method = 'GET'): Request {
  return new Request(`https://worker.test${path}`, {
    method,
    headers: { Cookie: `immich_access_token=${sessionCookie()}` },
  });
}

describe('album sharing graceful behavior', () => {
  it('GET /api/albums?shared=true returns [] (no album is shared here)', async () => {
    const res = await handleAlbums(req('/api/albums?shared=true'), makeEnv(), '/api/albums');
    const body = (await res.json()) as any[];
    expect(body).toEqual([]);
  });

  it('GET /api/albums (no shared param) still returns the album list', async () => {
    const res = await handleAlbums(req('/api/albums'), makeEnv(), '/api/albums');
    const body = (await res.json()) as any[];
    expect(body.length).toBe(1);
    expect(body[0].id).toBe('A1');
  });

  it('PUT /api/albums/{id}/users returns a shaped album, not a 404', async () => {
    const res = await handleAlbums(req('/api/albums/A1/users', 'PUT'), makeEnv(), '/api/albums/A1/users');
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.id).toBe('A1');
    expect(Array.isArray(body.albumUsers)).toBe(true);
  });

  it('DELETE /api/albums/{id}/user/{userId} returns 200, not a 404', async () => {
    const res = await handleAlbums(req('/api/albums/A1/user/u2', 'DELETE'), makeEnv(), '/api/albums/A1/user/u2');
    expect(res.status).toBe(200);
  });
});
