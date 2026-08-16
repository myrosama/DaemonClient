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

// ── Chunk cache, LRU by insertion order, refreshed on hit ──
const chunkCache = new Map();
const inflightChunks = new Map();
const MAX_CACHE_ENTRIES = 10;

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
  for (let attempt = 1; attempt <= 4; attempt++) {
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
      await sleep(1000 * attempt);
    }
  }
  throw lastErr;
}

// ── Download + decrypt one chunk, with retry, dedupe and LRU caching ──
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
  if (inflight) return inflight;

  const promise = (async () => {
    const partData = vFile.messages[chunkIndex];
    const tgPath = await getFilePath(partData, vFile.botToken, vFile.workerUrl);
    const downloadUrl = `https://api.telegram.org/file/bot${vFile.botToken}/${tgPath}`;
    const proxyUrl = `${vFile.workerUrl}/proxy?url=${encodeURIComponent(downloadUrl)}`;

    let rawData;
    let lastErr;
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const fileRes = await fetch(proxyUrl);
        if (!fileRes.ok) throw new Error(`Proxy fetch failed: ${fileRes.status}`);
        rawData = await fileRes.arrayBuffer();
        break;
      } catch (e) {
        lastErr = e;
        await sleep(1000 * attempt);
      }
    }
    if (!rawData) throw lastErr;

    // Decrypt only when the file is encrypted AND we hold the key. Serving
    // ciphertext as if it were plaintext (the old silent fall-through) made
    // previews fail with garbage instead of a real error.
    if (vFile.isEncrypted) {
      if (!vFile.decryptionKey) {
        const err = new Error('ENCRYPTED_NO_KEY');
        err.code = 'ENCRYPTED_NO_KEY';
        throw err;
      }
      rawData = await decryptChunk(rawData, vFile.decryptionKey);
    }

    if (chunkCache.size >= MAX_CACHE_ENTRIES) {
      const oldest = chunkCache.keys().next().value;
      chunkCache.delete(oldest);
    }
    chunkCache.set(cacheKey, rawData);
    return rawData;
  })();

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

  try {
    let plaintext;
    try {
      plaintext = await loadChunk(vFile, fileId, chunkIndex);
    } catch (e) {
      if (e.code === 'ENCRYPTED_NO_KEY') {
        // The SW restarted and only the page holds the key. Ask it to
        // re-register; the player's next range request succeeds.
        askClientToReregister(fileId);
        return new Response('Encryption key not available — re-registering.', {
          status: 503,
          headers: { 'Retry-After': '2' },
        });
      }
      throw e;
    }

    const chunkGlobalStart = chunkIndex * CHUNK_SIZE;
    const localStart = start - chunkGlobalStart;
    const chunkEnd = Math.min(end, chunkGlobalStart + plaintext.byteLength - 1);
    const localEnd = chunkEnd - chunkGlobalStart;
    const sliced = plaintext.slice(localStart, localEnd + 1);

    // Prefetch the next chunk so sequential playback doesn't stall on a full
    // 19 MB round trip at every chunk boundary. Fire-and-forget, deduped and
    // bounded by the same LRU cache.
    if (messages[chunkIndex + 1]) {
      loadChunk(vFile, fileId, chunkIndex + 1).catch(() => {});
    }

    return new Response(sliced, {
      status: isRangeRequest ? 206 : 200,
      headers: {
        'Content-Type': contentTypeFor(vFile),
        'Content-Length': sliced.byteLength.toString(),
        'Accept-Ranges': 'bytes',
        ...(isRangeRequest ? { 'Content-Range': `bytes ${start}-${chunkEnd}/${fileSize}` } : {}),
      },
    });
  } catch (err) {
    console.error('[SW] Stream error:', err);
    return new Response('Streaming failed: ' + err.message, { status: 500 });
  }
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
