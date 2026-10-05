import { describe, it, expect } from 'vitest';
import { isAllowedOrigin, sameSecret, sessionTokenFrom, telegramBotToken } from './relay-policy';

// The Photos service worker's real URL builders — another package, so the type
// check (rootDir = this package) is told to skip this one import.
// @ts-ignore TS6059: outside rootDir on purpose; vitest resolves it fine.
import { buildDownloadUrl, buildGetFileUrl } from '../../immich/web/src/service-worker/telegram-media';

const TOKEN = '123456789:AAH-real_Token-value';
const OTHER = '987654321:BBH-someone_else';

describe('telegramBotToken', () => {
  it('reads the bot from the URLs the Photos service worker actually builds', () => {
    const proxy = 'https://dc-x.sub.workers.dev/proxy';
    for (const built of [buildGetFileUrl(proxy, TOKEN, 'FILE-1'), buildDownloadUrl(proxy, TOKEN, 'photos/file_7.jpg')]) {
      const target = new URL(new URL(built).searchParams.get('url')!);
      expect(telegramBotToken(target)).toBe(TOKEN);
    }
  });

  it("reads the bot from Drive's upload / download / delete URLs", () => {
    for (const raw of [
      `https://api.telegram.org/bot${TOKEN}/sendDocument`,
      `https://api.telegram.org/bot${TOKEN}/getFile?file_id=x`,
      `https://api.telegram.org/file/bot${TOKEN}/documents/file_1.bin`,
      `https://api.telegram.org/bot${TOKEN}/deleteMessage`,
    ]) {
      expect(telegramBotToken(new URL(raw))).toBe(TOKEN);
    }
  });

  it('finds nothing in paths that are not bot calls', () => {
    for (const raw of ['https://api.telegram.org/', 'https://api.telegram.org/getMe', 'https://api.telegram.org/botX', 'https://api.telegram.org/x/bot1:2/getMe']) {
      expect(telegramBotToken(new URL(raw))).toBeNull();
    }
  });

  it('a percent-encoded token decodes to the same bot; a broken encoding is nothing', () => {
    expect(telegramBotToken(new URL(`https://api.telegram.org/bot${TOKEN.replace(':', '%3A')}/getMe`))).toBe(TOKEN);
    expect(telegramBotToken(new URL('https://api.telegram.org/bot%E0%A4%A/getMe'))).toBeNull();
  });
});

describe('sameSecret', () => {
  it('is true only for identical strings', () => {
    expect(sameSecret(TOKEN, TOKEN)).toBe(true);
    expect(sameSecret(TOKEN, OTHER)).toBe(false);
    expect(sameSecret(TOKEN, TOKEN + 'x')).toBe(false);
    expect(sameSecret(TOKEN, TOKEN.slice(0, -1))).toBe(false);
    expect(sameSecret('', TOKEN)).toBe(false);
    expect(sameSecret('', '')).toBe(true);
  });
});

describe('isAllowedOrigin', () => {
  const allowed = 'https://photos.daemonclient.uz, https://drive.daemonclient.uz,https://accounts.daemonclient.uz,http://localhost:5173';
  it('accepts exactly the configured origins', () => {
    for (const o of ['https://photos.daemonclient.uz', 'https://drive.daemonclient.uz', 'https://accounts.daemonclient.uz', 'http://localhost:5173']) {
      expect(isAllowedOrigin(o, allowed)).toBe(true);
    }
  });
  it('refuses look-alikes, other ports and anything merely containing "localhost"', () => {
    for (const o of ['https://localhost.evil.example', 'https://evil-localhost.example', 'http://localhost:5174', 'http://localhost',
      'https://photos.daemonclient.uz.evil.example', 'http://photos.daemonclient.uz', 'null', '']) {
      expect(isAllowedOrigin(o, allowed)).toBe(false);
    }
  });
});

describe('sessionTokenFrom', () => {
  it('a Bearer header wins over any cookie', () => {
    expect(sessionTokenFrom('Bearer chosen', '__session=shared-cookie; immich_access_token=old')).toBe('chosen');
  });
  it('falls back to the cookies when there is no Bearer header', () => {
    expect(sessionTokenFrom(null, 'immich_access_token=abc')).toBe('abc');
    expect(sessionTokenFrom('', 'x=1; __session=def')).toBe('def');
    expect(sessionTokenFrom('Basic zzz', 'immich_access_token=abc')).toBe('abc');
  });
  it('does not match a cookie whose name merely ends in the same words', () => {
    expect(sessionTokenFrom(null, 'not_immich_access_token=evil')).toBeNull();
    expect(sessionTokenFrom(null, 'x__session=evil')).toBeNull();
  });
  it('an empty Bearer is no token', () => {
    expect(sessionTokenFrom('Bearer ', null)).toBeNull();
  });
});
