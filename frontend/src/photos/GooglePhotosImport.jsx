import React, { useState, useRef, useCallback, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ZipReader, BlobReader, BlobWriter, TextWriter } from '@zip.js/zip.js';
import firebase from 'firebase/compat/app';
import 'firebase/compat/firestore';
import {
    sleep, generateThumbnail, generateVideoThumbnail, extractExifData,
    uploadToTelegram, uploadThumbnailToTelegram,
    getUserPhotosRef, formatFileSize,
} from './utils.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

const MEDIA_EXTENSIONS = new Set([
    'jpg', 'jpeg', 'png', 'webp', 'gif', 'heic', 'heif', 'bmp', 'tiff', 'tif',
    'mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v', '3gp', 'mts',
]);

const MIME_MAP = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
    gif: 'image/gif', heic: 'image/heic', heif: 'image/heif', bmp: 'image/bmp',
    tiff: 'image/tiff', tif: 'image/tiff',
    mp4: 'video/mp4', mov: 'video/quicktime', avi: 'video/x-msvideo',
    mkv: 'video/x-matroska', webm: 'video/webm', m4v: 'video/x-m4v',
    '3gp': 'video/3gpp', mts: 'video/mp2t',
};

function getExt(name) {
    const dot = name.lastIndexOf('.');
    return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

function getFileName(path) {
    return path.split('/').pop() || path;
}

function isMediaFile(path) {
    if (path.includes('__MACOSX') || path.startsWith('.')) return false;
    return MEDIA_EXTENSIONS.has(getExt(path));
}

/** Parse Google Takeout JSON sidecar metadata */
function parseTakeoutJson(jsonStr) {
    try {
        const data = JSON.parse(jsonStr);
        const result = {};

        // photoTakenTime — Takeout uses Unix timestamp (seconds)
        if (data.photoTakenTime?.timestamp) {
            result.dateTaken = new Date(parseInt(data.photoTakenTime.timestamp, 10) * 1000);
        } else if (data.creationTime?.timestamp) {
            result.dateTaken = new Date(parseInt(data.creationTime.timestamp, 10) * 1000);
        }

        // GPS coordinates
        if (data.geoData && (data.geoData.latitude !== 0 || data.geoData.longitude !== 0)) {
            result.latitude = data.geoData.latitude;
            result.longitude = data.geoData.longitude;
            result.altitude = data.geoData.altitude;
        } else if (data.geoDataExif && (data.geoDataExif.latitude !== 0 || data.geoDataExif.longitude !== 0)) {
            result.latitude = data.geoDataExif.latitude;
            result.longitude = data.geoDataExif.longitude;
            result.altitude = data.geoDataExif.altitude;
        }

        // Description
        if (data.description) {
            result.description = data.description;
        }

        // Title (original filename)
        if (data.title) {
            result.originalTitle = data.title;
        }

        // Favorited in Google Photos
        if (data.favorited) {
            result.isFavorite = true;
        }

        return result;
    } catch {
        return {};
    }
}

/** Find matching JSON sidecar file for a media file in the unzipped data */
function findJsonSidecar(mediaPath, entries) {
    // Google Takeout typically names it: photo.jpg.json
    const jsonPath1 = mediaPath + '.json';
    const match1 = entries.find(e => e.filename === jsonPath1);
    if (match1) return match1;

    // Sometimes it's: photo.json (without original extension)
    const lastDot = mediaPath.lastIndexOf('.');
    if (lastDot >= 0) {
        const jsonPath2 = mediaPath.slice(0, lastDot) + '.json';
        const match2 = entries.find(e => e.filename === jsonPath2);
        if (match2) return match2;
    }

    // Sometimes with edited suffix: photo.jpg(1).json
    const baseName = getFileName(mediaPath);
    for (const entry of entries) {
        if (!entry.filename.endsWith('.json')) continue;
        const jsonBaseName = getFileName(entry.filename);
        // Check if JSON references this media file
        if (jsonBaseName.startsWith(baseName.replace(/\.[^.]+$/, ''))) {
            return entry;
        }
    }

    return null;
}


// ═══════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════

const GooglePhotosImport = ({ onClose, config, encryptionKey, zkeEnabled, uid, onPhotosImported }) => {
    const [step, setStep] = useState(1);
    const [zipFiles, setZipFiles] = useState([]);
    const [isDragging, setIsDragging] = useState(false);
    const fileInputRef = useRef(null);

    // Import state
    const [importing, setImporting] = useState(false);
    const [paused, setPaused] = useState(false);
    const [importStats, setImportStats] = useState({
        total: 0,
        processed: 0,
        uploaded: 0,
        skipped: 0,
        failed: 0,
        currentFile: '',
        currentFileSize: 0,
        uploadPercent: 0,
        totalBytes: 0,
        processedBytes: 0,
    });
    const [importLog, setImportLog] = useState([]);
    const [importComplete, setImportComplete] = useState(false);

    const pausedRef = useRef(false);
    const cancelledRef = useRef(false);
    const abortControllerRef = useRef(null);

    useEffect(() => { pausedRef.current = paused; }, [paused]);

    // ── Drag & Drop ─────────────────────────────────────────────────────
    const handleDragOver = useCallback((e) => { e.preventDefault(); e.stopPropagation(); setIsDragging(true); }, []);
    const handleDragLeave = useCallback((e) => { e.preventDefault(); e.stopPropagation(); setIsDragging(false); }, []);
    const handleDrop = useCallback((e) => {
        e.preventDefault(); e.stopPropagation(); setIsDragging(false);
        const files = Array.from(e.dataTransfer.files).filter(f => f.name.endsWith('.zip') || f.type === 'application/zip');
        if (files.length) setZipFiles(prev => [...prev, ...files]);
    }, []);
    const handleFileSelect = useCallback((e) => {
        const files = Array.from(e.target.files || []).filter(f => f.name.endsWith('.zip') || f.type === 'application/zip');
        if (files.length) setZipFiles(prev => [...prev, ...files]);
        if (fileInputRef.current) fileInputRef.current.value = '';
    }, []);
    const removeZip = (index) => setZipFiles(prev => prev.filter((_, i) => i !== index));

    // ── Add log entry ───────────────────────────────────────────────────
    const log = (msg, type = 'info') => {
        setImportLog(prev => [...prev.slice(-200), { msg, type, time: new Date().toLocaleTimeString() }]);
    };

    // ── Wait while paused ───────────────────────────────────────────────
    const waitWhilePaused = async () => {
        while (pausedRef.current && !cancelledRef.current) {
            await sleep(300);
        }
    };

    // ── Main Import Pipeline ────────────────────────────────────────────
    const startImport = async () => {
        if (!config?.botToken || !uid) {
            log('Missing Telegram config. Set up bot token first.', 'error');
            return;
        }

        setImporting(true);
        setImportComplete(false);
        cancelledRef.current = false;
        pausedRef.current = false;

        const controller = new AbortController();
        abortControllerRef.current = controller;

        // 1. First pass: count all media files across all ZIPs
        log('Scanning ZIP archives...', 'info');
        const allMediaEntries = []; // { zipReader, entry, entries }
        const zipReadersToClose = [];

        for (let zi = 0; zi < zipFiles.length; zi++) {
            if (cancelledRef.current) break;
            const zipFile = zipFiles[zi];
            log(`Reading ${zipFile.name} (${formatFileSize(zipFile.size)})...`, 'info');

            try {
                const zipReader = new ZipReader(new BlobReader(zipFile));
                zipReadersToClose.push(zipReader);
                const entries = await zipReader.getEntries();

                for (const entry of entries) {
                    if (!entry.directory && isMediaFile(entry.filename) && entry.uncompressedSize > 0) {
                        allMediaEntries.push({ zipReader, entry, entries });
                    }
                }
                log(`Found ${entries.length} entries in ${zipFile.name}`, 'info');
            } catch (err) {
                log(`Failed to read ${zipFile.name}: ${err.message}`, 'error');
            }
        }

        const totalBytes = allMediaEntries.reduce((sum, e) => sum + e.entry.uncompressedSize, 0);
        setImportStats(prev => ({ ...prev, total: allMediaEntries.length, totalBytes }));
        log(`Found ${allMediaEntries.length} media files (${formatFileSize(totalBytes)})`, 'info');

        if (allMediaEntries.length === 0) {
            log('No media files found in the ZIP archives.', 'error');
            setImporting(false);
            return;
        }

        // 2. Load existing photos for deduplication
        log('Checking for duplicates...', 'info');
        const existingSnap = await getUserPhotosRef(uid).get();
        const existingMap = new Map();
        existingSnap.docs.forEach(d => {
            const data = d.data();
            existingMap.set(`${data.fileName}::${data.fileSize}`, true);
        });

        // 3. Process each media file
        let processedCount = 0;
        let uploadedCount = 0;
        let skippedCount = 0;
        let failedCount = 0;
        let processedBytes = 0;
        const importedPhotos = [];

        for (const meta of allMediaEntries) {
            if (cancelledRef.current) {
                log('Import cancelled by user.', 'warn');
                break;
            }

            await waitWhilePaused();
            if (cancelledRef.current) break;

            const { zipReader, entry: zipEntry, entries } = meta;
            const path = zipEntry.filename;
            const size = zipEntry.uncompressedSize;
            const fileName = getFileName(path);
            const ext = getExt(fileName);
            const mimeType = MIME_MAP[ext] || 'application/octet-stream';
            const isVideo = mimeType.startsWith('video/');

            processedCount++;
            setImportStats(prev => ({
                ...prev,
                processed: processedCount,
                currentFile: fileName,
                currentFileSize: size,
                uploadPercent: 0,
            }));

            // Dedup check
            if (existingMap.has(`${fileName}::${size}`)) {
                skippedCount++;
                setImportStats(prev => ({ ...prev, skipped: skippedCount }));
                processedBytes += size;
                setImportStats(prev => ({ ...prev, processedBytes }));
                continue;
            }

            try {
                const blob = await zipEntry.getData(new BlobWriter(mimeType));
                const file = new File([blob], fileName, { type: mimeType, lastModified: Date.now() });

                // Parse JSON sidecar for metadata
                const jsonSidecar = findJsonSidecar(path, entries);
                let takeoutMeta = {};
                if (jsonSidecar) {
                    try {
                        const jsonStr = await jsonSidecar.getData(new TextWriter());
                        takeoutMeta = parseTakeoutJson(jsonStr);
                    } catch {}
                }

                // Extract EXIF from the file itself if possible
                let exifData = { dateTaken: null };
                if (!isVideo) {
                    try {
                        exifData = await extractExifData(file);
                    } catch {}
                }

                // Merge: prefer EXIF data, fallback to Takeout JSON
                const dateTaken = exifData.dateTaken || takeoutMeta.dateTaken || null;
                const latitude = exifData.latitude || takeoutMeta.latitude || null;
                const longitude = exifData.longitude || takeoutMeta.longitude || null;

                // Generate thumbnail
                let thumbBlob = null;
                try {
                    thumbBlob = isVideo
                        ? await generateVideoThumbnail(file)
                        : await generateThumbnail(file);
                } catch {}

                // Upload thumbnail
                const thumbResult = await uploadThumbnailToTelegram(
                    thumbBlob, config.botToken, config.channelId,
                    zkeEnabled ? encryptionKey : null
                );

                await waitWhilePaused();
                if (cancelledRef.current) break;

                // Upload original file
                const uploadResult = await uploadToTelegram(
                    file, fileName, config.botToken, config.channelId,
                    (p) => setImportStats(prev => ({ ...prev, uploadPercent: p.percent })),
                    controller.signal,
                    zkeEnabled ? encryptionKey : null
                );

                // Save to Firestore
                const photoRef = getUserPhotosRef(uid).doc();
                const photoData = {
                    id: photoRef.id,
                    fileName, fileSize: size, fileType: mimeType,
                    messages: uploadResult.messages, encrypted: uploadResult.encrypted,
                    thumbFileId: thumbResult?.file_id || null,
                    thumbMessageId: thumbResult?.message_id || null,
                    thumbEncrypted: thumbResult?.encrypted || false,
                    dateTaken: dateTaken
                        ? firebase.firestore.Timestamp.fromDate(new Date(dateTaken))
                        : firebase.firestore.Timestamp.fromDate(new Date(file.lastModified)),
                    latitude, longitude,
                    cameraMake: exifData.cameraMake || null,
                    cameraModel: exifData.cameraModel || null,
                    camera: exifData.camera || null,
                    width: exifData.width || null, height: exifData.height || null,
                    iso: exifData.iso || null, aperture: exifData.aperture || null,
                    exposure: exifData.exposure || null, focalLength: exifData.focalLength || null,
                    lensModel: exifData.lensModel || null, software: exifData.software || null,
                    hasExif: !!exifData.dateTaken,
                    isFavorite: takeoutMeta.isFavorite || false,
                    trashed: false, archived: false,
                    description: takeoutMeta.description || null,
                    importSource: 'google-photos-takeout',
                    uploadedAt: firebase.firestore.Timestamp.now(),
                };

                await photoRef.set(photoData);
                importedPhotos.push(photoData);

                // Mark as existing for future dedup within this batch
                existingMap.set(`${fileName}::${size}`, true);

                uploadedCount++;
                setImportStats(prev => ({ ...prev, uploaded: uploadedCount }));
                log(`✓ ${fileName} (${formatFileSize(size)})`, 'success');

            } catch (err) {
                if (err.name === 'AbortError' || cancelledRef.current) break;
                failedCount++;
                setImportStats(prev => ({ ...prev, failed: failedCount }));
                log(`✗ ${fileName}: ${err.message}`, 'error');
            }

            processedBytes += size;
            setImportStats(prev => ({ ...prev, processedBytes }));

            // Small delay between files to avoid Telegram rate limits
            if (processedCount < allMediaEntries.length) {
                await sleep(800);
            }
        }

        // Clean up memory
        for (const reader of zipReadersToClose) {
            try { await reader.close(); } catch {}
        }

        // Done
        setImporting(false);
        setImportComplete(true);
        log(`Import complete! ${uploadedCount} uploaded, ${skippedCount} skipped, ${failedCount} failed.`, 'info');

        if (importedPhotos.length > 0 && onPhotosImported) {
            onPhotosImported(importedPhotos);
        }
    };

    const handleCancel = () => {
        cancelledRef.current = true;
        abortControllerRef.current?.abort();
        setPaused(false);
    };

    const handlePauseResume = () => {
        setPaused(prev => !prev);
    };

    // ── Render ───────────────────────────────────────────────────────────
    return (
        <div className="gpi-overlay" onClick={(e) => { if (e.target === e.currentTarget && !importing) onClose(); }}>
            <motion.div
                className="gpi-modal"
                initial={{ opacity: 0, scale: 0.92, y: 20 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.92, y: 20 }}
                transition={{ duration: 0.25 }}
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header */}
                <div className="gpi-header">
                    <div className="gpi-header-title">
                        <div className="gpi-google-icon">
                            <svg width="20" height="20" viewBox="0 0 24 24">
                                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
                                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
                                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
                            </svg>
                        </div>
                        <div>
                            <h2>Import from Google Photos</h2>
                            <p className="gpi-subtitle">Transfer your entire library via Google Takeout</p>
                        </div>
                    </div>
                    {!importing && (
                        <button onClick={onClose} className="gpi-close-btn">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                            </svg>
                        </button>
                    )}
                </div>

                {/* Step indicator */}
                <div className="gpi-steps">
                    {[1, 2, 3].map(s => (
                        <div key={s} className={`gpi-step ${step >= s ? 'active' : ''} ${step === s ? 'current' : ''}`}>
                            <div className="gpi-step-num">{importComplete && s === 3 ? '✓' : s}</div>
                            <span>{s === 1 ? 'Instructions' : s === 2 ? 'Select Files' : 'Import'}</span>
                        </div>
                    ))}
                    <div className="gpi-step-line" style={{ width: `${((step - 1) / 2) * 100}%` }} />
                </div>

                {/* ── Step 1: Instructions ─── */}
                <AnimatePresence mode="wait">
                    {step === 1 && (
                        <motion.div key="step1" className="gpi-body" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}>
                            <div className="gpi-instructions">
                                <div className="gpi-inst-item">
                                    <div className="gpi-inst-num">1</div>
                                    <div>
                                        <h4>Export from Google Takeout</h4>
                                        <p>Go to <a href="https://takeout.google.com" target="_blank" rel="noreferrer">takeout.google.com</a>, deselect all services, then select only <strong>Google Photos</strong>.</p>
                                    </div>
                                </div>
                                <div className="gpi-inst-item">
                                    <div className="gpi-inst-num">2</div>
                                    <div>
                                        <h4>Choose export settings</h4>
                                        <p>Select <strong>.zip</strong> format with <strong>50 GB</strong> file size for fewer archives. Click "Create export".</p>
                                    </div>
                                </div>
                                <div className="gpi-inst-item">
                                    <div className="gpi-inst-num">3</div>
                                    <div>
                                        <h4>Wait for Google to prepare</h4>
                                        <p>This can take <strong>hours or days</strong> for large libraries. Google will email you when it's ready.</p>
                                    </div>
                                </div>
                                <div className="gpi-inst-item">
                                    <div className="gpi-inst-num">4</div>
                                    <div>
                                        <h4>Download & import here</h4>
                                        <p>Download all the ZIP files, then come back here to import them. We'll extract your photos, merge metadata, and upload everything securely.</p>
                                    </div>
                                </div>
                            </div>

                            <div className="gpi-info-box">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>
                                </svg>
                                <div>
                                    <strong>Privacy first</strong> — ZIP files are processed entirely in your browser. Nothing is sent to any third-party server.
                                    {zkeEnabled && <span className="gpi-zke-badge"> • ZKE encryption will be applied</span>}
                                </div>
                            </div>

                            <div className="gpi-actions">
                                <button onClick={onClose} className="photos-btn photos-btn-secondary">Cancel</button>
                                <button onClick={() => setStep(2)} className="photos-btn photos-btn-primary">
                                    I have my Takeout ZIPs ready
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="9 18 15 12 9 6"/></svg>
                                </button>
                            </div>
                        </motion.div>
                    )}

                    {/* ── Step 2: File Selection ─── */}
                    {step === 2 && (
                        <motion.div key="step2" className="gpi-body" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}>
                            <div
                                className={`gpi-dropzone ${isDragging ? 'dragging' : ''} ${zipFiles.length > 0 ? 'has-files' : ''}`}
                                onDragOver={handleDragOver}
                                onDragLeave={handleDragLeave}
                                onDrop={handleDrop}
                                onClick={() => fileInputRef.current?.click()}
                            >
                                <input
                                    type="file"
                                    ref={fileInputRef}
                                    onChange={handleFileSelect}
                                    accept=".zip,application/zip"
                                    multiple
                                    style={{ display: 'none' }}
                                />
                                <div className="gpi-drop-icon">
                                    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                                        <polyline points="17 8 12 3 7 8"/>
                                        <line x1="12" y1="3" x2="12" y2="15"/>
                                    </svg>
                                </div>
                                <p className="gpi-drop-text">
                                    {isDragging ? 'Drop ZIP files here' : 'Drag & drop your Takeout ZIP files here'}
                                </p>
                                <p className="gpi-drop-sub">or click to browse • Supports multiple ZIP files</p>
                            </div>

                            {zipFiles.length > 0 && (
                                <div className="gpi-file-list">
                                    <div className="gpi-file-list-header">
                                        <span>{zipFiles.length} ZIP {zipFiles.length === 1 ? 'file' : 'files'} selected</span>
                                        <span className="gpi-file-total">{formatFileSize(zipFiles.reduce((s, f) => s + f.size, 0))} total</span>
                                    </div>
                                    {zipFiles.map((f, i) => (
                                        <div key={i} className="gpi-file-item">
                                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 8v13H3V3h13l5 5z"/><path d="M17 21v-8H7v8"/><path d="M7 3v5h8"/></svg>
                                            <div className="gpi-file-info">
                                                <span className="gpi-file-name">{f.name}</span>
                                                <span className="gpi-file-size">{formatFileSize(f.size)}</span>
                                            </div>
                                            <button onClick={(e) => { e.stopPropagation(); removeZip(i); }} className="gpi-file-remove" title="Remove">
                                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                                            </button>
                                        </div>
                                    ))}
                                </div>
                            )}

                            <div className="gpi-actions">
                                <button onClick={() => setStep(1)} className="photos-btn photos-btn-secondary">
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>
                                    Back
                                </button>
                                <button
                                    onClick={() => { setStep(3); startImport(); }}
                                    disabled={zipFiles.length === 0}
                                    className="photos-btn photos-btn-primary"
                                >
                                    Start Import ({zipFiles.length} {zipFiles.length === 1 ? 'file' : 'files'})
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="9 18 15 12 9 6"/></svg>
                                </button>
                            </div>
                        </motion.div>
                    )}

                    {/* ── Step 3: Import Progress ─── */}
                    {step === 3 && (
                        <motion.div key="step3" className="gpi-body" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}>
                            {/* Stats dashboard */}
                            <div className="gpi-stats-grid">
                                <div className="gpi-stat">
                                    <span className="gpi-stat-val">{importStats.uploaded}</span>
                                    <span className="gpi-stat-label">Uploaded</span>
                                </div>
                                <div className="gpi-stat">
                                    <span className="gpi-stat-val">{importStats.skipped}</span>
                                    <span className="gpi-stat-label">Skipped</span>
                                </div>
                                <div className="gpi-stat">
                                    <span className="gpi-stat-val gpi-stat-error">{importStats.failed}</span>
                                    <span className="gpi-stat-label">Failed</span>
                                </div>
                                <div className="gpi-stat">
                                    <span className="gpi-stat-val">{importStats.processed}/{importStats.total}</span>
                                    <span className="gpi-stat-label">Progress</span>
                                </div>
                            </div>

                            {/* Overall progress bar */}
                            <div className="gpi-progress-section">
                                <div className="gpi-progress-labels">
                                    <span>
                                        {importing
                                            ? (paused ? '⏸ Paused' : `Importing ${importStats.processed}/${importStats.total}`)
                                            : importComplete ? '✓ Import Complete' : 'Preparing...'
                                        }
                                    </span>
                                    <span>{importStats.total > 0 ? `${Math.round((importStats.processed / importStats.total) * 100)}%` : '0%'}</span>
                                </div>
                                <div className="gpi-progress-track">
                                    <div
                                        className={`gpi-progress-fill ${paused ? 'paused' : ''} ${importComplete ? 'complete' : ''}`}
                                        style={{ width: importStats.total > 0 ? `${(importStats.processed / importStats.total) * 100}%` : '0%' }}
                                    />
                                </div>
                                <div className="gpi-progress-sub">
                                    {formatFileSize(importStats.processedBytes)} / {formatFileSize(importStats.totalBytes)}
                                </div>
                            </div>

                            {/* Current file */}
                            {importing && importStats.currentFile && (
                                <div className="gpi-current-file">
                                    <div className="gpi-current-file-header">
                                        <span className="gpi-current-file-name" title={importStats.currentFile}>
                                            {importStats.currentFile}
                                        </span>
                                        <span className="gpi-current-file-size">{formatFileSize(importStats.currentFileSize)}</span>
                                    </div>
                                    <div className="gpi-file-progress-track">
                                        <div className="gpi-file-progress-fill" style={{ width: `${importStats.uploadPercent}%` }} />
                                    </div>
                                </div>
                            )}

                            {/* Import log */}
                            <div className="gpi-log">
                                <div className="gpi-log-header">Activity Log</div>
                                <div className="gpi-log-scroll">
                                    {importLog.map((entry, i) => (
                                        <div key={i} className={`gpi-log-entry gpi-log-${entry.type}`}>
                                            <span className="gpi-log-time">{entry.time}</span>
                                            <span className="gpi-log-msg">{entry.msg}</span>
                                        </div>
                                    ))}
                                    {importLog.length === 0 && <div className="gpi-log-empty">Waiting to start...</div>}
                                </div>
                            </div>

                            {/* Controls */}
                            <div className="gpi-actions">
                                {importing && (
                                    <>
                                        <button onClick={handleCancel} className="photos-btn photos-btn-secondary" style={{ color: 'var(--photos-danger)' }}>
                                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                                <rect x="3" y="3" width="18" height="18" rx="2"/>
                                            </svg>
                                            Cancel
                                        </button>
                                        <button onClick={handlePauseResume} className="photos-btn photos-btn-primary">
                                            {paused ? (
                                                <><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21"/></svg> Resume</>
                                            ) : (
                                                <><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg> Pause</>
                                            )}
                                        </button>
                                    </>
                                )}
                                {importComplete && (
                                    <button onClick={onClose} className="photos-btn photos-btn-primary">
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="20 6 9 17 4 12"/></svg>
                                        Done
                                    </button>
                                )}
                            </div>
                        </motion.div>
                    )}
                </AnimatePresence>
            </motion.div>
        </div>
    );
};

export default GooglePhotosImport;
