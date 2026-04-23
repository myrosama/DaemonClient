import firebase from 'firebase/compat/app';
import 'firebase/compat/firestore';
import { encryptChunk, decryptChunk } from '../crypto.js';
import exifr from 'exifr';
import heic2any from 'heic2any';

// Formats that need conversion → JPEG for universal browser compatibility
const CONVERT_EXTS = new Set(['heic', 'heif', 'bmp', 'tiff', 'tif']);
const CONVERT_TYPES = new Set(['image/heic', 'image/heif', 'image/bmp', 'image/tiff']);

/**
 * Check if a blob is actually HEIC/HEIF by reading its magic bytes.
 * iOS often sends HEIC files with type: '' or type: 'application/octet-stream'.
 * HEIC magic: bytes 4-11 contain 'ftyp' followed by a brand like 'heic', 'heix', 'mif1', etc.
 */
async function isHeicByMagicBytes(blob) {
    try {
        const header = await blob.slice(0, 12).arrayBuffer();
        const view = new Uint8Array(header);
        // Check for 'ftyp' at offset 4
        if (view[4] === 0x66 && view[5] === 0x74 && view[6] === 0x79 && view[7] === 0x70) {
            // Read brand (bytes 8-11)
            const brand = String.fromCharCode(view[8], view[9], view[10], view[11]);
            const heicBrands = ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1', 'avif'];
            return heicBrands.includes(brand.toLowerCase());
        }
    } catch {}
    return false;
}

/**
 * Normalize problematic image formats → JPEG at upload time.
 * Returns { blob, fileName, mimeType } with converted or original values.
 * Uses magic-bytes detection to catch HEIC files that iOS sends with blank mime types.
 */
export async function normalizeImageFormat(blob, fileName = '') {
    const ext = fileName.split('.').pop()?.toLowerCase() || '';
    let needsConvert = CONVERT_EXTS.has(ext) || CONVERT_TYPES.has(blob.type);
    let isHeic = ext === 'heic' || ext === 'heif' || blob.type === 'image/heic' || blob.type === 'image/heif';

    // Magic-bytes fallback: catch HEIC files with blank/wrong mime types
    if (!needsConvert && !blob.type.startsWith('video/')) {
        const magicHeic = await isHeicByMagicBytes(blob);
        if (magicHeic) { isHeic = true; needsConvert = true; }
    }

    if (!needsConvert) return { blob, fileName, mimeType: blob.type || 'image/jpeg' };

    try {
        let jpegBlob;
        if (isHeic) {
            // Use heic2any for HEIC/HEIF
            console.log(`[Format] Converting HEIC → JPEG: ${fileName}`);
            const result = await heic2any({ blob, toType: 'image/jpeg', quality: 0.92 });
            jpegBlob = Array.isArray(result) ? result[0] : result;
        } else {
            // BMP, TIFF → Canvas → JPEG
            jpegBlob = await canvasConvertToJpeg(blob);
        }
        const newName = fileName.replace(/\.[^.]+$/i, '.jpg');
        console.log(`[Format] Converted ${fileName} → ${newName} (${formatFileSize(jpegBlob.size)})`);
        return { blob: jpegBlob, fileName: newName, mimeType: 'image/jpeg' };
    } catch (e) {
        console.error(`[Format] Conversion FAILED for ${fileName}:`, e);
        // Still try to serve it - don't silently pass broken files
        return { blob, fileName, mimeType: blob.type || 'application/octet-stream' };
    }
}

/** Convert any browser-renderable image blob to JPEG via Canvas */
async function canvasConvertToJpeg(blob) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        const url = URL.createObjectURL(blob);
        img.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width = img.width; canvas.height = img.height;
            canvas.getContext('2d').drawImage(img, 0, 0);
            canvas.toBlob((b) => { URL.revokeObjectURL(url); b ? resolve(b) : reject(new Error('Canvas toBlob failed')); }, 'image/jpeg', 0.92);
        };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Image load failed')); };
        img.src = url;
    });
}

