import type { Env } from './index';
import { firestoreGet, firestoreSet, json, requireAuth } from './helpers';
import { DEFAULT_CHUNK_SIZE, MAX_UPLOAD_SESSION_TTL_MS, newSessionId, computeExpiryIso } from './contracts';

interface QuotaState {
  uploadTokens: number;
  downloadTokens: number;
  lastRefillAt: number;
}

const quotaCache = new Map<string, QuotaState>();

function refillQuota(state: QuotaState): QuotaState {
  const now = Date.now();
  const elapsed = Math.max(0, now - state.lastRefillAt);
  const refillUnits = Math.floor(elapsed / 1000);
  const uploadTokens = Math.min(32, state.uploadTokens + refillUnits * 2);
  const downloadTokens = Math.min(48, state.downloadTokens + refillUnits * 3);
  return { uploadTokens, downloadTokens, lastRefillAt: now };
}

function getQuota(uid: string): QuotaState {
  const cached = quotaCache.get(uid) || { uploadTokens: 24, downloadTokens: 36, lastRefillAt: Date.now() };
  const next = refillQuota(cached);
  quotaCache.set(uid, next);
  return next;
}

function takeToken(uid: string, direction: 'upload' | 'download'): boolean {
  const quota = getQuota(uid);
  if (direction === 'upload') {
    if (quota.uploadTokens <= 0) return false;
    quota.uploadTokens -= 1;
  } else {
    if (quota.downloadTokens <= 0) return false;
    quota.downloadTokens -= 1;
  }
  quotaCache.set(uid, quota);
  return true;
}

async function signSessionProof(payload: string, scope: string): Promise<string> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(`daemonclient:${scope}`),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', keyMaterial, new TextEncoder().encode(payload));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

export async function handlePolicy(request: Request, env: Env, path: string): Promise<Response> {
  const session = await requireAuth(request, env);
  const uid = session.uid;

  if (path === '/api/policy/worker' && request.method === 'POST') {
    const body = await request.json() as { url?: string };
    const rawUrl = (body.url || '').trim();
    if (!rawUrl) return json({ message: 'Worker URL is required' }, 400);
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      return json({ message: 'Invalid worker URL' }, 400);
    }
    if (parsed.protocol !== 'https:') return json({ message: 'Worker URL must use HTTPS' }, 400);
    await firestoreSet(env, uid, 'config/worker', { url: parsed.toString(), updatedAt: new Date().toISOString() }, session.idToken);
    return json({ ok: true, url: parsed.toString() });
  }

  if (path === '/api/policy/upload-session' && request.method === 'POST') {
    const body = await request.json() as { assetId?: string; totalChunks?: number; chunkSize?: number };
    const assetId = (body.assetId || '').trim();
    const totalChunks = Math.max(1, Number(body.totalChunks || 1));
    if (!assetId) return json({ message: 'assetId is required' }, 400);
    if (!takeToken(uid, 'upload')) return json({ message: 'Rate limited', retryAfterMs: 2000 }, 429);

    const sessionId = newSessionId();
    const expiresAt = computeExpiryIso(MAX_UPLOAD_SESSION_TTL_MS);
    const chunkSize = Math.max(512 * 1024, Number(body.chunkSize || DEFAULT_CHUNK_SIZE));
    const sessionRecord = {
      sessionId,
      assetId,
      ownerUid: uid,
      createdAt: new Date().toISOString(),
      expiresAt,
      allowedChunkRange: [0, totalChunks - 1],
      maxParallelChunks: 6,
      resumeToken: crypto.randomUUID(),
      chunkSize,
      status: 'active',
      proof: await signSessionProof(`${uid}:${assetId}:${sessionId}:${expiresAt}`, uid),
    };

    await firestoreSet(env, uid, `sessions/${sessionId}`, sessionRecord, session.idToken);
    return json(sessionRecord, 201);
  }

  if (path.match(/^\/api\/policy\/upload-session\/([^/]+)$/) && request.method === 'GET') {
    const sessionId = path.match(/^\/api\/policy\/upload-session\/([^/]+)$/)?.[1] || '';
    const record = await firestoreGet(env, uid, `sessions/${sessionId}`, session.idToken);
    if (!record) return json({ message: 'Session not found' }, 404);
    return json(record);
  }

  if (path.match(/^\/api\/policy\/upload-session\/([^/]+)\/complete$/) && request.method === 'POST') {
    const sessionId = path.match(/^\/api\/policy\/upload-session\/([^/]+)\/complete$/)?.[1] || '';
    const record = await firestoreGet(env, uid, `sessions/${sessionId}`, session.idToken);
    if (!record) return json({ message: 'Session not found' }, 404);
    await firestoreSet(env, uid, `sessions/${sessionId}`, { status: 'completed', completedAt: new Date().toISOString() }, session.idToken);
    return json({ ok: true });
  }

  if (path === '/api/policy/health' && request.method === 'GET') {
    const workerConfig = await firestoreGet(env, uid, 'config/worker', session.idToken);
    return json({
      uid,
      rate: getQuota(uid),
      hasWorker: Boolean(workerConfig?.url),
      workerUrl: workerConfig?.url || null,
    });
  }

  return json({ message: 'Policy endpoint not found' }, 404);
}
