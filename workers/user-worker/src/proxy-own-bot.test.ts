import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import worker from './index';

// On a user's own worker, /proxy relays only for the owner's Telegram bot: the
// bot token in the Telegram path must equal the one this worker has on record
// (its D1 copy of the Telegram settings). Anything else — another bot, no token
// on record, or a database it can't read — is refused before any request
// leaves the worker.

const OWN = '123456789:AAH-owner-token';
const OTHER = '987654321:BBH-someone-else';

function fakeD1(telegram: unknown, opts: { fail?: boolean } = {}) {
  const statement = (sql: string) => ({
    bind: () => statement(sql),
    first: async () => {
      if (/FROM config/i.test(sql)) {
        if (opts.fail) throw new Error('D1 unavailable');
        return telegram === undefined ? null : { value: JSON.stringify(telegram) };
      }
      return null;
    },
    all: async () => ({ results: [] }),
    run: async () => ({}),
  });
  return { prepare: (sql: string) => statement(sql), batch: async () => [], exec: async () => ({}) };
}

const ctx: any = { waitUntil() {} };
const call = (env: any, target: string) =>
  worker.fetch(new Request(`https://dc-x.sub.workers.dev/proxy?url=${encodeURIComponent(target)}`), env, ctx);
const envWith = (DB: any) => ({ ALLOWED_ORIGINS: 'https://photos.daemonclient.uz', DB });

let fetchSpy: any;
beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));
});
afterEach(() => fetchSpy.mockRestore());

describe("/proxy on a user's worker relays only the owner's bot", () => {
  it("relays the owner's bot calls and file downloads", async () => {
    const env = envWith(fakeD1({ botToken: OWN, channelId: '-100' }));
    for (const target of [`https://api.telegram.org/bot${OWN}/sendDocument`, `https://api.telegram.org/file/bot${OWN}/documents/file_1.bin`]) {
      fetchSpy.mockClear();
      const res = await call(env, target);
      expect(res.status).toBe(200);
      expect(fetchSpy.mock.calls[0][0]).toBe(target);
    }
  });

  it('accepts the legacy bot_token field name too', async () => {
    const res = await call(envWith(fakeD1({ bot_token: OWN })), `https://api.telegram.org/bot${OWN}/getMe`);
    expect(res.status).toBe(200);
  });

  const refused: Array<[string, any, string]> = [
    ['another bot', fakeD1({ botToken: OWN }), `https://api.telegram.org/bot${OTHER}/sendDocument`],
    ["another bot's file", fakeD1({ botToken: OWN }), `https://api.telegram.org/file/bot${OTHER}/x.bin`],
    ['a call with no bot in the path', fakeD1({ botToken: OWN }), 'https://api.telegram.org/getMe'],
    ['no bot token on record', fakeD1(undefined), `https://api.telegram.org/bot${OWN}/getMe`],
    ['settings on record without a token', fakeD1({ channelId: '-100' }), `https://api.telegram.org/bot${OWN}/getMe`],
  ];
  for (const [name, db, target] of refused) {
    it(`refuses ${name}, and nothing leaves the worker`, async () => {
      const res = await call(envWith(db), target);
      expect(res.status).toBe(403);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  }

  it('a database it cannot read answers "try again" (503) — and still relays nothing', async () => {
    const res = await call(envWith(fakeD1({ botToken: OWN }, { fail: true })), `https://api.telegram.org/bot${OWN}/getMe`);
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fetches exactly the URL it checked', async () => {
    const env = envWith(fakeD1({ botToken: OWN }));
    await call(env, `https://api.telegram.org/bot${OWN}/getFile?file_id=A%20B`);
    expect(fetchSpy.mock.calls[0][0]).toBe(new URL(`https://api.telegram.org/bot${OWN}/getFile?file_id=A%20B`).href);
  });

  it('every response varies by Origin', async () => {
    const res = await call(envWith(fakeD1({ botToken: OWN })), `https://api.telegram.org/bot${OWN}/getMe`);
    expect(res.headers.get('Vary')).toContain('Origin');
  });
});
