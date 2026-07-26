import { describe, it, expect } from 'vitest';
import { __botKeyForTests as botKey } from './assets';

// Two module-scope maps hold per-bot rate-limiter state: sendBuckets (the send
// pacer) and tgQueues (the download queue). Both used the FULL Telegram token
// as their key, and neither ever evicted.
//
// On a per-user worker that is one entry, forever, harmlessly. But
// handleUploadImpl is NOT gated on env.DB, so the SHARED worker reaches the
// same code — one entry per user who uploads through it — and a Cloudflare
// isolate lives across many requests. The result was other people's live bot
// tokens accumulating in memory as map keys, with no bound.
//
// A Telegram token is `<botId>:<secret>`. The id alone identifies the bot just
// as uniquely and is public — it is the bot's own user id.

describe('per-bot state is keyed by something that is not a credential', () => {
  it('uses only the public bot id', () => {
    expect(botKey('8154329871:AAHsecretsecretsecret')).toBe('8154329871');
  });

  it('two tokens for the same bot collapse to one key', () => {
    // A rotated token is the same bot; it should reuse the same rate limiter,
    // not start a fresh burst allowance.
    expect(botKey('123456:oldsecret')).toBe(botKey('123456:newsecret'));
  });

  it('different bots stay separate — the pacer must not be shared', () => {
    expect(botKey('111:x')).not.toBe(botKey('222:x'));
  });

  it('never returns anything containing the secret', () => {
    const secret = 'AAHdeadbeefdeadbeefdeadbeef';
    expect(botKey(`999:${secret}`)).not.toContain(secret);
  });

  it('degrades safely on a malformed token rather than leaking it as a key', () => {
    // Whatever this is, it is not a token — but it must not become a map key
    // that contains it verbatim.
    const weird = 'not-a-token-at-all';
    const key = botKey(weird);
    expect(key).not.toContain(weird);
    expect(key.startsWith('anon-')).toBe(true);
  });

  it('an empty token does not produce an empty key', () => {
    expect(botKey('')).toBeTruthy();
  });
});
