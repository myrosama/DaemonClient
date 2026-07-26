import type { Env } from './index';
import { isSelfHost } from './selfhost-auth';
import { json, requireAuth } from './helpers';
import { D1Adapter } from './d1-adapter';
import { getCachedConfig } from './cached-config';

export async function handleServer(request: Request, env: Env, path: string): Promise<Response> {
  if (path === '/api/server/config' || path === '/api/server-info/config') return json(serverConfig(request, env));
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
  if (path === '/api/server/processor') return handleProcessor(request, env);
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

function serverConfig(request: Request, env: Env) {
  // A self-hosted install must never be told that OUR domain is its external
  // address — clients build links from this. Prefer an explicitly configured
  // domain, else the address this very request arrived on, and only fall back
  // to the hosted site for the managed service.
  const externalDomain = (env as any).EXTERNAL_DOMAIN
    || (isSelfHost(env) ? new URL(request.url).origin : 'https://photos.daemonclient.uz');
  return {
    loginPageMessage: '',
    trashDays: 30,
    userDeleteDelay: 7,
    isInitialized: true,
    isOnboarded: true,
    externalDomain,
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


// ── The HEIC processor ──────────────────────────────────────────────────────
//
// Telegram generates a thumbnail for anything you send it — except HEIC, which
// it cannot decode. That is the entire reason HEIC photos have needed a manual
// fix from the web. The answer is a tiny serverless function the USER deploys
// to their OWN free account (`processor/`); the worker then converts through it
// at upload time and the manual step disappears.
//
// This endpoint is how that URL gets attached. It is the most dangerous input
// in the product: whatever is stored here receives the user's PLAINTEXT photo
// bytes. So the URL is not merely stored — it must prove three things first.

const PROCESSOR_PROBE_TIMEOUT_MS = 10000;

/** Reject anything that is not a public https endpoint. */
function processorUrlIsSane(raw: string): { ok: true; base: string } | { ok: false; reason: string } {
  let u: URL;
  try { u = new URL(raw); } catch { return { ok: false, reason: 'That is not a valid URL.' }; }

  if (u.protocol !== 'https:') {
    return { ok: false, reason: 'The processor URL must be https — your photos are sent to it.' };
  }
  const host = u.hostname.toLowerCase();
  // Plaintext photos must never be posted to something inside the network.
  const isPrivate =
    host === 'localhost' || host.endsWith('.localhost') || host === '::1' ||
    /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) || /^0\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host.endsWith('.internal') || host.endsWith('.local');
  if (isPrivate) {
    return { ok: false, reason: 'That address is not reachable from the internet.' };
  }
  return { ok: true, base: `${u.origin}${u.pathname.replace(/\/+$/, '').replace(/\/convertHeicThumbnail$/, '')}` };
}

/** GET  → what is configured now.
 *  POST → { url } : verify it really is this user's own processor, then save.
 *  DELETE → detach it. */
async function handleProcessor(request: Request, env: Env): Promise<Response> {
  const session = await requireAuth(request, env);

  if (request.method === 'GET') {
    const cfg = await getCachedConfig<any>(env, session.uid, session.idToken, 'telegram').catch(() => null);
    return json({ url: cfg?.heicConvertUrl || null, configured: !!cfg?.heicConvertUrl });
  }

  if (request.method === 'DELETE') {
    if (!env.DB) return json({ message: 'Not supported on this server' }, 400);
    const db = new D1Adapter(env.DB);
    const existing = (await db.getJsonConfig<any>('telegram')) || {};
    delete existing.heicConvertUrl;
    await db.setJsonConfig('telegram', existing);
    return json({ url: null, configured: false });
  }

  if (request.method !== 'POST') return json({ message: 'Method not allowed' }, 405);
  if (!env.DB) return json({ message: 'Not supported on this server' }, 400);

  const body = (await request.json().catch(() => ({}))) as any;
  const sane = processorUrlIsSane(String(body?.url || '').trim());
  if (!sane.ok) return json({ message: sane.reason }, 400);
  const base = sane.base;

  // 1. Is it actually one of ours? A typo pointing at some unrelated site would
  //    otherwise be accepted and then fed photographs.
  let health: any;
  try {
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(PROCESSOR_PROBE_TIMEOUT_MS) });
    if (!res.ok) return json({ message: `The processor answered ${res.status}. Is the deploy finished?` }, 400);
    health = await res.json();
  } catch {
    return json({ message: 'Could not reach that URL. Check the deploy finished and the URL is complete.' }, 400);
  }
  if (health?.service !== 'daemonclient-processor') {
    return json({ message: 'That URL is not a DaemonClient processor.' }, 400);
  }

  // 2. Is it pinned to ONE account? An unpinned instance is usable by anyone in
  //    the Firebase project, which for a self-hosted install with open signup is
  //    everybody.
  if (health.ownerPinned !== true) {
    return json({
      message: 'That processor has no OWNER_UID set, so anyone could use it. Set OWNER_UID and redeploy.',
      problems: health.problems || [],
    }, 400);
  }

  // 3. Is it pinned to THIS account? This is the check that matters, and it
  //    cannot be faked: the processor verifies the bearer token against its own
  //    Firebase project and its own OWNER_UID, and answers 401 to anyone else.
  //    So if it accepts this user's token, it is this user's instance. Health
  //    output alone could never establish that — it is the same for everyone.
  try {
    const probe = await fetch(`${base}/convertHeicThumbnail`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${session.idToken}`, 'Content-Type': 'application/octet-stream' },
      // Deliberately not a real image. Authorisation is checked before decoding,
      // so a 401 means "not your instance" and a 4xx about the image means
      // "yours, and working".
      body: new Uint8Array([0]),
      signal: AbortSignal.timeout(PROCESSOR_PROBE_TIMEOUT_MS),
    });
    if (probe.status === 401 || probe.status === 403) {
      return json({
        message: 'That processor belongs to a different account. Deploy your own and use its URL.',
      }, 400);
    }
  } catch {
    return json({ message: 'The processor did not respond to an authenticated request.' }, 400);
  }

  const db = new D1Adapter(env.DB);
  const existing = (await db.getJsonConfig<any>('telegram')) || {};
  await db.setJsonConfig('telegram', { ...existing, heicConvertUrl: `${base}/convertHeicThumbnail` });

  return json({ url: `${base}/convertHeicThumbnail`, configured: true, ok: health.ok === true });
}
