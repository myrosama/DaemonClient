/**
 * PhotoGalleryView — Client-side photo gallery for DaemonPhotos.
 * Same UI/UX design system as the main DaemonClient dashboard.
 * Photos served directly from Telegram → browser. No backend server.
 */
import React, { useState, useEffect, useRef, useCallback } from 'react';
import firebase from 'firebase/compat/app';
import 'firebase/compat/auth';
import 'firebase/compat/firestore';
import { deriveKey, encryptChunk, decryptChunk, base64ToBytes } from './crypto.js';
import { extractExifDate, generateThumbnail, isImageFile, isVideoFile, groupPhotosByDate } from './photo-utils.js';

const getAuth = () => firebase.auth();
const getDb = () => firebase.firestore();
const appId = 'default-daemon-client';
const CHUNK_SIZE = 19 * 1024 * 1024;
const PROXY = "https://daemonclient-proxy.sadrikov49.workers.dev";
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── Telegram Helpers ───
async function tgUpload(blob, filename, botToken, channelId) {
  const form = new FormData();
  form.append('chat_id', channelId);
  form.append('document', blob, filename);
  const url = `${PROXY}?url=${encodeURIComponent(`https://api.telegram.org/bot${botToken}/sendDocument`)}`;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await fetch(url, { method: 'POST', body: form });
      const data = await res.json();
      if (data.ok) return { message_id: data.result.message_id, file_id: data.result.document.file_id };
      if (data.parameters?.retry_after) await sleep(data.parameters.retry_after * 1000 + 500);
      else await sleep(2000 * attempt);
    } catch (e) { await sleep(3000 * attempt); }
  }
  throw new Error(`Upload failed: ${filename}`);
}

async function tgDownload(fileId, botToken) {
  const infoUrl = `${PROXY}?url=${encodeURIComponent(`https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`)}`;
  const info = await (await fetch(infoUrl)).json();
  if (!info.ok) throw new Error('getFile failed');
  const dlUrl = `${PROXY}?url=${encodeURIComponent(`https://api.telegram.org/file/bot${botToken}/${info.result.file_path}`)}`;
  return await (await fetch(dlUrl)).arrayBuffer();
}

async function tgDelete(messageId, botToken, channelId) {
  await fetch(`${PROXY}?url=${encodeURIComponent(`https://api.telegram.org/bot${botToken}/deleteMessage`)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: channelId, message_id: messageId })
  });
}

// ─── Loader ───
const Spinner = ({ small }) => (
  <div className={`animate-spin rounded-full border-2 border-indigo-400 border-t-transparent ${small ? 'h-5 w-5' : 'h-10 w-10'}`} />
);