/**
 * Generate a micro-thumbnail (tiny 8×8 JPEG data URL, ~200 bytes).
 * Stored directly in Firestore metadata for instant placeholder rendering.
 */
export async function generateMicroThumb(file) {
    try {
        // If it's a video, try generating from frame
        if (file.type?.startsWith('video/')) {
            return await _microThumbFromVideo(file);
        }
        return await _microThumbFromImage(file);
    } catch {
        return null;
    }
}

async function _microThumbFromImage(blob) {
    return new Promise((resolve) => {
        const img = new Image();
        const url = URL.createObjectURL(blob);
        img.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width = 8; canvas.height = 8;
            canvas.getContext('2d').drawImage(img, 0, 0, 8, 8);
            const dataUrl = canvas.toDataURL('image/jpeg', 0.5);
            URL.revokeObjectURL(url);
            resolve(dataUrl);
        };
        img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
        img.src = url;
    });
}

async function _microThumbFromVideo(file) {
    return new Promise((resolve) => {
        const video = document.createElement('video');
        const url = URL.createObjectURL(file);
        video.muted = true; video.preload = 'metadata';
        video.onloadeddata = () => { video.currentTime = Math.min(1, video.duration / 4); };
        video.onseeked = () => {
            const canvas = document.createElement('canvas');
            canvas.width = 8; canvas.height = 8;
            canvas.getContext('2d').drawImage(video, 0, 0, 8, 8);
            const dataUrl = canvas.toDataURL('image/jpeg', 0.5);
            URL.revokeObjectURL(url);
            resolve(dataUrl);
        };
        video.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
        video.src = url;
    });
}

/** @deprecated Use normalizeImageFormat instead */
export async function convertHeicToJpeg(blob, fileName = '') {
    const result = await normalizeImageFormat(blob, fileName);
    return result.blob;
}

// Lazy firebase references — do NOT call firebase.firestore() at module load 
// time because this file gets imported before App.jsx calls initializeApp().
let _db = null;
const getDb = () => { if (!_db) _db = firebase.firestore(); return _db; };
const appIdentifier = 'default-daemon-client';
const CHUNK_SIZE = 19 * 1024 * 1024;
const PROXY_BASE_URL = "https://daemonclient-proxy.sadrikov49.workers.dev";
export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Thumbnail blob URL cache (in-memory, never expires since blob URLs are local)
const thumbUrlCache = new Map();
// Track in-flight requests to avoid duplicate fetches
const thumbInflight = new Map();

// ── Thumbnail Generation ────────────────────────────────────────────────────
export async function generateThumbnail(file, maxSize = 400) {
    // Convert HEIC/HEIF to JPEG first so the browser can render it
    let renderableBlob = file;
    try {
        renderableBlob = await convertHeicToJpeg(file, file.name || '');
    } catch {}

    return new Promise((resolve) => {
        const img = new Image();
        const url = URL.createObjectURL(renderableBlob);
        img.onload = () => {
            const canvas = document.createElement('canvas');
            let w = img.width, h = img.height;
            if (w > h) { h = Math.round(h * maxSize / w); w = maxSize; }
            else { w = Math.round(w * maxSize / h); h = maxSize; }
            canvas.width = w; canvas.height = h;
            canvas.getContext('2d').drawImage(img, 0, 0, w, h);
            canvas.toBlob((blob) => { URL.revokeObjectURL(url); resolve(blob); }, 'image/webp', 0.82);
        };
        img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
        img.src = url;
    });
}

