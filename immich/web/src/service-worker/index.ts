/// <reference types="@sveltejs/kit" />
/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />
import { PUBLIC_DAEMONCLIENT_WORKER_URL } from '$env/static/public';
import { unreachableResponseFor } from '$lib/utils/worker-unreachable';
import { installMessageListener } from './messaging';
import { isAbortError, isTrustedMessageSource, MediaScheduler, type MediaTag, parseViewingMessage, RetryAfterError } from './media-scheduler';
import { CancelHints, MediaSession, pacedFetch } from './media-session';
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

// ── Media loading ───────────────────────────────────────────────────────────
// Every asset-binary read that can reach the worker or Telegram — manifest,
// getFile, the download itself, and the worker fallback — runs as a job in the
// media scheduler (./media-scheduler, a port of Nuke's design; SPEC §4.9, D15,
// D17 — the mobile core follows the same rules). Cache hits never enter it.
//
//   OPENED     the asset the viewer shows (page hint {type:'viewing'})
//   NEXT       neighbour preloads, grid hover playback, other media
//   VISIBLE    grid thumbnails, newest request first
//   BACKGROUND (reserved; nothing uses it yet)
//
// Limits (SPEC §4.9 starting values, so web and mobile behave the same):
//   - 6 jobs at once, 1 slot reserved for OPENED, at most 2 NEXT.
//   - Token bucket, 20 job starts/s, burst 10. A cold thumbnail job is about
//     3 worker invocations (manifest, getFile, download) and 2 Telegram calls;
//     at a typical 300-500 ms per job the 6 slots are the real limiter, and the
//     bucket only caps the bursts when slots free fast. Cancelled work never
//     spends a token, so a fling costs only what is loaded — the free tier's
//     100k invocations a day go to photos someone actually looked at.
//   - A 429 (HTTP, Telegram JSON retry_after, Retry-After) pauses everyone
//     once; /proxy's 503 + Retry-After pauses briefly (≤ 5 s).
const mediaScheduler = new MediaScheduler({
  maxConcurrent: 6,
  reservedForOpened: 1,
  maxNext: 2,
  rate: 20,
  burst: 10,
});
const media = new MediaSession(mediaScheduler);
const cancelHints = new CancelHints();

// Answer for a request the page has already cancelled. Nobody reads it; it only
// has to be a non-ok status so nothing caches it, and to avoid the console
// noise of a rejected respondWith.
const cancelledResponse = () => new Response(null, { status: 499, statusText: 'Client Closed Request' });

// Still rate-limited after the scheduler's retries: tell the page to come back later.
const rateLimitedResponse = (error: RetryAfterError) =>
  new Response(null, { status: 503, headers: { 'Retry-After': String(Math.ceil(error.delayMs / 1000)) } });

function mediaTagFor(url: URL): MediaTag | undefined {
  const parsed = parseAssetBinaryPath(url.pathname);
  if (!parsed) return undefined;
  return { ...parsed, size: (url.searchParams.get('size') || '').toLowerCase() };
}

// Non-media API reads only (server config, timeline JSON). Media reads go
// through the scheduler and its one shared 429 pause instead.
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
  // User switch or logout → wipe per-user media caches. Switch the token first:
  // requests that arrive while the caches are being cleared must already see
  // the new (or no) session, not the old one.
  // Compare against the stored token too: after an SW restart cachedToken is
  // null, and a page re-sending the same token must not cancel its own loads.
  const previous = cachedToken ?? (await readStoredToken());
  cachedToken = token;
  if (token !== previous) {
    // Queued media fails with AbortError, the viewing hint and any 429 pause
    // are forgotten, and in-flight jobs of the old session can't write caches.
    media.reset();
    cancelHints.clear();
  }
  if (previous && token !== previous) await resetMediaState();
  const cache = await caches.open('dc-auth-v3');
  if (token) {
    await cache.put(TOKEN_CACHE_KEY, new Response(token));
  } else {
    await cache.delete(TOKEN_CACHE_KEY);
  }
}

async function readStoredToken(): Promise<string | null> {
  const cache = await caches.open('dc-auth-v3');
  const stored = await cache.match(TOKEN_CACHE_KEY);
  return stored ? stored.text() : null;
}

