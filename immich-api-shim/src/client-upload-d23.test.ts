// SPEC D23: a client upload from the phone carries its own preview and EXIF;
// the worker records them, so nothing has to download the original later.
import { describe, it, expect, vi } from 'vitest';

vi.mock('./cached-config', () => ({
  getCachedConfig: async () => ({ botToken: 'TESTBOT', channelId: '-100123' }),
}));

import { handleAssets } from './assets';
import { sqliteD1 } from './test-d1';
import { testSessionToken, testAuthEnv } from './test-session';
// Another package, so the type check (rootDir = this package) skips this import.
// @ts-ignore TS6059: outside rootDir on purpose; vitest resolves it fine.
import { MIGRATION_SQL } from '../../schema/schema.mjs';

async function clientUpload(fields: Record<string, string>) {
  const DB = sqliteD1(MIGRATION_SQL);
  const form = new FormData();
  const base: Record<string, string> = {
    clientUpload: 'true', telegramChunks: JSON.stringify([{ index: 0, message_id: 1, file_id: 'orig' }]),
    telegramOriginalId: 'orig', telegramThumbId: 'thumb', encryptionMode: 'server', thumbEncrypted: 'true',
    fileName: 'IMG_0001.HEIC', fileSize: '1000', mimeType: 'image/heic', checksum: 'c2hhMQ==',
    deviceAssetId: 'dev-1', deviceId: 'phone', fileCreatedAt: '2026-11-15T10:00:00.000Z',
  };
  for (const [k, v] of Object.entries({ ...base, ...fields })) form.append(k, v);
  const request = new Request('https://worker.test/api/assets', {
    method: 'POST', headers: { Authorization: `Bearer ${await testSessionToken()}` }, body: form,
  });
  const env: any = testAuthEnv({ DB, waitUntil: () => {} });
  const res = await handleAssets(request, env, '/api/assets', new URL(request.url));
  return { res, row: DB.rows('SELECT * FROM photos')[0] };
}

describe('a client upload with its own preview and EXIF', () => {
  it('records the preview, encrypted like the rest, and the EXIF, and marks EXIF as read', async () => {
    const { res, row } = await clientUpload({
      telegramPreviewId: 'preview-1',
      exif: JSON.stringify({ make: 'Apple', model: 'iPhone 15', iso: 50, orientation: 6, latitude: 41.3, longitude: 69.2 }),
    });
    expect([200, 201]).toContain(res.status);
    expect(row.telegramPreviewId).toBe('preview-1');
    expect(row.previewEncrypted).toBe(1);
    expect([row.make, row.model, row.iso, row.orientation]).toEqual(['Apple', 'iPhone 15', 50, '6']);
    expect([row.latitude, row.longitude]).toEqual([41.3, 69.2]);
    expect(row.exifChecked).toBe(2);
  });
  it('without EXIF, leaves it for the later check, as before', async () => {
    const { row } = await clientUpload({});
    expect(row.telegramPreviewId ?? null).toBeNull();
    expect(row.exifChecked ?? 0).toBe(0);
  });
  it('form coordinates still win over the EXIF ones', async () => {
    const { row } = await clientUpload({ latitude: '10.5', longitude: '20.5', exif: JSON.stringify({ latitude: 41.3, longitude: 69.2 }) });
    expect([row.latitude, row.longitude]).toEqual([10.5, 20.5]);
  });
  it('a bad preview id or bad EXIF never fails the upload', async () => {
    const { res, row } = await clientUpload({ telegramPreviewId: 'bad id<script>', exif: '{nope' });
    expect([200, 201]).toContain(res.status);
    expect(row.telegramPreviewId ?? null).toBeNull();
    expect(row.exifChecked ?? 0).toBe(0);
  });
  it('an unencrypted upload stores an unencrypted preview', async () => {
    const { row } = await clientUpload({ encryptionMode: 'off', thumbEncrypted: 'false', telegramPreviewId: 'p2' });
    expect([row.telegramPreviewId, row.previewEncrypted]).toEqual(['p2', 0]);
  });
});
