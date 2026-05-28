/// <reference types="@sveltejs/kit" />
/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />
import { installMessageListener } from './messaging';
import { handleCancel } from './request';

// Fallback for /api/auth/login only — that's the one endpoint the SW must hit
// before it knows the user's per-user worker URL. Login response includes
// `workerUrl`, which we persist and route everything else to directly so the
// user's own worker handles all their data.
const DEFAULT_WORKER_URL = 'https://immich-api.sadrikov49.workers.dev';
const ASSET_BINARY_REGEX = /^\/api\/assets\/[a-f0-9-]+\/(original|thumbnail)/;
const API_REGEX = /^\/api\//;
const TOKEN_CACHE_KEY = 'https://dc-internal/auth-token';
const WORKER_URL_CACHE_KEY = 'https://dc-internal/worker-url';

const sw = globalThis as unknown as ServiceWorkerGlobalScope;

let cachedToken: string | null = null;
let cachedWorkerUrl: string | null = null;

async function persistToken(token: string | null) {
  cachedToken = token;
  const cache = await caches.open('dc-auth-v3');
  if (token) {
    await cache.put(TOKEN_CACHE_KEY, new Response(token));
  } else {
    await cache.delete(TOKEN_CACHE_KEY);
  }
}

async function loadToken(): Promise<string | null> {
  if (cachedToken) return cachedToken;
  const cache = await caches.open('dc-auth-v3');
  const res = await cache.match(TOKEN_CACHE_KEY);
  if (res) {
    cachedToken = await res.text();
    return cachedToken;
  }
  return null;
}

async function persistWorkerUrl(url: string | null) {
  cachedWorkerUrl = url;
  const cache = await caches.open('dc-auth-v3');
  if (url) {
    await cache.put(WORKER_URL_CACHE_KEY, new Response(url));
  } else {
    await cache.delete(WORKER_URL_CACHE_KEY);
  }
}

function decodeWorkerUrlFromToken(token: string): string | null {
  try {
    const payload = token.includes('.') ? token.split('.')[0] : token;
    const data = JSON.parse(atob(payload));
    return typeof data.workerUrl === 'string' && data.workerUrl ? data.workerUrl : null;
  } catch { return null; }
}

async function getWorkerUrl(): Promise<string> {
  if (cachedWorkerUrl) return cachedWorkerUrl;
  const cache = await caches.open('dc-auth-v3');
  const res = await cache.match(WORKER_URL_CACHE_KEY);
  if (res) {
    cachedWorkerUrl = await res.text();
    return cachedWorkerUrl;
  }
  // Fall back to decoding the workerUrl from the persisted session JWT.
  // This lets already-logged-in users get their per-user worker URL without
  // re-logging in, even after the SW cache was cleared (e.g. version bump).
  const token = await loadToken();
  if (token) {
    const workerUrl = decodeWorkerUrlFromToken(token);
    if (workerUrl) {
      await persistWorkerUrl(workerUrl);
      return workerUrl;
    }
  }
  return DEFAULT_WORKER_URL;
}

const handleActivate = (event: ExtendableEvent) => {
  // Drop every old cache namespace so a stale workerUrl from a prior SW
  // version (e.g. when the SW briefly hard-coded api.daemonclient.uz) cannot
  // mis-route a user's API calls to the wrong worker. Only the v3 namespaces
  // survive the activation.
  event.waitUntil((async () => {
    const KEEP = new Set(['dc-auth-v3', 'dc-assets-v4']);
    const names = await caches.keys();
    await Promise.all(names.filter(n => !KEEP.has(n)).map(n => caches.delete(n)));
    cachedToken = null;
    cachedWorkerUrl = null;
    await sw.clients.claim();
  })());
};

const handleInstall = (event: ExtendableEvent) => {
  event.waitUntil(sw.skipWaiting());
};

async function extractToken(request: Request): Promise<string | null> {
  const persisted = await loadToken();
  if (persisted) return persisted;
  const cookie = request.headers.get('cookie') || '';
  const match = cookie.match(/(?:immich_access_token|__session)=([^;]+)/);
  if (match) return match[1];
  const auth = request.headers.get('authorization') || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  return null;
}