async function loadToken(): Promise<string | null> {
  if (cachedToken) return cachedToken;
  cachedToken = await readStoredToken();
  return cachedToken;
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

async function directWorkerFetch(
  request: Request,
  cacheable: boolean,
  pathname: string,
  signal: AbortSignal = request.signal,
): Promise<Response> {
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
  // Logout forgets the session BEFORE contacting the worker: if the worker is
  // unreachable the request below fails, and the user must still be signed out
  // here (the token for this request is already in `headers`).
  if (pathname === '/api/auth/logout') {
    await persistToken(null);
    await persistWorkerUrl(null);
  }

  if (request.headers.get('range')) headers['Range'] = request.headers.get('range')!;
  if (request.headers.get('content-type')) headers['Content-Type'] = request.headers.get('content-type')!;

  let body: BodyInit | undefined;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    body = await request.arrayBuffer();
  }

  // Asset binaries (the fallback when the direct Telegram path can't serve
  // one) are media-scheduler jobs; other requests (uploads, API calls) bypass it.
  const tag = request.method === 'GET' ? mediaTagFor(url) : undefined;
  const generation = media.generation;
  let response: Response;
  try {
    if (tag && cacheable) {
      // Identical requests share one job and its RESULT: every caller builds
      // its own Response from the same bytes. The job writes the cache itself,
      // so the bytes are kept even when every caller has gone — unless the
      // session changed meanwhile.
      response = await media.sharedFetch(
        { tag, key: workerUrl, signal },
        () => pacedFetch(workerUrl, { method: 'GET', headers }),
        async (copy) => {
          const cache = await caches.open('dc-assets-v4');
          if (media.isCurrent(generation)) await cache.put(workerUrl, copy);
        },
      );
    } else if (tag) {
      // A ranged read (video the user is playing): never cached or coalesced.
      response = await media.schedule({ tag, signal }, () => pacedFetch(workerUrl, { method: 'GET', headers }));
    } else {
      // GET/HEAD are idempotent → retry transient 429/503/network drops with
      // backoff. Without this, ONE flaky-4G packet loss during the app's boot
      // call (/api/server/config) used to surface as a hard "Error 503" page.
      // Mutations (POST/PUT/DELETE) keep single-shot semantics.
      const idempotent = request.method === 'GET' || request.method === 'HEAD';
      response = await (idempotent
        ? fetchWithBackoff(workerUrl, { method: request.method, headers, body })
        : fetch(workerUrl, { method: request.method, headers, body }));
    }
  } catch (error) {
    if (isAbortError(error)) return cancelledResponse();
    if (error instanceof RetryAfterError) return rateLimitedResponse(error);
    // Network failure — serve cache or fall back to transparent placeholder
    if (cacheable) {
      const cache = await caches.open('dc-assets-v4');
      const cached = await cache.match(workerUrl);
      if (cached) return cached;
    }
    console.error('[SW] Network error, no cache available:', error);
    return unreachableResponseFor(base, DEFAULT_WORKER_URL);
  }

  if (pathname === '/api/auth/login' && response.ok) {
    const cloned = response.clone();
    try {
      const data = await cloned.json() as any;
      if (data.accessToken) await persistToken(data.accessToken);
      if (data.workerUrl) await persistWorkerUrl(data.workerUrl);
    } catch {}
  }

  return response;
}

// ── Client-direct media path ────────────────────────────────────────────────
// Everything below either reads a cache or runs INSIDE one scheduler job; no
// job schedules another and waits on it, so a job never holds a slot while
// waiting for one. Rate-limit answers surface as RetryAfterError (pacedFetch)
// and the scheduler pauses everyone instead of each request backing off alone.
// Writes to shared state check the session generation first, so a previous
// user's in-flight work can't land in the next user's caches.

type TgConfig = { botToken: string; proxyUrl: string };

const isRetryable = (error: unknown) => isAbortError(error) || error instanceof RetryAfterError;

// Authenticated GET to the user's own worker base (tiny JSON only).
async function workerGet(request: Request, path: string): Promise<Response> {
  const headers: Record<string, string> = {};
  const token = await extractToken(request);
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const base = await getWorkerUrl();
  return pacedFetch(base + path, { method: 'GET', headers });
}

async function getTgConfig(request: Request, generation: number): Promise<TgConfig> {
  if (cachedTgConfig) return cachedTgConfig;
  const res = await workerGet(request, '/api/server/telegram-config');
  const cfg = (await res.json()) as any;
  if (!cfg?.botToken || !cfg?.proxyUrl) throw new Error('telegram config unavailable');
  const config = { botToken: cfg.botToken, proxyUrl: cfg.proxyUrl };
  if (media.isCurrent(generation)) cachedTgConfig = config;
  return config;
}

