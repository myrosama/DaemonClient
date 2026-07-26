// HEIC → JPEG, as a serverless function.
//
// Why this exists: Cloudflare Workers cannot decode HEIC. Not a design choice —
// libheif is far more CPU than a Worker invocation is allowed. Everything else
// in DaemonClient is serverless and free, so this is too: a single stateless
// function on a free tier, no container, no server, nothing to keep running.
//
// It is pure WASM (libheif-js) plus a JPEG encoder, so the same file runs
// unchanged on Vercel, Netlify, Cloudflare Pages Functions, or Firebase
// Functions — anywhere that speaks the standard Request/Response handler.
//
// PRIVACY: every user runs their OWN instance. A worker only ever calls the URL
// stored in its own config, and the request is verified against that user's own
// Firebase project. Nothing is written to disk; bytes arrive, are converted in
// memory, and leave in the response.

import libheif from 'libheif-js/wasm-bundle.js';
import { encode as encodeJpeg } from '@jsquash/jpeg';

const THUMB_EDGE = Number(process.env.THUMB_EDGE || 720);
const MAX_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 32 * 1024 * 1024);
const PROJECT_ID = (process.env.FIREBASE_PROJECT_ID || '').trim();
const OWNER_UID = (process.env.OWNER_UID || '').trim();

const CERTS_URL =
  'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';

let certsCache = { certs: null, expiresAt: 0 };

async function googleCerts(force = false) {
  const now = Date.now();
  if (!force && certsCache.certs && now < certsCache.expiresAt) return certsCache.certs;

  const res = await fetch(CERTS_URL);
  if (!res.ok) throw new Error(`could not fetch Google certificates (${res.status})`);
  const certs = await res.json();

  // Honour Google's own cache lifetime rather than inventing one.
  let maxAge = 3600;
  const cc = res.headers.get('cache-control') || '';
  const m = cc.match(/max-age=(\d+)/);
  if (m) maxAge = Number(m[1]);
  certsCache = { certs, expiresAt: now + Math.max(60_000, (maxAge - 60) * 1000) };
  return certs;
}

const b64urlToBytes = (s) => {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

/** Convert a PEM X.509 certificate into a WebCrypto verification key. */
async function keyFromCert(pem) {
  const body = pem.replace(/-----(BEGIN|END) CERTIFICATE-----|\s/g, '');
  const der = b64urlToBytes(body.replace(/\+/g, '-').replace(/\//g, '_'));
  // Extract the SubjectPublicKeyInfo from the certificate. Rather than parse
  // ASN.1 by hand, let WebCrypto try: importKey('spki') on the cert fails, so
  // we locate the RSA public key by its OID header.
  const marker = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01];
  let idx = -1;
  outer: for (let i = 0; i + marker.length < der.length; i++) {
    for (let j = 0; j < marker.length; j++) if (der[i + j] !== marker[j]) continue outer;
    idx = i;
    break;
  }
  if (idx < 0) throw new Error('unsupported certificate');

  // Walk back to the enclosing SEQUENCE that is the SubjectPublicKeyInfo.
  let start = idx - 4;
  while (start >= 0 && der[start] !== 0x30) start--;
  if (start < 0) throw new Error('unsupported certificate');
  const spki = der.slice(start);
  return crypto.subtle.importKey('spki', spki, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
}

/** Verify a Firebase ID token: signature, issuer, audience, expiry, owner. */
async function verifyToken(idToken) {
  if (!PROJECT_ID) throw new Error('server misconfigured: FIREBASE_PROJECT_ID is not set');

  const parts = String(idToken).split('.');
  if (parts.length !== 3) throw new Error('malformed token');
  const [headerB64, payloadB64, sigB64] = parts;

  let header, claims;
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlToBytes(headerB64)));
    claims = JSON.parse(new TextDecoder().decode(b64urlToBytes(payloadB64)));
  } catch {
    throw new Error('malformed token');
  }

  // Only RS256. Accepting the algorithm the token asks for is how "alg: none"
  // and HMAC-with-the-public-key attacks get in.
  if (header.alg !== 'RS256') throw new Error('unexpected token algorithm');

  let certs = await googleCerts();
  if (!header.kid || !certs[header.kid]) {
    // A key we do not know may just predate a rotation — refetch once. The
    // result is cached either way, so this cannot be used to force repeated
    // outbound requests.
    certs = await googleCerts(true);
  }
  if (!header.kid || !certs[header.kid]) throw new Error('token signed with an unknown key');

  const key = await keyFromCert(certs[header.kid]);
  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    b64urlToBytes(sigB64),
    new TextEncoder().encode(`${headerB64}.${payloadB64}`),
  );
  if (!ok) throw new Error('bad token signature');

  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== 'number' || claims.exp < now) throw new Error('token expired');
  if (claims.aud !== PROJECT_ID) throw new Error('token is for a different project');
  if (claims.iss !== `https://securetoken.google.com/${PROJECT_ID}`) throw new Error('unexpected token issuer');

  const uid = claims.user_id || claims.sub;
  if (!uid) throw new Error('token carries no subject');
  // The single most important check: this instance belongs to one person, so a
  // leaked URL is worthless to anyone else.
  if (OWNER_UID && uid !== OWNER_UID) throw new Error('this processor is private to another account');
  return uid;
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** Nearest-neighbour downscale. Good enough for a grid thumbnail and far
 *  cheaper than pulling in an image-processing dependency. */
