// Search must not return deleted photos, and must say which ones are deleted.
// It used to load every row and label each `isTrashed: false`, so a deleted
// photo came back from search looking like a live one.
import { describe, it, expect } from 'vitest';
import { handleSearch } from './search';
import { sqliteD1 } from './test-d1';
import { testSessionToken, testAuthEnv } from './test-session';
// Another package, so the type check (rootDir = this package) skips this import.
// @ts-ignore TS6059: outside rootDir on purpose; vitest resolves it fine.
import { MIGRATION_SQL } from '../../../packages/schema/schema.mjs';

async function library() {
  const DB = sqliteD1(MIGRATION_SQL);
  await DB.prepare('ALTER TABLE photos ADD COLUMN purgedAt TEXT').run();
  const rows = [
    { id: 'live', isTrashed: 0, purgedAt: null },
    { id: 'deleted', isTrashed: 1, purgedAt: null },
    { id: 'erased', isTrashed: 1, purgedAt: '2026-11-20T00:00:00.000Z' },
  ];
  for (const r of rows) {
    await DB.prepare(`INSERT INTO photos (id, ownerId, fileName, fileSize, mimeType, fileCreatedAt, uploadedAt, isTrashed, purgedAt)
      VALUES (?, 'u1', ?, 1, 'image/jpeg', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', ?, ?)`)
      .bind(r.id, `${r.id}.jpg`, r.isTrashed, r.purgedAt).run();
  }
  return DB;
}

async function search(body: object) {
  const DB = await library();
  const request = new Request('https://worker.test/api/search/metadata', {
    method: 'POST',
    headers: { Authorization: `Bearer ${await testSessionToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const res = await handleSearch(request, testAuthEnv({ DB }) as any, '/api/search/metadata');
  const items = ((await res.json()) as any).assets.items as any[];
  return Object.fromEntries(items.map((i) => [i.id, i.isTrashed]));
}

describe('search and deleted photos', () => {
  it('leaves deleted photos out by default', async () => {
    expect(await search({})).toEqual({ live: false });
  });

  it('includes them, marked deleted, when asked with withDeleted', async () => {
    expect(await search({ withDeleted: true })).toEqual({ live: false, deleted: true });
  });

  it('never returns a photo already erased from Telegram', async () => {
    expect('erased' in (await search({ withDeleted: true }))).toBe(false);
  });
});
