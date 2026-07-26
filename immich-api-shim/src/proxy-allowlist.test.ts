import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import worker from './index';

// `/proxy` exists so the Drive client can push its Telegram chunks out through
// its OWN worker. It used to take any url, unauthenticated — an open proxy on
// every worker we deploy, one per user. It was closed to Telegram earlier but
// never covered by a test, and the host rule it shipped with was a `.telegram.org`
// SUFFIX check, which a Cyrillic homograph slips through: `аpi.telegram.org`
// normalises to the genuine subdomain `xn--pi-6kc.telegram.org`.

// corsHeaders() reads env.ALLOWED_ORIGINS unguarded, so it must be present.
const env: any = { ALLOWED_ORIGINS: 'https://photos.daemonclient.uz' };
const ctx: any = { waitUntil() {} };
const call = (target: string | null, init?: RequestInit) =>
  worker.fetch(
    new Request(
      target === null
        ? 'https://worker.test/proxy'
        : `https://worker.test/proxy?url=${encodeURIComponent(target)}`,
      init,
    ),
    env,
    ctx,
  );

let fetchSpy: any;
beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));
});
afterEach(() => fetchSpy.mockRestore());

describe('/proxy target allowlist', () => {
  it('relays to the Telegram Bot API', async () => {
    const target = 'https://api.telegram.org/bot123:ABC/sendDocument';
    const res = await call(target);
    expect(res.status).toBe(200);
    expect(fetchSpy.mock.calls[0][0]).toBe(target);
  });

  it('relays Telegram file downloads', async () => {
    const target = 'https://api.telegram.org/file/bot123:ABC/documents/file_1.bin';
    await call(target);
    expect(fetchSpy.mock.calls[0][0]).toBe(target);
  });

  // The request must never leave the worker. Asserting only on the status
  // would still pass if it did.
  const blocked: Array<[string, string]> = [
    ['an unrelated site', 'https://example.com/'],
    ['cloud instance metadata', 'http://169.254.169.254/latest/meta-data/'],
    ['a private address', 'http://10.0.0.1/'],
    ['localhost', 'http://127.0.0.1:8787/'],
    ['plaintext http to Telegram', 'http://api.telegram.org/bot123:ABC/getMe'],
    ['a lookalike host', 'https://api.telegram.org.evil.com/'],
    ['userinfo pointing elsewhere', 'https://api.telegram.org@evil.com/'],
    ['a homograph that normalises into the telegram.org zone', 'https://аpi.telegram.org/bot123:ABC/getMe'],
    ['any other telegram.org subdomain', 'https://evil.telegram.org/'],
    ['a non-standard port on the right host', 'https://api.telegram.org:8443/bot123:ABC/getMe'],
    ['a non-http scheme', 'data:text/plain,hello'],
    ['a relative url', '/etc/passwd'],
  ];

  for (const [label, target] of blocked) {
    it(`refuses ${label}`, async () => {
      const res = await call(target);
      expect(res.status).toBe(403);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  }

  it('refuses a request with no url at all', async () => {
    const res = await call(null);
    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not follow redirects out of the allowlist', async () => {
    await call('https://api.telegram.org/bot123:ABC/getMe');
    expect(fetchSpy.mock.calls[0][1].redirect).toBe('manual');
  });

  it('forwards the multipart boundary, which every chunk upload depends on', async () => {
    const contentType = 'multipart/form-data; boundary=----dcBoundary1234';
    await call('https://api.telegram.org/bot123:ABC/sendDocument', {
      method: 'POST',
      body: 'x',
      headers: { 'content-type': contentType },
    });
    expect(new Headers(fetchSpy.mock.calls[0][1].headers).get('content-type')).toBe(contentType);
  });

  it("does not pass the caller's own credentials on to Telegram", async () => {
    await call('https://api.telegram.org/bot123:ABC/getMe', {
      headers: { cookie: 'dc_session=secret', authorization: 'Bearer someone-elses-token' },
    });
    const sent = new Headers(fetchSpy.mock.calls[0][1].headers);
    expect(sent.get('cookie')).toBeNull();
    expect(sent.get('authorization')).toBeNull();
  });
});
