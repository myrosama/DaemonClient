import { beforeEach, describe, expect, it } from 'vitest';
import { __resetCertsCache, derSequenceEnd, looksLikeFirebaseIdToken, verifyFirebaseIdToken } from './firebase-token';

// Sign real RS256 tokens with a throwaway key and hand the verifier a
// certificate built from that same key, so the signature path is exercised for
// real rather than stubbed. Anything less would let a forged-signature
// regression through.
const PROJECT = 'daemonclient-test';
const KID = 'test-kid';

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));

let keyPair: CryptoKeyPair;
let certPem: string;

/** Wrap a raw SPKI public key in a minimal X.509 certificate so keyFromCert's
 *  OID scan has something realistic to find. */
async function makeCertPem(pub: CryptoKey): Promise<string> {
  const spki = new Uint8Array((await crypto.subtle.exportKey('spki', pub)) as ArrayBuffer);
  // A certificate is a SEQUENCE that contains the SPKI. Prefixing filler before
  // the SPKI is enough: the verifier scans for the RSA OID and walks back to the
  // enclosing SEQUENCE, which is exactly the SPKI we embed here.
  const der = new Uint8Array(spki.length + 8);
  der.set([0x30, 0x82, 0x00, 0x00, 0x30, 0x82, 0x00, 0x00], 0);
  der.set(spki, 8);
  const b64 = btoa(String.fromCharCode(...der));
  return `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----`;
}

async function signToken(claims: Record<string, unknown>, header: Record<string, unknown> = {}) {
  const h = enc({ alg: 'RS256', kid: KID, typ: 'JWT', ...header });
  const p = enc(claims);
  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    keyPair.privateKey,
    new TextEncoder().encode(`${h}.${p}`),
  );
  return `${h}.${p}.${b64url(new Uint8Array(sig))}`;
}

const future = () => Math.floor(Date.now() / 1000) + 3600;
const validClaims = (over: Record<string, unknown> = {}) => ({
  aud: PROJECT,
  iss: `https://securetoken.google.com/${PROJECT}`,
  sub: 'uid-123',
  email: 'someone@example.com',
  exp: future(),
  ...over,
});

beforeEach(async () => {
  __resetCertsCache();
  if (!keyPair) {
    keyPair = (await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign', 'verify'],
    )) as CryptoKeyPair;
    certPem = await makeCertPem(keyPair.publicKey);
  }
});

const certs = async () => ({ [KID]: certPem });

describe('looksLikeFirebaseIdToken', () => {
  it('tells a 3-part Firebase JWT from our own 2-part session token', () => {
    expect(looksLikeFirebaseIdToken('a.b.c')).toBe(true);
    expect(looksLikeFirebaseIdToken('payload.signature')).toBe(false);
  });
});

