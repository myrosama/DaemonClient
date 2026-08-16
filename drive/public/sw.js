// public/sw.js — Virtual File System + Telegram Proxy
//
// Three responsibilities:
//   1. Proxy  /tg-proxy/*  → api.telegram.org (existing)
//   2. Stream /stream/<id> → fetch chunk from TG, decrypt, serve Range slice
//   3. Survive its own termination. A service worker is killed after ~30s of
//      idleness — on a long video the user only has to pause for a minute and
//      the old build woke up with an empty Map and 404'd the rest of the file.
//      Registrations (everything except the key, which must never touch disk)
//      are now persisted to IndexedDB, and if an encrypted file needs its key
//      the SW asks an open page to re-register via NEED_REGISTER.

// ── Lifecycle: activate immediately (no waiting for old tabs to close) ──
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

// ── Crypto constants (must match crypto.js) ──
const IV_LENGTH = 12;
const CHUNK_SIZE = 19 * 1024 * 1024; // 19 MB plaintext chunk

// ── Virtual file registry (in memory; metadata mirrored to IndexedDB) ──
const virtualFiles = new Map();

// ── Chunk cache + in-flight dedupe ──
const chunkCache = new Map();
const inflightChunks = new Map();

// ── Chunk cache, LRU by insertion order, refreshed on hit ──
// Size adapts to the device: 19 MB/chunk × N. 16 entries ≈ 304 MB is fine on
// a desktop with ≥8 GB; a 2 GB phone gets 6 (114 MB). A bigger cache is what
// lets back-and-forth seeking in a big file hit memory instead of Telegram.
const DEVICE_MEM_GB = (typeof navigator !== 'undefined' && navigator.deviceMemory) || 4;
const MAX_CACHE_ENTRIES = DEVICE_MEM_GB >= 8 ? 16 : DEVICE_MEM_GB >= 4 ? 10 : 6;

// ── Chunk download scheduler ──
// A scrub burst fires range requests across many chunks at once; letting them
// all download concurrently saturates the link so the chunk the user actually
// stopped on arrives last. Cap concurrency and always run the MOST RECENTLY
// DEMANDED chunk first — stale scrub probes wait, and the winner is what the
// player is waiting for.
const MAX_CONCURRENT_CHUNK_LOADS = 2;
let activeLoads = 0;
const pendingLoads = []; // { key, wanted, run } — wanted = demand timestamp
const chunkDemand = new Map(); // cacheKey -> last demand timestamp

function scheduleLoad(key, run) {
  chunkDemand.set(key, Date.now());
  return new Promise((resolve, reject) => {
    pendingLoads.push({ key, wanted: Date.now(), run, resolve, reject });
    pumpLoads();
  });
}

function pumpLoads() {
  while (activeLoads < MAX_CONCURRENT_CHUNK_LOADS && pendingLoads.length > 0) {
    // Newest demand first.
    pendingLoads.sort((a, b) => (chunkDemand.get(b.key) || b.wanted) - (chunkDemand.get(a.key) || a.wanted));
    const job = pendingLoads.shift();
    activeLoads++;
    job.run().then(job.resolve, job.reject).finally(() => { activeLoads--; pumpLoads(); });
  }
}

// ── Telegram file_path cache (paths are valid ~1h; getFile is rate-limited
//    and used to be called for every single range request) ──
const filePathCache = new Map();
const FILE_PATH_TTL = 45 * 60 * 1000;

// ── MIME types: the stored fileType comes from the uploading browser and is
//    often empty or generic; the player refuses octet-stream. Prefer the
//    extension when we know it. ──
const MIME_BY_EXT = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml', avif: 'image/avif',
  ico: 'image/x-icon',
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska',
  mov: 'video/quicktime', avi: 'video/x-msvideo', wmv: 'video/x-ms-wmv',
  flv: 'video/x-flv', mpg: 'video/mpeg', mpeg: 'video/mpeg', ts: 'video/mp2t',
  m2ts: 'video/mp2t', '3gp': 'video/3gpp', '3g2': 'video/3gpp2', ogv: 'video/ogg',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac',
  wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg',
  wma: 'audio/x-ms-wma', pdf: 'application/pdf',
  txt: 'text/plain', md: 'text/plain', json: 'application/json',
  csv: 'text/csv', xml: 'application/xml', html: 'text/html', htm: 'text/html',
};

