import type { Env } from './index';

/** Shared helpers for Firestore REST and auth token extraction */

export function getSessionToken(request: Request): string | null {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/immich_access_token=([^;]+)/);
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

export function decodeSession(token: string): SessionData | null {
  try {
    const json = atob(token);
    const data = JSON.parse(json);
    if (data.exp && data.exp < Date.now()) return null;
    return data;
  } catch { return null; }
}

export async function requireAuth(request: Request): Promise<SessionData> {
  const token = getSessionToken(request);
  if (!token) throw new Error('Not authenticated');
  const session = decodeSession(token);
  if (!session) throw new Error('Session expired');
  return session;
}

const FIRESTORE_BASE = 'https://firestore.googleapis.com/v1';

export function firestoreDocPath(env: Env, uid: string, ...parts: string[]): string {
  return `projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/artifacts/${env.APP_IDENTIFIER}/users/${uid}/${parts.join('/')}`;
}

export async function firestoreGet(env: Env, uid: string, path: string, idToken: string): Promise<any> {
  const docPath = firestoreDocPath(env, uid, ...path.split('/'));
  const res = await fetch(`${FIRESTORE_BASE}/${docPath}`, {
    headers: { 'Authorization': `Bearer ${idToken}` },
  });
  if (!res.ok) return null;
  const doc = await res.json();
  return parseFirestoreDoc(doc);
}

export async function firestoreQuery(
  env: Env, uid: string, collection: string, idToken: string,
  orderBy?: string, direction?: string, limit?: number
): Promise<any[]> {
  const parent = `projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/artifacts/${env.APP_IDENTIFIER}/users/${uid}`;
  const collId = collection;
  const body: any = {
    structuredQuery: {
      from: [{ collectionId: collId }],
    }
  };
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
