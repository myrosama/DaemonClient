import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { formatDate, formatFileSize, resolveThumbnailUrl } from './utils.js';
// Note: no direct Firestore usage here — all data comes via props

const PhotoLightbox = ({ photo, photos, onClose, onToggleFavorite, onDelete, onDownload, config, encryptionKey }) => {
    const [currentIndex, setCurrentIndex] = useState(() => photos.findIndex(p => p.id === photo.id));
    const current = photos[currentIndex];
    const [mediaUrl, setMediaUrl] = useState(null);
    const [loading, setLoading] = useState(true);
    const [showInfo, setShowInfo] = useState(false);
    const isVideo = current?.fileType?.startsWith('video/');
    const touchRef = useRef({ startX: 0, startY: 0 });

    // Load full-res via SW
    useEffect(() => {
        if (!current || !config?.botToken) return;
        setLoading(true); setMediaUrl(null);
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
                        setMediaUrl(`/stream/${fileId}`);
                    }
                }
            } catch {
                // Fallback: resolve thumbnail
                if (current.thumbFileId) {
                    const url = await resolveThumbnailUrl(current.thumbFileId, config.botToken);
                    setMediaUrl(url);
                } else if (current.thumbnail) { setMediaUrl(current.thumbnail); }
            }
            setLoading(false);
        };
        load();
    }, [currentIndex, current, config, encryptionKey]);

    // Keyboard nav
    useEffect(() => {
        const handleKey = (e) => {
            if (e.key === 'Escape') onClose();
            if (e.key === 'ArrowLeft' && currentIndex > 0) setCurrentIndex(i => i - 1);
            if (e.key === 'ArrowRight' && currentIndex < photos.length - 1) setCurrentIndex(i => i + 1);
            if (e.key === 'i') setShowInfo(s => !s);
            if (e.key === 'f') onToggleFavorite(current);
        };
        window.addEventListener('keydown', handleKey);
        return () => window.removeEventListener('keydown', handleKey);
    }, [currentIndex, photos.length, onClose, current, onToggleFavorite]);

    // Touch swipe
    const onTouchStart = (e) => { touchRef.current = { startX: e.touches[0].clientX, startY: e.touches[0].clientY }; };
    const onTouchEnd = (e) => {
        const dx = e.changedTouches[0].clientX - touchRef.current.startX;
        const dy = Math.abs(e.changedTouches[0].clientY - touchRef.current.startY);
        if (dy > 100) return; // Vertical swipe, ignore
        if (dx > 80 && currentIndex > 0) setCurrentIndex(i => i - 1);
        if (dx < -80 && currentIndex < photos.length - 1) setCurrentIndex(i => i + 1);
    };

    if (!current) return null;
    const dateStr = formatDate(current.dateTaken);

    return (
        <div className="photos-lightbox" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
            {/* Top bar */}
            <div className="lb-topbar">
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

            {/* Main media */}
            <div className="lb-media-area">
                {currentIndex > 0 && <button onClick={() => setCurrentIndex(i => i - 1)} className="lb-nav lb-nav-left"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg></button>}
                {currentIndex < photos.length - 1 && <button onClick={() => setCurrentIndex(i => i + 1)} className="lb-nav lb-nav-right"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2"><polyline points="9 18 15 12 9 6"/></svg></button>}
                {loading && <div className="lb-spinner" />}
                {mediaUrl && !isVideo && <motion.img key={currentIndex} src={mediaUrl} alt={current.fileName} initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className="lb-image" draggable={false} />}
                {mediaUrl && isVideo && <motion.video key={currentIndex} src={mediaUrl} controls autoPlay initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="lb-video" />}
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

            {/* Bottom thumbnail strip */}
            <div className="lb-thumbstrip">
                {photos.map((p, i) => (
                    <button key={p.id} onClick={() => setCurrentIndex(i)} className={`lb-thumb ${i === currentIndex ? 'lb-thumb-active' : ''}`}>
                        <ThumbImg photo={p} botToken={config?.botToken} />
                    </button>
                ))}
            </div>
        </div>
    );
};

// Small component to lazily load thumb in strip
const ThumbImg = ({ photo, botToken }) => {
    const [src, setSrc] = useState(photo.thumbnail || null);
    useEffect(() => {
        if (!src && photo.thumbFileId && botToken) {
            resolveThumbnailUrl(photo.thumbFileId, botToken).then(url => { if (url) setSrc(url); });
        }
    }, [photo.thumbFileId, botToken, src]);
    return src ? <img src={src} alt="" loading="lazy" /> : <div className="lb-thumb-placeholder" />;
};

export default PhotoLightbox;
