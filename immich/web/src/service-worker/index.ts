/// <reference types="@sveltejs/kit" />
/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />
import { installMessageListener } from './messaging';
import { handleCancel } from './request';

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
  const cache = await caches.open('dc-auth-v1');
  if (token) {
    await cache.put(TOKEN_CACHE_KEY, new Response(token));
  } else {
    await cache.delete(TOKEN_CACHE_KEY);
  }
}

async function loadToken(): Promise<string | null> {
  if (cachedToken) return cachedToken;
  const cache = await caches.open('dc-auth-v1');
  const res = await cache.match(TOKEN_CACHE_KEY);
  if (res) {
    cachedToken = await res.text();
    return cachedToken;
  }
  return null;
}

async function persistWorkerUrl(url: string | null) {
  cachedWorkerUrl = url;
  const cache = await caches.open('dc-auth-v1');
  if (url) {
    await cache.put(WORKER_URL_CACHE_KEY, new Response(url));
  } else {
    await cache.delete(WORKER_URL_CACHE_KEY);
  }
}

async function getWorkerUrl(): Promise<string> {
  if (cachedWorkerUrl) return cachedWorkerUrl;
  const cache = await caches.open('dc-auth-v1');
  const res = await cache.match(WORKER_URL_CACHE_KEY);
  if (res) {
    cachedWorkerUrl = await res.text();
    return cachedWorkerUrl!;
  }
  return DEFAULT_WORKER_URL;
}

const handleActivate = (event: ExtendableEvent) => {
  event.waitUntil(sw.clients.claim());
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
  const base = await getWorkerUrl();
  const workerUrl = base + url.pathname + url.search;

  if (cacheable) {
    const cache = await caches.open('dc-assets-v1');
    const cached = await cache.match(workerUrl);
    if (cached) {
      return cached;
    }
  }

  const headers: Record<string, string> = {};
  const token = await extractToken(request);
  if (token) headers['Authorization'] = `Bearer ${token}`;
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
      const cache = await caches.open('dc-assets-v1');
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
      if (data.accessToken) {
        await persistToken(data.accessToken);
      }
      if (data.workerUrl) {
        await persistWorkerUrl(data.workerUrl);
      }
    } catch {}
  }

  if (pathname === '/api/auth/logout') {
    await persistToken(null);
    await persistWorkerUrl(null);
  }

  if (cacheable && response.ok) {
    const cache = await caches.open('dc-assets-v1');
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
