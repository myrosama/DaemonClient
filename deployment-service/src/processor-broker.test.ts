import { describe, it, expect, afterEach, vi } from 'vitest';
import { handleAttachProcessor, mintWorkerSession } from './index';

// The deployment-service brokers the hosted "attach a HEIC processor" step: the
// browser holds only a Firebase ID token, but the user's worker authenticates
// with its own signed session, so this service mints one (it owns the secret)
// and forwards the request. The worker's POST /api/server/processor stays the
// single validator. These tests pin the trust-boundary guarantees:
//   - it refuses anyone without a valid Firebase ID token (never mints/forwards)
//   - it fails CLOSED when there is no worker or no per-worker secret
//   - the minted token it sends is one the worker will actually verify, carrying
//     the user's REAL id token (so the processor probe authenticates as them)
//   - it returns the worker's verdict unchanged — it does not invent an "ok"

const SECRET = 'a-real-per-worker-session-secret-32chars!!';
const WORKER = 'https://dc-abc.someone.workers.dev';

const env: any = { FIREBASE_API_KEY: 'k', FIREBASE_PROJECT_ID: 'proj-123' };

function req(bodyObj: any, authHeader = 'Bearer FIREBASE_ID_TOKEN') {
  return new Request('https://deploy.test/processor', {
    method: 'POST',
    headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
    body: JSON.stringify(bodyObj),
  });
}

