/// <reference types="@sveltejs/kit" />
/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />
import { PUBLIC_DAEMONCLIENT_WORKER_URL } from '$env/static/public';
import { installMessageListener } from './messaging';
import { handleCancel } from './request';
import {
  type AssetBinaryKind,
  type AssetManifest,
  buildDownloadUrl,
  buildGetFileUrl,
  decryptBytes,
  deriveKey,
  isEncrypted,
  parseAssetBinaryPath,
  planVideoRange,
  selectFileIds,
  VIDEO_CHUNK_SIZE,
} from './telegram-media';

// Fallback for pre-login traffic (server config, auth) — the endpoints the SW
// must reach before it knows the user's per-user worker URL. Login response
// includes `workerUrl`, which we persist and route everything else to directly
// so the user's own worker handles all their data.
// Custom domain, NOT immich-api.sadrikov49.workers.dev: several mobile
// carriers block or degrade *.workers.dev, which made first-visit boot die
// with a 503 while photos.daemonclient.uz itself loaded fine. Same worker,
// same zero-cost plan — just reached through the daemonclient.uz zone.
// Strip any trailing slash so `base + '/api/...'` never produces `//api/...`,
// which a pathname-matching Worker router would 404. Matches Drive and
// accounts-portal, which normalise the same way.
const DEFAULT_WORKER_URL = PUBLIC_DAEMONCLIENT_WORKER_URL.replace(/\/+$/, '');
// Must stay in step with ASSET_BINARY_RE in ./telegram-media. `video/playback`
// is included so video takes the client-direct ranged path instead of being
// stitched inside the Worker (error 1102 — see the note there).
const ASSET_BINARY_REGEX = /^\/api\/assets\/[a-f0-9-]+\/(original|thumbnail|video\/playback)/;
const API_REGEX = /^\/api\//;
const TOKEN_CACHE_KEY = 'https://dc-internal/auth-token';
const WORKER_URL_CACHE_KEY = 'https://dc-internal/worker-url';

// Client-direct media: the SW reads asset bytes straight from Telegram (via the
// user's streaming /proxy) and decrypts them here, so the per-user Worker only
// serves tiny JSON and can never hit its 128MB/CPU/subrequest limits.
const MEDIA_CACHE = 'dc-media-v1';        // final decoded image blobs
const MANIFEST_CACHE = 'dc-manifest-v1';  // per-asset Telegram file-id manifests

const sw = globalThis as unknown as ServiceWorkerGlobalScope;

let cachedToken: string | null = null;
let cachedWorkerUrl: string | null = null;

// Telegram config (botToken + proxy) and the derived AES key, fetched once per
// SW lifetime. `mediaKey === undefined` = not yet resolved; `null` = resolved,
// no encryption.
let cachedTgConfig: { botToken: string; proxyUrl: string } | null = null;
let mediaKey: CryptoKey | null | undefined = undefined;
// Telegram file_path resolutions (getFile) are valid ~1h — cache to skip the
// extra round-trip on repeat reads of the same file id.
const filePathCache = new Map<string, { path: string; exp: number }>();

// ── Thumbnail loading algorithm ─────────────────────────────────────────────
// Goal: Google-Photos-like loading without 503 storms.
//
// Root cause of 503s:
//   Scrolling fires 20-50 simultaneous thumbnail requests. Each hits the CF
//   Worker which calls tgGetFileUrl + Telegram CDN. Before the worker fix,
//   EVERY fetch (including downloads) burned a send-bucket token → 4s wait ×
//   50 requests → worker wall-clock exceeded → Cloudflare returns HTML 503
//   (no CORS headers) → SW fetch rejects with CORS TypeError → cascade.
//
// Three-layer fix (worker fix already deployed as of bundle e1ab97124127+):
//   1. Worker: only pace SEND urls, not downloads (isSendUrl guard).
//   2. SW: concurrency cap — max 6 in-flight thumbnail requests at once;
//      the rest queue here rather than hammering the worker simultaneously.
//   3. SW: in-flight deduplication — same URL requested twice shares one fetch.
//   4. SW: retry with exponential backoff on 429/503, honouring Retry-After.

const MAX_THUMB_CONCURRENCY = 6;
let activeThumbFetches = 0;
const thumbWaiters: Array<() => void> = [];

function thumbAcquire(): Promise<void> {
  if (activeThumbFetches < MAX_THUMB_CONCURRENCY) {
    activeThumbFetches++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => thumbWaiters.push(resolve));
}