function contentTypeFor(vFile) {
  const name = vFile.fileName || '';
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  if (MIME_BY_EXT[ext]) return MIME_BY_EXT[ext];
  if (vFile.fileType && vFile.fileType !== 'application/octet-stream') return vFile.fileType;
  return 'application/octet-stream';
}

// ── IndexedDB persistence for registration metadata (NEVER the key) ──
const DB_NAME = 'dc-sw-stream';
const STORE = 'files';

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(fileId, meta) {
  try {
    const db = await idbOpen();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(meta, fileId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (e) { console.warn('[SW] idbPut failed:', e); }
}

async function idbGet(fileId) {
  try {
    const db = await idbOpen();
    const result = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const rq = tx.objectStore(STORE).get(fileId);
      rq.onsuccess = () => resolve(rq.result);
      rq.onerror = () => reject(rq.error);
    });
    db.close();
    return result || null;
  } catch (e) { console.warn('[SW] idbGet failed:', e); return null; }
}

async function idbClear() {
  try {
    const db = await idbOpen();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (e) { console.warn('[SW] idbClear failed:', e); }
}

async function askClientToReregister(fileId) {
  const clients = await self.clients.matchAll({ type: 'window' });
  for (const client of clients) client.postMessage({ type: 'NEED_REGISTER', fileId });
}

async function getRegistration(fileId) {
  if (virtualFiles.has(fileId)) return virtualFiles.get(fileId);
  // SW was restarted mid-session — recover the metadata from IndexedDB.
  // The decryption key is deliberately never persisted, so for encrypted
  // files the caller must get a page to re-register (NEED_REGISTER).
  const meta = await idbGet(fileId);
  if (!meta) return null;
  const recovered = { ...meta, decryptionKey: null };
  virtualFiles.set(fileId, recovered);
  return recovered;
}

// ── Message handler: register / clear files for streaming ──
self.addEventListener('message', async (event) => {
  const data = event.data;
  if (!data) return;

  if (data.type === 'REGISTER_FILE') {
    const { fileId, messages, botToken, workerUrl, rawKeyBytes, isEncrypted, fileSize, fileType, fileName } = data;

    let decryptionKey = null;
    if (rawKeyBytes) {
      try {
        decryptionKey = await crypto.subtle.importKey('raw', rawKeyBytes, { name: 'AES-GCM' }, false, ['decrypt']);
      } catch (e) {
        console.error('[SW] Failed to import key:', e);
      }
    }

    const reg = { messages, botToken, workerUrl, decryptionKey, isEncrypted, fileSize, fileType, fileName };
    virtualFiles.set(fileId, reg);
    // Mirror to IndexedDB WITHOUT the key — survives SW termination, but the
    // key material itself never touches disk.
    idbPut(fileId, { messages, botToken, workerUrl, isEncrypted, fileSize, fileType, fileName });

    if (event.ports && event.ports[0]) {
      event.ports[0].postMessage({ status: 'ok' });
    }
  }

  if (data.type === 'CLEAR_FILES') {
    virtualFiles.clear();
    chunkCache.clear();
    inflightChunks.clear();
    filePathCache.clear();
    idbClear();
  }
});

// ── AES-GCM decrypt (works in SW context via crypto.subtle) ──
async function decryptChunk(encryptedData, key) {
  const data = new Uint8Array(encryptedData);
  const iv = data.slice(0, IV_LENGTH);
  const ciphertext = data.slice(IV_LENGTH);
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Resolve a Telegram file_path, cached (getFile is rate-limited and was
//    previously called for every range request on the same chunk set) ──
async function getFilePath(partData, botToken, workerUrl) {
  const cached = filePathCache.get(partData.file_id);
  if (cached && Date.now() - cached.ts < FILE_PATH_TTL) return cached.path;

  const infoUrl = `https://api.telegram.org/bot${botToken}/getFile?file_id=${partData.file_id}`;
  let lastErr;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const infoRes = await fetch(`${workerUrl}/proxy?url=${encodeURIComponent(infoUrl)}`);
      const infoData = await infoRes.json();
      if (!infoData.ok) {
        if (infoData.error_code === 429 && infoData.parameters?.retry_after) {
          await sleep((infoData.parameters.retry_after + 1) * 1000);
          continue;
        }
        throw new Error('Telegram getFile failed: ' + (infoData.description || ''));
      }
      filePathCache.set(partData.file_id, { path: infoData.result.file_path, ts: Date.now() });
      return infoData.result.file_path;
    } catch (e) {
      lastErr = e;
      await sleep(Math.min(1000 * 2 ** (attempt - 1), 15000));
    }
  }
  throw lastErr;
}

// If the SW restarted mid-session, encrypted files are recovered from
// IndexedDB WITHOUT the key (it is never persisted). A range request that
// arrives before the page re-registers must STALL — waiting for the key —
// not fail: the <video> element treats a failed range request as a fatal
// media error and dies, even though the key arrives a moment later.
let lastKeyAsk = 0;
async function waitForDecryptionKey(fileId, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const reg = virtualFiles.get(fileId);
    if (reg && reg.decryptionKey) return true;
    if (Date.now() - lastKeyAsk > 2000) {
      lastKeyAsk = Date.now();
      askClientToReregister(fileId);
    }
    await sleep(400);
  }
  return false;
}

