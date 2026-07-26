import { describe, it, expect } from 'vitest';
import { redactTelegramUrl } from './assets';

// A Telegram URL carries the bot token in its path. Anything that logs one
// hands whoever can read the worker's logs full control of the user's channel:
// every photo they own, and the ability to delete all of it.
//
// The rate-limit path used to log `url.substring(0, 80)`. The prefix
// "https://api.telegram.org/bot" is 28 characters and a bot token is ~46, so
// those 80 characters contained the entire token — logged on every 429, which
// under a backup storm is constant.

const TOKEN = '8154329871:AAHf3kZq7Lm2pXvN9dRtYuIoP0aSdFgHjKl';

describe('redactTelegramUrl', () => {
  it('removes the token from a Bot API call', () => {
    const out = redactTelegramUrl(`https://api.telegram.org/bot${TOKEN}/sendDocument`);
    expect(out).not.toContain(TOKEN);
    expect(out).toBe('https://api.telegram.org/bot<redacted>/sendDocument');
  });

  it('removes the token from a file download url', () => {
    const out = redactTelegramUrl(`https://api.telegram.org/file/bot${TOKEN}/documents/file_12.bin`);
    expect(out).not.toContain(TOKEN);
    expect(out).toBe('https://api.telegram.org/file/bot<redacted>/documents/file_12.bin');
  });

  // The old bug was a fixed-length prefix. Assert on the token, not on a length.
  it('leaves no fragment of the token behind', () => {
    const out = redactTelegramUrl(`https://api.telegram.org/bot${TOKEN}/getFile?file_id=abc`);
    for (const part of [TOKEN, TOKEN.split(':')[1], 'AAHf3kZq']) {
      expect(out).not.toContain(part);
    }
    // The numeric bot id is public (it is the bot's user id), but it is part of
    // the same path segment and goes with it.
    expect(out).not.toContain('8154329871');
  });

  it('keeps the method name, which is the reason the line is logged at all', () => {
    expect(redactTelegramUrl(`https://api.telegram.org/bot${TOKEN}/sendDocument`)).toContain('sendDocument');
    expect(redactTelegramUrl(`https://api.telegram.org/bot${TOKEN}/getFile?file_id=abc`)).toContain('file_id=abc');
  });

  it('stops at the query string rather than swallowing the rest of the url', () => {
    expect(redactTelegramUrl('https://api.telegram.org/bot123:ABC?x=1')).toBe(
      'https://api.telegram.org/bot<redacted>?x=1',
    );
  });

  it('passes through a url with no token in it', () => {
    expect(redactTelegramUrl('https://api.telegram.org/')).toBe('https://api.telegram.org/');
  });
});