function thumbRelease(): void {
  const next = thumbWaiters.shift();
  if (next) {
    next(); // already incremented — slot transfers directly to the waiter
  } else {
    activeThumbFetches--;
  }
}

// In-flight deduplication: same URL → shared promise, one Telegram roundtrip.
const inflight = new Map<string, Promise<Response>>();
// Same idea for the client-direct media path, but keyed on the decoded bytes so
// each caller can build its own independently-readable Response.
const mediaInflight = new Map<string, Promise<{ buffer: ArrayBuffer; contentType: string }>>();

async function fetchWithBackoff(url: string, init: RequestInit, maxAttempts = 4): Promise<Response> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const res = await fetch(url, init);
      if ((res.status === 429 || res.status === 503) && attempt < maxAttempts - 1) {
        const retryAfter = parseInt(res.headers.get('Retry-After') || '0') || 0;
        const backoff = Math.max(retryAfter * 1000, Math.min(1000 * Math.pow(2, attempt), 16000));
        await new Promise(r => setTimeout(r, backoff));
        continue;
      }
      return res;
    } catch (err) {
      if (attempt === maxAttempts - 1) throw err;
      await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
    }
  }
  throw new Error('fetchWithBackoff: max attempts reached');
}

// Drop all cached Telegram config, keys and media so a different user (or a
// logout) never reads the previous user's bytes.
async function resetMediaState() {
  cachedTgConfig = null;
  mediaKey = undefined;
  filePathCache.clear();
  await Promise.all([caches.delete(MEDIA_CACHE), caches.delete(MANIFEST_CACHE)]);
}

