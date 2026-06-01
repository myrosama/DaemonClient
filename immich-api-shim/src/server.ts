import type { Env } from './index';
import { json } from './helpers';

export async function handleServer(request: Request, env: Env, path: string): Promise<Response> {
  if (path === '/api/server/config' || path === '/api/server-info/config') return json(serverConfig());
  if (path === '/api/server/features') return json(serverFeatures());
  if (path === '/api/server/about') return json(serverAbout());
  if (path === '/api/server/version') return json({ major: 2, minor: 7, patch: 5 });
  if (path === '/api/server/version-history') return json([]);
  if (path === '/api/server/setup') return json({ isInitialized: true, isOnboarded: true });
  if (path === '/api/server/media-types') return json(mediaTypes());
  if (path === '/api/server/statistics') {
    if (env.DB) {
      try {
        const { requireAuth } = await import('./helpers');
        const { D1Adapter } = await import('./d1-adapter');
        const session = await requireAuth(request, env);
        const db = env.DB;
        const [photos, videos, usage] = await Promise.all([
          db.prepare(`SELECT COUNT(*) as c FROM photos WHERE ownerId = ? AND mimeType LIKE 'image/%' AND (isTrashed = 0 OR isTrashed IS NULL)`).bind(session.uid).first<{c:number}>(),
          db.prepare(`SELECT COUNT(*) as c FROM photos WHERE ownerId = ? AND mimeType LIKE 'video/%' AND (isTrashed = 0 OR isTrashed IS NULL)`).bind(session.uid).first<{c:number}>(),
          db.prepare(`SELECT SUM(fileSize) as s FROM photos WHERE ownerId = ? AND (isTrashed = 0 OR isTrashed IS NULL)`).bind(session.uid).first<{s:number}>(),
        ]);
        return json({ photos: photos?.c || 0, videos: videos?.c || 0, usage: usage?.s || 0, usageByUser: [] });
      } catch { /* fall through */ }
    }
    return json({ photos: 0, videos: 0, usage: 0, usageByUser: [] });
  }
  if (path === '/api/server/storage') {
    // "Large storage" sentinel — effectively unlimited. MUST stay well under
    // signed-int64 max (9.2e18): the native Flutter/Dart app parses diskSizeRaw
    // as int64, and a value above that (the old 67676767 TiB ≈ 7.4e19) overflows
    // → server-info deserialization throws → the whole app fails to load photos.
    // JS/web tolerates any magnitude, which is why web worked but mobile broke.
    // 1 PiB is huge (reads as unlimited) and parses safely on every client; the
    // web sidebar renders anything over 1 PB as the ∞ glyph (StorageSpace.svelte).
    const BIG = 1024 ** 5; // 1 PiB = 1,125,899,906,842,624 bytes — safe int64
    let usedBytes = 0;
    if (env.DB) {
      try {
        const { requireAuth } = await import('./helpers');
        const session = await requireAuth(request, env);
        const row = await env.DB.prepare(
          `SELECT SUM(fileSize) as s FROM photos WHERE ownerId = ? AND (isTrashed = 0 OR isTrashed IS NULL)`
        ).bind(session.uid).first<{ s: number }>();
        usedBytes = row?.s || 0;
      } catch { /* non-auth or DB error → stay at 0 */ }
    }
    return json({
      diskAvailable: 'Unlimited', diskAvailableRaw: BIG - usedBytes,
      diskSize: 'Unlimited', diskSizeRaw: BIG,
      diskUse: '', diskUseRaw: usedBytes,
      diskUsagePercentage: usedBytes / BIG,
    });
  }
  if (path === '/api/server/license') return json({});
  if (path === '/api/server/theme') return json({ customCss: '' });
  if (path === '/api/server/onboarding') return json({});
  if (path === '/api/server/ping') return json({ res: 'pong' });
  if (path === '/api/server/telegram-config') return handleTelegramConfig(request, env);
  if (path === '/api/server/zke-config') return handleZkeConfig(request, env);
  return json({ message: 'Not found' }, 404);
}

