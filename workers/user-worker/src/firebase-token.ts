// Verify a Firebase ID token (RS256, Google's rotating public certs).
//
// Why the Worker needs this: the accounts dashboard, Drive and Photos all sign
// the user in with the Firebase SDK, which yields an ID token — not one of the
// HMAC session tokens `/api/auth/login` mints. Without this, every dashboard
// call answered 401 "Session expired" and the cards silently rendered zeros.
// Accepting the ID token directly is also what lets one sign-in serve all three
// apps instead of each minting its own session.
//
// The hardening here mirrors processor/api/convert.js, which has verified these
// tokens in production for a while. Keep the two in step.

const CERTS_URL =
  'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';

let certsCache: { certs: Record<string, string> | null; expiresAt: number } = { certs: null, expiresAt: 0 };
// Google rotates signing keys far slower than this. Bounding forced refetches
// stops an unauthenticated caller from buying one outbound request per attempt
// simply by inventing a `kid` — the lookup happens before signature checking,
// so no valid token is needed to trigger it.
const FORCED_REFETCH_COOLDOWN_MS = 5 * 60 * 1000;
let lastForcedFetch = 0;

/** Test seam — module state would otherwise leak between cases. */
export function __resetCertsCache(): void {
  certsCache = { certs: null, expiresAt: 0 };
  lastForcedFetch = 0;
}

export type CertFetcher = (force?: boolean) => Promise<Record<string, string>>;

export const googleCerts: CertFetcher = async (force = false) => {
  const now = Date.now();
  if (!force && certsCache.certs && now < certsCache.expiresAt) return certsCache.certs;
  // A forced refetch is for key rotation, which is rare. Outside the cooldown
  // window serve what we have rather than making the request.
  if (force && certsCache.certs && now - lastForcedFetch < FORCED_REFETCH_COOLDOWN_MS) return certsCache.certs;
  if (force) lastForcedFetch = now;

  const res = await fetch(CERTS_URL);
  if (!res.ok) throw new Error(`could not fetch Google certificates (${res.status})`);
  const certs = (await res.json()) as Record<string, string>;

  // Honour Google's own cache lifetime rather than inventing one. On a free-tier
  // Worker this matters: it keeps cert fetches to roughly one per day per
  // isolate instead of one per request.
  let maxAge = 3600;
  const m = (res.headers.get('cache-control') || '').match(/max-age=(\d+)/);
  if (m) maxAge = Number(m[1]);
  certsCache = { certs, expiresAt: now + Math.max(60_000, (maxAge - 60) * 1000) };
  return certs;
};

function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function keyFromCert(pem: string): Promise<CryptoKey> {
  const body = pem.replace(/-----(BEGIN|END) CERTIFICATE-----|\s/g, '');
  const der = b64urlToBytes(body);
  // Locate the SubjectPublicKeyInfo inside the X.509 certificate by its RSA
  // algorithm OID, rather than hand-rolling an ASN.1 parser.
  const marker = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01];
  let idx = -1;
  outer: for (let i = 0; i + marker.length < der.length; i++) {
    for (let j = 0; j < marker.length; j++) if (der[i + j] !== marker[j]) continue outer;
    idx = i;
    break;
  }
  if (idx < 0) throw new Error('unsupported certificate');
  let start = idx - 4;
  while (start >= 0 && der[start] !== 0x30) start--;
  if (start < 0) throw new Error('unsupported certificate');

  // Slice the SPKI EXACTLY, not "from here to the end of the certificate".
  // workerd's importKey('spki') rejects trailing bytes — the certificate's own
  // signature follows the SPKI, so slicing to the end fails with "Invalid N
  // trailing bytes after SPKI input". Node happens to tolerate it, which is why
  // this only shows up once deployed. (processor/api/convert.js runs on Node
  // and still slices to the end; it works there, but this is the correct form.)
  const end = derSequenceEnd(der, start);
  if (end > der.length) throw new Error('unsupported certificate');
  return crypto.subtle.importKey(
    'spki',
    der.slice(start, end),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
}

/** End offset (exclusive) of the DER TLV that starts at `start`.
 *  Short form: one length byte. Long form: 0x80|n, then n big-endian bytes. */
export function derSequenceEnd(der: Uint8Array, start: number): number {
  const lengthByte = der[start + 1];
  if (lengthByte === undefined) throw new Error('unsupported certificate');
  if (lengthByte < 0x80) return start + 2 + lengthByte;
  const count = lengthByte & 0x7f;
  if (count === 0 || count > 4) throw new Error('unsupported certificate');
  let length = 0;
  for (let i = 0; i < count; i++) {
    const b = der[start + 2 + i];
    if (b === undefined) throw new Error('unsupported certificate');
    length = length * 256 + b;
  }
  return start + 2 + count + length;
}

export interface FirebaseIdentity {
  uid: string;
  email: string;
  /** Token expiry, in milliseconds, to match SessionData.exp. */
  exp: number;
}

/** A Firebase ID token is a 3-part JWT; our own session tokens are 2-part.
 *  That shape is the discriminator, so the two can never be confused. */
export function looksLikeFirebaseIdToken(token: string): boolean {
  return token.split('.').length === 3;
}

export async function verifyFirebaseIdToken(
  idToken: string,
  projectId: string,
  fetchCerts: CertFetcher = googleCerts,
): Promise<FirebaseIdentity> {
  if (!projectId) throw new Error('server misconfigured: FIREBASE_PROJECT_ID is not set');

  const parts = String(idToken).split('.');
  if (parts.length !== 3) throw new Error('malformed token');
  const [headerB64, payloadB64, sigB64] = parts;

  let header: any;
  let claims: any;
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlToBytes(headerB64)));
    claims = JSON.parse(new TextDecoder().decode(b64urlToBytes(payloadB64)));
  } catch {
    throw new Error('malformed token');
  }

  // Only RS256. Trusting the algorithm the token names is how `alg: none` and
  // HMAC-signed-with-the-public-key forgeries get in.
  if (header.alg !== 'RS256') throw new Error('unexpected token algorithm');

  const has = (c: Record<string, string>, kid: unknown) =>
    typeof kid === 'string' && Object.prototype.hasOwnProperty.call(c, kid);

  let certs = await fetchCerts();
  if (!has(certs, header.kid)) {
    // An unknown key may simply predate a rotation — refetch once. googleCerts
    // rate-limits forced refetches, so a stream of invented `kid`s cannot turn
    // into a stream of outbound requests.
    certs = await fetchCerts(true);
  }
  if (!has(certs, header.kid)) throw new Error('token signed with an unknown key');

  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    await keyFromCert(certs[header.kid]),
    b64urlToBytes(sigB64),
    new TextEncoder().encode(`${headerB64}.${payloadB64}`),
  );
  if (!ok) throw new Error('bad token signature');

  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== 'number' || claims.exp < now) throw new Error('token expired');
  if (claims.aud !== projectId) throw new Error('token is for a different project');
  if (claims.iss !== `https://securetoken.google.com/${projectId}`) throw new Error('unexpected token issuer');

  const uid = claims.user_id || claims.sub;
  if (!uid) throw new Error('token carries no subject');

  return { uid: String(uid), email: String(claims.email || ''), exp: claims.exp * 1000 };
}