// Returns the AES key when the library is encrypted, else null. The browser
// handling its own decryption is exactly what keeps the worker off the byte
// path (the user endorsed this — it's the user's own ZKE password).
async function getMediaKey(request: Request, generation: number): Promise<CryptoKey | null> {
  if (mediaKey !== undefined) return mediaKey;
  let key: CryptoKey | null;
  try {
    const res = await workerGet(request, '/api/server/zke-config');
    const zke = (await res.json()) as any;
    key = zke?.enabled && zke?.password && zke?.salt ? await deriveKey(zke.password, zke.salt) : null;
  } catch (error) {
    if (isRetryable(error)) throw error;
    key = null;
  }
  if (media.isCurrent(generation)) mediaKey = key;
  return key;
}

const manifestCacheKey = (assetId: string) => `https://dc-manifest/${assetId}`;

async function cachedManifest(assetId: string): Promise<AssetManifest | undefined> {
  const cache = await caches.open(MANIFEST_CACHE);
  const cached = await cache.match(manifestCacheKey(assetId));
  return cached ? cached.json() : undefined;
}

// Per-asset manifest, cached forever (Telegram file ids are immutable).
async function getManifest(request: Request, assetId: string, generation: number): Promise<AssetManifest> {
  const cached = await cachedManifest(assetId);
  if (cached) return cached;
  const res = await workerGet(request, `/api/assets/${assetId}/dc-manifest`);
  if (!res.ok) throw new Error(`manifest ${res.status}`);
  const manifest = (await res.clone().json()) as AssetManifest;
  if (media.isCurrent(generation)) {
    const cache = await caches.open(MANIFEST_CACHE);
    await cache.put(manifestCacheKey(assetId), res);
  }
  return manifest;
}

async function resolveFilePath(tg: TgConfig, fileId: string, generation: number): Promise<string> {
  const hit = filePathCache.get(fileId);
  if (hit && hit.exp > Date.now()) return hit.path;
  const res = await pacedFetch(buildGetFileUrl(tg.proxyUrl, tg.botToken, fileId), { method: 'GET' });
  const data = (await res.json()) as any;
  if (!data?.ok || !data.result?.file_path) throw new Error(`getFile failed for ${fileId}`);
  const path = data.result.file_path as string;
  if (media.isCurrent(generation)) filePathCache.set(fileId, { path, exp: Date.now() + 50 * 60 * 1000 });
  return path;
}

async function downloadOneFile(
  tg: TgConfig,
  fileId: string,
  key: CryptoKey | null,
  generation: number,
): Promise<ArrayBuffer> {
  let filePath: string;
  try {
    filePath = await resolveFilePath(tg, fileId, generation);
  } catch (error) {
    if (isRetryable(error)) throw error;
    filePathCache.delete(fileId);
    filePath = await resolveFilePath(tg, fileId, generation);
  }
  const res = await pacedFetch(buildDownloadUrl(tg.proxyUrl, tg.botToken, filePath), { method: 'GET' });
  if (!res.ok) {
    filePathCache.delete(fileId); // path may have expired
    throw new Error(`download ${res.status} for ${fileId}`);
  }
  const bytes = await res.arrayBuffer();
  return key ? decryptBytes(bytes, key) : bytes;
}

// One stored video chunk, as a job of the request's class. Concurrent ranges
// inside the same chunk share one download.
function downloadChunk(
  tag: MediaTag,
  fileId: string,
  source: VideoSource,
  signal: AbortSignal,
  generation: number,
): Promise<ArrayBuffer> {
  return media.schedule({ tag, key: `chunk:${fileId}`, signal }, () =>
    downloadOneFile(source.tg, fileId, source.key, generation),
  );
}

type VideoSource = { manifest: AssetManifest; tg: TgConfig; key: CryptoKey | null };

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
  source: VideoSource,
  tag: MediaTag,
  signal: AbortSignal,
  generation: number,
): Promise<Response | null> {
  const { manifest } = source;
  // /video/playback prefers the H.264 rendition when one exists — same swap the
  // Worker's handleOriginal performs. Without this a repaired video would fall
  // back to its HEVC source and stop playing in non-Apple browsers.
  const usePlayback = tag.kind === 'playback' && !!manifest.playbackChunks?.length;
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
    // chunk instead of buffering the whole file. Each chunk is its own job, so
    // the stream never holds a slot while the reader is idle.
    let next = 0;
    const streamAbort = new AbortController();
    signal.addEventListener('abort', () => streamAbort.abort(), { once: true });
    const stream = new ReadableStream({
      async pull(controller) {
        if (next >= chunks.length) {
          controller.close();
          return;
        }
        const c = byIndex.get(next++);
        if (!c) { controller.error(new Error('manifest gap')); return; }
        const bytes = await downloadChunk(tag, c.file_id, source, streamAbort.signal, generation);
        controller.enqueue(new Uint8Array(bytes));
      },
      cancel() {
        next = chunks.length;
        streamAbort.abort();
      },
    });
    return new Response(stream, { status: 200, headers: { ...headers, 'Content-Length': String(totalSize) } });
  }

  const wanted = byIndex.get(plan.chunkIndex);
  if (!wanted) return null; // gap in the manifest → let the Worker answer
  const plaintext = await downloadChunk(tag, wanted.file_id, source, signal, generation);
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