// ── Download + decrypt one chunk, with retry, dedupe and LRU caching ──
// Playback-critical: transient failures (worker cold start, Telegram hiccups,
// rate limits) are retried with exponential backoff so the player's own
// buffer covers the gap instead of surfacing a media error to the user.
async function loadChunk(vFile, fileId, chunkIndex) {
  const cacheKey = `${fileId}:${chunkIndex}`;

  const cached = chunkCache.get(cacheKey);
  if (cached) {
    // LRU touch
    chunkCache.delete(cacheKey);
    chunkCache.set(cacheKey, cached);
    return cached;
  }

  const inflight = inflightChunks.get(cacheKey);
  if (inflight) {
    chunkDemand.set(cacheKey, Date.now()); // still wanted — bump priority
    return inflight;
  }

  const promise = scheduleLoad(cacheKey, async () => {
    const partData = vFile.messages[chunkIndex];
    const tgPath = await getFilePath(partData, vFile.botToken, vFile.workerUrl);
    const downloadUrl = `https://api.telegram.org/file/bot${vFile.botToken}/${tgPath}`;
    const proxyUrl = `${vFile.workerUrl}/proxy?url=${encodeURIComponent(downloadUrl)}`;

    let rawData;
    let lastErr;
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        const fileRes = await fetch(proxyUrl);
        if (fileRes.status === 429) {
          const ra = parseInt(fileRes.headers.get('Retry-After') || '0', 10);
          await sleep((ra || 3) * 1000);
          continue;
        }
        if (!fileRes.ok) throw new Error(`Proxy fetch failed: ${fileRes.status}`);
        rawData = await fileRes.arrayBuffer();
        break;
      } catch (e) {
        lastErr = e;
        await sleep(Math.min(1000 * 2 ** (attempt - 1), 15000));
      }
    }
    if (!rawData) throw lastErr;

    // Decrypt only when the file is encrypted. If the SW restarted the key is
    // not in memory (never persisted) — WAIT for the page to re-send it rather
    // than failing: a failed range request kills the player instantly, while a
    // slow one just shows the player's buffering spinner.
    if (vFile.isEncrypted) {
      let key = vFile.decryptionKey;
      if (!key) {
        const got = await waitForDecryptionKey(fileId);
        if (!got) {
          const err = new Error('ENCRYPTED_NO_KEY');
          err.code = 'ENCRYPTED_NO_KEY';
          throw err;
        }
        key = virtualFiles.get(fileId).decryptionKey;
      }
      rawData = await decryptChunk(rawData, key);
    }

    if (chunkCache.size >= MAX_CACHE_ENTRIES) {
      const oldest = chunkCache.keys().next().value;
      chunkCache.delete(oldest);
    }
    chunkCache.set(cacheKey, rawData);
    return rawData;
  });

  inflightChunks.set(cacheKey, promise);
  try {
    return await promise;
  } finally {
    inflightChunks.delete(cacheKey);
  }
}

// ── Parse a Range header, including suffix ranges (`bytes=-500`), which
//    players use to probe metadata at the end of a file (moov atom, ID3v1).
//    The old parser produced NaN for these and answered 416. ──
function parseRange(rangeHeader, fileSize) {
  let start = 0;
  let end = fileSize - 1;
  const isRangeRequest = !!rangeHeader;
  if (rangeHeader) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
    if (!m || (m[1] === '' && m[2] === '')) return { invalid: true };
    if (m[1] === '') {
      const n = parseInt(m[2], 10);
      start = Math.max(0, fileSize - n);
      end = fileSize - 1;
    } else {
      start = parseInt(m[1], 10);
      end = m[2] === '' ? fileSize - 1 : Math.min(parseInt(m[2], 10), fileSize - 1);
    }
  }
  if (isNaN(start) || isNaN(end) || start > end || (fileSize > 0 && start >= fileSize)) {
    return { invalid: true };
  }
  return { start, end, isRangeRequest };
}