// ─── Main Gallery ───
export default function PhotoGalleryView() {
  const [photos, setPhotos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [config, setConfig] = useState(null); // { botToken, channelId }
  const [encKey, setEncKey] = useState(null);
  const [zkeEnabled, setZkeEnabled] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProg, setUploadProg] = useState({ current: 0, total: 0, name: '' });
  const [viewPhoto, setViewPhoto] = useState(null);
  const [viewIdx, setViewIdx] = useState(-1);
  const [viewBlob, setViewBlob] = useState(null);
  const [viewLoading, setViewLoading] = useState(false);
  const fileInputRef = useRef(null);
  const flatPhotos = useRef([]);
  const thumbCache = useRef(new Map());
  const uid = getAuth().currentUser?.uid;

  // Load config + photos
  useEffect(() => {
    if (!uid) return;
    const loadConfig = async () => {
      const doc = await getDb().collection(`artifacts/${appId}/users/${uid}/config`).doc('telegram').get();
      if (doc.exists) setConfig(doc.data());
      // ZKE
      const zkeDoc = await getDb().collection(`artifacts/${appId}/users/${uid}/config`).doc('zke').get();
      if (zkeDoc.exists) {
        const z = zkeDoc.data();
        if (z.enabled && z.password && z.salt) {
          const key = await deriveKey(z.password, base64ToBytes(z.salt));
          setEncKey(key); setZkeEnabled(true);
        }
      }
    };
    loadConfig();
    const unsub = getDb().collection(`artifacts/${appId}/users/${uid}/photos`)
      .orderBy('takenAt', 'desc')
      .onSnapshot(snap => {
        const items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        setPhotos(items); flatPhotos.current = items; setLoading(false);
      }, () => setLoading(false));
    return () => unsub();
  }, [uid]);

  // Upload
  const handleUpload = async (files) => {
    if (!config || uploading) return;
    const images = Array.from(files).filter(f => isImageFile(f) || isVideoFile(f));
    if (!images.length) return;
    setUploading(true);
    setUploadProg({ current: 0, total: images.length, name: '' });
    for (let i = 0; i < images.length; i++) {
      const file = images[i];
      setUploadProg({ current: i + 1, total: images.length, name: file.name });
      try {
        const [exifDate, thumbData] = await Promise.all([
          extractExifDate(file), generateThumbnail(file, 400)
        ]);
        const takenAt = exifDate || new Date(file.lastModified);
        let uploadBlob;
        if (zkeEnabled && encKey) {
          const raw = await file.arrayBuffer();
          const enc = await encryptChunk(raw, encKey);
          uploadBlob = new Blob([enc]);
        } else { uploadBlob = file; }
        const messages = [];
        const totalParts = Math.ceil(uploadBlob.size / CHUNK_SIZE);
        for (let p = 0; p < totalParts; p++) {
          const chunk = uploadBlob.slice(p * CHUNK_SIZE, (p + 1) * CHUNK_SIZE);
          const partName = totalParts === 1 ? file.name : `${file.name}.part${String(p+1).padStart(3,'0')}`;
          const info = await tgUpload(chunk, partName, config.botToken, config.channelId);
          messages.push(info);
          await sleep(500);
        }
        await getDb().collection(`artifacts/${appId}/users/${uid}/photos`).add({
          fileName: file.name, fileSize: file.size, fileType: file.type,
          width: thumbData?.width || 0, height: thumbData?.height || 0,
          takenAt: firebase.firestore.Timestamp.fromDate(takenAt),
          uploadedAt: firebase.firestore.FieldValue.serverTimestamp(),
          encrypted: zkeEnabled && !!encKey, messages, albumId: null,
        });
      } catch (err) { console.error(`Upload error ${file.name}:`, err); }
    }
    setUploading(false);
  };

  // Load a photo from Telegram (for viewer or thumbnail)
  const loadPhoto = useCallback(async (photo) => {
    if (!config) return null;
    const cached = thumbCache.current.get(photo.id);
    if (cached) return cached;
    try {
      const buffers = [];
      for (const msg of photo.messages) {
        const data = await tgDownload(msg.file_id, config.botToken);
        buffers.push(data);
      }
      let combined = new Uint8Array(buffers.reduce((s, b) => s + b.byteLength, 0));
      let offset = 0;
      for (const buf of buffers) { combined.set(new Uint8Array(buf), offset); offset += buf.byteLength; }
      if (photo.encrypted && encKey) {
        combined = new Uint8Array(await decryptChunk(combined.buffer, encKey));
      }
      const blobUrl = URL.createObjectURL(new Blob([combined], { type: photo.fileType }));
      thumbCache.current.set(photo.id, blobUrl);
      return blobUrl;
    } catch (e) { console.error('Download error:', e); return null; }
  }, [config, encKey]);

  // Open viewer
  const openViewer = async (photo, idx) => {
    setViewPhoto(photo); setViewIdx(idx);
    const cached = thumbCache.current.get(photo.id);
    if (cached) { setViewBlob(cached); return; }
    setViewBlob(null); setViewLoading(true);
    const url = await loadPhoto(photo);
    if (url) setViewBlob(url);
    setViewLoading(false);
  };

  const navViewer = async (dir) => {
    const list = flatPhotos.current;
    const newIdx = viewIdx + dir;
    if (newIdx >= 0 && newIdx < list.length) await openViewer(list[newIdx], newIdx);
  };

  // Delete
  const deletePhoto = async (photo) => {
    if (!confirm(`Delete ${photo.fileName}?`)) return;
    if (config) {
      for (const msg of photo.messages) {
        try { await tgDelete(msg.message_id, config.botToken, config.channelId); } catch {}
        await sleep(350);
      }
    }
    await getDb().collection(`artifacts/${appId}/users/${uid}/photos`).doc(photo.id).delete();
    thumbCache.current.delete(photo.id);
    if (viewPhoto?.id === photo.id) { setViewPhoto(null); setViewBlob(null); }
  };

  // Download original to device
  const downloadToDevice = () => {
    if (!viewBlob || !viewPhoto) return;
    const a = document.createElement('a');
    a.href = viewBlob; a.download = viewPhoto.fileName; a.click();
  };

  const grouped = groupPhotosByDate(photos);

  return (
    <div className="min-h-screen bg-gray-900 text-white font-sans">
      {/* Header */}
      <header className="sticky top-0 z-40 bg-gray-900/95 backdrop-blur border-b border-gray-800 px-4 py-3">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <h1 className="text-xl font-bold text-indigo-400">DaemonPhotos</h1>
          <div className="flex items-center space-x-3">
            <button onClick={() => fileInputRef.current?.click()} disabled={uploading || !config}
              className="bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-700 px-4 py-2 rounded-lg text-sm font-medium transition-colors">
              {uploading ? `${uploadProg.current}/${uploadProg.total}` : '📷 Upload'}
            </button>
            <button onClick={() => getAuth().signOut()} className="text-gray-400 hover:text-white text-sm">Logout</button>
          </div>
        </div>
        <input ref={fileInputRef} type="file" accept="image/*,video/*" multiple className="hidden"
          onChange={e => { handleUpload(e.target.files); e.target.value = ''; }} />
      </header>

      {/* Upload progress */}
      {uploading && (
        <div className="bg-indigo-900/50 border-b border-indigo-700 px-4 py-2">
          <div className="max-w-7xl mx-auto flex items-center space-x-3">
            <Spinner small /> <span className="text-sm text-indigo-300">Uploading {uploadProg.name} ({uploadProg.current}/{uploadProg.total})</span>
            <div className="flex-1 bg-gray-700 rounded-full h-1.5">
              <div className="bg-indigo-500 h-1.5 rounded-full transition-all" style={{ width: `${(uploadProg.current / uploadProg.total) * 100}%` }} />
            </div>
          </div>
        </div>
      )}

      {/* Content */}
      <main className="max-w-7xl mx-auto px-2 md:px-4 py-4">
        {loading ? (
          <div className="flex flex-col items-center justify-center py-32"><Spinner /><p className="mt-4 text-gray-400">Loading photos...</p></div>
        ) : photos.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-32 text-center">
            <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" className="text-gray-600 mb-4"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
            <h2 className="text-xl font-semibold text-gray-400 mb-2">No photos yet</h2>
            <p className="text-gray-500 mb-6">Upload your first photos to get started</p>
            <button onClick={() => fileInputRef.current?.click()} className="bg-indigo-600 hover:bg-indigo-700 px-6 py-3 rounded-lg font-medium">Upload Photos</button>
          </div>
        ) : (
          grouped.map(([date, datePhotos]) => (
            <div key={date} className="mb-6">
              <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-2 px-1">{date}</h2>
              <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-7 gap-1">
                {datePhotos.map(photo => {
                  const globalIdx = flatPhotos.current.findIndex(p => p.id === photo.id);
                  return <PhotoTile key={photo.id} photo={photo} onClick={() => openViewer(photo, globalIdx)} loadPhoto={loadPhoto} />;
                })}
              </div>
            </div>
          ))
        )}
      </main>

      {/* Full-screen Viewer */}
      {viewPhoto && (
        <div className="fixed inset-0 z-50 bg-black flex flex-col">
          <div className="flex items-center justify-between p-3 bg-black/80">
            <div className="text-sm text-gray-300 truncate max-w-[50%]">{viewPhoto.fileName}</div>
            <div className="flex items-center space-x-2">
              <button onClick={downloadToDevice} disabled={!viewBlob} className="text-xs bg-green-600 hover:bg-green-700 disabled:bg-gray-700 px-3 py-1.5 rounded">⬇ Save</button>
              <button onClick={() => deletePhoto(viewPhoto)} className="text-xs bg-red-600 hover:bg-red-700 px-3 py-1.5 rounded">🗑</button>
              <button onClick={() => { setViewPhoto(null); setViewBlob(null); }} className="text-white text-2xl px-2 hover:text-gray-300">✕</button>
            </div>
          </div>
          <div className="flex-1 flex items-center justify-center relative" onClick={e => { if (e.target === e.currentTarget) { setViewPhoto(null); setViewBlob(null); } }}>
            {viewIdx > 0 && <button onClick={() => navViewer(-1)} className="absolute left-2 top-1/2 -translate-y-1/2 text-white/60 hover:text-white text-4xl z-10">‹</button>}
            {viewIdx < flatPhotos.current.length - 1 && <button onClick={() => navViewer(1)} className="absolute right-2 top-1/2 -translate-y-1/2 text-white/60 hover:text-white text-4xl z-10">›</button>}
            {viewBlob ? <img src={viewBlob} alt={viewPhoto.fileName} className="max-h-full max-w-full object-contain" />
              : <div className="flex flex-col items-center"><Spinner /><p className="mt-4 text-gray-500 text-sm">Loading from Telegram...</p></div>}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── PhotoTile — scroll-aware loading via IntersectionObserver ───
function PhotoTile({ photo, onClick, loadPhoto }) {
  const [thumbUrl, setThumbUrl] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const ref = useRef(null);
  const loaded = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || loaded.current) return;
    const obs = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting && !loaded.current) {
        loaded.current = true;
        obs.disconnect();
        setIsLoading(true);
        loadPhoto(photo).then(url => { if (url) setThumbUrl(url); setIsLoading(false); });
      }
    }, { rootMargin: '300px' });
    obs.observe(el);
    return () => obs.disconnect();
  }, [photo, loadPhoto]);

  return (
    <button ref={ref} onClick={onClick} className="aspect-square overflow-hidden rounded bg-gray-800 hover:opacity-90 transition-opacity relative group">
      {thumbUrl ? (
        <img src={thumbUrl} alt="" className="w-full h-full object-cover" />
      ) : (
        <div className={`w-full h-full flex items-center justify-center bg-gray-800 ${isLoading ? 'animate-pulse' : ''}`}>
          {isLoading ? <Spinner small /> : (
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" className="text-gray-600"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
          )}
        </div>
      )}
      {photo.encrypted && <div className="absolute top-1 right-1 text-xs text-green-400 opacity-0 group-hover:opacity-100 transition-opacity">🔒</div>}
    </button>
  );
}