async function persistToken(token: string | null) {
  // User switch or logout → wipe per-user media caches.
  if (cachedToken && token !== cachedToken) await resetMediaState();
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
    const KEEP = new Set(['dc-auth-v3', 'dc-assets-v4', MEDIA_CACHE, MANIFEST_CACHE]);
    const names = await caches.keys();
    await Promise.all(names.filter(n => !KEEP.has(n)).map(n => caches.delete(n)));
    cachedToken = null;
    cachedWorkerUrl = null;
    cachedTgConfig = null;
    mediaKey = undefined;
    filePathCache.clear();
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

  // Thumbnail requests: apply concurrency cap + in-flight deduplication.
  // Non-thumbnail requests (uploads, API calls) bypass the limiter entirely.
  let response: Response;
  if (cacheable && (request.method === 'GET' || request.method === 'HEAD')) {
    const key = workerUrl;
    let pending = inflight.get(key);
    if (!pending) {
      pending = (async () => {
        await thumbAcquire();
        try {
          return await fetchWithBackoff(workerUrl, { method: request.method, headers, body });
        } finally {
          thumbRelease();
          inflight.delete(key);
        }
      })();
      inflight.set(key, pending);
    }
    try {
      response = await pending;
    } catch (err) {
      // Network failure — serve cache or fall back to transparent placeholder
      if (cacheable) {
        const cache = await caches.open('dc-assets-v4');
        const cached = await cache.match(workerUrl);
        if (cached) return cached;
      }
      console.error('[SW] Network error, no cache available:', err);
      return new Response(
        JSON.stringify({ message: 'Service temporarily unavailable' }),
        { status: 503, headers: { 'Content-Type': 'application/json', 'Retry-After': '5' } }
      );
    }
  } else {
    try {
      // GET/HEAD are idempotent → retry transient 429/503/network drops with
      // backoff. Without this, ONE flaky-4G packet loss during the app's boot
      // call (/api/server/config) used to surface as a hard "Error 503" page.
      // Mutations (POST/PUT/DELETE) keep single-shot semantics.
      const idempotent = request.method === 'GET' || request.method === 'HEAD';
      response = idempotent
        ? await fetchWithBackoff(workerUrl, { method: request.method, headers, body })
        : await fetch(workerUrl, { method: request.method, headers, body });
    } catch (err) {
      if (cacheable) {
        const cache = await caches.open('dc-assets-v4');
        const cached = await cache.match(workerUrl);
        if (cached) return cached;
      }
      console.error('[SW] Network error, no cache available:', err);
      return new Response(
        JSON.stringify({ message: 'Service temporarily unavailable' }),
        { status: 503, headers: { 'Content-Type': 'application/json', 'Retry-After': '5' } }
      );
    }
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

// ── Client-direct media path ────────────────────────────────────────────────
// Authenticated GET to the user's own worker base (tiny JSON only).
async function workerGet(request: Request, path: string): Promise<Response> {
  const headers: Record<string, string> = {};
  const token = await extractToken(request);
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const base = await getWorkerUrl();
  return fetchWithBackoff(base + path, { method: 'GET', headers });
}

async function getTgConfig(request: Request): Promise<{ botToken: string; proxyUrl: string }> {
  if (cachedTgConfig) return cachedTgConfig;
  const res = await workerGet(request, '/api/server/telegram-config');
  const cfg = (await res.json()) as any;
  if (!cfg?.botToken || !cfg?.proxyUrl) throw new Error('telegram config unavailable');
  cachedTgConfig = { botToken: cfg.botToken, proxyUrl: cfg.proxyUrl };
  return cachedTgConfig;
}

// Returns the AES key when the library is encrypted, else null. The browser
// handling its own decryption is exactly what keeps the worker off the byte
// path (the user endorsed this — it's the user's own ZKE password).
async function getMediaKey(request: Request): Promise<CryptoKey | null> {
  if (mediaKey !== undefined) return mediaKey;
  try {
    const res = await workerGet(request, '/api/server/zke-config');
    const zke = (await res.json()) as any;
    mediaKey = zke?.enabled && zke?.password && zke?.salt ? await deriveKey(zke.password, zke.salt) : null;
  } catch {
    mediaKey = null;
  }
  return mediaKey;
}

// Per-asset manifest, cached forever (Telegram file ids are immutable).
async function getManifest(request: Request, assetId: string): Promise<AssetManifest> {
  const cacheKey = `https://dc-manifest/${assetId}`;
  const cache = await caches.open(MANIFEST_CACHE);
  const cached = await cache.match(cacheKey);
  if (cached) return cached.json();
  const res = await workerGet(request, `/api/assets/${assetId}/dc-manifest`);
  if (!res.ok) throw new Error(`manifest ${res.status}`);
  const manifest = (await res.clone().json()) as AssetManifest;
  await cache.put(cacheKey, res);
  return manifest;
}

async function resolveFilePath(tg: { botToken: string; proxyUrl: string }, fileId: string): Promise<string> {
  const hit = filePathCache.get(fileId);
  if (hit && hit.exp > Date.now()) return hit.path;
  const res = await fetchWithBackoff(buildGetFileUrl(tg.proxyUrl, tg.botToken, fileId), { method: 'GET' });
  const data = (await res.json()) as any;
  if (!data?.ok || !data.result?.file_path) throw new Error(`getFile failed for ${fileId}`);
  const path = data.result.file_path as string;
  filePathCache.set(fileId, { path, exp: Date.now() + 50 * 60 * 1000 });
  return path;
}

async function downloadOneFile(
  tg: { botToken: string; proxyUrl: string },
  fileId: string,
  key: CryptoKey | null,
): Promise<ArrayBuffer> {
  let filePath: string;
  try {
    filePath = await resolveFilePath(tg, fileId);
  } catch {
    filePathCache.delete(fileId);
    filePath = await resolveFilePath(tg, fileId);
  }
  const res = await fetchWithBackoff(buildDownloadUrl(tg.proxyUrl, tg.botToken, filePath), { method: 'GET' });
  if (!res.ok) {
    filePathCache.delete(fileId); // path may have expired
    throw new Error(`download ${res.status} for ${fileId}`);
  }
  const bytes = await res.arrayBuffer();
  return key ? decryptBytes(bytes, key) : bytes;
}

// Serve a video straight from Telegram, one stored chunk per response.
//
// Peak memory is a single chunk regardless of file size, so a 1 GB video costs
// the same as a 20 MB one — this is why it replaces the Worker path rather than
// merely relieving it. Returning fewer bytes than requested is legal for a 206
// and browsers just ask for the next range. Drive's sw.js has served video this
// way for a long time; this is the same shape, reading chunk ids from the
// per-asset manifest instead of a pre-registered map.
//
// Returns null to fall back to the Worker rather than fail the request.
async function fetchVideoDirect(
  request: Request,
  manifest: AssetManifest,
  kind: AssetBinaryKind,
  tg: { botToken: string; proxyUrl: string },
  key: CryptoKey | null,
): Promise<Response | null> {
  // /video/playback prefers the H.264 rendition when one exists — same swap the
  // Worker's handleOriginal performs. Without this a repaired video would fall
  // back to its HEVC source and stop playing in non-Apple browsers.
  const usePlayback = kind === 'playback' && !!manifest.playbackChunks?.length;
  const chunks = [...(usePlayback ? manifest.playbackChunks! : manifest.chunks)].sort((a, b) => a.index - b.index);
  const totalSize = (usePlayback && manifest.playbackSize) || manifest.fileSize;
  if (chunks.length === 0 || !totalSize) return null;

  // Address by the chunk's DECLARED index rather than array position: a manifest
  // missing an entry would otherwise shift every later chunk and serve correct
  // bytes at the wrong offsets, silently corrupting playback.
  const byIndex = new Map(chunks.map((c) => [c.index, c]));

  const headers: Record<string, string> = {
    'Content-Type': manifest.mimeType || 'video/mp4',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=3600',
  };

  const plan = planVideoRange(request.headers.get('range'), totalSize, VIDEO_CHUNK_SIZE, chunks.length);

  if (plan.kind === 'unsatisfiable') {
    return new Response(null, {
      status: 416,
      headers: { ...headers, 'Content-Range': `bytes */${plan.totalSize}` },
    });
  }

  if (plan.kind === 'full') {
    // No Range header (a direct download, say). Stream chunks in order; `pull`
    // is only called when the consumer has drained, so memory stays at one
    // chunk instead of buffering the whole file.
    let next = 0;
    const stream = new ReadableStream({
      async pull(controller) {
        if (next >= chunks.length) {
          controller.close();
          return;
        }
        const c = byIndex.get(next++);
        if (!c) { controller.error(new Error('manifest gap')); return; }
        const bytes = await downloadOneFile(tg, c.file_id, key);
        controller.enqueue(new Uint8Array(bytes));
      },
      cancel() {
        next = chunks.length;
      },
    });
    return new Response(stream, { status: 200, headers: { ...headers, 'Content-Length': String(totalSize) } });
  }

  const wanted = byIndex.get(plan.chunkIndex);
  if (!wanted) return null; // gap in the manifest → let the Worker answer
  const plaintext = await downloadOneFile(tg, wanted.file_id, key);
  const chunkStart = plan.chunkIndex * VIDEO_CHUNK_SIZE;
  const localStart = plan.start - chunkStart;
  const localEnd = Math.min(plan.end - chunkStart, plaintext.byteLength - 1);
  // A chunk shorter than the manifest implies means the two disagree; the
  // Worker still has the authoritative view, so defer to it rather than serve
  // bytes we can't place.
  if (localStart < 0 || localStart >= plaintext.byteLength || localEnd < localStart) return null;

  const sliced = plaintext.slice(localStart, localEnd + 1);
  return new Response(sliced, {
    status: 206,
    headers: {
      ...headers,
      'Content-Length': String(sliced.byteLength),
      'Content-Range': `bytes ${plan.start}-${chunkStart + localEnd}/${totalSize}`,
    },
  });
}

// Read an asset's thumbnail/original straight from Telegram + decrypt locally.
// Returns null to signal "fall back to the worker path" (missing file id,
// encrypted-but-no-key, or any failure) so we never regress an image.
async function fetchAssetDirect(request: Request, pathname: string): Promise<Response | null> {
  const parsed = parseAssetBinaryPath(pathname);
  if (!parsed) return null;
  const { assetId, kind } = parsed;
  const size = (new URL(request.url).searchParams.get('size') || '').toLowerCase();

  // Video bytes go to the ranged, chunk-at-a-time path — before the media
  // cache, because a partial 206 must never be cached and replayed as if it
  // were the whole asset. Thumbnails of videos are images and fall through.
  if (kind === 'original' || kind === 'playback') {
    const manifest = await getManifest(request, assetId).catch(() => null);
    // Trust the request kind over the stored mime: /video/playback is video by
    // definition, and containers like .3gp/.mts are often stored as a generic
    // octet-stream. Any multi-chunk asset goes here too — concatenating one is
    // exactly the blow-up this path exists to avoid.
    const looksLikeVideo =
      kind === 'playback' ||
      !!manifest?.mimeType?.startsWith('video/') ||
      (manifest?.chunks?.length ?? 0) > 1;
    if (manifest && looksLikeVideo) {
      try {
        const tg = await getTgConfig(request);
        const needsKey = isEncrypted(manifest.encryptionMode);
        const key = needsKey ? await getMediaKey(request) : null;
        if (needsKey && !key) return null;
        return await fetchVideoDirect(request, manifest, kind, tg, key);
      } catch (err: any) {
        console.warn('[SW] client-direct video failed, falling back to worker:', err?.message);
        return null;
      }
    }
  }

  const mediaKeyUrl = `https://dc-media/${assetId}/${kind}/${size || '_'}`;
  const mediaCache = await caches.open(MEDIA_CACHE);
  const cached = await mediaCache.match(mediaKeyUrl);
  if (cached) return cached;

  const buildResponse = (buffer: ArrayBuffer, contentType: string) =>
    new Response(buffer, {
      status: 200,
      headers: { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=31536000, immutable' },
    });

  // Dedup concurrent requests for the same rendition to ONE Telegram round-trip.
  // The shared promise resolves to bytes (not a Response) so every caller can
  // build its own fresh, independently-readable Response.
  const existing = mediaInflight.get(mediaKeyUrl);
  if (existing) {
    try {
      const { buffer, contentType } = await existing;
      return buildResponse(buffer, contentType);
    } catch {
      return null;
    }
  }

  const work = (async (): Promise<{ buffer: ArrayBuffer; contentType: string }> => {
    const manifest = await getManifest(request, assetId);

    // Video bytes never take this path: it concatenates every file id into one
    // buffer, which is fine for an image and ruinous for a 1 GB video.
    // fetchVideoDirect (above) serves those a chunk at a time, and the caller
    // routes to it before reaching here. A video *thumbnail* is an image and
    // continues through normally.
    if (manifest.mimeType.startsWith('video/') && kind !== 'thumbnail') {
      throw new Error('FALLBACK');
    }

    const fileIds = selectFileIds(manifest, kind, size);
    if (fileIds.length === 0) throw new Error('FALLBACK');

    const tg = await getTgConfig(request);
    const key = isEncrypted(manifest.encryptionMode) ? await getMediaKey(request) : null;
    if (isEncrypted(manifest.encryptionMode) && !key) throw new Error('FALLBACK');

    await thumbAcquire();
    let buffer: ArrayBuffer;
    try {
      if (fileIds.length === 1) {
        buffer = await downloadOneFile(tg, fileIds[0], key);
      } else {
        const parts: ArrayBuffer[] = [];
        for (const fid of fileIds) parts.push(await downloadOneFile(tg, fid, key));
        const total = parts.reduce((n, p) => n + p.byteLength, 0);
        const joined = new Uint8Array(total);
        let off = 0;
        for (const p of parts) { joined.set(new Uint8Array(p), off); off += p.byteLength; }
        buffer = joined.buffer;
      }
    } finally {
      thumbRelease();
    }

    // Thumb/preview renditions are always JPEG; originals carry their own mime.
    const renditionId = fileIds[0];
    const contentType = (renditionId === manifest.thumbId || renditionId === manifest.previewId)
      ? 'image/jpeg'
      : manifest.mimeType || 'application/octet-stream';
    return { buffer, contentType };
  })();

  mediaInflight.set(mediaKeyUrl, work);
  try {
    const { buffer, contentType } = await work;
    // Cache thumbnails/previews + small images; skip large originals (disk).
    if (kind === 'thumbnail' || buffer.byteLength <= 4 * 1024 * 1024) {
      await mediaCache.put(mediaKeyUrl, buildResponse(buffer, contentType));
    }
    return buildResponse(buffer, contentType);
  } catch (err: any) {
    if (err?.message !== 'FALLBACK') {
      console.warn('[SW] client-direct media failed, falling back to worker:', err?.message);
    }
    return null;
  } finally {
    mediaInflight.delete(mediaKeyUrl);
  }
}

const handleFetch = (event: FetchEvent): void => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (!API_REGEX.test(url.pathname)) return;

  if (event.request.method === 'GET' || event.request.method === 'HEAD') {
    // A ranged request must never be cached or deduped by URL alone: Cache.put
    // rejects a 206, and a cached 200 would be replayed for every later range.
    const hasRange = !!event.request.headers.get('range');
    const cacheable = ASSET_BINARY_REGEX.test(url.pathname) && event.request.method === 'GET' && !hasRange;
    // Asset binaries: read straight from Telegram in the browser; fall back to
    // the worker proxy path only when that can't serve it.
    if (ASSET_BINARY_REGEX.test(url.pathname) && event.request.method === 'GET') {
      event.respondWith(
        fetchAssetDirect(event.request, url.pathname).then(
          (res) => res ?? directWorkerFetch(event.request, cacheable, url.pathname),
        ),
      );
      return;
    }
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