function rangeResponse(fileSize, extraHeaders = {}) {
  return new Response('Range Not Satisfiable', {
    status: 416,
    headers: { 'Content-Range': `bytes */${fileSize}`, ...extraHeaders },
  });
}

// ── Main stream handler ──
async function handleStreamRequest(request, url) {
  const fileId = url.pathname.split('/').pop();
  const vFile = await getRegistration(fileId);

  if (!vFile) {
    return new Response('File not registered with Service Worker.', { status: 404 });
  }

  const { messages, fileSize } = vFile;

  if (!messages || messages.length === 0) {
    return new Response('File has no chunks.', { status: 404 });
  }

  const range = parseRange(request.headers.get('Range'), fileSize);
  if (range.invalid) return rangeResponse(fileSize);
  const { start, end, isRangeRequest } = range;

  const chunkIndex = Math.floor(start / CHUNK_SIZE);
  if (!messages[chunkIndex]) return rangeResponse(fileSize);

  // The slice geometry is computable BEFORE the chunk is downloaded — chunk
  // length is min(CHUNK_SIZE, fileSize - chunkStart) — so the response can be
  // sent IMMEDIATELY with a body stream that delivers bytes when the chunk
  // lands. This is the fix for seek-death on big files: the player used to
  // wait 30s+ on a response that hadn't started (fresh 19MB chunk through the
  // worker proxy), and Chromium's demuxer gave up → seek collapsed to EOF and
  // playback "paused at the end". With headers-first the player sees a live
  // 206, shows its spinner, and resumes when data arrives.
  const chunkGlobalStart = chunkIndex * CHUNK_SIZE;
  const chunkLen = Math.min(CHUNK_SIZE, fileSize - chunkGlobalStart);
  const chunkEnd = Math.min(end, chunkGlobalStart + chunkLen - 1);
  const sliceLen = chunkEnd - start + 1;
  const localStart = start - chunkGlobalStart;
  const localEnd = chunkEnd - chunkGlobalStart;

  // Prefetch the next chunk for sequential playback (near chunk start only —
  // scrub probes must not seed 19MB downloads after every stop).
  const nearChunkStart = localStart < 64 * 1024;
  if (nearChunkStart && messages[chunkIndex + 1]) {
    loadChunk(vFile, fileId, chunkIndex + 1).catch(() => {});
  }

  const cached = chunkCache.get(`${fileId}:${chunkIndex}`);
  const body = new ReadableStream({
    async start(controller) {
      try {
        let plaintext = cached;
        if (!plaintext) {
          plaintext = await loadChunk(vFile, fileId, chunkIndex);
        }
        controller.enqueue(new Uint8Array(plaintext.slice(localStart, localEnd + 1)));
        controller.close();
      } catch (e) {
        controller.error(e);
      }
    },
  });

  return new Response(body, {
    status: isRangeRequest ? 206 : 200,
    headers: {
      'Content-Type': contentTypeFor(vFile),
      'Content-Length': sliceLen.toString(),
      'Accept-Ranges': 'bytes',
      ...(isRangeRequest ? { 'Content-Range': `bytes ${start}-${chunkEnd}/${fileSize}` } : {}),
    },
  });
}

// ── Fetch interceptor ──
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Same-origin only: any other origin could have its own /stream/ or
  // /tg-proxy/ paths, and the old pathname-only check would hijack them.
  if (url.origin !== self.location.origin) return;

  // 1. Existing Telegram proxy
  if (url.pathname.startsWith('/tg-proxy/')) {
    const tgFilePath = url.pathname.substring('/tg-proxy/'.length) + url.search;
    const actualUrl = `https://api.telegram.org/${tgFilePath}`;
    event.respondWith(
      fetch(actualUrl, {
        method: event.request.method,
        headers: event.request.headers,
      })
    );
    return;
  }

  // 2. Virtual file streamer
  if (url.pathname.startsWith('/stream/')) {
    event.respondWith(handleStreamRequest(event.request, url));
  }
});
