import type { Env } from './index';
import { getSessionToken, decodeSession } from './helpers';

// Proxy a per-user request from the central router worker to the user's own
// per-user worker. The user's workerUrl is baked into the session JWT at
// /api/auth/login, so dispatching is a JWT-decode + fetch — zero DB reads.
//
// Returns null if the request can't be proxied (no session, no workerUrl in
// session, malformed token). Caller should then fall back to the local
// handler chain.
export async function proxyToUserWorker(request: Request, _env: Env): Promise<Response | null> {
  const token = getSessionToken(request);
  if (!token) return null;

  const payload = token.includes('.') ? token.split('.')[0] : token;
  const session = decodeSession(payload);
  if (!session) return null;

  const workerUrl = (session as any).workerUrl as string | undefined;
  if (!workerUrl) return null;

  const incoming = new URL(request.url);
  const target = workerUrl.replace(/\/$/, '') + incoming.pathname + incoming.search;

  // Build a clean header set: drop hop-by-hop and CF-injected headers, keep
  // auth + content-type + range so the per-user worker sees the same client
  // intent. The original cookie carries the session JWT — preserve it.
  const fwd = new Headers();
  for (const [k, v] of request.headers) {
    const lower = k.toLowerCase();
    if (lower === 'host' || lower === 'connection' || lower.startsWith('cf-') ||
        lower === 'content-length' || lower === 'transfer-encoding') continue;
    fwd.set(k, v);
  }

  const init: RequestInit = {
    method: request.method,
    headers: fwd,
    redirect: 'manual',
  };
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    // Stream the body through; avoids buffering large uploads in memory.
    (init as any).body = request.body;
  }

  const upstream = await fetch(target, init);

  // Strip the per-user worker's CORS headers — the central router will add
  // its own (matching the photos.daemonclient.uz origin) at the outer layer.
  const out = new Headers();
  for (const [k, v] of upstream.headers) {
    const lower = k.toLowerCase();
    if (lower.startsWith('access-control-')) continue;
    out.set(k, v);
  }

  return new Response(upstream.body, { status: upstream.status, headers: out });
}