export async function generateVideoThumbnail(file, maxSize = 400) {
    return new Promise((resolve) => {
        const video = document.createElement('video');
        const url = URL.createObjectURL(file);
        video.muted = true; video.preload = 'metadata';
        video.onloadeddata = () => { video.currentTime = Math.min(1, video.duration / 4); };
        video.onseeked = () => {
            const canvas = document.createElement('canvas');
            let w = video.videoWidth, h = video.videoHeight;
            if (w > h) { h = Math.round(h * maxSize / w); w = maxSize; }
            else { w = Math.round(w * maxSize / h); h = maxSize; }
            canvas.width = w; canvas.height = h;
            canvas.getContext('2d').drawImage(video, 0, 0, w, h);
            canvas.toBlob((blob) => { URL.revokeObjectURL(url); resolve(blob); }, 'image/webp', 0.82);
        };
        video.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
        video.src = url;
    });
}

// ── EXIF Extraction ─────────────────────────────────────────────────────────
export async function extractExifData(file) {
    try {
        const exif = await exifr.parse(file, {
            pick: ['DateTimeOriginal','CreateDate','GPSLatitude','GPSLongitude',
                   'Make','Model','ExposureTime','FNumber','ISO','ImageWidth','ImageHeight',
                   'FocalLength','LensModel','Software','OffsetTimeOriginal']
        });
        if (!exif) return { dateTaken: null };
        return {
            dateTaken: exif.DateTimeOriginal || exif.CreateDate || null,
            latitude: exif.GPSLatitude || null, longitude: exif.GPSLongitude || null,
            cameraMake: exif.Make || null, cameraModel: exif.Model || null,
            camera: [exif.Make, exif.Model].filter(Boolean).join(' ') || null,
            exposure: exif.ExposureTime || null, aperture: exif.FNumber || null,
            iso: exif.ISO || null, width: exif.ImageWidth || null, height: exif.ImageHeight || null,
            focalLength: exif.FocalLength || null, lensModel: exif.LensModel || null,
            software: exif.Software || null,
        };
    } catch { return { dateTaken: null }; }
}

// ── Upload file to Telegram (chunked) ───────────────────────────────────────
export async function uploadToTelegram(blob, fileName, botToken, channelId, onProgress, abortSignal, encryptionKey = null) {
    const totalParts = Math.ceil(blob.size / CHUNK_SIZE);
    const uploadedMessageInfo = [];
    let uploadedBytes = 0;
    const isEncrypted = encryptionKey !== null;

    for (let i = 0; i < totalParts; i++) {
        if (abortSignal?.aborted) throw new Error("Upload cancelled.");
        const partNumber = i + 1;
        const rawChunk = blob.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
        let chunkToUpload;
        if (isEncrypted) {
            const rawData = await rawChunk.arrayBuffer();
            const encryptedData = await encryptChunk(rawData, encryptionKey);
            chunkToUpload = new Blob([encryptedData]);
        } else { chunkToUpload = rawChunk; }

        for (let attempt = 1; attempt <= 10; attempt++) {
            try {
                if (onProgress) onProgress({ percent: Math.round((uploadedBytes / blob.size) * 100), status: `Uploading ${partNumber}/${totalParts}` });
                const formData = new FormData();
                formData.append('chat_id', channelId);
                const displayName = isEncrypted
                    ? `${Array.from(crypto.getRandomValues(new Uint8Array(8)), b => b.toString(16).padStart(2, '0')).join('')}.part${String(partNumber).padStart(3, '0')}`
                    : `${fileName}.part${String(partNumber).padStart(3, '0')}`;
                formData.append('document', chunkToUpload, displayName);
                const telegramUrl = `https://api.telegram.org/bot${botToken}/sendDocument`;
                const proxyUrl = `${PROXY_BASE_URL}?url=${encodeURIComponent(telegramUrl)}`;
                const response = await fetch(proxyUrl, { method: 'POST', body: formData, signal: abortSignal });
                const result = await response.json();
                if (result.ok) {
                    uploadedMessageInfo.push({ message_id: result.result.message_id, file_id: result.result.document.file_id });
                    uploadedBytes += rawChunk.size;
                    break;
                }
                if (response.status === 429 && result.parameters?.retry_after) {
                    await sleep(parseInt(result.parameters.retry_after, 10) * 1000 + 500);
                } else { await sleep(2000 * attempt); }
            } catch (error) {
                if (error.name === 'AbortError') throw error;
                if (attempt >= 10) throw new Error(`Upload failed for part ${partNumber}`);
                await sleep(3000 * attempt);
            }
        }
        if (partNumber < totalParts) await sleep(1000);
    }
    if (onProgress) onProgress({ percent: 100, status: 'Done!' });
    return { messages: uploadedMessageInfo, encrypted: isEncrypted };
}