interface StubOpts {
  user?: { localId: string; email: string } | null; // accounts:lookup result
  config?: Record<string, string> | null;            // config/cloudflare fields
  workerStatus?: number;                              // worker verdict status
  workerBody?: any;                                   // worker verdict body
}
let fetchSpy: any;
let capturedWorkerReq: { url: string; auth: string | null; body: any } | null = null;
function stub(o: StubOpts) {
  capturedWorkerReq = null;
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init: any) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('accounts:lookup')) {
      if (!o.user) return new Response(JSON.stringify({ users: [] }), { status: 200 });
      return new Response(JSON.stringify({ users: [o.user] }), { status: 200 });
    }
    if (url.includes('config/cloudflare')) {
      if (!o.config) return new Response('not found', { status: 404 });
      const fields: any = {};
      for (const [k, v] of Object.entries(o.config)) fields[k] = { stringValue: v };
      return new Response(JSON.stringify({ fields }), { status: 200 });
    }
    if (url.endsWith('/api/server/processor')) {
      capturedWorkerReq = {
        url,
        auth: (init?.headers?.Authorization as string) ?? null,
        body: JSON.parse(String(init?.body || '{}')),
      };
      return new Response(JSON.stringify(o.workerBody ?? { url: 'x', configured: true }), { status: o.workerStatus ?? 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
}
afterEach(() => fetchSpy?.mockRestore());

async function recomputeSig(payloadB64: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(`session:${secret}`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payloadB64));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

describe('POST /processor broker', () => {
  it('mints a token the worker will verify, carrying the real id token', async () => {
    stub({
      user: { localId: 'owner-uid', email: 'me@example.com' },
      config: { workerUrl: WORKER, sessionSecret: SECRET },
      workerStatus: 200,
      workerBody: { url: 'https://p.vercel.app/convertHeicThumbnail', configured: true, ok: true },
    });

    const res = await handleAttachProcessor(req({ url: 'https://p.vercel.app' }), env);
    expect(res.status).toBe(200);
    expect((await res.json() as any).configured).toBe(true);

    // The forwarded request went to the user's OWN worker with the processor URL.
    expect(capturedWorkerReq).not.toBeNull();
    expect(capturedWorkerReq!.url).toBe(`${WORKER}/api/server/processor`);
    expect(capturedWorkerReq!.body).toEqual({ url: 'https://p.vercel.app' });

    // The bearer is a 2-part signed session the worker's verifySignedSessionToken
    // will accept: signature matches HMAC(payload, THIS worker's secret), and the
    // payload carries the user's uid, their real id token, and a future expiry.
    const token = (capturedWorkerReq!.auth || '').replace(/^Bearer /, '');
    const [payloadB64, sig] = token.split('.');
    expect(token.split('.')).toHaveLength(2);
    expect(sig).toBe(await recomputeSig(payloadB64, SECRET));
    const payload = JSON.parse(atob(payloadB64));
    expect(payload.uid).toBe('owner-uid');
    expect(payload.idToken).toBe('FIREBASE_ID_TOKEN');
    expect(payload.exp).toBeGreaterThan(Date.now());
  });

  it('returns the worker verdict unchanged — a 400 stays a 400', async () => {
    stub({
      user: { localId: 'owner-uid', email: 'me@example.com' },
      config: { workerUrl: WORKER, sessionSecret: SECRET },
      workerStatus: 400,
      workerBody: { message: 'That processor belongs to a different account.' },
    });
    const res = await handleAttachProcessor(req({ url: 'https://someone-else.vercel.app' }), env);
    expect(res.status).toBe(400);
    expect((await res.json() as any).message).toMatch(/different account/);
  });

  it('refuses an unauthenticated caller before minting or forwarding anything', async () => {
    stub({ user: null });
    const res = await handleAttachProcessor(req({ url: 'https://p.vercel.app' }), env);
    expect(res.status).toBe(401);
    expect(capturedWorkerReq).toBeNull(); // never reached the worker
  });

  it('fails closed when the user has no worker yet', async () => {
    stub({ user: { localId: 'u', email: 'e' }, config: { sessionSecret: SECRET } }); // no workerUrl
    const res = await handleAttachProcessor(req({ url: 'https://p.vercel.app' }), env);
    expect(res.status).toBe(400);
    expect(capturedWorkerReq).toBeNull();
  });

  it('fails closed (never signs with a weak fallback) when the per-worker secret is missing', async () => {
    stub({ user: { localId: 'u', email: 'e' }, config: { workerUrl: WORKER } }); // no sessionSecret
    const res = await handleAttachProcessor(req({ url: 'https://p.vercel.app' }), env);
    expect(res.status).toBe(409);
    expect(capturedWorkerReq).toBeNull();
  });

  it('rejects an empty URL without touching the worker', async () => {
    stub({ user: { localId: 'u', email: 'e' }, config: { workerUrl: WORKER, sessionSecret: SECRET } });
    const res = await handleAttachProcessor(req({ url: '   ' }), env);
    expect(res.status).toBe(400);
    expect(capturedWorkerReq).toBeNull();
  });

  it('refuses to server-side-fetch a workerUrl that is not a provisioned .workers.dev host (SSRF pin)', async () => {
    // config/cloudflare is user-writable, so a hostile workerUrl must be rejected
    // BEFORE any server-side fetch to it — never forwarded to. Only
    // https://<name>.<subdomain>.workers.dev on the default port is allowed.
    for (const bad of [
      'https://169.254.169.254/api',          // cloud metadata IP
      'https://attacker.example.com',         // arbitrary host
      'http://dc-abc.someone.workers.dev',    // not https
      'https://dc-abc.someone.workers.dev:8080', // non-default port
    ]) {
      stub({ user: { localId: 'u', email: 'e' }, config: { workerUrl: bad, sessionSecret: SECRET } });
      const res = await handleAttachProcessor(req({ url: 'https://p.vercel.app' }), env);
      expect(res.status, bad).toBe(400);
      expect(capturedWorkerReq, bad).toBeNull(); // never fetched the hostile host
      fetchSpy?.mockRestore();
    }
  });

  it('mintWorkerSession is deterministic and worker-shaped', async () => {
    const t = await mintWorkerSession({ uid: 'x', exp: 123 }, SECRET);
    const [p, s] = t.split('.');
    expect(s).toBe(await recomputeSig(p, SECRET));
  });
});