describe('verifyFirebaseIdToken', () => {
  it('accepts a correctly signed token and returns the identity', async () => {
    const token = await signToken(validClaims());
    await expect(verifyFirebaseIdToken(token, PROJECT, certs)).resolves.toMatchObject({
      uid: 'uid-123',
      email: 'someone@example.com',
    });
  });

  it('prefers user_id over sub, as Firebase emits both', async () => {
    const token = await signToken(validClaims({ user_id: 'real-uid', sub: 'other' }));
    await expect(verifyFirebaseIdToken(token, PROJECT, certs)).resolves.toMatchObject({ uid: 'real-uid' });
  });

  it('rejects a tampered payload', async () => {
    const token = await signToken(validClaims());
    const [h, , s] = token.split('.');
    const forged = `${h}.${enc(validClaims({ sub: 'attacker' }))}.${s}`;
    await expect(verifyFirebaseIdToken(forged, PROJECT, certs)).rejects.toThrow(/signature/);
  });

  it('rejects alg:none — trusting the named algorithm is a forgery route', async () => {
    const h = enc({ alg: 'none', kid: KID, typ: 'JWT' });
    const p = enc(validClaims());
    await expect(verifyFirebaseIdToken(`${h}.${p}.`, PROJECT, certs)).rejects.toThrow(/algorithm/);
  });

  it('rejects HS256 signed with the public key', async () => {
    const token = await signToken(validClaims(), { alg: 'HS256' });
    await expect(verifyFirebaseIdToken(token, PROJECT, certs)).rejects.toThrow(/algorithm/);
  });

  it('rejects a token minted for a different Firebase project', async () => {
    const token = await signToken(validClaims({ aud: 'someone-elses-project' }));
    await expect(verifyFirebaseIdToken(token, PROJECT, certs)).rejects.toThrow(/different project/);
  });

  it('rejects an unexpected issuer', async () => {
    const token = await signToken(validClaims({ iss: 'https://evil.example/' }));
    await expect(verifyFirebaseIdToken(token, PROJECT, certs)).rejects.toThrow(/issuer/);
  });

  it('rejects an expired token', async () => {
    const token = await signToken(validClaims({ exp: Math.floor(Date.now() / 1000) - 10 }));
    await expect(verifyFirebaseIdToken(token, PROJECT, certs)).rejects.toThrow(/expired/);
  });

  it('rejects a token signed with a key Google does not publish', async () => {
    const token = await signToken(validClaims(), { kid: 'unknown-kid' });
    await expect(verifyFirebaseIdToken(token, PROJECT, certs)).rejects.toThrow(/unknown key/);
  });

  it('rejects malformed input', async () => {
    await expect(verifyFirebaseIdToken('not-a-jwt', PROJECT, certs)).rejects.toThrow(/malformed/);
    await expect(verifyFirebaseIdToken('a.b.c', PROJECT, certs)).rejects.toThrow(/malformed/);
  });

  it('refuses to verify when the project id is not configured (fails closed)', async () => {
    const token = await signToken(validClaims());
    await expect(verifyFirebaseIdToken(token, '', certs)).rejects.toThrow(/misconfigured/);
  });

  it('refetches certs once when the kid is unknown, in case of rotation', async () => {
    let calls = 0;
    const rotating = async (force?: boolean): Promise<Record<string, string>> => {
      calls++;
      return force ? { [KID]: certPem } : {};
    };
    const token = await signToken(validClaims());
    await expect(verifyFirebaseIdToken(token, PROJECT, rotating)).resolves.toMatchObject({ uid: 'uid-123' });
    expect(calls).toBe(2);
  });
});

// workerd's importKey('spki') rejects trailing bytes; Node silently tolerates
// them. That difference hid a bug that only appeared once deployed, so pin the
// length arithmetic here where it runs in Node.
describe('derSequenceEnd — slice the SPKI exactly, not to end-of-certificate', () => {
  it('short form: one length byte', () => {
    // 0x30 0x03 <3 bytes> → ends at 5
    expect(derSequenceEnd(new Uint8Array([0x30, 0x03, 1, 2, 3, 0xff, 0xff]), 0)).toBe(5);
  });

  it('long form 0x81: one following length byte', () => {
    const der = new Uint8Array(200);
    der[0] = 0x30; der[1] = 0x81; der[2] = 130;
    expect(derSequenceEnd(der, 0)).toBe(3 + 130);
  });

  it('long form 0x82: two following length bytes (the RSA-2048 case)', () => {
    const der = new Uint8Array(400);
    der[0] = 0x30; der[1] = 0x82; der[2] = 0x01; der[3] = 0x22; // 290
    expect(derSequenceEnd(der, 0)).toBe(4 + 290);
  });

  it('stops before trailing bytes rather than swallowing them', () => {
    const der = new Uint8Array([0x30, 0x02, 0xaa, 0xbb, /* trailing */ 0x99, 0x99, 0x99]);
    const end = derSequenceEnd(der, 0);
    expect(end).toBe(4);
    expect(der.length - end).toBe(3); // the bytes workerd would have rejected
  });

  it('refuses a malformed length rather than guessing', () => {
    expect(() => derSequenceEnd(new Uint8Array([0x30, 0x88, 1, 2]), 0)).toThrow(/unsupported/);
    expect(() => derSequenceEnd(new Uint8Array([0x30]), 0)).toThrow(/unsupported/);
  });
});