async function handleZkeConfig(request: Request, env: Env): Promise<Response> {
  const { requireAuth, firestoreGet } = await import('./helpers');
  const session = await requireAuth(request, env);

  // Per-user workers store ZKE keys in D1; the deployment-service generates
  // them there on first provision and never writes them to Firestore. Reading
  // from Firestore here returns stale/wrong keys, so the web client encrypts
  // with K_firestore while the worker later decrypts with K_d1 — AES-GCM auth
  // fails and every uploaded photo becomes unviewable. Prefer D1 when bound.
  if (env.DB) {
    const { D1Adapter } = await import('./d1-adapter');
    const adapter = new D1Adapter(env.DB);
    const zke = await adapter.getZkeConfig();
    return json({
      enabled: !!zke?.enabled,
      password: zke?.password,
      salt: zke?.salt,
      mode: zke?.mode,
    });
  }

  const config = await firestoreGet(env, session.uid, 'config/zke', session.idToken);
  return json({
    enabled: config?.enabled || config?.mode === 'server',
    password: config?.password,
    salt: config?.salt,
    mode: config?.mode
  });
}

async function handleTelegramConfig(request: Request, env: Env): Promise<Response> {
  const { requireAuth } = await import('./helpers');
  const { getCachedConfig } = await import('./cached-config');
  const session = await requireAuth(request, env);
  const config = await getCachedConfig<any>(env, session.uid, session.idToken, 'telegram');
  // Each user's own worker provides the CORS proxy. Falls back to env value (central
  // shim) if this worker has no D1 binding (i.e., it IS the central worker).
  const selfProxy = `${new URL(request.url).origin}/proxy`;
  return json({
    botToken: config?.botToken || config?.bot_token,
    channelId: config?.channelId || config?.channel_id,
    proxyUrl: env.DB ? selfProxy : (env.TELEGRAM_PROXY || selfProxy),
  });
}

function serverConfig() {
  return {
    loginPageMessage: '',
    trashDays: 30,
    userDeleteDelay: 7,
    isInitialized: true,
    isOnboarded: true,
    externalDomain: 'https://photos.daemonclient.uz',
    maintenanceMode: false,
    publicUsers: false,
    mapDarkStyleUrl: '',
    mapLightStyleUrl: '',
    oauthButtonText: 'Login with OAuth',
  };
}

function serverFeatures() {
  return {
    configFile: false,
    duplicateDetection: false,
    email: false,
    facialRecognition: false,
    importFaces: false,
    map: true,
    oauth: false,
    oauthAutoLaunch: false,
    ocr: false,
    passwordLogin: true,
    reverseGeocoding: true,
    search: true,
    sidecar: false,
    smartSearch: true,
    trash: true,
    videos: true,
  };
}

function serverAbout() {
  return {
    version: '1.115.0',
    versionUrl: '',
    licensed: true,
    build: 'daemonclient',
    buildUrl: '',
    buildImage: '',
    buildImageUrl: '',
    repository: 'DaemonClient',
    repositoryUrl: 'https://github.com/myrosama/DaemonClient',
    sourceRef: 'main',
    sourceCommit: '',
    sourceUrl: '',
    nodejs: '',
    ffmpeg: '',
    imagemagick: '',
    libvips: '',
    exiftool: '',
  };
}

function mediaTypes() {
  return {
    image: [
      '.jpg', '.jpeg', '.png', '.webp', '.gif', '.heic', '.heif', '.avif',
      '.tiff', '.tif', '.bmp', '.svg', '.ico', '.raw', '.cr2', '.nef',
      '.arw', '.dng', '.raf', '.orf', '.rw2', '.pef', '.srw', '.x3f',
      '.3fr', '.rwl', '.cap', '.iiq', '.erf', '.nrw', '.jxl',
    ],
    sidecar: ['.xmp'],
    video: [
      '.mp4', '.mov', '.webm', '.avi', '.mkv', '.m4v', '.3gp',
      '.mpg', '.mpeg', '.wmv', '.flv', '.mts', '.m2ts',
    ],
  };
}