// Trust the request kind over the stored mime: /video/playback is video by
// definition, and containers like .3gp/.mts are often stored as a generic
// octet-stream. Any multi-chunk asset goes here too — concatenating one is
// exactly the blow-up the chunked path exists to avoid.
const looksLikeVideo = (manifest: AssetManifest, kind: AssetBinaryKind) =>
  kind === 'playback' || !!manifest.mimeType?.startsWith('video/') || (manifest.chunks?.length ?? 0) > 1;

// Video bytes go to the ranged, chunk-at-a-time path — before the media cache,
// because a partial 206 must never be cached and replayed as if it were the
// whole asset. Returns undefined when the asset is not a video (continue with
// the image path), null to fall back to the worker.
async function fetchVideoIfVideo(
  request: Request,
  tag: MediaTag,
  signal: AbortSignal,
  generation: number,
): Promise<Response | null | undefined> {
  const { assetId, kind } = tag;
  // Manifest, Telegram config and key in ONE job — or none when all are cached.
  const setup = async (): Promise<VideoSource | null | undefined> => {
    let manifest: AssetManifest | undefined;
    try {
      manifest = await getManifest(request, assetId, generation);
    } catch (error) {
      if (isRetryable(error)) throw error;
    }
    if (!manifest || !looksLikeVideo(manifest, kind)) return undefined;
    try {
      const tg = await getTgConfig(request, generation);
      const needsKey = isEncrypted(manifest.encryptionMode);
      const key = needsKey ? await getMediaKey(request, generation) : null;
      return needsKey && !key ? null : { manifest, tg, key };
    } catch (error) {
      if (isRetryable(error)) throw error;
      console.warn('[SW] client-direct video failed, falling back to worker:', (error as Error)?.message);
      return null;
    }
  };
  const known = await cachedManifest(assetId);
  const offline =
    !!known &&
    (!looksLikeVideo(known, kind) ||
      (!!cachedTgConfig && (mediaKey !== undefined || !isEncrypted(known.encryptionMode))));
  const source = offline ? await setup() : await media.schedule({ tag, key: `video-setup:${assetId}`, signal }, setup);
  if (!source) return source;
  try {
    return await fetchVideoDirect(request, source, tag, signal, generation);
  } catch (error: any) {
    if (isRetryable(error)) throw error;
    console.warn('[SW] client-direct video failed, falling back to worker:', error?.message);
    return null;
  }
}

