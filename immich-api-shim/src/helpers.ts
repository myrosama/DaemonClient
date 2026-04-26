import type { Env } from './index';

/** Shared helpers for Firestore REST and auth token extraction */

export function getSessionToken(request: Request): string | null {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/(?:immich_access_token|__session)=([^;]+)/);
  if (match) return match[1];
  const auth = request.headers.get('Authorization') || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  return null;
}

export interface SessionData {
  uid: string;
  email: string;
  idToken: string;
  refreshToken: string;
  exp: number;
}

async function hmacSign(payload: string, scope: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(`session:${scope}`),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

async function verifySignedSessionToken(token: string, scope: string): Promise<SessionData | null> {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const payloadB64 = parts[0];
  const expectedSig = await hmacSign(payloadB64, scope);
  if (parts[1] !== expectedSig) return null;
  try {
    const json = atob(payloadB64);
    const data = JSON.parse(json);
    if (data.exp && data.exp < Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

export function decodeSession(token: string): SessionData | null {
  try {
    const json = atob(token);
    const data = JSON.parse(json);
    if (data.exp && data.exp < Date.now()) return null;
    return data;
  } catch { return null; }
}

const refreshInFlight = new Map<string, Promise<string>>();
const tokenCache = new Map<string, { token: string; expires: number }>();

async function refreshFirebaseToken(apiKey: string, refreshToken: string): Promise<string> {
  const url = `https://securetoken.googleapis.com/v1/token?key=${apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=refresh_token&refresh_token=${refreshToken}`
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error(`[refreshToken] Failed: ${res.status} ${body.substring(0, 200)}`);
    throw new Error(`Token refresh failed: ${res.status}`);
  }
  const data = await res.json() as any;
  return data.id_token;
}

export async function requireAuth(request: Request, env?: Env): Promise<SessionData> {
  const token = getSessionToken(request);
  if (!token) throw new Error('Not authenticated');
  let session: SessionData | null = null;
  if (env?.APP_IDENTIFIER && token.includes('.')) {
    session = await verifySignedSessionToken(token, env.APP_IDENTIFIER);
  } else {
    session = decodeSession(token);
  }
  if (!session) throw new Error('Session expired');

  let idTokenExpired = false;
  try {
    const payload = JSON.parse(atob(session.idToken.split('.')[1]));
    if (payload.exp * 1000 < Date.now()) idTokenExpired = true;
  } catch { idTokenExpired = true; }

  if (idTokenExpired && env?.FIREBASE_API_KEY && session.refreshToken) {
    const cacheKey = session.uid;
    const cached = tokenCache.get(cacheKey);
    if (cached && cached.expires > Date.now()) {
      session.idToken = cached.token;
      return session;
    }

    if (!refreshInFlight.has(cacheKey)) {
      const promise = refreshFirebaseToken(env.FIREBASE_API_KEY, session.refreshToken)
        .then(newToken => {
          tokenCache.set(cacheKey, { token: newToken, expires: Date.now() + 3500000 });
          return newToken;
        })
        .catch((err) => {
          // CRITICAL: Remove failed refresh from cache so next request can retry
          refreshInFlight.delete(cacheKey);
          throw err;
        })
        .finally(() => {
          // Clean up successful refreshes after a delay
          setTimeout(() => refreshInFlight.delete(cacheKey), 1000);
        });
      refreshInFlight.set(cacheKey, promise);
    }

    try {
      session.idToken = await refreshInFlight.get(cacheKey)!;
    } catch (err) {
      // Don't cache the failure - let next request retry
      refreshInFlight.delete(cacheKey);
      throw new Error('Session expired');
    }
  }

  return session;
}

const FIRESTORE_BASE = 'https://firestore.googleapis.com/v1';

export function firestoreDocPath(env: Env, uid: string, ...parts: string[]): string {
  return `projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/artifacts/${env.APP_IDENTIFIER}/users/${uid}/${parts.join('/')}`;
}

const firestoreCache = new Map<string, { value: any; expires: number }>();

export async function firestoreGet(env: Env, uid: string, path: string, idToken: string): Promise<any> {
  const cacheKey = `${uid}:${path}`;
  const now = Date.now();
  const cached = firestoreCache.get(cacheKey);
  if (cached && cached.expires > now) {
    return cached.value;
  }

  const docPath = firestoreDocPath(env, uid, ...path.split('/'));
  const res = await fetch(`${FIRESTORE_BASE}/${docPath}`, {
    headers: { 'Authorization': `Bearer ${idToken}` },
  });
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      console.error(`[firestoreGet] AUTH FAILURE: ${path} returned ${res.status} for uid ${uid} — token may be expired`);
    } else if (res.status !== 404) {
      console.warn(`[firestoreGet] ${path} returned ${res.status} for uid ${uid}`);
    }
    return null;
  }
  const doc = await res.json();
  const value = parseFirestoreDoc(doc);
  
  const ttl = path.startsWith('config') ? 300000 : 30000; // 30s for queries, 5min for config
  firestoreCache.set(cacheKey, { value, expires: now + ttl });

  // Proactive LRU eviction: keep cache size bounded
  if (firestoreCache.size > 5000) {
    // Delete oldest 1000 entries (Map maintains insertion order)
    const toDelete = Array.from(firestoreCache.keys()).slice(0, 1000);
    toDelete.forEach(k => firestoreCache.delete(k));
  }

  // Lazy expiry cleanup: periodically remove expired entries
  if (Math.random() < 0.01) { // 1% of requests trigger cleanup
    const expiredKeys: string[] = [];
    for (const [key, entry] of firestoreCache.entries()) {
      if (entry.expires < now) {
        expiredKeys.push(key);
        if (expiredKeys.length > 500) break; // Limit cleanup work
      }
    }
    expiredKeys.forEach(k => firestoreCache.delete(k));
  }
  
  return value;
}

export async function firestoreQuery(
  env: Env, uid: string, collection: string, idToken: string,
  orderBy?: string, direction?: string, limit?: number,
  whereFilters?: Array<{ field: string; op: string; value: any }>
): Promise<any[]> {
  const parent = `projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/artifacts/${env.APP_IDENTIFIER}/users/${uid}`;
  const collId = collection;
  const body: any = {
    structuredQuery: {
      from: [{ collectionId: collId }],
    }
  };

  // Add where filters
  if (whereFilters && whereFilters.length > 0) {
    body.structuredQuery.where = {
      compositeFilter: {
        op: 'AND',
        filters: whereFilters.map(f => ({
          fieldFilter: {
            field: { fieldPath: f.field },
            op: f.op,
            value: toFirestoreValue(f.value)
          }
        }))
      }
    };
  }

  if (orderBy) {
    body.structuredQuery.orderBy = [{
      field: { fieldPath: orderBy },
      direction: direction === 'ASCENDING' ? 'ASCENDING' : 'DESCENDING'
    }];
  }
  if (limit) body.structuredQuery.limit = limit;

  const res = await fetch(`${FIRESTORE_BASE}/${parent}:runQuery`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${idToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) return [];
  const results = await res.json() as any[];
  return results.filter((r: any) => r.document).map((r: any) => parseFirestoreDoc(r.document));
}

export async function firestoreSet(env: Env, uid: string, path: string, data: Record<string, any>, idToken: string): Promise<void> {
  const cacheKey = `${uid}:${path}`;
  const ttl = path.startsWith('config') ? 300000 : 60000;
  const cached = firestoreCache.get(cacheKey)?.value || {};
  firestoreCache.set(cacheKey, { value: { ...cached, ...data }, expires: Date.now() + ttl });

  const docPath = firestoreDocPath(env, uid, ...path.split('/'));
  const fields: Record<string, any> = {};
  for (const [k, v] of Object.entries(data)) {
    fields[k] = toFirestoreValue(v);
  }
  await fetch(`${FIRESTORE_BASE}/${docPath}`, {
    method: 'PATCH',
    headers: { 'Authorization': `Bearer ${idToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  });
}

export async function firestoreDelete(env: Env, uid: string, path: string, idToken: string): Promise<void> {
  const cacheKey = `${uid}:${path}`;
  firestoreCache.delete(cacheKey);

  const docPath = firestoreDocPath(env, uid, ...path.split('/'));
  await fetch(`${FIRESTORE_BASE}/${docPath}`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${idToken}` },
  });
}

function parseFirestoreDoc(doc: any): any {
  if (!doc || !doc.fields) return null;
  const result: any = {};
  const name = doc.name || '';
  const parts = name.split('/');
  result._id = parts[parts.length - 1];
  for (const [key, val] of Object.entries(doc.fields)) {
    result[key] = fromFirestoreValue(val as any);
  }
  return result;
}

function fromFirestoreValue(val: any): any {
  if (val.stringValue !== undefined) return val.stringValue;
  if (val.integerValue !== undefined) return Number(val.integerValue);
  if (val.doubleValue !== undefined) return val.doubleValue;
  if (val.booleanValue !== undefined) return val.booleanValue;
  if (val.nullValue !== undefined) return null;
  if (val.timestampValue !== undefined) return val.timestampValue;
  if (val.arrayValue) return (val.arrayValue.values || []).map(fromFirestoreValue);
  if (val.mapValue) {
    const obj: any = {};
    for (const [k, v] of Object.entries(val.mapValue.fields || {})) {
      obj[k] = fromFirestoreValue(v as any);
    }
    return obj;
  }
  return null;
}

function toFirestoreValue(val: any): any {
  if (val === null || val === undefined) return { nullValue: null };
  if (typeof val === 'string') return { stringValue: val };
  if (typeof val === 'number') return Number.isInteger(val) ? { integerValue: String(val) } : { doubleValue: val };
  if (typeof val === 'boolean') return { booleanValue: val };
  if (Array.isArray(val)) return { arrayValue: { values: val.map(toFirestoreValue) } };
  if (typeof val === 'object') {
    const fields: Record<string, any> = {};
    for (const [k, v] of Object.entries(val)) fields[k] = toFirestoreValue(v);
    return { mapValue: { fields } };
  }
  return { stringValue: String(val) };
}

export function json(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
