import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// heicConvertUrl is REQUIRED: without it backfillHeicThumbBatch returns at
// assets.ts:2841 before ever fetching a key, and a test asserting "nothing was
// stamped" would pass simply because the job never ran.
vi.mock('./cached-config', () => ({
  getCachedConfig: async () => ({
    botToken: 'BACKFILLBOT',
    channelId: '-100123',
    heicConvertUrl: 'https://user-processor.example.com/convert',
  }),
}));

import { backfillChecksumBatch, backfillHeicThumbBatch } from './assets';

// Missing key material must not permanently retire healable rows.
//
// Both background backfills fetch the ZKE key lazily and, before the
// fail-closed change, handled a missing one by simply not proceeding:
// `if (isServerZke && !serverKey) return;` in the HEIC job, and a guard that
// left `checksum` null in the checksum job, which then hit an explicit
// "transient failure — leaving unstamped for retry" branch.
//
// Making getEncryptionKey THROW turned both of those graceful skips into a jump
// into the per-row catch — and both catches stamp the row as permanently
// checked (`heicThumbChecked` / `checksumChecked`). So a config fault, which is
// install-wide and lasts until a human fixes it, would have been recorded as
// "this row is permanently unfixable" for every server-encrypted photo the job
// touched. Fixing the keys afterwards would not undo it.
//
// These jobs run on every timeline load and every sync, so the whole broken
// window would have been spent chewing through the library irreversibly. The
// checksum one matters most: the comment at its stamping site records that
// retiring healable rows leaves "photos duplicated on the phone with no path
// back".

const BROKEN_ZKE = [
  { key: 'zke_mode', value: 'server' },
  { key: 'zke_enabled', value: '1' },
  { key: 'zke_password', value: '' },
  { key: 'zke_salt', value: '' },
];

const photoRow = {
  id: 'p1',
  ownerId: 'u1',
  fileName: 'holiday.heic',
  fileSize: 1000,
  mimeType: 'image/heic',
  encryptionMode: 'server',
  telegramOriginalId: 'tg1',
  telegramChunks: JSON.stringify([{ index: 0, message_id: 1, file_id: 'c0' }]),
  checksum: null,
  checksumChecked: 0,
  heicThumbChecked: 0,
  telegramThumbId: null,
};

/** Records every UPDATE so a test can assert nothing was stamped. */
function trackingDb() {
  const updates: string[] = [];
  const answer = (sql: string) => {
    if (sql.includes('zke_')) return { results: BROKEN_ZKE };
    if (sql.startsWith('UPDATE')) return { results: [] };
    return { results: [photoRow] };
  };
  const db: any = {
    updates,
    prepare: (sql: string) => {
      if (sql.trim().startsWith('UPDATE')) updates.push(sql);
      const r = {
        bind: (..._a: any[]) => r,
        first: async () => (sql.includes('zke_') ? null : photoRow),
        all: async () => answer(sql),
        run: async () => ({}),
      };
      return r;
    },
  };
  return db;
}

let fetchSpy: any;
beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
    new Response(JSON.stringify({ ok: true, result: { file_path: 'x/y.bin' } }), {
      headers: { 'Content-Type': 'application/json' },
    }),
  );
});
afterEach(() => fetchSpy.mockRestore());

const stamped = (db: any, column: string) => db.updates.some((sql: string) => sql.includes(column));

describe('backfills when the encryption keys are unavailable', () => {
  it('the checksum backfill stamps nothing', async () => {
    const db = trackingDb();
    await backfillChecksumBatch({ DB: db } as any, 'u1', 'tok');
    expect(stamped(db, 'checksumChecked')).toBe(false);
  });

  it('the HEIC thumbnail backfill stamps nothing', async () => {
    const db = trackingDb();
    await backfillHeicThumbBatch({ DB: db } as any, 'u1', 'tok');
    expect(stamped(db, 'heicThumbChecked')).toBe(false);
  });

  it('neither writes anything at all', async () => {
    // Stronger than the above: a config fault is not this row's fault, so the
    // job's correct output is no database write of any kind.
    const a = trackingDb();
    await backfillChecksumBatch({ DB: a } as any, 'u1', 'tok');
    const b = trackingDb();
    await backfillHeicThumbBatch({ DB: b } as any, 'u1', 'tok');
    expect(a.updates).toEqual([]);
    expect(b.updates).toEqual([]);
  });
});
