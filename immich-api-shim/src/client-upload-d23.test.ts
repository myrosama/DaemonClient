// SPEC D23: a client upload from the phone carries its own preview and EXIF;
// the worker records them, so nothing has to download the original later.
import { describe, it, expect, vi } from 'vitest';

vi.mock('./cached-config', () => ({
  getCachedConfig: async () => ({ botToken: 'TESTBOT', channelId: '-100123' }),
}));

import { handleAssets } from './assets';
import { toAssetManifest } from './asset-manifest';
import { sqliteD1 } from './test-d1';
import { testSessionToken, testAuthEnv } from './test-session';
// Another package, so the type check (rootDir = this package) skips this import.
// @ts-ignore TS6059: outside rootDir on purpose; vitest resolves it fine.
import { MIGRATION_SQL } from '../../schema/schema.mjs';

async function clientUpload(fields: Record<string, string>) {
  const DB = sqliteD1(MIGRATION_SQL);
  // The worker adds this column with a once-per-isolate step that an earlier
  // test in this file has already used up on its own database.
  await DB.prepare('ALTER TABLE photos ADD COLUMN telegramPlaybackChunks TEXT').run();
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
  it('an empty EXIF object (a screenshot) still counts as read, so the original is never fetched for it', async () => {
    const { row } = await clientUpload({ exif: '{}' });
    expect(row.exifChecked).toBe(2);
  });
  it('a preview with no thumbnail is still marked encrypted when the upload is', async () => {
    const { row } = await clientUpload({ telegramThumbId: '', thumbEncrypted: 'false', telegramPreviewId: 'p3' });
    expect([row.telegramPreviewId, row.previewEncrypted]).toEqual(['p3', 1]);
  });
  it('an empty preview id (what the phone sends with no preview) stores none', async () => {
    const { row } = await clientUpload({ telegramPreviewId: '' });
    expect(row.telegramPreviewId ?? null).toBeNull();
  });
  it('half a location, or one out of range, is not stored', async () => {
    for (const [lat, lon] of [['41.3', ''], ['', '69.2'], ['91', '69.2'], ['41.3', '181']]) {
      const { row } = await clientUpload({ latitude: lat, longitude: lon });
      expect([row.latitude ?? null, row.longitude ?? null]).toEqual([null, null]);
    }
  });
  it("records the phone's playback copy of a video, which the manifest then offers", async () => {
    const copy = [{ index: 0, message_id: 7, file_id: 'play-0' }, { index: 1, message_id: 8, file_id: 'play-1' }];
    const { row } = await clientUpload({ mimeType: 'video/quicktime', fileName: 'IMG_0002.MOV', telegramPlaybackChunks: JSON.stringify(copy), playbackSize: '25000000' });
    expect(JSON.parse(row.telegramPlaybackChunks)).toEqual({ size: 25000000, chunks: copy });
    const m = toAssetManifest(row);
    expect([m.playbackChunks, m.playbackSize]).toEqual([[{ index: 0, file_id: 'play-0' }, { index: 1, file_id: 'play-1' }], 25000000]);
  });
  it('a playback copy without a valid size, or with bad parts, is not stored, and the upload still succeeds', async () => {
    const good = JSON.stringify([{ index: 0, file_id: 'p0' }]);
    for (const [chunks, size] of [[good, ''], [good, '-5'], [good, '1.5'], ['not json', '10'], ['[]', '10'], [JSON.stringify([{ index: 0, file_id: 'bad id' }]), '10'], [JSON.stringify([{ index: -1, file_id: 'p0' }]), '10'], [JSON.stringify([null]), '10']]) {
      const { res, row } = await clientUpload({ telegramPlaybackChunks: chunks, playbackSize: size });
      expect([200, 201]).toContain(res.status);
      expect(row.telegramPlaybackChunks ?? null).toBeNull();
    }
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