async function fetchImageDirect(
  request: Request,
  tag: MediaTag,
  signal: AbortSignal,
  generation: number,
): Promise<Response> {
  const { assetId, kind, size } = tag;
  const mediaKeyUrl = `https://dc-media/${assetId}/${kind}/${size || '_'}`;
  const mediaCache = await caches.open(MEDIA_CACHE);
  const cached = await mediaCache.match(mediaKeyUrl);
  if (cached) return cached;

  const buildResponse = (buffer: ArrayBuffer, contentType: string) =>
    new Response(buffer, {
      status: 200,
      headers: { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=31536000, immutable' },
    });

  // Dedup concurrent requests for the same rendition to ONE Telegram round-trip
  // (the scheduler shares the job by key). The shared job resolves to bytes (not
  // a Response) so every caller can build its own fresh, independently-readable
  // Response, and it writes the cache itself so the bytes are kept even if every
  // caller has gone by the time they land.
  const { buffer, contentType } = await media.schedule(
    { tag, key: mediaKeyUrl, signal },
    async (): Promise<{ buffer: ArrayBuffer; contentType: string }> => {
      const manifest = await getManifest(request, assetId, generation);

      // Video bytes never take this path: it concatenates every file id into one
      // buffer, which is fine for an image and ruinous for a 1 GB video.
      // fetchVideoIfVideo serves those a chunk at a time, and the caller routes
      // to it before reaching here. A video *thumbnail* is an image and
      // continues through normally.
      if (manifest.mimeType.startsWith('video/') && kind !== 'thumbnail') {
        throw new Error('FALLBACK');
      }

      const fileIds = selectFileIds(manifest, kind, size);
      if (fileIds.length === 0) throw new Error('FALLBACK');

      const tg = await getTgConfig(request, generation);
      const key = isEncrypted(manifest.encryptionMode) ? await getMediaKey(request, generation) : null;
      if (isEncrypted(manifest.encryptionMode) && !key) throw new Error('FALLBACK');

      let buffer: ArrayBuffer;
      if (fileIds.length === 1) {
        buffer = await downloadOneFile(tg, fileIds[0], key, generation);
      } else {
        const parts: ArrayBuffer[] = [];
        for (const fid of fileIds) parts.push(await downloadOneFile(tg, fid, key, generation));
        const total = parts.reduce((n, p) => n + p.byteLength, 0);
        const joined = new Uint8Array(total);
        let off = 0;
        for (const p of parts) { joined.set(new Uint8Array(p), off); off += p.byteLength; }
        buffer = joined.buffer;
      }

      // Thumb/preview renditions are always JPEG; originals carry their own mime.
      const renditionId = fileIds[0];
      const contentType = (renditionId === manifest.thumbId || renditionId === manifest.previewId)
        ? 'image/jpeg'
        : manifest.mimeType || 'application/octet-stream';
      // Cache thumbnails/previews + small images; skip large originals (disk).
      if ((kind === 'thumbnail' || buffer.byteLength <= 4 * 1024 * 1024) && media.isCurrent(generation)) {
        await mediaCache.put(mediaKeyUrl, buildResponse(buffer, contentType));
      }
      return { buffer, contentType };
    },
  );
  return buildResponse(buffer, contentType);
}

// Read an asset's thumbnail/original straight from Telegram + decrypt locally.
// Returns null to signal "fall back to the worker path" (missing file id,
// encrypted-but-no-key, or any failure) so we never regress an image.
async function fetchAssetDirect(request: Request, tag: MediaTag, signal: AbortSignal): Promise<Response | null> {
  const generation = media.generation;
  try {
    if (tag.kind === 'original' || tag.kind === 'playback') {
      const video = await fetchVideoIfVideo(request, tag, signal, generation);
      if (video !== undefined) return video;
    }
    return await fetchImageDirect(request, tag, signal, generation);
  } catch (error: any) {
    if (isAbortError(error)) return cancelledResponse();
    if (error instanceof RetryAfterError) return rateLimitedResponse(error);
    if (error?.message !== 'FALLBACK') {
      console.warn('[SW] client-direct media failed, falling back to worker:', error?.message);
    }
    return null;
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
    const tag = event.request.method === 'GET' && ASSET_BINARY_REGEX.test(url.pathname) ? mediaTagFor(url) : undefined;
    if (tag) {
      // The page's cancel hints (and request.signal, once browsers propagate
      // it) release this request's claim on its job.
      const ticket = cancelHints.register(event.request.url, event.request.signal);
      event.respondWith(
        fetchAssetDirect(event.request, tag, ticket.signal)
          .then((res) => res ?? directWorkerFetch(event.request, cacheable, url.pathname, ticket.signal))
          .finally(ticket.done),
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
  // Only our own pages may steer the SW — never another origin or a worker.
  if (!isTrustedMessageSource(event.source, sw.location.origin)) return;
  if (event.data?.type === 'cancel' && typeof event.data.url === 'string') {
    try {
      cancelHints.cancel(new URL(event.data.url, sw.location.origin).href);
    } catch {
      // Not a URL: ignore.
    }
  }
  if (event.data?.type === 'viewing') {
    const viewing = parseViewingMessage(event.data);
    if (viewing) media.setViewing(viewing.assetId);
  }
  if (event.data?.type === 'SET_TOKEN') {
    persistToken(event.data.token);
  }
  if (event.data?.type === 'CLEAR_TOKEN') {
    persistToken(null);
  }
  if (event.data?.type === 'SET_WORKER_URL') {
    persistWorkerUrl(event.data.workerUrl || null);
  }
  // Forget the session completely, then say so on the reply port — used by the
  // "can't reach your cloud" screen's Sign out, which must not navigate until the
  // stored worker URL is gone (or the next page would hit the dead worker again).
  if (event.data?.type === 'RESET_SESSION') {
    event.waitUntil(
      (async () => {
        await persistToken(null);
        await persistWorkerUrl(null);
        event.ports?.[0]?.postMessage({ type: 'SESSION_RESET' });
      })(),
    );
  }
});

sw.addEventListener('install', handleInstall, { passive: true });
sw.addEventListener('activate', handleActivate, { passive: true });
sw.addEventListener('fetch', handleFetch, { passive: true });
installMessageListener();
