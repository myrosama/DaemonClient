import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import firebase from 'firebase/compat/app';
import 'firebase/compat/auth';
import 'firebase/compat/firestore';
import { motion, AnimatePresence } from 'framer-motion';
import { deriveKey, base64ToBytes } from './crypto.js';
import PhotoLightbox from './photos/Lightbox.jsx';
import GooglePhotosImport from './photos/GooglePhotosImport.jsx';
import {
    sleep, generateThumbnail, generateVideoThumbnail, extractExifData,
    uploadToTelegram, uploadThumbnailToTelegram, resolveThumbnailUrl,
    getUserPhotosRef, getUserAlbumsRef, getUserFilesRef, getUserConfigRef,
    deleteTelegramMessages, formatFileSize, getMonthKey, getDayKey, formatDate,
    repairMissingThumbnails, normalizeImageFormat,
} from './photos/utils.js';
import './photos/photos.css';

// Lazy Firebase references — these must NOT be called at module load time
let _auth = null, _db = null;
const getAuth = () => { if (!_auth) _auth = firebase.auth(); return _auth; };
const getDb = () => { if (!_db) _db = firebase.firestore(); return _db; };
// All metadata loaded upfront for instant timeline navigation

// ═══════════════════════════════════════════════════════════════════════════
// Google Photos-style Lazy Thumbnail — flex-based, aspect-ratio-aware
// ═══════════════════════════════════════════════════════════════════════════
const LazyThumb = ({ photo, botToken, decryptionKey, onClick, selected, onSelect, selectionMode, isFocused }) => {
    const ref = useRef(null);
    const [src, setSrc] = useState(null);
    const [visible, setVisible] = useState(false);
    const longPressTimer = useRef(null);

    useEffect(() => {
        const el = ref.current;
        if (!el) return;
        const obs = new IntersectionObserver(([entry]) => {
            if (entry.isIntersecting) { setVisible(true); obs.unobserve(el); }
        }, { rootMargin: '400px' });
        obs.observe(el);
        return () => obs.disconnect();
    }, []);

    useEffect(() => {
        if (!visible) return;
        if (photo.thumbnail) { setSrc(photo.thumbnail); return; }
        if (photo.thumbFileId && botToken) {
            const key = photo.thumbEncrypted ? decryptionKey : null;
            resolveThumbnailUrl(photo.thumbFileId, botToken, key).then(url => { if (url) setSrc(url); });
        }
    }, [visible, photo.thumbFileId, photo.thumbnail, photo.thumbEncrypted, botToken, decryptionKey]);

    const isVideo = photo.fileType?.startsWith('video/');
    // Compute flex sizing from aspect ratio — preserves native proportions
    const ar = (photo.width && photo.height) ? photo.width / photo.height : 1.33;

    // Long-press for mobile selection
    const handlePointerDown = (e) => {
        if (e.pointerType !== 'touch') return;
        longPressTimer.current = setTimeout(() => {
            if (navigator.vibrate) navigator.vibrate(50);
            onSelect(photo, e);
        }, 500);
    };
    const handlePointerUp = () => clearTimeout(longPressTimer.current);
    const handlePointerCancel = () => clearTimeout(longPressTimer.current);

    return (
        <div ref={ref}
            data-photo-id={photo.id}
            className={`gp-tile ${selected ? 'gp-selected' : ''} ${selectionMode ? 'gp-selection-active' : ''} ${isFocused ? 'gp-focused' : ''}`}
            style={{ flexGrow: ar, flexBasis: `calc(var(--gp-row-height, 220px) * ${ar})` }}
            onClick={(e) => {
                if (e.shiftKey || e.ctrlKey || e.metaKey || selectionMode) { e.preventDefault(); onSelect(photo, e); }
                else onClick(photo);
            }}
            onPointerDown={handlePointerDown}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerCancel}
            onContextMenu={(e) => { if (selectionMode) e.preventDefault(); }}
        >
            {src ? <img src={src} alt="" /> : <div className="gp-tile-skeleton" />}
            {/* Ghost checkbox — appears on hover, fills when selected */}
            <div className="gp-check" onClick={(e) => { e.stopPropagation(); onSelect(photo, e); }}>
                {selected
                    ? <svg width="18" height="18" viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="#4f46e5" stroke="white" strokeWidth="1.5"/><polyline points="7 12 10.5 15.5 17 9" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                    : <svg width="18" height="18" viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="rgba(0,0,0,0.3)" stroke="white" strokeWidth="1.5"/></svg>
                }
            </div>
            {photo.isFavorite && <div className="gp-fav">♥</div>}
            {isVideo && (
                <div className="gp-video-badge">
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="white"><polygon points="5 3 19 12 5 21"/></svg>
                    {photo.duration ? <span>{photo.duration}</span> : null}
                </div>
            )}
        </div>
    );
};

