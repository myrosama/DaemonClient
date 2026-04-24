/**
 * Photo utilities — EXIF extraction + thumbnail generation (client-side).
 */

// Extract EXIF date from JPEG
export function extractExifDate(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const view = new DataView(e.target.result);
        if (view.getUint16(0) !== 0xFFD8) { resolve(null); return; }
        let offset = 2;
        while (offset < view.byteLength - 2) {
          const marker = view.getUint16(offset);
          if (marker === 0xFFE1) {
            const exifData = parseExifBlock(view, offset + 4);
            if (exifData) { resolve(exifData); return; }
          }
          if ((marker & 0xFF00) !== 0xFF00) break;
          offset += 2 + view.getUint16(offset + 2);
        }
      } catch (err) { /* ignore */ }
      resolve(null);
    };
    reader.readAsArrayBuffer(file.slice(0, 128 * 1024));
  });
}

function parseExifBlock(view, offset) {
  const exifHeader = String.fromCharCode(
    view.getUint8(offset), view.getUint8(offset+1),
    view.getUint8(offset+2), view.getUint8(offset+3)
  );
  if (exifHeader !== 'Exif') return null;
  const tiffOffset = offset + 6;
  const littleEndian = view.getUint16(tiffOffset) === 0x4949;
  const ifdOffset = view.getUint32(tiffOffset + 4, littleEndian);
  return readIFD(view, tiffOffset, tiffOffset + ifdOffset, littleEndian);
}

function readIFD(view, tiffBase, ifdOffset, le) {
  try {
    const count = view.getUint16(ifdOffset, le);
    for (let i = 0; i < count; i++) {
      const entryOffset = ifdOffset + 2 + i * 12;
      const tag = view.getUint16(entryOffset, le);
      if (tag === 0x8769) { // ExifIFD pointer
        const subIfdOffset = view.getUint32(entryOffset + 8, le);
        const result = readIFD(view, tiffBase, tiffBase + subIfdOffset, le);
        if (result) return result;
      }
      if (tag === 0x9003 || tag === 0x9004) { // DateTimeOriginal / DateTimeDigitized
        const valOffset = view.getUint32(entryOffset + 8, le);
        let str = '';
        for (let j = 0; j < 19; j++) str += String.fromCharCode(view.getUint8(tiffBase + valOffset + j));
        const parsed = new Date(str.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3'));
        if (!isNaN(parsed.getTime())) return parsed;
      }
    }
  } catch (e) { /* ignore */ }
  return null;
}

// Generate thumbnail using Canvas
export function generateThumbnail(file, maxSize = 300) {
  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(maxSize / img.width, maxSize / img.height, 1);
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.6);
      URL.revokeObjectURL(url);
      resolve({ dataUrl, width: img.width, height: img.height });
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}

// Generate tiny inline thumbnail (~2KB) for Firestore
export function generateTinyThumbnail(file, maxSize = 60) {
  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(maxSize / img.width, maxSize / img.height, 1);
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/jpeg', 0.4));
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}

// Check if file is a supported image
export function isImageFile(file) {
  return file.type.startsWith('image/') || /\.(jpg|jpeg|png|gif|webp|heic|heif|bmp|svg)$/i.test(file.name);
}

// Check if file is a supported video
export function isVideoFile(file) {
  return file.type.startsWith('video/') || /\.(mp4|mov|avi|mkv|webm)$/i.test(file.name);
}

// Group photos by date for timeline
export function groupPhotosByDate(photos) {
  const groups = {};
  for (const photo of photos) {
    const date = photo.takenAt || photo.uploadedAt;
    const key = date ? new Date(date.seconds ? date.seconds * 1000 : date).toLocaleDateString('en-US', {
      year: 'numeric', month: 'long', day: 'numeric'
    }) : 'Unknown Date';
    if (!groups[key]) groups[key] = [];
    groups[key].push(photo);
  }
  // Sort groups by date descending
  const sorted = Object.entries(groups).sort(([a], [b]) => {
    const da = new Date(a), db = new Date(b);
    if (isNaN(da)) return 1; if (isNaN(db)) return -1;
    return db - da;
  });
  return sorted;
}