function downscale(rgba, width, height, maxEdge) {
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  if (scale >= 1) return { data: rgba, width, height };

  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(height - 1, Math.floor(y / scale));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(width - 1, Math.floor(x / scale));
      const from = (sy * width + sx) * 4;
      const to = (y * w + x) * 4;
      out[to] = rgba[from];
      out[to + 1] = rgba[from + 1];
      out[to + 2] = rgba[from + 2];
      out[to + 3] = rgba[from + 3];
    }
  }
  return { data: out, width: w, height: h };
}

export async function handleConvert(request) {
  if (request.method !== 'POST') return json({ error: 'POST only' }, 405);

  const auth = request.headers.get('authorization') || '';
  if (!auth.startsWith('Bearer ')) return json({ error: 'missing bearer token' }, 401);
  try {
    await verifyToken(auth.slice(7));
  } catch (e) {
    return json({ error: e.message }, 401);
  }

  const bytes = new Uint8Array(await request.arrayBuffer());
  if (!bytes.length) return json({ error: 'empty body' }, 400);
  if (bytes.length > MAX_BYTES) return json({ error: `body exceeds ${MAX_BYTES} bytes` }, 413);

  try {
    const decoder = new libheif.HeifDecoder();
    const images = decoder.decode(bytes);
    if (!images || !images.length) return json({ error: 'no image found in this file' }, 422);

    const image = images[0];
    const width = image.get_width();
    const height = image.get_height();

    const rgba = new Uint8ClampedArray(width * height * 4);
    await new Promise((resolve, reject) => {
      image.display({ data: rgba, width, height }, (out) => (out ? resolve(out) : reject(new Error('decode failed'))));
    });

    const small = downscale(rgba, width, height, THUMB_EDGE);
    const jpeg = await encodeJpeg(
      { data: small.data, width: small.width, height: small.height },
      { quality: 80 },
    );

    return new Response(jpeg, {
      status: 200,
      headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' },
    });
  } catch (e) {
    return json({ error: `HEIC decode failed: ${e.message}` }, 422);
  }
}

export function handleHealth() {
  // Unauthenticated on purpose: the setup CLI and the dashboard call this to
  // confirm a fresh deployment is reachable. It exposes no user data, and it
  // reports whether the instance is pinned to one account so the CLI can warn
  // when it is not.
  const problems = [];
  if (!PROJECT_ID) problems.push('FIREBASE_PROJECT_ID is not set — every request will be rejected');
  if (!OWNER_UID) problems.push('OWNER_UID is not set — any account in this Firebase project can use this instance');

  return json({
    service: 'daemonclient-processor',
    version: '2.0.0',
    runtime: 'serverless',
    capabilities: { heicThumbnail: true },
    ownerPinned: !!OWNER_UID,
    // Reachability is what the caller is testing; a missing OWNER_UID is a
    // warning, not a failure, so it must not make health checks fail the deploy.
    ok: problems.length === 0,
    problems,
  });
}

/** The portable Web-standard handler: a standard `Request` in, a `Response` out.
 *  Kept as a named export so the same function serves every host that speaks the
 *  Web interface (and so it is unit-testable in plain Node). */
export async function handler(request) {
  const url = new URL(request.url);
  if (url.pathname.endsWith('/health')) return handleHealth();
  return handleConvert(request);
}

// Runs on Vercel's NODE.js runtime, NOT Edge. Decoding HEIC through the libheif
// WASM is computationally intense — and Vercel documents the Node.js runtime as
// the one "suited to computationally intense or large functions", with far more
// generous CPU, memory and bundle limits than an Edge Function on the free plan.
// The Node runtime serves the same Web `Request`/`Response` handler via the
// `{ fetch }` export, so the handler above is reused unchanged.
// Do NOT re-add `export const config = { runtime: 'edge' }` — its absence is
// asserted in test/handler.test.mjs.
export default { fetch: handler };
