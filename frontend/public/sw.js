// public/sw.js — Virtual File System + Telegram Proxy
//
// Two responsibilities:
//   1. Proxy  /tg-proxy/*  → api.telegram.org (existing)
//   2. Stream /stream/<id> → fetch chunk from TG, decrypt, serve Range slice

// ── Activate immediately (no waiting for old tabs to close) ──
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

// ── Crypto constants (must match crypto.js) ──
const IV_LENGTH = 12;

// ── Virtual file registry ──
// { [fileId]: { messages, botToken, decryptionKey, fileSize, fileType } }
const virtualFiles = new Map();

// ── Chunk cache (avoid re-downloading the same chunk) ──
// { "<fileId>:<chunkIndex>": ArrayBuffer(plaintext) }
const chunkCache = new Map();
const MAX_CACHE_ENTRIES = 10;

// ── Message handler: register files for streaming ──
self.addEventListener('message', async (event) => {
  if (event.data && event.data.type === 'REGISTER_FILE') {
    const { fileId, messages, botToken, rawKeyBytes, isEncrypted, fileSize, fileType } = event.data;

    // Import raw key bytes as CryptoKey for AES-GCM decryption
    let decryptionKey = null;
    if (rawKeyBytes) {
      try {
        decryptionKey = await crypto.subtle.importKey(
          'raw', rawKeyBytes, { name: 'AES-GCM' }, false, ['decrypt']
        );
      } catch (e) {
        console.error('[SW] Failed to import key:', e);
      }
    }

    virtualFiles.set(fileId, { messages, botToken, decryptionKey, isEncrypted, fileSize, fileType });
    // Send confirmation via MessageChannel
    if (event.ports && event.ports[0]) {
      event.ports[0].postMessage({ status: 'ok' });
    }
  }
});

// ── Fetch interceptor ──
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

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

// ── AES-GCM decrypt (works in SW context via crypto.subtle) ──
async function decryptChunk(encryptedData, key) {
  const data = new Uint8Array(encryptedData);
  const iv = data.slice(0, IV_LENGTH);
  const ciphertext = data.slice(IV_LENGTH);
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
}

// ── Main stream handler ──
async function handleStreamRequest(request, url) {
  const fileId = url.pathname.split('/').pop();
  const vFile = virtualFiles.get(fileId);

  if (!vFile) {
    return new Response('File not registered with Service Worker.', { status: 404 });
  }

  const { messages, botToken, decryptionKey, isEncrypted, fileSize, fileType } = vFile;
  const CHUNK_SIZE = 19 * 1024 * 1024; // 19 MB plaintext chunk

  // ── Parse Range header ──
  let start = 0;
  let end = fileSize - 1;
  const rangeHeader = request.headers.get('Range');

  if (rangeHeader) {
    const parts = rangeHeader.replace(/bytes=/, '').split('-');
    start = parseInt(parts[0], 10);
    end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    // Clamp
    if (end >= fileSize) end = fileSize - 1;
  }

  // ── Which chunk(s) do we need? ──
  const chunkIndex = Math.floor(start / CHUNK_SIZE);
  const partData = messages[chunkIndex];

  if (!partData) {
    return new Response('Chunk out of bounds.', { status: 416 });
  }

  try {
    // ── Get the plaintext chunk (cache or fetch+decrypt) ──
    const cacheKey = `${fileId}:${chunkIndex}`;
    let plaintext;

    if (chunkCache.has(cacheKey)) {
      plaintext = chunkCache.get(cacheKey);
    } else {
      // 1. Resolve Telegram file path
      const infoRes = await fetch(
        `https://api.telegram.org/bot${botToken}/getFile?file_id=${partData.file_id}`
      );
      const infoData = await infoRes.json();
      if (!infoData.ok) throw new Error('Telegram getFile failed: ' + (infoData.description || ''));

      const tgPath = infoData.result.file_path;
      const downloadUrl = `https://api.telegram.org/file/bot${botToken}/${tgPath}`;

      // 2. Fetch via Cloudflare proxy (CORS)
      const proxyUrl = `https://daemonclient-proxy.sadrikov49.workers.dev?url=${encodeURIComponent(downloadUrl)}`;
      const fileRes = await fetch(proxyUrl);
      if (!fileRes.ok) throw new Error(`Proxy fetch failed: ${fileRes.status}`);

      let rawData = await fileRes.arrayBuffer();

      // 3. Decrypt only if this specific file is actually encrypted
      if (partData.isEncrypted && decryptionKey) {
        rawData = await decryptChunk(rawData, decryptionKey);
      } else if (isEncrypted && decryptionKey) {
        // Fallback for older chunks logic
        rawData = await decryptChunk(rawData, decryptionKey);
      }

      plaintext = rawData;

      // 4. Cache it (evict oldest if full)
      if (chunkCache.size >= MAX_CACHE_ENTRIES) {
        const oldest = chunkCache.keys().next().value;
        chunkCache.delete(oldest);
      }
      chunkCache.set(cacheKey, plaintext);
    }

    // ── Slice the bytes the browser actually asked for ──
    const chunkGlobalStart = chunkIndex * CHUNK_SIZE;
    const localStart = start - chunkGlobalStart;
    // Don't go beyond this chunk's boundary or the file's end
    const chunkEnd = Math.min(end, chunkGlobalStart + plaintext.byteLength - 1);
    const localEnd = chunkEnd - chunkGlobalStart;
    const sliced = plaintext.slice(localStart, localEnd + 1);

    // ── Build response ──
    const isRangeRequest = !!rangeHeader;

    return new Response(sliced, {
      status: isRangeRequest ? 206 : 200,
      headers: {
        'Content-Type': fileType || 'application/octet-stream',
        'Content-Length': sliced.byteLength.toString(),
        'Accept-Ranges': 'bytes',
        ...(isRangeRequest
          ? { 'Content-Range': `bytes ${start}-${chunkEnd}/${fileSize}` }
          : {}),
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (err) {
    console.error('[SW] Stream error:', err);
    return new Response('Streaming failed: ' + err.message, { status: 500 });
  }
}