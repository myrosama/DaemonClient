import React, { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { formatDate, formatFileSize, resolveThumbnailUrl, convertHeicToJpeg } from './utils.js';

// ── Helpers ──────────────────────────────────────────────────────────────────
const HEIC_EXTS = new Set(['heic', 'heif']);
function isHeicFile(photo) {
    if (['image/heic', 'image/heif'].includes(photo.fileType)) return true;
    return HEIC_EXTS.has((photo.fileName || '').split('.').pop()?.toLowerCase());
}

// ═══════════════════════════════════════════════════════════════════════════
// PHOTO LIGHTBOX — Native-feeling viewer with zoom, swipe, video controls
// ═══════════════════════════════════════════════════════════════════════════
const PhotoLightbox = ({ photo, photos, onClose, onToggleFavorite, onDelete, onDownload, config, encryptionKey }) => {
    const [currentIndex, setCurrentIndex] = useState(() => photos.findIndex(p => p.id === photo.id));
    const current = photos[currentIndex];
    const [mediaUrl, setMediaUrl] = useState(null);
    const [loading, setLoading] = useState(true);
    const [showInfo, setShowInfo] = useState(false);
    const [toolbarVisible, setToolbarVisible] = useState(true);
    const isVideo = current?.fileType?.startsWith('video/');

    // Zoom state
    const [scale, setScale] = useState(1);
    const [translate, setTranslate] = useState({ x: 0, y: 0 });
    const isZoomed = scale > 1.05;

    // Refs
    const touchRef = useRef({ startX: 0, startY: 0, lastDist: 0, isPinch: false });
    const panRef = useRef({ startX: 0, startY: 0, lastX: 0, lastY: 0, panning: false });
    const dismissRef = useRef({ startY: 0, currentY: 0, isDismissing: false });
    const toolbarTimer = useRef(null);
    const mediaAreaRef = useRef(null);
    const imgRef = useRef(null);

    // ── Load media ───────────────────────────────────────────────────────
    useEffect(() => {
        if (!current || !config?.botToken) return;
        setLoading(true); setMediaUrl(null);
        setScale(1); setTranslate({ x: 0, y: 0 });
        let revokePrev = null;
        const load = async () => {
            try {
                if ('serviceWorker' in navigator) {
                    const reg = await navigator.serviceWorker.ready;
                    const sw = reg.active;
                    if (sw) {
                        let rawKeyBytes = null;
                        if (current.encrypted && encryptionKey) {
                            try { rawKeyBytes = await crypto.subtle.exportKey('raw', encryptionKey); } catch {}
                        }
                        const fileId = current.fileRef || current.id;
                        await new Promise((resolve, reject) => {
                            const ch = new MessageChannel();
                            ch.port1.onmessage = (e) => e.data?.status === 'ok' ? resolve() : reject();
                            sw.postMessage({
                                type: 'REGISTER_FILE', fileId, messages: current.messages,
                                botToken: config.botToken, rawKeyBytes,
                                isEncrypted: current.encrypted === true,
                                fileSize: current.fileSize, fileType: current.fileType || 'image/jpeg',
                            }, [ch.port2]);
                            setTimeout(() => reject(new Error('timeout')), 8000);
                        });

                        // HEIC conversion for viewing
                        if (!isVideo && isHeicFile(current)) {
                            try {
                                const resp = await fetch(`/stream/${fileId}`);
                                const rawBlob = await resp.blob();
                                const jpegBlob = await convertHeicToJpeg(rawBlob, current.fileName || '');
                                const blobUrl = URL.createObjectURL(jpegBlob);
                                revokePrev = blobUrl;
                                setMediaUrl(blobUrl);
                            } catch { setMediaUrl(`/stream/${fileId}`); }
                        } else {
                            setMediaUrl(`/stream/${fileId}`);
                        }
                    }
                }
            } catch {
                if (current.thumbFileId) {
                    const url = await resolveThumbnailUrl(current.thumbFileId, config.botToken);
                    setMediaUrl(url);
                } else if (current.thumbnail) { setMediaUrl(current.thumbnail); }
            }
            setLoading(false);
        };
        load();
        return () => { if (revokePrev) URL.revokeObjectURL(revokePrev); };
    }, [currentIndex, current, config, encryptionKey]);

    // ── Auto-hide toolbar ────────────────────────────────────────────────
    const resetToolbarTimer = useCallback(() => {
        setToolbarVisible(true);
        clearTimeout(toolbarTimer.current);
        toolbarTimer.current = setTimeout(() => setToolbarVisible(false), 3500);
    }, []);

    useEffect(() => {
        resetToolbarTimer();
        return () => clearTimeout(toolbarTimer.current);
    }, [currentIndex]);

    // ── Preload adjacent media ───────────────────────────────────────────
    useEffect(() => {
        if (!config?.botToken) return;
        const preload = async (p) => {
            if (!p) return;
            const type = p.fileType || 'image/jpeg';
            
            try {
                if ('serviceWorker' in navigator) {
                    const reg = await navigator.serviceWorker.ready;
                    const sw = reg.active;
                    if (sw) {
                        let rawKeyBytes = null;
                        if (p.encrypted && encryptionKey) {
                            try { rawKeyBytes = await crypto.subtle.exportKey('raw', encryptionKey); } catch {}
                        }
                        const fileId = p.fileRef || p.id;
                        await new Promise((resolve) => {
                            const ch = new MessageChannel();
                            ch.port1.onmessage = () => resolve();
                            sw.postMessage({
                                type: 'REGISTER_FILE', fileId, messages: p.messages,
                                botToken: config.botToken, rawKeyBytes,
                                isEncrypted: p.encrypted === true,
                                fileSize: p.fileSize, fileType: type,
                            }, [ch.port2]);
                            setTimeout(resolve, 3000);
                        });
                        
                        // Prefetch quietly
                        if (!type.startsWith('video/')) {
                            const img = new Image();
                            img.src = `/stream/${fileId}`;
                        }
                    }
                }
            } catch (err) {}
        };

        const nextP = currentIndex < photos.length - 1 ? photos[currentIndex + 1] : null;
        const prevP = currentIndex > 0 ? photos[currentIndex - 1] : null;
        preload(nextP);
        preload(prevP);
    }, [currentIndex, photos, config, encryptionKey]);

    // ── Keyboard navigation ──────────────────────────────────────────────
    useEffect(() => {
        const handleKey = (e) => {
            if (e.key === 'Escape') { if (isZoomed) { setScale(1); setTranslate({ x: 0, y: 0 }); } else onClose(); }
            if (e.key === 'ArrowLeft' && currentIndex > 0 && !isZoomed) setCurrentIndex(i => i - 1);
            if (e.key === 'ArrowRight' && currentIndex < photos.length - 1 && !isZoomed) setCurrentIndex(i => i + 1);
            if (e.key === 'i') setShowInfo(s => !s);
            if (e.key === 'f') onToggleFavorite(current);
            if (e.key === '+' || e.key === '=') setScale(s => Math.min(5, s + 0.5));
            if (e.key === '-') { setScale(s => { const n = Math.max(1, s - 0.5); if (n <= 1) setTranslate({ x: 0, y: 0 }); return n; }); }
        };
        window.addEventListener('keydown', handleKey);
        return () => window.removeEventListener('keydown', handleKey);
    }, [currentIndex, photos.length, onClose, current, onToggleFavorite, isZoomed]);

    // ── Mouse wheel zoom ─────────────────────────────────────────────────
    const handleWheel = useCallback((e) => {
        if (isVideo) return;
        e.preventDefault();
        resetToolbarTimer();
        const delta = e.deltaY > 0 ? -0.15 : 0.15;
        setScale(s => {
            const next = Math.max(1, Math.min(5, s + delta));
            if (next <= 1) setTranslate({ x: 0, y: 0 });
            return next;
        });
    }, [isVideo, resetToolbarTimer]);

    useEffect(() => {
        const el = mediaAreaRef.current;
        if (!el) return;
        el.addEventListener('wheel', handleWheel, { passive: false });
        return () => el.removeEventListener('wheel', handleWheel);
    }, [handleWheel]);

    // ── Double-click / double-tap to zoom ────────────────────────────────
    const lastTapRef = useRef(0);
    const handleDoubleTap = useCallback(() => {
        if (isVideo) return;
        if (isZoomed) {
            setScale(1); setTranslate({ x: 0, y: 0 });
        } else {
            setScale(2.5);
        }
    }, [isVideo, isZoomed]);

    const handleMediaClick = (e) => {
        resetToolbarTimer();
        const now = Date.now();
        if (now - lastTapRef.current < 300) {
            handleDoubleTap();
            lastTapRef.current = 0;
        } else {
            lastTapRef.current = now;
            // Single tap toggles toolbar visibility
            setTimeout(() => {
                if (lastTapRef.current !== 0) {
                    setToolbarVisible(v => !v);
                    lastTapRef.current = 0;
                }
            }, 300);
        }
    };

    // ── Touch gestures (pinch-to-zoom, pan, swipe nav, swipe dismiss) ───
    const handleTouchStart = (e) => {
        if (e.touches.length === 2) {
            // Pinch start
            const dist = Math.hypot(
                e.touches[0].clientX - e.touches[1].clientX,
                e.touches[0].clientY - e.touches[1].clientY
            );
            touchRef.current = { ...touchRef.current, lastDist: dist, isPinch: true };
        } else if (e.touches.length === 1) {
            const t = e.touches[0];
            touchRef.current = { ...touchRef.current, startX: t.clientX, startY: t.clientY, isPinch: false };
            panRef.current = { startX: t.clientX, startY: t.clientY, lastX: translate.x, lastY: translate.y, panning: isZoomed };
            dismissRef.current = { startY: t.clientY, currentY: t.clientY, isDismissing: false };
        }
    };

    const handleTouchMove = (e) => {
        if (e.touches.length === 2 && touchRef.current.isPinch) {
            // Pinch zoom
            const dist = Math.hypot(
                e.touches[0].clientX - e.touches[1].clientX,
                e.touches[0].clientY - e.touches[1].clientY
            );
            const delta = dist / touchRef.current.lastDist;
            touchRef.current.lastDist = dist;
            setScale(s => Math.max(1, Math.min(5, s * delta)));
        } else if (e.touches.length === 1) {
            const t = e.touches[0];
            if (isZoomed && panRef.current.panning) {
                // Pan while zoomed
                const dx = t.clientX - panRef.current.startX;
                const dy = t.clientY - panRef.current.startY;
                setTranslate({ x: panRef.current.lastX + dx, y: panRef.current.lastY + dy });
            } else if (!isZoomed) {
                // Track for swipe dismiss
                dismissRef.current.currentY = t.clientY;
                const dy = t.clientY - dismissRef.current.startY;
                if (Math.abs(dy) > 30) dismissRef.current.isDismissing = true;
            }
        }
    };

    const handleTouchEnd = (e) => {
        if (touchRef.current.isPinch) {
            touchRef.current.isPinch = false;
            if (scale <= 1) { setScale(1); setTranslate({ x: 0, y: 0 }); }
            return;
        }
        if (isZoomed) return; // Don't navigate while zoomed

        const dx = e.changedTouches[0].clientX - touchRef.current.startX;
        const dy = e.changedTouches[0].clientY - touchRef.current.startY;

        // Swipe dismiss (vertical)
        if (dismissRef.current.isDismissing && Math.abs(dy) > 120 && Math.abs(dy) > Math.abs(dx) * 1.5) {
            onClose();
            return;
        }

        // Swipe navigate (horizontal)
        if (Math.abs(dx) > 80 && Math.abs(dy) < 100) {
            if (dx > 0 && currentIndex > 0) setCurrentIndex(i => i - 1);
            if (dx < 0 && currentIndex < photos.length - 1) setCurrentIndex(i => i + 1);
        }
    };

    // ── Video state ──────────────────────────────────────────────────────
    const videoRef = useRef(null);
    const [videoPaused, setVideoPaused] = useState(false);

    const toggleVideoPlay = () => {
        const v = videoRef.current;
        if (!v) return;
        if (v.paused) { v.play(); setVideoPaused(false); }
        else { v.pause(); setVideoPaused(true); }
    };

    if (!current) return null;
    const dateStr = formatDate(current.dateTaken);

    const imgStyle = {
        transform: `scale(${scale}) translate(${translate.x / scale}px, ${translate.y / scale}px)`,
        transition: touchRef.current.isPinch || panRef.current.panning ? 'none' : 'transform 0.25s ease-out',
        cursor: isZoomed ? 'grab' : 'default',
    };

    return (
        <div className="photos-lightbox"
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
        >
            {/* Top bar — auto-hide */}
            <div className={`lb-topbar ${toolbarVisible ? '' : 'lb-toolbar-hidden'}`}>
                <button onClick={onClose} className="lb-btn"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
                <p className="lb-date">{dateStr}</p>
                <div className="lb-actions">
                    <button onClick={() => setShowInfo(!showInfo)} className="lb-btn" title="Info (I)">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
                    </button>
                    <button onClick={() => onDownload?.(current)} className="lb-btn" title="Download">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                    </button>
                    <button onClick={() => onToggleFavorite(current)} className="lb-btn" title="Favorite (F)">
                        {current.isFavorite
                            ? <svg width="20" height="20" viewBox="0 0 24 24" fill="#ef4444" stroke="#ef4444" strokeWidth="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
                            : <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
                        }
                    </button>
                    <button onClick={() => { if (window.confirm('Move to trash?')) { onDelete(current); onClose(); }}} className="lb-btn lb-btn-danger" title="Delete">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                    </button>
                </div>
            </div>

            {/* Main media area */}
            <div className="lb-media-area" ref={mediaAreaRef} onClick={handleMediaClick}>
                {/* Nav arrows — desktop only, hidden when zoomed */}
                {!isZoomed && currentIndex > 0 && <button onClick={(e) => { e.stopPropagation(); setCurrentIndex(i => i - 1); }} className={`lb-nav lb-nav-left ${toolbarVisible ? '' : 'lb-toolbar-hidden'}`}><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg></button>}
                {!isZoomed && currentIndex < photos.length - 1 && <button onClick={(e) => { e.stopPropagation(); setCurrentIndex(i => i + 1); }} className={`lb-nav lb-nav-right ${toolbarVisible ? '' : 'lb-toolbar-hidden'}`}><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2"><polyline points="9 18 15 12 9 6"/></svg></button>}
                
                {loading && <div className="lb-spinner" />}
                
                {/* Photo */}
                {mediaUrl && !isVideo && (
                    <motion.img
                        key={currentIndex}
                        ref={imgRef}
                        src={mediaUrl}
                        alt={current.fileName}
                        initial={{ opacity: 0, scale: 0.95 }}
                        animate={{ opacity: 1, scale: 1 }}
                        className="lb-image"
                        style={imgStyle}
                        draggable={false}
                    />
                )}
                
                {/* Video with custom overlay */}
                {mediaUrl && isVideo && (
                    <div className="lb-video-container" onClick={(e) => { e.stopPropagation(); toggleVideoPlay(); }}>
                        <motion.video
                            key={currentIndex}
                            ref={videoRef}
                            src={mediaUrl}
                            controls
                            autoPlay
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            className="lb-video"
                            onPlay={() => setVideoPaused(false)}
                            onPause={() => setVideoPaused(true)}
                        />
                        {videoPaused && (
                            <div className="lb-video-play-overlay">
                                <svg width="64" height="64" viewBox="0 0 24 24" fill="white" opacity="0.85"><polygon points="5 3 19 12 5 21"/></svg>
                            </div>
                        )}
                    </div>
                )}

                {/* Photo counter */}
                <div className={`lb-counter ${toolbarVisible ? '' : 'lb-toolbar-hidden'}`}>
                    {currentIndex + 1} / {photos.length}
                </div>
            </div>

            {/* Info panel */}
            <AnimatePresence>
                {showInfo && (
                    <motion.div initial={{ x: 300, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: 300, opacity: 0 }} className="lb-info-panel">
                        <div className="lb-info-header"><h3>Details</h3><button onClick={() => setShowInfo(false)} className="lb-btn-sm"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button></div>
                        <p className="lb-info-name" title={current.fileName}>{current.fileName}</p>
                        <p className="lb-info-size">{formatFileSize(current.fileSize)} • {current.fileType || 'image'}</p>

                        <div className="lb-info-section">
                            <div className="lb-info-section-title"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg><span>Date & Time</span></div>
                            <p className="lb-info-value">{dateStr}</p>
                            {current.dateTaken && <p className="lb-info-sub">{new Date(current.dateTaken.seconds ? current.dateTaken.seconds * 1000 : current.dateTaken).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</p>}
                            {!current.hasExif && <p className="lb-info-warn">⚠ From file metadata (no EXIF)</p>}
                        </div>

                        {(current.camera || current.software) && <div className="lb-info-section">
                            <div className="lb-info-section-title"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg><span>Device</span></div>
                            {current.cameraMake && <p className="lb-info-sub">{current.cameraMake}</p>}
                            {current.cameraModel && <p className="lb-info-value">{current.cameraModel}</p>}
                            {current.software && <p className="lb-info-sub">Software: {current.software}</p>}
                            {current.lensModel && <p className="lb-info-sub">Lens: {current.lensModel}</p>}
                        </div>}

                        {(current.aperture || current.exposure || current.iso || current.focalLength) && <div className="lb-info-section">
                            <div className="lb-info-section-title"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/></svg><span>Camera Settings</span></div>
                            <div className="lb-info-grid">
                                {current.aperture && <div className="lb-info-stat"><span className="lb-info-stat-val">f/{current.aperture}</span><span className="lb-info-stat-label">Aperture</span></div>}
                                {current.exposure && <div className="lb-info-stat"><span className="lb-info-stat-val">{current.exposure < 1 ? `1/${Math.round(1/current.exposure)}` : current.exposure}s</span><span className="lb-info-stat-label">Shutter</span></div>}
                                {current.iso && <div className="lb-info-stat"><span className="lb-info-stat-val">{current.iso}</span><span className="lb-info-stat-label">ISO</span></div>}
                                {current.focalLength && <div className="lb-info-stat"><span className="lb-info-stat-val">{current.focalLength}mm</span><span className="lb-info-stat-label">Focal</span></div>}
                            </div>
                        </div>}

                        {current.width && current.height && <div className="lb-info-section">
                            <div className="lb-info-section-title"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2"/></svg><span>Resolution</span></div>
                            <p className="lb-info-value">{current.width} × {current.height}</p>
                            <p className="lb-info-sub">{((current.width * current.height) / 1000000).toFixed(1)} MP</p>
                        </div>}

                        {current.latitude && current.longitude && <div className="lb-info-section">
                            <div className="lb-info-section-title"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg><span>Location</span></div>
                            <p className="lb-info-value">{typeof current.latitude === 'number' ? current.latitude.toFixed(6) : current.latitude}, {typeof current.longitude === 'number' ? current.longitude.toFixed(6) : current.longitude}</p>
                            <a href={`https://maps.google.com/?q=${current.latitude},${current.longitude}`} target="_blank" rel="noreferrer" className="lb-info-link">Open in Maps ↗</a>
                        </div>}

                        {current.encrypted && <div className="lb-info-badge"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg><span>Zero-Knowledge Encrypted</span></div>}
                    </motion.div>
                )}
            </AnimatePresence>

            {/* Bottom thumbnail strip — auto-hide */}
            <div className={`lb-thumbstrip ${toolbarVisible ? '' : 'lb-toolbar-hidden'}`}>
                {photos.map((p, i) => (
                    <button key={p.id} onClick={() => setCurrentIndex(i)} className={`lb-thumb ${i === currentIndex ? 'lb-thumb-active' : ''}`}>
                        <ThumbImg photo={p} botToken={config?.botToken} decryptionKey={encryptionKey} />
                    </button>
                ))}
            </div>
        </div>
    );
};

// Small component to lazily load thumb in strip
const ThumbImg = ({ photo, botToken, decryptionKey }) => {
    const [src, setSrc] = useState(photo.thumbnail || null);
    useEffect(() => {
        if (!src && photo.thumbFileId && botToken) {
            const key = photo.thumbEncrypted ? decryptionKey : null;
            resolveThumbnailUrl(photo.thumbFileId, botToken, key).then(url => { if (url) setSrc(url); });
        }
    }, [photo.thumbFileId, photo.thumbEncrypted, botToken, decryptionKey, src]);
    return src ? <img src={src} alt="" loading="lazy" /> : <div className="lb-thumb-placeholder" />;
};

export default PhotoLightbox;
