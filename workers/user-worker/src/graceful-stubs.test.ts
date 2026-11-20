import { describe, it, expect } from 'vitest';
import { handleStubs } from './stubs';

const env: any = {};

function get(path: string, method = 'GET'): Request {
  return new Request(`https://worker.test${path}`, { method });
}

describe('graceful stubbed endpoints', () => {
  it('GET /api/shared-links/me returns a shaped object with assets as an array', async () => {
    const res = await handleStubs(get('/api/shared-links/me'), env, '/api/shared-links/me');
    const body = (await res.json()) as any;
    // The public share page does sharedLink.assets.length — must not throw.
    expect(Array.isArray(body.assets)).toBe(true);
    expect(body.assets.length).toBe(0);
    expect(typeof body.id).toBe('string');
  });

  it('GET /api/shared-links returns an array', async () => {
    const res = await handleStubs(get('/api/shared-links'), env, '/api/shared-links');
    const body = (await res.json()) as any;
    expect(Array.isArray(body)).toBe(true);
  });

  it('POST /api/shared-links returns a shaped object with an assets array', async () => {
    const res = await handleStubs(get('/api/shared-links', 'POST'), env, '/api/shared-links');
    const body = (await res.json()) as any;
    expect(Array.isArray(body.assets)).toBe(true);
  });

  it('PUT /api/tags returns an array (upsertTags must not crash)', async () => {
    const res = await handleStubs(get('/api/tags', 'PUT'), env, '/api/tags');
    const body = (await res.json()) as any;
    expect(Array.isArray(body)).toBe(true);
  });

  it('PUT /api/tags/{id}/assets returns an array (tagAssets must not crash)', async () => {
    const res = await handleStubs(get('/api/tags/abc/assets', 'PUT'), env, '/api/tags/abc/assets');
    const body = (await res.json()) as any;
    expect(Array.isArray(body)).toBe(true);
  });

  it('DELETE /api/tags/{id}/assets returns an array', async () => {
    const res = await handleStubs(get('/api/tags/abc/assets', 'DELETE'), env, '/api/tags/abc/assets');
    const body = (await res.json()) as any;
    expect(Array.isArray(body)).toBe(true);
  });
});