// ── Upload thumbnail to Telegram (encrypted when ZKE enabled) ───────────────
export async function uploadThumbnailToTelegram(thumbBlob, botToken, channelId, encryptionKey = null) {
    if (!thumbBlob) return null;
    const isEncrypted = encryptionKey !== null;

    let blobToUpload = thumbBlob;
    if (isEncrypted) {
        // Encrypt the thumbnail just like file chunks
        const rawData = await thumbBlob.arrayBuffer();
        const encryptedData = await encryptChunk(rawData, encryptionKey);
        blobToUpload = new Blob([encryptedData]);
    }

    // Always use sendDocument for consistency (encrypted blobs aren't valid images)
    const formData = new FormData();
    formData.append('chat_id', channelId);
    const fileName = isEncrypted
        ? `t_${Array.from(crypto.getRandomValues(new Uint8Array(6)), b => b.toString(16).padStart(2, '0')).join('')}.bin`
        : `thumb_${Date.now()}.webp`;
    formData.append('document', blobToUpload, fileName);

    const telegramUrl = `https://api.telegram.org/bot${botToken}/sendDocument`;
    const proxyUrl = `${PROXY_BASE_URL}?url=${encodeURIComponent(telegramUrl)}`;

    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const res = await fetch(proxyUrl, { method: 'POST', body: formData });
            const data = await res.json();
            if (data.ok) {
                return {
                    message_id: data.result.message_id,
                    file_id: data.result.document.file_id,
                    encrypted: isEncrypted,
                };
            }
            if (data.error_code === 429) {
                const wait = (data.parameters?.retry_after || 3) * 1000;
                await sleep(wait + 500);
                continue;
            }
        } catch {}
        await sleep(1500 * attempt);
    }
    return null;
}

// ── Concurrent thumbnail resolver with decryption support ──────────────────
// Resolves thumbnails in parallel batches, decrypts if encrypted, caches as
// local blob URLs (these never expire, unlike raw Telegram URLs).
const THUMB_CONCURRENCY = 5;
const _resolveQueue = [];
let _activeWorkers = 0;

async function _fetchAndCacheThumbnail(fileId, botToken, decryptionKey) {
    // 1. Resolve Telegram file path
    const getFileUrl = `https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`;
    const proxyUrl = `${PROXY_BASE_URL}?url=${encodeURIComponent(getFileUrl)}`;

    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const res = await fetch(proxyUrl);
            const data = await res.json();

            if (data.ok) {
                const tgPath = data.result.file_path;
                const downloadUrl = `https://api.telegram.org/file/bot${botToken}/${tgPath}`;
                const fileProxyUrl = `${PROXY_BASE_URL}?url=${encodeURIComponent(downloadUrl)}`;

                // 2. Download the actual thumbnail bytes
                const fileRes = await fetch(fileProxyUrl);
                if (!fileRes.ok) throw new Error(`Thumb fetch failed: ${fileRes.status}`);
                let rawData = await fileRes.arrayBuffer();

                // 3. Decrypt if encrypted
                if (decryptionKey) {
                    try {
                        rawData = await decryptChunk(rawData, decryptionKey);
                    } catch (e) {
                        console.warn('[Thumb] Decryption failed, using raw:', e.message);
                    }
                }

                // 4. Create a local blob URL (never expires)
                const blob = new Blob([rawData], { type: 'image/webp' });
                return URL.createObjectURL(blob);
            }

            if (data.error_code === 429) {
                const wait = (data.parameters?.retry_after || 5) * 1000;
                await sleep(wait + 500);
                continue;
            }

            return null; // Non-retryable error
        } catch (e) {
            if (attempt >= 3) return null;
            await sleep(1000 * attempt);
        }
    }
    return null;
}

