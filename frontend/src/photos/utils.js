import firebase from 'firebase/compat/app';
import 'firebase/compat/firestore';
import { encryptChunk } from '../crypto.js';
import exifr from 'exifr';

// Lazy firebase references — do NOT call firebase.firestore() at module load 
// time because this file gets imported before App.jsx calls initializeApp().
let _db = null;
const getDb = () => { if (!_db) _db = firebase.firestore(); return _db; };
const appIdentifier = 'default-daemon-client';
const CHUNK_SIZE = 19 * 1024 * 1024;
const PROXY_BASE_URL = "https://daemonclient-proxy.sadrikov49.workers.dev";
export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Thumbnail URL cache (in-memory)
const thumbUrlCache = new Map();

// ── Thumbnail Generation ────────────────────────────────────────────────────
export async function generateThumbnail(file, maxSize = 400) {
    return new Promise((resolve) => {
        const img = new Image();
        const url = URL.createObjectURL(file);
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

// ── Upload thumbnail to Telegram as PHOTO (better caching & serving) ────────
export async function uploadThumbnailToTelegram(thumbBlob, botToken, channelId) {
    if (!thumbBlob) return null;
    const formData = new FormData();
    formData.append('chat_id', channelId);
    // Use sendPhoto — Telegram auto-creates optimized sizes & serves them faster
    formData.append('photo', thumbBlob, `thumb_${Date.now()}.webp`);
    const telegramUrl = `https://api.telegram.org/bot${botToken}/sendPhoto`;
    const proxyUrl = `${PROXY_BASE_URL}?url=${encodeURIComponent(telegramUrl)}`;
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const res = await fetch(proxyUrl, { method: 'POST', body: formData });
            const data = await res.json();
            if (data.ok) {
                // sendPhoto returns an array of photo sizes — use the smallest for thumbnails
                const photos = data.result.photo;
                const smallest = photos[0]; // Telegram sorts by size ascending
                const largest = photos[photos.length - 1];
                return {
                    message_id: data.result.message_id,
                    file_id: smallest.file_id, // small thumb
                    file_id_hq: largest.file_id, // higher quality
                };
            }
        } catch {}
        await sleep(1500 * attempt);
    }
    // Fallback: try as document if sendPhoto fails (e.g. for non-image thumbnails)
    const formData2 = new FormData();
    formData2.append('chat_id', channelId);
    formData2.append('document', thumbBlob, `thumb_${Date.now()}.webp`);
    const telegramUrl2 = `https://api.telegram.org/bot${botToken}/sendDocument`;
    const proxyUrl2 = `${PROXY_BASE_URL}?url=${encodeURIComponent(telegramUrl2)}`;
    try {
        const res = await fetch(proxyUrl2, { method: 'POST', body: formData2 });
        const data = await res.json();
        if (data.ok) return { message_id: data.result.message_id, file_id: data.result.document.file_id };
    } catch {}
    return null;
}

// ── Thumbnail URL caching (localStorage + memory) ──────────────────────────
const THUMB_CACHE_KEY = 'dc_thumb_urls';
const THUMB_CACHE_MAX_AGE = 3600 * 1000; // 1 hour (Telegram file URLs expire)

function loadThumbCache() {
    try {
        const raw = localStorage.getItem(THUMB_CACHE_KEY);
        if (!raw) return;
        const data = JSON.parse(raw);
        const now = Date.now();
        Object.entries(data).forEach(([fileId, entry]) => {
            if (now - entry.ts < THUMB_CACHE_MAX_AGE) {
                thumbUrlCache.set(fileId, entry.url);
            }
        });
    } catch {}
}
function saveThumbCache() {
    try {
        const obj = {};
        thumbUrlCache.forEach((url, fileId) => { obj[fileId] = { url, ts: Date.now() }; });
        localStorage.setItem(THUMB_CACHE_KEY, JSON.stringify(obj));
    } catch {}
}
// Load cache on module init
loadThumbCache();

// ── Rate-limited thumbnail resolver ─────────────────────────────────────────
// Queue system: resolves thumbnails one at a time with delay to avoid 429s
const _resolveQueue = [];
let _resolving = false;

async function _processResolveQueue() {
    if (_resolving) return;
    _resolving = true;
    while (_resolveQueue.length > 0) {
        const { fileId, botToken, resolve } = _resolveQueue.shift();
        if (thumbUrlCache.has(fileId)) { resolve(thumbUrlCache.get(fileId)); continue; }
        try {
            const getFileUrl = `https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`;
            const proxyUrl = `${PROXY_BASE_URL}?url=${encodeURIComponent(getFileUrl)}`;
            const res = await fetch(proxyUrl);
            const data = await res.json();
            if (data.ok) {
                const url = `https://api.telegram.org/file/bot${botToken}/${data.result.file_path}`;
                thumbUrlCache.set(fileId, url);
                resolve(url);
            } else {
                resolve(null);
                if (data.error_code === 429) {
                    const wait = (data.parameters?.retry_after || 5) * 1000;
                    await sleep(wait);
                }
            }
        } catch { resolve(null); }
        // Small delay between requests to avoid rate limiting
        await sleep(150);
    }
    saveThumbCache(); // Persist to localStorage
    _resolving = false;
}

export function resolveThumbnailUrl(fileId, botToken) {
    if (!fileId || !botToken) return Promise.resolve(null);
    if (thumbUrlCache.has(fileId)) return Promise.resolve(thumbUrlCache.get(fileId));
    return new Promise((resolve) => {
        _resolveQueue.push({ fileId, botToken, resolve });
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
