import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import worker from '../src/index.js';

// This worker exists for exactly one reason: the Telegram Bot API sends no CORS
// headers, so a browser cannot call it directly. It relays to Telegram.
//
// It used to relay to ANY url, for ANY caller, with no authentication —
// an open relay on a public hostname. These tests hold the allowlist closed.

const ctx = { waitUntil() {}, passThroughOnException() {} };
const call = (url, init) => worker.fetch(new Request(url, init), {}, ctx);
const proxy = (target) => `https://proxy.example.com/?url=${encodeURIComponent(target)}`;

let fetchSpy;
beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));
});
afterEach(() => fetchSpy.mockRestore());

describe('target allowlist', () => {
  it('relays to the Telegram Bot API', async () => {
    const target = 'https://api.telegram.org/bot123:ABC/getMe';
    const res = await call(proxy(target));

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(fetchSpy.mock.calls[0][0]).toBe(target);
  });

  it('relays Telegram file downloads', async () => {
    const target = 'https://api.telegram.org/file/bot123:ABC/documents/file_1.bin';
    await call(proxy(target));
    expect(fetchSpy.mock.calls[0][0]).toBe(target);
  });

  // Each of these was previously relayed. The request must never leave the
  // worker — asserting on the status alone would pass even if it did.
  const blocked = [
    ['an unrelated public site', 'https://example.com/'],
    ["someone else's API, with the caller's credentials attached", 'https://api.github.com/user'],
    ['cloud instance metadata', 'http://169.254.169.254/latest/meta-data/'],
    ['a private address', 'http://192.168.1.1/'],
    ['localhost', 'http://127.0.0.1:8080/'],
    ['plaintext http to Telegram', 'http://api.telegram.org/bot123:ABC/getMe'],
    ['a lookalike host', 'https://api.telegram.org.evil.com/bot123:ABC/getMe'],
    ['a hostname that merely contains the string', 'https://api.telegram.organisation.io/'],
    ['userinfo pointing elsewhere', 'https://api.telegram.org@evil.com/'],
    ['an encoded-slash userinfo trick', 'https://api.telegram.org%2f@evil.com/'],
    ['a non-http scheme', 'data:text/html,<script>alert(1)</script>'],
    ['a relative url', '/etc/passwd'],
    // `new URL()` punycodes a Cyrillic "а" into xn--pi-6kc.telegram.org, which
    // a `.telegram.org` suffix rule would have accepted.
    ['a homograph that normalises into the telegram.org zone', 'https://аpi.telegram.org/bot123:ABC/getMe'],
    ['any other telegram.org subdomain', 'https://evil.telegram.org/'],
    ['a non-standard port on the right host', 'https://api.telegram.org:8443/bot123:ABC/getMe'],
    // An ideographic full stop that normalises to a real dot, moving the
    // registrable domain to evil.com.
    ['an ideographic full stop in the host', 'https://api.telegram.org。evil.com/'],
  ];

  for (const [label, target] of blocked) {
    it(`refuses ${label}`, async () => {
      const res = await call(proxy(target));
      expect(res.status).toBe(403);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  }

  it('refuses a request with no url at all', async () => {
    const res = await call('https://proxy.example.com/');
    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('what gets forwarded', () => {
  it("does not pass the caller's credentials on to Telegram", async () => {
    await call(proxy('https://api.telegram.org/bot123:ABC/getMe'), {
      headers: {
        cookie: 'dc_session=secret',
        authorization: 'Bearer someone-elses-token',
        'x-forwarded-for': '203.0.113.9',
        'content-type': 'application/json',
      },
    });

    const sent = new Headers(fetchSpy.mock.calls[0][1].headers);
    expect(sent.get('cookie')).toBeNull();
    expect(sent.get('authorization')).toBeNull();
    expect(sent.get('x-forwarded-for')).toBeNull();
    // ...while still forwarding what Telegram actually needs. Content-Type
    // carries the multipart boundary; dropping it breaks every upload.
    expect(sent.get('content-type')).toBe('application/json');
  });

  it('forwards the multipart boundary intact', async () => {
    const contentType = 'multipart/form-data; boundary=----dcBoundary1234';
    await call(proxy('https://api.telegram.org/bot123:ABC/sendDocument'), {
      method: 'POST',
      body: 'x',
      headers: { 'content-type': contentType },
    });
    expect(new Headers(fetchSpy.mock.calls[0][1].headers).get('content-type')).toBe(contentType);
  });

  it('forwards Range, so chunked video playback keeps working', async () => {
    await call(proxy('https://api.telegram.org/file/bot123:ABC/documents/file_1.bin'), {
      headers: { range: 'bytes=0-1048575' },
    });
    expect(new Headers(fetchSpy.mock.calls[0][1].headers).get('range')).toBe('bytes=0-1048575');
  });

  it('does not follow redirects out of the allowlist', async () => {
    await call(proxy('https://api.telegram.org/bot123:ABC/getMe'));
    expect(fetchSpy.mock.calls[0][1].redirect).toBe('manual');
  });
});

describe('CORS', () => {
  it('answers preflight without relaying anything', async () => {
    const res = await call(
      'https://proxy.example.com/?url=https%3A%2F%2Fapi.telegram.org%2Fbot123%3AABC%2FgetMe',
      { method: 'OPTIONS' },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('puts CORS headers on the refusal too, so the browser can read the 403', async () => {
    const res = await call(proxy('https://example.com/'));
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });
});
