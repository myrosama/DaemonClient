import type { VideoPosterResult } from './video-poster';

// ffmpeg.wasm fallback for videos the browser can't decode natively (HEVC on
// non-Safari, e.g. Linux/Firefox/Chrome). It carries its own HEVC decoder +
// libx264 encoder, so it can both extract a poster frame AND transcode the video
// to a web-playable H.264 rendition — regardless of browser/OS codec support.
//
// Loaded entirely from CDN at runtime (no local dependency — the immich web
// fork's pnpm store can't take new deps cleanly), single-threaded core (no
// SharedArrayBuffer / cross-origin-isolation headers needed), and only ever
// loaded when the native path has already failed. Any failure returns nulls →
// the caller skips that part, so this is purely additive (no regression).

const FFMPEG_ESM = 'https://esm.sh/@ffmpeg/ffmpeg@0.12.15';
const CORE_BASE = 'https://unpkg.com/@ffmpeg/core@0.12.10/dist/umd';

let ffmpegPromise: Promise<any> | null = null;

async function blobURL(url: string, mime: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`load ${url}: ${res.status}`);
  const buf = await res.arrayBuffer();
  return URL.createObjectURL(new Blob([buf], { type: mime }));
}

async function loadFfmpeg(): Promise<any> {
  if (ffmpegPromise) return ffmpegPromise;
  ffmpegPromise = (async () => {
    const mod: any = await import(/* @vite-ignore */ FFMPEG_ESM);
    const ffmpeg = new mod.FFmpeg();
    await ffmpeg.load({
      coreURL: await blobURL(`${CORE_BASE}/ffmpeg-core.js`, 'text/javascript'),
      wasmURL: await blobURL(`${CORE_BASE}/ffmpeg-core.wasm`, 'application/wasm'),
    });
    return ffmpeg;
  })().catch((e) => {
    ffmpegPromise = null; // allow a later retry
    throw e;
  });
  return ffmpegPromise;
}

function toPlainBuffer(out: unknown): ArrayBuffer {
  if (!(out instanceof Uint8Array) || out.byteLength === 0) return new ArrayBuffer(0);
  // Copy out of the (possibly SharedArrayBuffer-backed) wasm heap into a plain
  // ArrayBuffer so Blob/TS accept it.
  const buf = new ArrayBuffer(out.byteLength);
  new Uint8Array(buf).set(out);
  return buf;
}

export interface VideoFfmpegResult {
  poster: VideoPosterResult | null;
  /** H.264 720p MP4 rendition, web-playable everywhere. Null if not requested or it failed. */
  playback: Blob | null;
}

/**
 * Decode the video at `videoUrl` (the decrypted ORIGINAL — the worker decrypts
 * server-ZKE — so ffmpeg can find the moov atom wherever it sits), extracting a
 * poster frame and, when `transcode` is set, an H.264 720p rendition. Downloads
 * and writes the input only ONCE for both. Each step fails independently.
 */
export async function processVideoFfmpeg(
  videoUrl: string,
  opts: { transcode: boolean },
): Promise<VideoFfmpegResult> {
  const result: VideoFfmpegResult = { poster: null, playback: null };
  try {
    const ffmpeg = await loadFfmpeg();

    const res = await fetch(videoUrl);
    if (!res.ok) return result;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength === 0) return result;

    const inName = 'in.bin';
    await ffmpeg.writeFile(inName, bytes);
    try {
      // ── Poster: one frame ~0.5s in (dodges an opening black frame). ──
      try {
        await ffmpeg.exec(['-ss', '0.5', '-i', inName, '-frames:v', '1', '-q:v', '3', 'poster.jpg']);
        const jpeg = toPlainBuffer(await ffmpeg.readFile('poster.jpg'));
        if (jpeg.byteLength) {
          const blob = new Blob([jpeg], { type: 'image/jpeg' });
          let videoWidth = 0;
          let videoHeight = 0;
          try {
            const bmp = await createImageBitmap(blob);
            videoWidth = bmp.width;
            videoHeight = bmp.height;
            bmp.close?.();
          } catch { /* dims best-effort */ }
          result.poster = { blob, videoWidth, videoHeight };
        }
        await ffmpeg.deleteFile('poster.jpg').catch(() => {});
      } catch (e) {
        console.warn('[video-poster-ffmpeg] poster failed', e);
      }

      // ── Playback: HEVC→H.264 720p, faststart. ultrafast keeps wasm tolerable. ──
      if (opts.transcode) {
        try {
          await ffmpeg.exec([
            '-i', inName,
            '-vf', 'scale=-2:720',
            '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28',
            '-c:a', 'aac', '-b:a', '128k',
            '-movflags', '+faststart',
            'play.mp4',
          ]);
          const mp4 = toPlainBuffer(await ffmpeg.readFile('play.mp4'));
          if (mp4.byteLength) result.playback = new Blob([mp4], { type: 'video/mp4' });
          await ffmpeg.deleteFile('play.mp4').catch(() => {});
        } catch (e) {
          console.warn('[video-poster-ffmpeg] transcode failed', e);
        }
      }
    } finally {
      await ffmpeg.deleteFile(inName).catch(() => {});
    }
    return result;
  } catch (e) {
    console.warn('[video-poster-ffmpeg] failed', e);
    return result;
  }
}

/** Poster-only convenience wrapper (kept for callers that don't transcode). */
export async function extractVideoPosterFfmpeg(videoUrl: string): Promise<VideoPosterResult | null> {
  return (await processVideoFfmpeg(videoUrl, { transcode: false })).poster;
}