async function _processResolveQueue() {
    while (_resolveQueue.length > 0 && _activeWorkers < THUMB_CONCURRENCY) {
        const task = _resolveQueue.shift();
        if (!task) break;

        const { fileId, botToken, decryptionKey, resolve } = task;

        // Double-check cache (may have been resolved by another worker)
        if (thumbUrlCache.has(fileId)) {
            resolve(thumbUrlCache.get(fileId));
            continue;
        }

        // Check if already in flight
        if (thumbInflight.has(fileId)) {
            thumbInflight.get(fileId).then(resolve);
            continue;
        }

        _activeWorkers++;

        const promise = _fetchAndCacheThumbnail(fileId, botToken, decryptionKey)
            .then(blobUrl => {
                if (blobUrl) thumbUrlCache.set(fileId, blobUrl);
                thumbInflight.delete(fileId);
                _activeWorkers--;
                // Kick off next item
                _processResolveQueue();
                return blobUrl;
            })
            .catch(() => {
                thumbInflight.delete(fileId);
                _activeWorkers--;
                _processResolveQueue();
                return null;
            });

        thumbInflight.set(fileId, promise);
        promise.then(resolve);
    }
}

/**
 * Resolve a thumbnail file_id to a displayable blob URL.
 * Handles decryption, caching, concurrency limiting, and 429 retry.
 *
 * @param {string} fileId - Telegram file_id of the thumbnail
 * @param {string} botToken - User's bot token
 * @param {CryptoKey|null} decryptionKey - ZKE key if thumbnail is encrypted
 * @returns {Promise<string|null>} Blob URL or null
 */
export function resolveThumbnailUrl(fileId, botToken, decryptionKey = null) {
    if (!fileId || !botToken) return Promise.resolve(null);
    if (thumbUrlCache.has(fileId)) return Promise.resolve(thumbUrlCache.get(fileId));
    // Join existing in-flight request
    if (thumbInflight.has(fileId)) return thumbInflight.get(fileId);
    return new Promise((resolve) => {
        _resolveQueue.push({ fileId, botToken, decryptionKey, resolve });
        _processResolveQueue();
    });
}

// ── Firestore helpers ───────────────────────────────────────────────────────
export function getUserPhotosRef(uid) {
    return getDb().collection(`artifacts/${appIdentifier}/users/${uid}/photos`);
}
export function getUserAlbumsRef(uid) {
    return getDb().collection(`artifacts/${appIdentifier}/users/${uid}/albums`);
}
export function getUserFilesRef(uid) {
    return getDb().collection(`artifacts/${appIdentifier}/users/${uid}/files`);
}
export function getUserConfigRef(uid) {
    return getDb().collection(`artifacts/${appIdentifier}/users/${uid}/config`);
}

// ── Delete Telegram messages ────────────────────────────────────────────────
export async function deleteTelegramMessages(messages, botToken, channelId) {
    if (!messages?.length || !botToken) return;
    for (const msg of messages) {
        try {
            const url = `https://api.telegram.org/bot${botToken}/deleteMessage`;
            const proxyUrl = `${PROXY_BASE_URL}?url=${encodeURIComponent(url)}`;
            await fetch(proxyUrl, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: channelId, message_id: msg.message_id })
            });
        } catch {}
        await sleep(350);
    }
}

// ── Format helpers ──────────────────────────────────────────────────────────
export function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

