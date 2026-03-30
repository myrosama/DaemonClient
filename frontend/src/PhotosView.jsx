import React, { useState, useEffect, useRef, useCallback } from 'react';
import firebase from 'firebase/compat/app';
import 'firebase/compat/auth';
import 'firebase/compat/firestore';
import { motion, AnimatePresence } from 'framer-motion';
import { deriveKey, encryptChunk, decryptChunk, generateSalt, generatePassword, bytesToBase64, base64ToBytes } from './crypto.js';
import exifr from 'exifr';

// Firebase (already initialized by App.jsx, just get references)
if (!firebase.apps.length) {
    firebase.initializeApp({
        apiKey: "AIzaSyBH5diC5M7MnOIuOWaNPmOB1AV6uJVZyS8", authDomain: "daemonclient-c0625.firebaseapp.com",
        projectId: "daemonclient-c0625", storageBucket: "daemonclient-c0625.firebasestorage.app",
        messagingSenderId: "424457448611", appId: "1:424457448611:web:bea9f7673fb40f137de316",
    });
}
const auth = firebase.auth();
const db = firebase.firestore();
const appIdentifier = 'default-daemon-client';
const CHUNK_SIZE = 19 * 1024 * 1024;
const PROXY_BASE_URL = "https://daemonclient-proxy.sadrikov49.workers.dev";
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ============================================================================
// UTILITY: Generate thumbnail from image file
// ============================================================================
async function generateThumbnail(file, maxSize = 320) {
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
            const dataUrl = canvas.toDataURL('image/webp', 0.7);
            URL.revokeObjectURL(url);
            resolve(dataUrl);
        };
        img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
        img.src = url;
    });
}

// ============================================================================
// UTILITY: Extract EXIF metadata
// ============================================================================
async function extractExifData(file) {
    try {
        const exif = await exifr.parse(file, {
            pick: ['DateTimeOriginal', 'CreateDate', 'GPSLatitude', 'GPSLongitude',
                   'Make', 'Model', 'ExposureTime', 'FNumber', 'ISO', 'ImageWidth', 'ImageHeight']
        });
        if (!exif) return {};
        return {
            dateTaken: exif.DateTimeOriginal || exif.CreateDate || null,
            latitude: exif.GPSLatitude || null,
            longitude: exif.GPSLongitude || null,
            camera: [exif.Make, exif.Model].filter(Boolean).join(' ') || null,
            exposure: exif.ExposureTime || null,
            aperture: exif.FNumber || null,
            iso: exif.ISO || null,
            width: exif.ImageWidth || null,
            height: exif.ImageHeight || null,
        };
    } catch { return {}; }
}

