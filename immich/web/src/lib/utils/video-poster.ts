// Extracts a poster frame from a video URL using the browser's native
// HTMLVideoElement (no ffmpeg needed — browser decodes H.264/WebM/etc).
// Returns the poster JPEG blob plus the video's native dimensions, or null on
// failure (unsupported codec, network error, timeout, …).

const TIMEOUT_MS = 15_000;

export interface VideoPosterResult {
  blob: Blob;
  videoWidth: number;
  videoHeight: number;
}

export function extractVideoPoster(videoUrl: string): Promise<VideoPosterResult | null> {
  return new Promise((resolve) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        video.src = '';
        resolve(null);
      }
    }, TIMEOUT_MS);

    const done = (result: VideoPosterResult | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      video.src = '';
      resolve(result);
    };

    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    // CRITICAL for iOS Safari — which is the platform that matters most here,
    // because it's the only browser that can decode iPhone HEVC video. Without
    // `playsinline` (+ the webkit-prefixed attribute), iOS refuses to decode a
    // video inline for canvas capture and we get a black frame or nothing. With
    // it (and muted), we're allowed to play/seek inline and draw to canvas.
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    video.setAttribute('webkit-playsinline', '');
    video.setAttribute('muted', '');
    // crossOrigin is same-origin for /api/… routes — set it anyway so the
    // attribute is present; getImageData/toBlob still work either way.
    video.crossOrigin = 'anonymous';
    video.src = videoUrl;

    video.onerror = () => done(null);

    // Use onloadedmetadata to set currentTime, then onseeked to draw so we
    // always get a decoded non-blank frame (frame-0 may be blank for some codecs).
    // iOS often has no decoded frame from preload=metadata + a bare seek, so
    // kick a brief muted inline play() first to force a real frame to decode.
    video.onloadedmetadata = () => {
      video.play().catch(() => { /* autoplay may be blocked; seek still tries */ });
      // Seek 0.1 s in; clamped to within the video.
      video.currentTime = Math.min(0.1, (video.duration || 0) > 0.2 ? 0.1 : 0);
    };

    video.onseeked = () => {
      try {
        const vw = video.videoWidth || 1;
        const vh = video.videoHeight || 1;
        const MAX = 256;
        const s = Math.min(MAX / vw, MAX / vh, 1);
        const w = Math.max(1, Math.round(vw * s));
        const h = Math.max(1, Math.round(vh * s));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) { done(null); return; }
        ctx.drawImage(video, 0, 0, w, h);
        canvas.toBlob(
          (b) => done(b ? { blob: b, videoWidth: vw, videoHeight: vh } : null),
          'image/jpeg',
          0.8,
        );
      } catch {
        done(null);
      }
    };

    video.load();
  });
}