async function directWorkerFetch(request: Request, cacheable: boolean, pathname: string): Promise<Response> {
  const url = new URL(request.url);

  const headers: Record<string, string> = {};
  const token = await extractToken(request);
  if (token) headers['Authorization'] = `Bearer ${token}`;

  // If the SW cache was wiped (e.g. version bump) but the user is still
  // logged in via a browser cookie, bootstrap the per-user workerUrl from
  // the JWT baked into that cookie — zero extra network calls.
  if (!cachedWorkerUrl && token) {
    const workerUrlFromToken = decodeWorkerUrlFromToken(token);
    if (workerUrlFromToken) {
      await persistWorkerUrl(workerUrlFromToken);
    }
  }

  const base = await getWorkerUrl();
  // Cache-bust binary assets (thumbnails/originals). A prior shim bug served
  // ENCRYPTED bytes for server-ZKE thumbnails and cached them as immutable for
  // a year across three layers: this SW cache, the browser HTTP cache, and the
  // worker's own caches.default (all keyed on the full URL). Bumping the SW
  // namespace clears this cache; appending a version param changes the URL so
  // the browser HTTP cache and the worker edge cache also miss the poisoned
  // entries and refetch freshly-decrypted bytes. Bump ASSET_CACHE_BUST when a
  // future change requires re-busting these layers.
  const ASSET_CACHE_BUST = 'v4';
  let workerUrl = base + url.pathname + url.search;
  if (cacheable) {
    workerUrl += (url.search ? '&' : '?') + `dcv=${ASSET_CACHE_BUST}`;
  }

  if (cacheable) {
    const cache = await caches.open('dc-assets-v4');
    const cached = await cache.match(workerUrl);
    if (cached) {
      return cached;
    }
  }
  if (request.headers.get('range')) headers['Range'] = request.headers.get('range')!;
  if (request.headers.get('content-type')) headers['Content-Type'] = request.headers.get('content-type')!;

  let body: BodyInit | undefined;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    body = await request.arrayBuffer();
  }

  let response: Response;
  try {
    response = await fetch(workerUrl, {
      method: request.method,
      headers,
      body,
    });
  } catch (err) {
    // Network error - try to serve from cache
    if (cacheable) {
      const cache = await caches.open('dc-assets-v4');
      const cached = await cache.match(workerUrl);
      if (cached) {
        console.log('[SW] Network error, serving from cache:', pathname);
        return cached;
      }
    }

    // No cache available - return 503 with retry header
    console.error('[SW] Network error, no cache available:', err);
    return new Response(
      JSON.stringify({ message: 'Service temporarily unavailable', error: 'Network error' }),
      {
        status: 503,
        headers: {
          'Content-Type': 'application/json',
          'Retry-After': '10'
        }
      }
    );
  }

  if (pathname === '/api/auth/login' && response.ok) {
    const cloned = response.clone();
    try {
      const data = await cloned.json() as any;
      if (data.accessToken) await persistToken(data.accessToken);
      if (data.workerUrl) await persistWorkerUrl(data.workerUrl);
    } catch {}
  }

  if (pathname === '/api/auth/logout') {
    await persistToken(null);
    await persistWorkerUrl(null);
  }

  if (cacheable && response.ok) {
    const cache = await caches.open('dc-assets-v4');
    cache.put(workerUrl, response.clone());
  }

  return response;
}

const handleFetch = (event: FetchEvent): void => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (!API_REGEX.test(url.pathname)) return;

  if (event.request.method === 'GET') {
    const cacheable = ASSET_BINARY_REGEX.test(url.pathname);
    event.respondWith(directWorkerFetch(event.request, cacheable, url.pathname));
    return;
  }

  if (event.request.method === 'POST' || event.request.method === 'PUT' || event.request.method === 'DELETE') {
    event.respondWith(directWorkerFetch(event.request, false, url.pathname));
    return;
  }
};

sw.addEventListener('message', (event) => {
  if (event.data?.type === 'SET_TOKEN') {
    persistToken(event.data.token);
  }
  if (event.data?.type === 'CLEAR_TOKEN') {
    persistToken(null);
  }
  if (event.data?.type === 'SET_WORKER_URL') {
    persistWorkerUrl(event.data.workerUrl || null);
  }
});

sw.addEventListener('install', handleInstall, { passive: true });
sw.addEventListener('activate', handleActivate, { passive: true });
sw.addEventListener('fetch', handleFetch, { passive: true });
installMessageListener();