export function formatDate(dateTaken) {
    if (!dateTaken) return 'Unknown date';
    const d = dateTaken.seconds ? new Date(dateTaken.seconds * 1000) : new Date(dateTaken);
    return d.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

export function getMonthKey(dateTaken, uploadedAt) {
    let date;
    if (dateTaken?.seconds) date = new Date(dateTaken.seconds * 1000);
    else if (dateTaken) date = new Date(dateTaken);
    else date = uploadedAt?.toDate?.() || new Date();
    return {
        key: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`,
        label: date.toLocaleDateString('en-US', { year: 'numeric', month: 'long' }),
        date,
    };
}

// ── Repair missing thumbnails ───────────────────────────────────────────────
/**
 * Find all photos without thumbnails, download from Telegram, generate thumb,
 * upload thumb, and update Firestore. Returns { repaired, failed, total }.
 */
export async function repairMissingThumbnails(uid, botToken, channelId, encryptionKey, onProgress) {
    const snap = await getUserPhotosRef(uid).where('thumbFileId', '==', null).get();
    if (snap.empty) return { repaired: 0, failed: 0, total: 0 };

    const docs = snap.docs.map(d => ({ id: d.id, ref: d.ref, ...d.data() }));
    let repaired = 0, failed = 0;

    for (let i = 0; i < docs.length; i++) {
        const photo = docs[i];
        if (onProgress) onProgress({ current: i + 1, total: docs.length, fileName: photo.fileName, repaired, failed });

        try {
            // Download first chunk from Telegram to generate thumbnail
            const firstMsg = photo.messages?.[0];
            if (!firstMsg?.file_id) { failed++; continue; }

            // Get Telegram file path
            const getFileUrl = `https://api.telegram.org/bot${botToken}/getFile?file_id=${firstMsg.file_id}`;
            const proxyUrl = `${PROXY_BASE_URL}?url=${encodeURIComponent(getFileUrl)}`;
            const fileRes = await fetch(proxyUrl);
            const fileData = await fileRes.json();
            if (!fileData.ok) { failed++; continue; }

            const tgPath = fileData.result.file_path;
            const downloadUrl = `https://api.telegram.org/file/bot${botToken}/${tgPath}`;
            const dlProxy = `${PROXY_BASE_URL}?url=${encodeURIComponent(downloadUrl)}`;
            const dlRes = await fetch(dlProxy);
            if (!dlRes.ok) { failed++; continue; }

            let rawData = await dlRes.arrayBuffer();

            // Decrypt if encrypted
            if (photo.encrypted && encryptionKey) {
                try { rawData = await decryptChunk(rawData, encryptionKey); } catch { failed++; continue; }
            }

            // Create a File object for thumbnail generation
            const blob = new Blob([rawData], { type: photo.fileType || 'application/octet-stream' });
            const file = new File([blob], photo.fileName || 'photo', { type: blob.type });

            // Generate thumbnail (convertHeicToJpeg is now built into generateThumbnail)
            const isVideo = (photo.fileType || '').startsWith('video/');
            const thumbBlob = isVideo
                ? await generateVideoThumbnail(file)
                : await generateThumbnail(file);

            if (!thumbBlob) { failed++; continue; }

            // Upload thumbnail to Telegram
            const thumbResult = await uploadThumbnailToTelegram(
                thumbBlob, botToken, channelId,
                encryptionKey || null
            );

            if (!thumbResult) { failed++; continue; }

            // Update Firestore
            await photo.ref.update({
                thumbFileId: thumbResult.file_id,
                thumbMessageId: thumbResult.message_id,
                thumbEncrypted: thumbResult.encrypted || false,
            });

            repaired++;
        } catch (e) {
            console.error(`[Repair] Failed for ${photo.fileName}:`, e);
            failed++;
        }

        // Rate limit delay
        await sleep(1200);
    }

    return { repaired, failed, total: docs.length };
}