// ═══════════════════════════════════════════════════════════════════════════
// MAIN PHOTOS VIEW
// ═══════════════════════════════════════════════════════════════════════════
const PhotosView = ({ onSwitchToDrive }) => {
    // State
    const [photos, setPhotos] = useState([]);
    const [loading, setLoading] = useState(true);
    const [config, setConfig] = useState(null);
    const [encryptionKey, setEncryptionKey] = useState(null);
    const [zkeEnabled, setZkeEnabled] = useState(false);
    const [uploading, setUploading] = useState(false);
    const [uploadStatus, setUploadStatus] = useState('');
    const [uploadPercent, setUploadPercent] = useState(0);
    const [selectedPhoto, setSelectedPhoto] = useState(null);
    const [selectedIds, setSelectedIds] = useState(new Set());
    const [activeTab, setActiveTab] = useState('photos'); // photos | favorites | albums | search | map
    const [albums, setAlbums] = useState([]);
    const [activeAlbum, setActiveAlbum] = useState(null);
    const [searchQuery, setSearchQuery] = useState('');
    const [showImport, setShowImport] = useState(false);
    const [showUploadMenu, setShowUploadMenu] = useState(false);
    const uploadMenuRef = useRef(null);
    const [showCreateAlbum, setShowCreateAlbum] = useState(false);
    const [newAlbumName, setNewAlbumName] = useState('');
    const [allLoaded, setAllLoaded] = useState(false);
    const fileInputRef = useRef(null);
    const abortRef = useRef(null);

    const [repairing, setRepairing] = useState(false);
    const [repairProgress, setRepairProgress] = useState(null);
    const [showScrollTop, setShowScrollTop] = useState(false);
    const lastSelectedRef = useRef(null);
    const scrollContainerRef = useRef(null);
    const [focusedIndex, setFocusedIndex] = useState(-1);
    // Drag-select
    const [dragSelecting, setDragSelecting] = useState(false);
    const [dragRect, setDragRect] = useState(null);
    const dragStartRef = useRef(null);
    const uid = getAuth().currentUser?.uid;

    // ── Load config + ZKE ───────────────────────────────────────────────
    useEffect(() => {
        if (!uid) return;
        const configRef = getUserConfigRef(uid).doc('telegram');
        configRef.get().then(snap => { if (snap.exists) setConfig(snap.data()); });
        const zkeRef = getUserConfigRef(uid).doc('zke');
        zkeRef.get().then(async (snap) => {
            if (snap.exists) {
                const d = snap.data();
                if (d.enabled && d.password && d.salt) {
                    const salt = base64ToBytes(d.salt);
                    const key = await deriveKey(d.password, salt);
                    setEncryptionKey(key); setZkeEnabled(true);
                }
            }
        });
    }, [uid]);

    // ── Load ALL photos metadata upfront ──────────────────────────────────
    // Metadata is tiny (~0.5KB/doc), so 12K photos = ~6MB — loads in <2s.
    // This gives instant timeline access (scroll/jump to any date).
    const loadPhotos = useCallback(async () => {
        if (!uid) return;
        setLoading(true);
        try {
            const snap = await getUserPhotosRef(uid)
                .where('trashed', '!=', true)
                .orderBy('trashed')
                .orderBy('dateTaken', 'desc')
                .get();
            setPhotos(snap.docs.map(d => ({ id: d.id, ...d.data() })));
        } catch {
            // Fallback without trashed field
            const snap = await getUserPhotosRef(uid)
                .orderBy('dateTaken', 'desc')
                .get();
            setPhotos(snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(d => !d.trashed));
        }
        setLoading(false);
        setAllLoaded(true);
    }, [uid]);

    useEffect(() => { loadPhotos(); }, [uid]);

    // ── Load albums ─────────────────────────────────────────────────────
    useEffect(() => {
        if (!uid) return;
        const unsub = getUserAlbumsRef(uid).orderBy('updatedAt', 'desc').onSnapshot(snap => {
            setAlbums(snap.docs.map(d => ({ id: d.id, ...d.data() })));
        }, () => {});
        return () => unsub();
    }, [uid]);

    // ── Grouped photos (must be defined before useEffects that reference it) ─
    const displayPhotos = useMemo(() => {
        let list = photos;
        if (activeTab === 'favorites') list = photos.filter(p => p.isFavorite);
        if (activeTab === 'search' && searchQuery) {
            const q = searchQuery.toLowerCase();
            list = photos.filter(p =>
                p.fileName?.toLowerCase().includes(q) ||
                p.camera?.toLowerCase().includes(q) ||
                p.cameraModel?.toLowerCase().includes(q) ||
                p.cameraMake?.toLowerCase().includes(q)
            );
        }
        if (activeAlbum) {
            const albumPhotoIds = new Set(activeAlbum.photoIds || []);
            list = photos.filter(p => albumPhotoIds.has(p.id));
        }
        return list;
    }, [photos, activeTab, searchQuery, activeAlbum]);

    // Group photos by DAY (Google Photos style)
    const groupedPhotos = useMemo(() => {
        const groups = {};
        displayPhotos.forEach(photo => {
            const { key, label, year } = getDayKey(photo.dateTaken, photo.uploadedAt);
            if (!groups[key]) groups[key] = { key, label, year, photos: [] };
            groups[key].photos.push(photo);
        });
        return Object.entries(groups).sort(([a], [b]) => b.localeCompare(a)).map(([, g]) => g);
    }, [displayPhotos]);

    // Year scrubber data — proportional to photo count, with months
    const scrubberData = useMemo(() => {
        const yearMap = {};
        groupedPhotos.forEach(g => {
            if (!yearMap[g.year]) yearMap[g.year] = { year: g.year, count: 0, months: {} };
            yearMap[g.year].count += g.photos.length;
            const month = g.date?.getMonth?.() ?? new Date(g.key).getMonth();
            const mKey = month;
            if (!yearMap[g.year].months[mKey]) yearMap[g.year].months[mKey] = { month: mKey, count: 0 };
            yearMap[g.year].months[mKey].count += g.photos.length;
        });
        const total = displayPhotos.length || 1;
        return Object.values(yearMap)
            .sort((a, b) => b.year - a.year)
            .map(y => ({
                ...y,
                fraction: y.count / total,
                monthList: Object.values(y.months).sort((a, b) => b.month - a.month).map(m => ({
                    ...m, fraction: m.count / y.count,
                    label: ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][m.month]
                }))
            }));
    }, [groupedPhotos, displayPhotos.length]);

    // Scroll to year (for year scrubber)
    const scrollToYear = useCallback((year) => {
        const el = document.querySelector(`[data-year-start="${year}"]`);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, []);

    const scrollToMonth = useCallback((year, monthIdx) => {
        // find the day group for this year+month
        const prefix = `${year}-${String(monthIdx + 1).padStart(2, '0')}`;
        const el = document.querySelector(`[data-day-key^="${prefix}"]`);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, []);

    // Select all photos in a day group
    const selectDayGroup = useCallback((group) => {
        setSelectedIds(prev => {
            const next = new Set(prev);
            const allSelected = group.photos.every(p => next.has(p.id));
            if (allSelected) {
                group.photos.forEach(p => next.delete(p.id));
            } else {
                group.photos.forEach(p => next.add(p.id));
            }
            return next;
        });
    }, []);

    // ── Keyboard shortcuts (Ctrl+A, Escape, Shift+Arrows) ─────────────
    useEffect(() => {
        const handleKeyboard = (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
                e.preventDefault();
                setSelectedIds(new Set(displayPhotos.map(p => p.id)));
                return;
            }
            if (e.key === 'Escape') {
                if (selectedIds.size > 0) setSelectedIds(new Set());
                setFocusedIndex(-1);
                return;
            }
            // Arrow key navigation + Shift for selection
            if (['ArrowRight','ArrowLeft','ArrowDown','ArrowUp'].includes(e.key)) {
                e.preventDefault();
                const cols = Math.max(1, Math.round(window.innerWidth / 250));
                setFocusedIndex(prev => {
                    let next = prev;
                    if (e.key === 'ArrowRight') next = Math.min(prev + 1, displayPhotos.length - 1);
                    if (e.key === 'ArrowLeft') next = Math.max(prev - 1, 0);
                    if (e.key === 'ArrowDown') next = Math.min(prev + cols, displayPhotos.length - 1);
                    if (e.key === 'ArrowUp') next = Math.max(prev - cols, 0);
                    if (next < 0) next = 0;
                    // Shift held = extend selection
                    if (e.shiftKey && displayPhotos[next]) {
                        setSelectedIds(sel => {
                            const ns = new Set(sel);
                            ns.add(displayPhotos[next].id);
                            return ns;
                        });
                    }
                    // Scroll the focused tile into view
                    const tile = document.querySelector(`[data-photo-id="${displayPhotos[next]?.id}"]`);
                    if (tile) tile.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
                    return next;
                });
            }
            // Enter to open focused photo
            if (e.key === 'Enter' && focusedIndex >= 0 && focusedIndex < displayPhotos.length) {
                setSelectedPhoto(displayPhotos[focusedIndex]);
            }
        };
        window.addEventListener('keydown', handleKeyboard);
        return () => window.removeEventListener('keydown', handleKeyboard);
    }, [displayPhotos, selectedIds.size, focusedIndex]);

    // ── Mouse drag-to-select ──────────────────────────────────────────────
    const handleDragSelectStart = useCallback((e) => {
        // Only left click on empty area (not on tiles directly)
        if (e.button !== 0 || e.target.closest('.gp-tile') || e.target.closest('.gp-day-header') || e.target.closest('.gp-year-scrubber')) return;
        dragStartRef.current = { x: e.clientX, y: e.clientY, scrollY: window.scrollY };
    }, []);

    const handleDragSelectMove = useCallback((e) => {
        if (!dragStartRef.current) return;
        const dx = Math.abs(e.clientX - dragStartRef.current.x);
        const dy = Math.abs(e.clientY - dragStartRef.current.y);
        if (dx < 5 && dy < 5) return; // deadzone
        setDragSelecting(true);
        const sx = dragStartRef.current.x;
        const sy = dragStartRef.current.y - dragStartRef.current.scrollY + window.scrollY;
        const cx = e.clientX;
        const cy = e.clientY;
        const rect = {
            left: Math.min(sx, cx), top: Math.min(sy, cy),
            right: Math.max(sx, cx), bottom: Math.max(sy, cy),
            width: Math.abs(cx - sx), height: Math.abs(cy - sy)
        };
        setDragRect(rect);
        // Find tiles that intersect the drag rect
        const tiles = document.querySelectorAll('.gp-tile');
        const newSel = new Set();
        tiles.forEach(tile => {
            const tr = tile.getBoundingClientRect();
            const tileTop = tr.top + window.scrollY;
            const tileBottom = tr.bottom + window.scrollY;
            if (tr.left < rect.right && tr.right > rect.left && tileTop < rect.bottom && tileBottom > rect.top) {
                const pid = tile.getAttribute('data-photo-id');
                if (pid) newSel.add(pid);
            }
        });
        setSelectedIds(newSel);
    }, []);

    const handleDragSelectEnd = useCallback(() => {
        dragStartRef.current = null;
        setDragSelecting(false);
        setDragRect(null);
    }, []);

    // ── Scroll-to-top visibility ─────────────────────────────────────────
    useEffect(() => {
        const handler = () => setShowScrollTop(window.scrollY > 600);
        window.addEventListener('scroll', handler, { passive: true });
        return () => window.removeEventListener('scroll', handler);
    }, []);

    // ── Close upload menu on outside click ──────────────────────────────
    useEffect(() => {
        if (!showUploadMenu) return;
        const handler = (e) => {
            if (uploadMenuRef.current && !uploadMenuRef.current.contains(e.target)) {
                setShowUploadMenu(false);
            }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [showUploadMenu]);



    // ── Upload handler ──────────────────────────────────────────────────
    // ── Drag-and-drop upload ─────────────────────────────────────────────
    const [isDragging, setIsDragging] = useState(false);
    const dragCounter = useRef(0);
    const handleDragEnter = (e) => { e.preventDefault(); dragCounter.current++; setIsDragging(true); };
    const handleDragLeave = (e) => { e.preventDefault(); dragCounter.current--; if (dragCounter.current <= 0) { setIsDragging(false); dragCounter.current = 0; } };
    const handleDragOver = (e) => { e.preventDefault(); };
    const handleDrop = (e) => {
        e.preventDefault(); setIsDragging(false); dragCounter.current = 0;
        const files = e.dataTransfer?.files;
        if (files?.length) processUpload(Array.from(files));
    };

    const handleUpload = async (e) => {
        const files = Array.from(e.target.files || []);
        if (files.length) processUpload(files);
    };

    const processUpload = async (files) => {
        if (!files.length || !config?.botToken) return;
        // Accept files by type OR by extension (HEIC often has blank type)
        const mediaFiles = files.filter(f => {
            if (f.type.startsWith('image/') || f.type.startsWith('video/')) return true;
            const ext = f.name?.split('.').pop()?.toLowerCase();
            return ['heic', 'heif', 'bmp', 'tiff', 'tif', 'webp', 'avif'].includes(ext);
        });
        if (!mediaFiles.length) { alert('Select image or video files.'); return; }
        setUploading(true);
        const controller = new AbortController();
        abortRef.current = controller;

        for (let i = 0; i < mediaFiles.length; i++) {
            if (controller.signal.aborted) break;
            let file = mediaFiles[i];
            setUploadStatus(`Processing ${i + 1}/${mediaFiles.length}: ${file.name}`);
            try {
                // Convert problematic formats (HEIC, BMP, TIFF) → JPEG
                if (!file.type.startsWith('video/')) {
                    const { blob, fileName, mimeType } = await normalizeImageFormat(file, file.name);
                    if (fileName !== file.name) {
                        file = new File([blob], fileName, { type: mimeType, lastModified: file.lastModified });
                    }
                }

                const isVideoFile = file.type.startsWith('video/');
                const [exifData, thumbBlob] = await Promise.all([
                    isVideoFile ? { dateTaken: null } : extractExifData(file),
                    isVideoFile ? generateVideoThumbnail(file) : generateThumbnail(file),
                ]);

                // Upload thumbnail to Telegram separately
                setUploadStatus(`Uploading thumb ${i + 1}/${mediaFiles.length}`);
                const thumbResult = await uploadThumbnailToTelegram(
                    thumbBlob, config.botToken, config.channelId,
                    zkeEnabled ? encryptionKey : null
                );

                // Upload original
                setUploadStatus(`Uploading ${i + 1}/${mediaFiles.length}: ${file.name}`);
                const uploadResult = await uploadToTelegram(
                    file, file.name, config.botToken, config.channelId,
                    (p) => setUploadPercent(p.percent), controller.signal,
                    zkeEnabled ? encryptionKey : null
                );

                // Save photo metadata ONLY — DO NOT save to files collection
                // (files collection = Drive view, photos collection = Photos view)
                const photoRef = getUserPhotosRef(uid).doc();
                await photoRef.set({
                    id: photoRef.id,
                    fileName: file.name, fileSize: file.size, fileType: file.type,
                    messages: uploadResult.messages, encrypted: uploadResult.encrypted,
                    thumbFileId: thumbResult?.file_id || null,
                    thumbMessageId: thumbResult?.message_id || null,
                    thumbEncrypted: thumbResult?.encrypted || false,
                    dateTaken: exifData.dateTaken
                        ? firebase.firestore.Timestamp.fromDate(new Date(exifData.dateTaken))
                        : firebase.firestore.Timestamp.fromDate(new Date(file.lastModified)),
                    latitude: exifData.latitude || null, longitude: exifData.longitude || null,
                    cameraMake: exifData.cameraMake || null, cameraModel: exifData.cameraModel || null,
                    camera: exifData.camera || null,
                    width: exifData.width || null, height: exifData.height || null,
                    iso: exifData.iso || null, aperture: exifData.aperture || null,
                    exposure: exifData.exposure || null, focalLength: exifData.focalLength || null,
                    lensModel: exifData.lensModel || null, software: exifData.software || null,
                    hasExif: !!exifData.dateTaken, isFavorite: false, trashed: false, archived: false,
                    uploadedAt: firebase.firestore.Timestamp.now(),
                });

                // Update local state immediately
                setPhotos(prev => {
                    const newPhoto = {
                        id: photoRef.id, fileName: file.name, fileSize: file.size,
                        fileType: file.type, messages: uploadResult.messages, encrypted: uploadResult.encrypted,
                        thumbFileId: thumbResult?.file_id || null, thumbMessageId: thumbResult?.message_id || null,
                        thumbEncrypted: thumbResult?.encrypted || false,
                        dateTaken: exifData.dateTaken ? firebase.firestore.Timestamp.fromDate(new Date(exifData.dateTaken)) : firebase.firestore.Timestamp.fromDate(new Date(file.lastModified)),
                        isFavorite: false, trashed: false, archived: false,
                        latitude: exifData.latitude, longitude: exifData.longitude,
                        camera: exifData.camera, cameraMake: exifData.cameraMake, cameraModel: exifData.cameraModel,
                        width: exifData.width, height: exifData.height,
                        iso: exifData.iso, aperture: exifData.aperture, exposure: exifData.exposure,
                        focalLength: exifData.focalLength, lensModel: exifData.lensModel, software: exifData.software,
                        hasExif: !!exifData.dateTaken,
                        uploadedAt: firebase.firestore.Timestamp.now(),
                    };
                    return [newPhoto, ...prev];
                });
            } catch (err) {
                if (err.name === 'AbortError' || err.message === 'Upload cancelled.') break;
                console.error(`Failed: ${file.name}:`, err);
            }
        }
        setUploading(false); setUploadStatus(''); setUploadPercent(0);
        abortRef.current = null;
        if (fileInputRef.current) fileInputRef.current.value = '';
    };

    // ── Actions ─────────────────────────────────────────────────────────
    const toggleFavorite = async (photo) => {
        try {
            await getUserPhotosRef(uid).doc(photo.id).update({ isFavorite: !photo.isFavorite });
            setPhotos(prev => prev.map(p => p.id === photo.id ? { ...p, isFavorite: !p.isFavorite } : p));
        } catch (err) { console.error(err); }
    };

    const trashPhoto = async (photo) => {
        try {
            await getUserPhotosRef(uid).doc(photo.id).update({ trashed: true, trashedAt: firebase.firestore.Timestamp.now() });
            setPhotos(prev => prev.filter(p => p.id !== photo.id));
        } catch (err) { console.error(err); }
    };

    const downloadPhoto = async (photo) => {
        if (!config?.botToken || !photo.messages?.length) return;
        try {
            const fileId = photo.fileRef || photo.id;
            if ('serviceWorker' in navigator) {
                const reg = await navigator.serviceWorker.ready;
                const sw = reg.active;
                if (sw) {
                    let rawKeyBytes = null;
                    if (photo.encrypted && encryptionKey) {
                        try { rawKeyBytes = await crypto.subtle.exportKey('raw', encryptionKey); } catch {}
                    }
                    await new Promise((resolve, reject) => {
                        const ch = new MessageChannel();
                        ch.port1.onmessage = (e) => e.data?.status === 'ok' ? resolve() : reject();
                        sw.postMessage({
                            type: 'REGISTER_FILE', fileId, messages: photo.messages,
                            botToken: config.botToken, rawKeyBytes,
                            isEncrypted: photo.encrypted === true,
                            fileSize: photo.fileSize, fileType: photo.fileType || 'image/jpeg',
                        }, [ch.port2]);
                        setTimeout(() => reject(), 8000);
                    });
                    const a = document.createElement('a');
                    a.href = `/stream/${fileId}`;
                    a.download = photo.fileName;
                    document.body.appendChild(a); a.click(); document.body.removeChild(a);
                }
            }
        } catch (err) { console.error('Download failed:', err); }
    };

    // ── Selection (with Shift+click range select) ────────────────────────
    const toggleSelect = useCallback((photo, e) => {
        setSelectedIds(prev => {
            const next = new Set(prev);
            // Shift+click range select
            if (e?.shiftKey && lastSelectedRef.current) {
                const lastIdx = displayPhotos.findIndex(p => p.id === lastSelectedRef.current);
                const curIdx = displayPhotos.findIndex(p => p.id === photo.id);
                if (lastIdx !== -1 && curIdx !== -1) {
                    const [start, end] = lastIdx < curIdx ? [lastIdx, curIdx] : [curIdx, lastIdx];
                    for (let i = start; i <= end; i++) next.add(displayPhotos[i].id);
                    return next;
                }
            }
            if (next.has(photo.id)) next.delete(photo.id); else next.add(photo.id);
            return next;
        });
        lastSelectedRef.current = photo.id;
    }, [displayPhotos]);

    const bulkDelete = async () => {
        if (!window.confirm(`Move ${selectedIds.size} items to trash?`)) return;
        const batch = getDb().batch();
        selectedIds.forEach(id => {
            batch.update(getUserPhotosRef(uid).doc(id), { trashed: true, trashedAt: firebase.firestore.Timestamp.now() });
        });
        await batch.commit();
        setPhotos(prev => prev.filter(p => !selectedIds.has(p.id)));
        setSelectedIds(new Set());
    };

    const bulkFavorite = async () => {
        const batch = getDb().batch();
        selectedIds.forEach(id => {
            batch.update(getUserPhotosRef(uid).doc(id), { isFavorite: true });
        });
        await batch.commit();
        setPhotos(prev => prev.map(p => selectedIds.has(p.id) ? { ...p, isFavorite: true } : p));
        setSelectedIds(new Set());
    };

    const bulkDownload = () => {
        const selected = photos.filter(p => selectedIds.has(p.id));
        selected.forEach(p => downloadPhoto(p));
        setSelectedIds(new Set());
    };

    const bulkAddToAlbum = async (albumId) => {
        const albumDoc = getUserAlbumsRef(uid).doc(albumId);
        await albumDoc.update({
            photoIds: firebase.firestore.FieldValue.arrayUnion(...Array.from(selectedIds)),
            updatedAt: firebase.firestore.Timestamp.now(),
        });
        setSelectedIds(new Set());
    };

    // ── Albums CRUD ─────────────────────────────────────────────────────
    const createAlbum = async () => {
        if (!newAlbumName.trim()) return;
        const ref = getUserAlbumsRef(uid).doc();
        await ref.set({
            id: ref.id, name: newAlbumName.trim(), photoIds: [],
            createdAt: firebase.firestore.Timestamp.now(),
            updatedAt: firebase.firestore.Timestamp.now(),
        });
        setNewAlbumName(''); setShowCreateAlbum(false);
    };

    const deleteAlbum = async (albumId) => {
        if (!window.confirm('Delete this album? Photos won\'t be deleted.')) return;
        await getUserAlbumsRef(uid).doc(albumId).delete();
        if (activeAlbum?.id === albumId) setActiveAlbum(null);
    };

    const removeFromAlbum = async (photoId) => {
        if (!activeAlbum) return;
        await getUserAlbumsRef(uid).doc(activeAlbum.id).update({
            photoIds: firebase.firestore.FieldValue.arrayRemove(photoId),
            updatedAt: firebase.firestore.Timestamp.now(),
        });
    };

    const selectionMode = selectedIds.size > 0;

    // ═══════════════════════════════════════════════════════════════════
    // RENDER
    // ═══════════════════════════════════════════════════════════════════
    return (
        <div className="photos-app"
            onDragEnter={handleDragEnter}
            onDragLeave={handleDragLeave}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
        >
            {/* Drag-to-upload overlay */}
            {isDragging && (
                <div className="gp-drop-overlay">
                    <div className="gp-drop-inner">
                        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                        <h2>Drop photos & videos here</h2>
                        <p>They'll be uploaded and encrypted automatically</p>
                    </div>
                </div>
            )}
            {/* Header */}
            <div className="photos-header">
                <div className="photos-header-inner">
                    <div className="photos-logo">
                        <img src="/logo.png" alt="" />
                        <h1>{activeAlbum ? activeAlbum.name : 'Photos'}</h1>
                        {!activeAlbum && photos.length > 0 && <span className="photos-count-badge">{photos.length.toLocaleString()}</span>}
                    </div>
                    <div className="photos-header-actions">
                        {/* Desktop tabs */}
                        <div className="photos-tabs photos-desktop-tabs">
                            {['photos','favorites','albums','search'].map(tab => (
                                <button key={tab} className={`photos-tab ${activeTab === tab ? 'active' : ''}`}
                                    onClick={() => { setActiveTab(tab); setActiveAlbum(null); setSelectedIds(new Set()); }}>
                                    {tab === 'photos' && <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>}
                                    {tab === 'favorites' && <svg viewBox="0 0 24 24" fill={activeTab==='favorites'?'currentColor':'none'} stroke="currentColor" strokeWidth="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>}
                                    {tab === 'albums' && <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>}
                                    {tab === 'search' && <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>}
                                    <span style={{textTransform:'capitalize'}}>{tab}</span>
                                </button>
                            ))}
                        </div>
                        <input type="file" ref={fileInputRef} onChange={handleUpload} className="hidden" accept="image/*,video/*,.heic,.heif,image/heic,image/heif" multiple style={{display:'none'}} />
                        <div className="photos-upload-dropdown" ref={uploadMenuRef}>
                            <button onClick={() => setShowUploadMenu(prev => !prev)} disabled={uploading} className="photos-btn photos-btn-primary">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                                Upload
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{marginLeft:2, transition:'transform 0.2s', transform: showUploadMenu ? 'rotate(180deg)' : 'rotate(0)'}}><polyline points="6 9 12 15 18 9"/></svg>
                            </button>
                            <AnimatePresence>
                                {showUploadMenu && (
                                    <motion.div
                                        className="photos-upload-menu"
                                        initial={{ opacity: 0, y: -8, scale: 0.95 }}
                                        animate={{ opacity: 1, y: 0, scale: 1 }}
                                        exit={{ opacity: 0, y: -8, scale: 0.95 }}
                                        transition={{ duration: 0.15, ease: 'easeOut' }}
                                    >
                                        <button onClick={() => { fileInputRef.current?.click(); setShowUploadMenu(false); }} className="photos-upload-menu-item">
                                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                                            <div className="photos-upload-menu-text">
                                                <span>Upload Photos</span>
                                                <span className="photos-upload-menu-sub">From your device</span>
                                            </div>
                                        </button>
                                        <div className="photos-upload-menu-divider" />
                                        <button onClick={() => { setShowImport(true); setShowUploadMenu(false); }} className="photos-upload-menu-item photos-upload-menu-import">
                                            <svg width="16" height="16" viewBox="0 0 24 24">
                                                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
                                                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                                                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
                                                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
                                            </svg>
                                            <div className="photos-upload-menu-text">
                                                <span>Import from Google Photos</span>
                                                <span className="photos-upload-menu-sub">Via Google Takeout</span>
                                            </div>
                                        </button>
                                        <div className="photos-upload-menu-divider" />
                                        <button onClick={() => {
                                            setShowUploadMenu(false);
                                            if (repairing) return;
                                            setRepairing(true);
                                            setRepairProgress({ current: 0, total: 0, fileName: 'Scanning...', repaired: 0, failed: 0 });
                                            repairMissingThumbnails(
                                                uid, config?.botToken, config?.channelId,
                                                zkeEnabled ? encryptionKey : null,
                                                (p) => setRepairProgress(p)
                                            ).then((result) => {
                                                setRepairing(false);
                                                setRepairProgress(null);
                                                if (result.repaired > 0) loadPhotos(true);
                                                alert(`Repair complete: ${result.repaired} fixed, ${result.failed} failed out of ${result.total}`);
                                            }).catch(() => { setRepairing(false); setRepairProgress(null); });
                                        }} className="photos-upload-menu-item" disabled={repairing}>
                                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>
                                            <div className="photos-upload-menu-text">
                                                <span>{repairing ? 'Repairing...' : 'Repair Thumbnails'}</span>
                                                <span className="photos-upload-menu-sub">Fix missing HEIC previews</span>
                                            </div>
                                        </button>
                                    </motion.div>
                                )}
                            </AnimatePresence>
                        </div>
                        <button onClick={onSwitchToDrive} className="photos-btn photos-btn-secondary">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
                            Drive
                        </button>
                        <button onClick={() => { firebase.auth().signOut(); }} className="photos-btn" style={{background:'var(--photos-danger)',color:'#fff'}} title="Logout">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
                        </button>
                    </div>
                </div>
            </div>

            {/* Upload progress */}
            {uploading && (
                <div className="photos-upload-bar">
                    <div className="photos-upload-inner">
                        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                            <span style={{fontSize:13,color:'var(--photos-accent)'}}>{uploadStatus}</span>
                            <button onClick={() => { abortRef.current?.abort(); setUploading(false); }} className="photos-btn photos-btn-sm" style={{color:'var(--photos-danger)'}}>Cancel</button>
                        </div>
                        <div className="progress-track"><div className="progress-fill" style={{width:`${uploadPercent}%`}} /></div>
                    </div>
                </div>
            )}

            {/* Repair progress */}
            {repairing && repairProgress && (
                <div className="photos-upload-bar">
                    <div className="photos-upload-inner">
                        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                            <span style={{fontSize:13,color:'var(--photos-accent)'}}>
                                🔧 Repairing thumbnails: {repairProgress.current}/{repairProgress.total} — {repairProgress.fileName}
                            </span>
                            <span style={{fontSize:12,color:'var(--photos-muted)'}}>
                                ✓{repairProgress.repaired} ✗{repairProgress.failed}
                            </span>
                        </div>
                        <div className="progress-track">
                            <div className="progress-fill" style={{width: repairProgress.total > 0 ? `${(repairProgress.current / repairProgress.total) * 100}%` : '0%'}} />
                        </div>
                    </div>
                </div>
            )}

            {/* ── SEARCH TAB ─── */}
            {activeTab === 'search' && (
                <div className="photos-search-page">
                    <div className="photos-search">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                        <input type="text" placeholder="Search by filename, camera, date..." value={searchQuery} onChange={e => setSearchQuery(e.target.value)} autoFocus />
                    </div>
                    {searchQuery && (
                        <div className="photos-search-results">
                            <p style={{fontSize:13,color:'var(--photos-text-dim)',marginBottom:12}}>{displayPhotos.length} results</p>
                            <div className="photos-grid">
                                {displayPhotos.map(p => <LazyThumb key={p.id} photo={p} botToken={config?.botToken} decryptionKey={encryptionKey} onClick={setSelectedPhoto} selected={selectedIds.has(p.id)} onSelect={toggleSelect} selectionMode={selectionMode} />)}
                            </div>
                        </div>
                    )}
                </div>
            )}

            {/* ── ALBUMS TAB ─── */}
            {activeTab === 'albums' && !activeAlbum && (
                <div className="albums-grid">
                    <div className="album-card album-create-card" onClick={() => setShowCreateAlbum(true)}>
                        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                        New Album
                    </div>
                    {albums.map(album => (
                        <div key={album.id} className="album-card" onClick={() => setActiveAlbum(album)}>
                            <div className="album-card-cover">
                                {(album.photoIds?.length > 0) ? (
                                    album.photoIds.slice(0, 4).map((pid, i) => {
                                        const p = photos.find(x => x.id === pid);
                                        return p ? <LazyThumb key={i} photo={p} botToken={config?.botToken} decryptionKey={encryptionKey} onClick={() => {}} selected={false} onSelect={() => {}} selectionMode={false} /> : <div key={i} className="album-cover-placeholder" />;
                                    })
                                ) : (
                                    <div className="album-cover-placeholder"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg></div>
                                )}
                            </div>
                            <div className="album-card-info">
                                <h3>{album.name}</h3>
                                <p>{album.photoIds?.length || 0} items</p>
                            </div>
                        </div>
                    ))}
                </div>
            )}

            {/* ── ALBUM DETAIL ─── */}
            {activeTab === 'albums' && activeAlbum && (
                <>
                    <div className="album-detail-header">
                        <div>
                            <button onClick={() => setActiveAlbum(null)} className="photos-btn photos-btn-secondary photos-btn-sm" style={{marginBottom:8}}>← Back</button>
                            <div className="album-detail-title">{activeAlbum.name}</div>
                            <div className="album-detail-meta">{activeAlbum.photoIds?.length || 0} items</div>
                        </div>
                        <div style={{display:'flex',gap:8}}>
                            <button onClick={() => deleteAlbum(activeAlbum.id)} className="photos-btn photos-btn-secondary photos-btn-sm" style={{color:'var(--photos-danger)'}}>Delete Album</button>
                        </div>
                    </div>
                    <div className="photos-content">
                        <div className="photos-grid">
                            {displayPhotos.map(p => <LazyThumb key={p.id} photo={p} botToken={config?.botToken} decryptionKey={encryptionKey} onClick={setSelectedPhoto} selected={selectedIds.has(p.id)} onSelect={toggleSelect} selectionMode={selectionMode} />)}
                        </div>
                        {displayPhotos.length === 0 && <div className="photos-empty"><p>No photos in this album yet. Select photos and add them.</p></div>}
                    </div>
                </>
            )}

            {/* ── PHOTOS / FAVORITES TAB — Google Photos layout ─── */}
            {(activeTab === 'photos' || activeTab === 'favorites') && (
                <div className="gp-layout">
                    <div className="gp-main">
                        {loading ? (
                            <div className="gp-skeleton-grid">
                                {Array.from({length: 24}).map((_, i) => {
                                    const ar = [1.33, 0.75, 1, 1.5, 0.8][i % 5];
                                    return <div key={i} className="gp-tile-skeleton" style={{flexGrow: ar, flexBasis: `calc(var(--gp-row-height, 220px) * ${ar})`}} />
                                })}
                            </div>
                        ) : displayPhotos.length === 0 ? (
                            <div className="photos-empty">
                                <div className="photos-empty-icon"><svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{color:'var(--photos-text-dim)'}}><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg></div>
                                <h2>{activeTab === 'favorites' ? 'No favorites yet' : 'No photos yet'}</h2>
                                <p>{activeTab === 'favorites' ? 'Tap the heart icon on a photo to add it here.' : 'Upload your photos & videos. They\'re stored securely with zero-knowledge encryption.'}</p>
                                {activeTab !== 'favorites' && <button onClick={() => fileInputRef.current?.click()} className="photos-btn photos-btn-primary">Upload Photos</button>}
                            </div>
                        ) : (
                            <div className="gp-timeline"
                                onMouseDown={handleDragSelectStart}
                                onMouseMove={handleDragSelectMove}
                                onMouseUp={handleDragSelectEnd}
                                onMouseLeave={handleDragSelectEnd}
                            >
                                {groupedPhotos.map((group, gi) => {
                                    const isFirstOfYear = gi === 0 || groupedPhotos[gi - 1]?.year !== group.year;
                                    const allSelected = group.photos.every(p => selectedIds.has(p.id));
                                    return (
                                        <div key={group.key} className="gp-day-group"
                                            data-year-start={isFirstOfYear ? group.year : undefined}
                                            data-day-key={group.key}
                                        >
                                            <div className="gp-day-header" onClick={() => selectDayGroup(group)}>
                                                <div className="gp-day-check">
                                                    {allSelected
                                                        ? <svg width="18" height="18" viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="#4f46e5" stroke="white" strokeWidth="1.5"/><polyline points="7 12 10.5 15.5 17 9" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                                                        : <svg width="18" height="18" viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="none" stroke="rgba(255,255,255,0.3)" strokeWidth="1.5"/></svg>
                                                    }
                                                </div>
                                                <span className="gp-day-label">{group.label}</span>
                                            </div>
                                            <div className="gp-grid">
                                                {group.photos.map(p => <LazyThumb key={p.id} photo={p} botToken={config?.botToken} decryptionKey={encryptionKey} onClick={setSelectedPhoto} selected={selectedIds.has(p.id)} onSelect={toggleSelect} selectionMode={selectionMode} />)}
                                            </div>
                                        </div>
                                    );
                                })}
                                {/* Drag-select rectangle overlay */}
                                {dragSelecting && dragRect && (
                                    <div className="gp-drag-rect" style={{
                                        position: 'absolute', left: dragRect.left, top: dragRect.top - (window.scrollY || 0),
                                        width: dragRect.width, height: dragRect.height,
                                        border: '1px solid rgba(79,70,229,0.7)', background: 'rgba(79,70,229,0.12)',
                                        pointerEvents: 'none', zIndex: 50
                                    }} />
                                )}
                            </div>
                        )}
                    </div>
                    {/* Proportional year scrubber — right edge */}
                    {scrubberData.length > 1 && (
                        <div className="gp-year-scrubber">
                            {scrubberData.map(yd => (
                                <div key={yd.year} className="gp-year-segment"
                                    style={{ flex: yd.fraction }}
                                >
                                    <button className="gp-year-mark" onClick={() => scrollToYear(yd.year)}>
                                        {yd.year}
                                    </button>
                                    <div className="gp-month-dots">
                                        {yd.monthList.map(m => (
                                            <div key={m.month} className="gp-month-dot"
                                                style={{ flex: m.fraction }}
                                                onClick={() => scrollToMonth(yd.year, m.month)}
                                                title={`${m.label} ${yd.year}`}
                                            >
                                                <div className="gp-dot" />
                                                <span className="gp-month-label">{m.label}</span>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}

            {/* ── MAP TAB (lazy loaded) ─── */}
            {activeTab === 'map' && <MapView photos={photos.filter(p => p.latitude && p.longitude)} botToken={config?.botToken} onSelect={setSelectedPhoto} />}

            {/* ── Bulk actions bar ─── */}
            {selectionMode && (
                <div className="photos-bulk-bar">
                    <span>{selectedIds.size} selected</span>
                    <button onClick={bulkFavorite} className="photos-btn-icon" title="Favorite"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg></button>
                    <button onClick={bulkDownload} className="photos-btn-icon" title="Download"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg></button>
                    {albums.length > 0 && <select onChange={(e) => { if (e.target.value) bulkAddToAlbum(e.target.value); e.target.value=''; }} style={{background:'var(--photos-surface)',border:'1px solid var(--photos-border)',color:'var(--photos-text)',borderRadius:8,padding:'6px 8px',fontSize:12}}>
                        <option value="">+ Album</option>
                        {albums.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                    </select>}
                    <button onClick={bulkDelete} className="photos-btn-icon" title="Delete" style={{color:'var(--photos-danger)'}}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>
                    <button onClick={() => setSelectedIds(new Set())} className="photos-btn-icon" title="Cancel"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
                </div>
            )}

            {/* ── Scroll-to-top button ─── */}
            <AnimatePresence>
                {showScrollTop && (
                    <motion.button
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: 20 }}
                        className="photos-scroll-top"
                        onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
                    >
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="18 15 12 9 6 15"/></svg>
                    </motion.button>
                )}
            </AnimatePresence>

            {/* ── Mobile bottom tabs ─── */}
            <div className="photos-mobile-tabs">
                {[
                    { id:'photos', label:'Photos', icon:<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg> },
                    { id:'search', label:'Search', icon:<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg> },
                    { id:'albums', label:'Albums', icon:<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg> },
                    { id:'map', label:'Map', icon:<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg> },
                ].map(t => (
                    <button key={t.id} className={`photos-mobile-tab ${activeTab === t.id ? 'active' : ''}`} onClick={() => { setActiveTab(t.id); setActiveAlbum(null); }}>
                        {t.icon}<span>{t.label}</span>
                    </button>
                ))}
            </div>

            {/* ── Create Album Modal ─── */}
            {showCreateAlbum && (
                <div className="photos-modal-overlay" onClick={() => setShowCreateAlbum(false)}>
                    <div className="photos-modal" onClick={e => e.stopPropagation()}>
                        <h3>Create Album</h3>
                        <input type="text" placeholder="Album name" value={newAlbumName} onChange={e => setNewAlbumName(e.target.value)} autoFocus onKeyDown={e => e.key === 'Enter' && createAlbum()} />
                        <div className="photos-modal-actions">
                            <button onClick={() => setShowCreateAlbum(false)} className="photos-btn photos-btn-secondary">Cancel</button>
                            <button onClick={createAlbum} className="photos-btn photos-btn-primary">Create</button>
                        </div>
                    </div>
                </div>
            )}

            {/* ── Lightbox ─── */}
            <AnimatePresence>
                {selectedPhoto && (
                    <PhotoLightbox photo={selectedPhoto} photos={displayPhotos} onClose={() => setSelectedPhoto(null)}
                        onToggleFavorite={toggleFavorite} onDelete={trashPhoto} onDownload={downloadPhoto}
                        config={config} encryptionKey={encryptionKey} />
                )}
            </AnimatePresence>

            {/* ── Google Photos Import ─── */}
            <AnimatePresence>
                {showImport && (
                    <GooglePhotosImport
                        onClose={() => setShowImport(false)}
                        config={config}
                        encryptionKey={encryptionKey}
                        zkeEnabled={zkeEnabled}
                        uid={uid}
                        onPhotosImported={(imported) => {
                            setPhotos(prev => [...imported, ...prev]);
                        }}
                    />
                )}
            </AnimatePresence>
        </div>
    );
};

// ═══════════════════════════════════════════════════════════════════════════
// MAP VIEW (Leaflet)
// ═══════════════════════════════════════════════════════════════════════════
const MapView = React.lazy(() => import('./photos/MapView.jsx'));
const MapViewWrapper = (props) => (
    <React.Suspense fallback={<div className="photos-empty"><div className="lb-spinner" /><p style={{marginTop:16}}>Loading map...</p></div>}>
        <MapView {...props} />
    </React.Suspense>
);

export default PhotosView;