// ============================================================================
// PHOTO UPLOAD (reuses the existing Telegram chunking)
// ============================================================================
async function uploadPhotoToTelegram(file, botToken, channelId, onProgress, abortSignal, encryptionKey = null) {
    const totalParts = Math.ceil(file.size / CHUNK_SIZE);
    const uploadedMessageInfo = [];
    let uploadedBytes = 0;
    const isEncrypted = encryptionKey !== null;

    for (let i = 0; i < totalParts; i++) {
        if (abortSignal?.aborted) throw new Error("Upload cancelled.");
        const partNumber = i + 1;
        const rawChunk = file.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
        let chunkToUpload;
        if (isEncrypted) {
            const rawData = await rawChunk.arrayBuffer();
            const encryptedData = await encryptChunk(rawData, encryptionKey);
            chunkToUpload = new Blob([encryptedData]);
        } else { chunkToUpload = rawChunk; }

        for (let attempt = 1; attempt <= 10; attempt++) {
            try {
                onProgress({ percent: Math.round((uploadedBytes / file.size) * 100), status: `Uploading ${partNumber}/${totalParts}` });
                const formData = new FormData();
                formData.append('chat_id', channelId);
                const displayName = isEncrypted
                    ? `${Array.from(crypto.getRandomValues(new Uint8Array(8)), b => b.toString(16).padStart(2, '0')).join('')}.part${String(partNumber).padStart(3, '0')}`
                    : `${file.name}.part${String(partNumber).padStart(3, '0')}`;
                formData.append('document', chunkToUpload, displayName);
                const telegramUploadUrl = `https://api.telegram.org/bot${botToken}/sendDocument`;
                const proxyUrl = `${PROXY_BASE_URL}?url=${encodeURIComponent(telegramUploadUrl)}`;
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
    onProgress({ percent: 100, status: 'Done!' });
    return {
        fileName: file.name, fileSize: file.size, fileType: file.type,
        uploadedAt: firebase.firestore.Timestamp.now(),
        messages: uploadedMessageInfo, encrypted: isEncrypted
    };
}

// ============================================================================
// LIGHTBOX VIEWER
// ============================================================================
const PhotoLightbox = ({ photo, photos, onClose, onNavigate, onToggleFavorite, onDelete }) => {
    const [currentIndex, setCurrentIndex] = useState(() => photos.findIndex(p => p.id === photo.id));
    const current = photos[currentIndex];
    const [imageUrl, setImageUrl] = useState(null);
    const [loading, setLoading] = useState(true);
    const [showInfo, setShowInfo] = useState(false);

    useEffect(() => {
        if (!current) return;
        setLoading(true);
        setImageUrl(null);
        // Register with SW for streaming
        const loadImage = async () => {
            try {
                if ('serviceWorker' in navigator) {
                    const registration = await navigator.serviceWorker.ready;
                    const sw = registration.active;
                    if (sw) {
                        await new Promise((resolve, reject) => {
                            const channel = new MessageChannel();
                            channel.port1.onmessage = (e) => e.data?.status === 'ok' ? resolve() : reject();
                            const configDoc = db.collection(`artifacts/${appIdentifier}/users/${auth.currentUser.uid}/config`).doc('telegram');
                            configDoc.get().then(snap => {
                                const config = snap.data();
                                sw.postMessage({
                                    type: 'REGISTER_FILE', fileId: current.fileRef || current.id,
                                    messages: current.messages, botToken: config.botToken,
                                    rawKeyBytes: null, isEncrypted: current.encrypted === true,
                                    fileSize: current.fileSize, fileType: current.fileType || 'image/jpeg',
                                }, [channel.port2]);
                            });
                            setTimeout(() => reject(), 5000);
                        });
                        setImageUrl(`/stream/${current.fileRef || current.id}`);
                    }
                }
            } catch {
                // Fallback to thumbnail
                setImageUrl(current.thumbnail || null);
            }
            setLoading(false);
        };
        loadImage();
    }, [currentIndex, current]);

    useEffect(() => {
        const handleKey = (e) => {
            if (e.key === 'Escape') onClose();
            if (e.key === 'ArrowLeft' && currentIndex > 0) setCurrentIndex(i => i - 1);
            if (e.key === 'ArrowRight' && currentIndex < photos.length - 1) setCurrentIndex(i => i + 1);
        };
        window.addEventListener('keydown', handleKey);
        return () => window.removeEventListener('keydown', handleKey);
    }, [currentIndex, photos.length, onClose]);

    if (!current) return null;

    const dateStr = current.dateTaken
        ? new Date(current.dateTaken.seconds ? current.dateTaken.seconds * 1000 : current.dateTaken).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
        : 'Unknown date';

    return (
        <div className="fixed inset-0 z-[100] flex flex-col" style={{ background: 'rgba(0,0,0,0.95)' }}>
            {/* Top bar */}
            <div className="flex items-center justify-between px-4 py-3 z-10">
                <button onClick={onClose} className="w-10 h-10 flex items-center justify-center rounded-full bg-white/10 hover:bg-white/20 transition-colors">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
                <p className="text-white/60 text-sm">{dateStr}</p>
                <div className="flex items-center gap-2">
                    <button onClick={() => setShowInfo(!showInfo)} className="w-10 h-10 flex items-center justify-center rounded-full bg-white/10 hover:bg-white/20">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
                    </button>
                    <button onClick={() => { onToggleFavorite(current); }} className="w-10 h-10 flex items-center justify-center rounded-full bg-white/10 hover:bg-white/20">
                        {current.isFavorite
                            ? <svg width="20" height="20" viewBox="0 0 24 24" fill="#ef4444" stroke="#ef4444" strokeWidth="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
                            : <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
                        }
                    </button>
                    <button onClick={() => { if (window.confirm('Delete this photo permanently?')) { onDelete(current); onClose(); } }} className="w-10 h-10 flex items-center justify-center rounded-full bg-white/10 hover:bg-red-500/40">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                    </button>
                </div>
            </div>

            {/* Main image area */}
            <div className="flex-1 flex items-center justify-center relative overflow-hidden">
                {/* Nav arrows */}
                {currentIndex > 0 && (
                    <button onClick={() => setCurrentIndex(i => i - 1)} className="absolute left-4 z-10 w-12 h-12 flex items-center justify-center rounded-full bg-black/40 hover:bg-black/60 transition-colors">
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>
                    </button>
                )}
                {currentIndex < photos.length - 1 && (
                    <button onClick={() => setCurrentIndex(i => i + 1)} className="absolute right-4 z-10 w-12 h-12 flex items-center justify-center rounded-full bg-black/40 hover:bg-black/60 transition-colors">
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2"><polyline points="9 18 15 12 9 6"/></svg>
                    </button>
                )}

                {loading && <div className="w-10 h-10 border-2 border-white/20 border-t-white/80 rounded-full animate-spin" />}
                {imageUrl && (
                    <motion.img
                        key={currentIndex}
                        src={imageUrl}
                        alt={current.fileName}
                        initial={{ opacity: 0, scale: 0.95 }}
                        animate={{ opacity: 1, scale: 1 }}
                        className="max-w-full max-h-[85vh] object-contain rounded select-none"
                        draggable={false}
                    />
                )}
            </div>

            {/* Info panel */}
            <AnimatePresence>
                {showInfo && (
                    <motion.div
                        initial={{ x: 300, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: 300, opacity: 0 }}
                        className="fixed right-0 top-0 bottom-0 w-80 bg-gray-900/95 backdrop-blur-xl border-l border-gray-700 p-6 z-20 overflow-y-auto"
                    >
                        <h3 className="text-lg font-bold text-white mb-4">Details</h3>
                        <div className="space-y-3 text-sm text-gray-300">
                            <div><span className="text-gray-500">Name</span><p className="truncate">{current.fileName}</p></div>
                            <div><span className="text-gray-500">Size</span><p>{(current.fileSize / 1024 / 1024).toFixed(2)} MB</p></div>
                            <div><span className="text-gray-500">Date</span><p>{dateStr}</p></div>
                            {current.camera && <div><span className="text-gray-500">Camera</span><p>{current.camera}</p></div>}
                            {current.width && current.height && <div><span className="text-gray-500">Resolution</span><p>{current.width} × {current.height}</p></div>}
                            {current.iso && <div><span className="text-gray-500">ISO</span><p>{current.iso}</p></div>}
                            {current.aperture && <div><span className="text-gray-500">Aperture</span><p>f/{current.aperture}</p></div>}
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>

            {/* Bottom thumbnails strip */}
            <div className="h-20 bg-black/60 flex items-center gap-1 px-4 overflow-x-auto">
                {photos.map((p, i) => (
                    <button key={p.id} onClick={() => setCurrentIndex(i)}
                        className={`flex-shrink-0 w-14 h-14 rounded overflow-hidden border-2 transition-all ${i === currentIndex ? 'border-indigo-500 scale-110' : 'border-transparent opacity-60 hover:opacity-100'}`}
                    >
                        <img src={p.thumbnail} alt="" className="w-full h-full object-cover" loading="lazy" />
                    </button>
                ))}
            </div>
        </div>
    );
};

// ============================================================================
// MAIN PHOTOS VIEW COMPONENT
// ============================================================================
const PhotosView = ({ onSwitchToDrive }) => {
    const [photos, setPhotos] = useState([]);
    const [loading, setLoading] = useState(true);
    const [config, setConfig] = useState(null);
    const [uploading, setUploading] = useState(false);
    const [uploadStatus, setUploadStatus] = useState('');
    const [uploadPercent, setUploadPercent] = useState(0);
    const [selectedPhoto, setSelectedPhoto] = useState(null);
    const [filter, setFilter] = useState('all'); // 'all' | 'favorites'
    const [encryptionKey, setEncryptionKey] = useState(null);
    const [zkeEnabled, setZkeEnabled] = useState(false);
    const fileInputRef = useRef(null);
    const abortRef = useRef(null);

    // Load config + ZKE key
    useEffect(() => {
        const uid = auth.currentUser?.uid;
        if (!uid) return;
        const configRef = db.collection(`artifacts/${appIdentifier}/users/${uid}/config`).doc('telegram');
        configRef.get().then(snap => { if (snap.exists) setConfig(snap.data()); });

        const zkeRef = db.collection(`artifacts/${appIdentifier}/users/${uid}/config`).doc('zke');
        zkeRef.get().then(async (snap) => {
            if (snap.exists) {
                const data = snap.data();
                if (data.enabled && data.password && data.salt) {
                    const salt = base64ToBytes(data.salt);
                    const key = await deriveKey(data.password, salt);
                    setEncryptionKey(key);
                    setZkeEnabled(true);
                }
            }
        });
    }, []);

    // Load photos (real-time)
    useEffect(() => {
        const uid = auth.currentUser?.uid;
        if (!uid) return;
        const query = db.collection(`artifacts/${appIdentifier}/users/${uid}/photos`)
            .orderBy('dateTaken', 'desc');
        const unsub = query.onSnapshot(snap => {
            const data = snap.docs.map(d => ({ id: d.id, ...d.data() }));
            setPhotos(data);
            setLoading(false);
        }, () => setLoading(false));
        return () => unsub();
    }, []);

    // Group photos by month
    const groupedPhotos = React.useMemo(() => {
        const filtered = filter === 'favorites' ? photos.filter(p => p.isFavorite) : photos;
        const groups = {};
        filtered.forEach(photo => {
            let date;
            if (photo.dateTaken?.seconds) date = new Date(photo.dateTaken.seconds * 1000);
            else if (photo.dateTaken) date = new Date(photo.dateTaken);
            else date = photo.uploadedAt?.toDate?.() || new Date();
            const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
            const label = date.toLocaleDateString('en-US', { year: 'numeric', month: 'long' });
            if (!groups[key]) groups[key] = { label, photos: [] };
            groups[key].photos.push(photo);
        });
        return Object.entries(groups).sort(([a], [b]) => b.localeCompare(a)).map(([, g]) => g);
    }, [photos, filter]);

    // Upload handler
    const handleUpload = async (e) => {
        const files = Array.from(e.target.files || []);
        if (!files.length || !config?.botToken) return;
        const imageFiles = files.filter(f => f.type.startsWith('image/'));
        if (!imageFiles.length) { alert('Please select image files only.'); return; }

        setUploading(true);
        const uid = auth.currentUser.uid;
        const controller = new AbortController();
        abortRef.current = controller;

        for (let i = 0; i < imageFiles.length; i++) {
            if (controller.signal.aborted) break;
            const file = imageFiles[i];
            setUploadStatus(`Processing ${i + 1}/${imageFiles.length}: ${file.name}`);

            try {
                // Step 1: Extract EXIF and generate thumbnail in parallel
                const [exifData, thumbnail] = await Promise.all([
                    extractExifData(file),
                    generateThumbnail(file)
                ]);

                // Step 2: Upload to Telegram
                setUploadStatus(`Uploading ${i + 1}/${imageFiles.length}: ${file.name}`);
                const uploadResult = await uploadPhotoToTelegram(
                    file, config.botToken, config.channelId,
                    (p) => setUploadPercent(p.percent),
                    controller.signal, zkeEnabled ? encryptionKey : null
                );

                // Step 3: Save to files collection (for consistency with Drive)
                const fileRef = db.collection(`artifacts/${appIdentifier}/users/${uid}/files`).doc();
                await fileRef.set({ id: fileRef.id, ...uploadResult, type: 'file', parentId: 'root' });

                // Step 4: Save photo metadata
                const photoRef = db.collection(`artifacts/${appIdentifier}/users/${uid}/photos`).doc();
                await photoRef.set({
                    id: photoRef.id,
                    fileRef: fileRef.id,
                    fileName: file.name,
                    fileSize: file.size,
                    fileType: file.type,
                    messages: uploadResult.messages,
                    encrypted: uploadResult.encrypted,
                    thumbnail: thumbnail || null,
                    dateTaken: exifData.dateTaken
                        ? firebase.firestore.Timestamp.fromDate(new Date(exifData.dateTaken))
                        : firebase.firestore.Timestamp.now(),
                    latitude: exifData.latitude || null,
                    longitude: exifData.longitude || null,
                    camera: exifData.camera || null,
                    width: exifData.width || null,
                    height: exifData.height || null,
                    iso: exifData.iso || null,
                    aperture: exifData.aperture || null,
                    exposure: exifData.exposure || null,
                    isFavorite: false,
                    uploadedAt: firebase.firestore.Timestamp.now(),
                });
            } catch (err) {
                if (err.name === 'AbortError' || err.message === 'Upload cancelled.') break;
                console.error(`Failed to upload ${file.name}:`, err);
            }
        }
        setUploading(false);
        setUploadStatus('');
        setUploadPercent(0);
        abortRef.current = null;
        if (fileInputRef.current) fileInputRef.current.value = '';
    };

    // Toggle favorite
    const handleToggleFavorite = async (photo) => {
        const uid = auth.currentUser.uid;
        try {
            await db.collection(`artifacts/${appIdentifier}/users/${uid}/photos`).doc(photo.id)
                .update({ isFavorite: !photo.isFavorite });
        } catch (err) { console.error('Failed to toggle favorite:', err); }
    };

    // Delete photo
    const handleDeletePhoto = async (photo) => {
        const uid = auth.currentUser.uid;
        try {
            // Delete from Telegram
            if (photo.messages?.length && config?.botToken) {
                for (const msg of photo.messages) {
                    try {
                        await fetch(`https://api.telegram.org/bot${config.botToken}/deleteMessage`, {
                            method: 'POST', headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ chat_id: config.channelId, message_id: msg.message_id })
                        });
                    } catch {}
                    await sleep(350);
                }
            }
            // Delete from photos collection
            await db.collection(`artifacts/${appIdentifier}/users/${uid}/photos`).doc(photo.id).delete();
            // Also delete from files collection if fileRef exists
            if (photo.fileRef) {
                try { await db.collection(`artifacts/${appIdentifier}/users/${uid}/files`).doc(photo.fileRef).delete(); } catch {}
            }
        } catch (err) { console.error('Failed to delete photo:', err); }
    };

    const filteredPhotos = filter === 'favorites' ? photos.filter(p => p.isFavorite) : photos;

    return (
        <div className="min-h-screen bg-gray-900 text-white font-sans">
            {/* Header */}
            <div className="sticky top-0 z-40 bg-gray-900/90 backdrop-blur-xl border-b border-gray-800">
                <div className="max-w-7xl mx-auto px-4 py-3">
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-4">
                            <img src="/logo.png" alt="Logo" className="w-8 h-8" />
                            <h1 className="text-xl font-bold text-white">Photos</h1>
                        </div>
                        <div className="flex items-center gap-3">
                            {/* Filter tabs */}
                            <div className="hidden sm:flex bg-gray-800 rounded-lg p-0.5">
                                <button onClick={() => setFilter('all')}
                                    className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-all ${filter === 'all' ? 'bg-indigo-600 text-white' : 'text-gray-400 hover:text-white'}`}>
                                    All Photos
                                </button>
                                <button onClick={() => setFilter('favorites')}
                                    className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-all flex items-center gap-1 ${filter === 'favorites' ? 'bg-indigo-600 text-white' : 'text-gray-400 hover:text-white'}`}>
                                    <svg width="12" height="12" viewBox="0 0 24 24" fill={filter === 'favorites' ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
                                    Favorites
                                </button>
                            </div>
                            {/* Upload button */}
                            <input type="file" ref={fileInputRef} onChange={handleUpload} className="hidden" accept="image/*" multiple />
                            <button onClick={() => fileInputRef.current?.click()} disabled={uploading}
                                className="bg-indigo-600 hover:bg-indigo-500 disabled:bg-gray-600 text-white px-4 py-2 rounded-lg text-sm font-semibold flex items-center gap-2 transition-all">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                                Upload
                            </button>
                            {/* Switch to Drive */}
                            <button onClick={onSwitchToDrive}
                                className="bg-gray-800 hover:bg-gray-700 text-gray-300 px-3 py-2 rounded-lg text-sm font-medium flex items-center gap-2 border border-gray-700">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
                                Drive
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            {/* Upload progress */}
            {uploading && (
                <div className="max-w-7xl mx-auto px-4 py-3">
                    <div className="bg-indigo-900/30 border border-indigo-500/30 rounded-lg px-4 py-3">
                        <div className="flex items-center justify-between mb-2">
                            <span className="text-sm text-indigo-200">{uploadStatus}</span>
                            <button onClick={() => { abortRef.current?.abort(); setUploading(false); }} className="text-xs text-red-400 hover:text-red-300 font-bold">CANCEL</button>
                        </div>
                        <div className="w-full bg-gray-700 rounded-full h-1.5">
                            <div className="bg-indigo-500 h-1.5 rounded-full transition-all" style={{ width: `${uploadPercent}%` }}/>
                        </div>
                    </div>
                </div>
            )}

            {/* Main Content */}
            <div className="max-w-7xl mx-auto px-4 py-6">
                {loading ? (
                    <div className="flex flex-col items-center justify-center py-32">
                        <div className="w-8 h-8 border-2 border-indigo-500/30 border-t-indigo-500 rounded-full animate-spin" />
                        <p className="mt-4 text-gray-400">Loading your photos...</p>
                    </div>
                ) : filteredPhotos.length === 0 ? (
                    /* Empty state */
                    <div className="flex flex-col items-center justify-center py-32">
                        <div className="w-24 h-24 rounded-full bg-gray-800 flex items-center justify-center mb-6">
                            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-gray-600">
                                <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>
                            </svg>
                        </div>
                        <h2 className="text-xl font-bold text-white mb-2">
                            {filter === 'favorites' ? 'No favorites yet' : 'No photos yet'}
                        </h2>
                        <p className="text-gray-400 text-center max-w-md mb-6">
                            {filter === 'favorites'
                                ? 'Open a photo and tap the heart icon to add it to favorites.'
                                : 'Upload your photos to store them securely with zero-knowledge encryption. Your photos, your privacy.'}
                        </p>
                        {filter !== 'favorites' && (
                            <button onClick={() => fileInputRef.current?.click()}
                                className="bg-indigo-600 hover:bg-indigo-500 text-white px-6 py-3 rounded-xl font-semibold flex items-center gap-2">
                                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                                Upload Photos
                            </button>
                        )}
                    </div>
                ) : (
                    /* Photo grid grouped by month */
                    <div className="space-y-8">
                        {groupedPhotos.map((group) => (
                            <div key={group.label}>
                                <h2 className="text-lg font-bold text-white mb-3 sticky top-16 z-10 bg-gray-900/80 backdrop-blur-sm py-2">
                                    {group.label}
                                    <span className="text-gray-500 text-sm font-normal ml-2">{group.photos.length} photos</span>
                                </h2>
                                <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-8 gap-1">
                                    {group.photos.map((photo) => (
                                        <motion.button
                                            key={photo.id}
                                            layoutId={photo.id}
                                            onClick={() => setSelectedPhoto(photo)}
                                            className="relative aspect-square overflow-hidden rounded group bg-gray-800"
                                            whileHover={{ scale: 1.02 }}
                                            whileTap={{ scale: 0.98 }}
                                        >
                                            {photo.thumbnail ? (
                                                <img
                                                    src={photo.thumbnail}
                                                    alt={photo.fileName}
                                                    className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
                                                    loading="lazy"
                                                />
                                            ) : (
                                                <div className="w-full h-full flex items-center justify-center bg-gray-800">
                                                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-gray-600">
                                                        <rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>
                                                    </svg>
                                                </div>
                                            )}
                                            {/* Favorite badge */}
                                            {photo.isFavorite && (
                                                <div className="absolute top-1 right-1">
                                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="#ef4444" stroke="#ef4444" strokeWidth="2">
                                                        <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
                                                    </svg>
                                                </div>
                                            )}
                                            {/* Hover overlay */}
                                            <div className="absolute inset-0 bg-gradient-to-t from-black/50 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
                                        </motion.button>
                                    ))}
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {/* Lightbox */}
            <AnimatePresence>
                {selectedPhoto && (
                    <PhotoLightbox
                        photo={selectedPhoto}
                        photos={filteredPhotos}
                        onClose={() => setSelectedPhoto(null)}
                        onToggleFavorite={handleToggleFavorite}
                        onDelete={handleDeletePhoto}
                    />
                )}
            </AnimatePresence>
        </div>
    );
};

export default PhotosView;
