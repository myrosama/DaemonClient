//! AES-256-GCM parts and PBKDF2 keys, byte-compatible with the production
//! JavaScript (`drive/src/crypto.js`, the web service worker and the worker's
//! `assets.ts`). Format (frozen, SPEC §4.2): a part is
//! `[12-byte random IV][ciphertext][16-byte GCM tag]`; the key is
//! PBKDF2-HMAC-SHA256(password UTF-8, base64 salt, 100,000 iterations), 32 bytes.

use aes_gcm::aead::{AeadInOut, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce, Tag};
use base64::Engine as _;
use bytes::Bytes;
use zeroize::Zeroizing;

pub const IV_LEN: usize = 12;
pub const TAG_LEN: usize = 16;
pub const PBKDF2_ITERATIONS: u32 = 100_000;
/// Plaintext encrypted into the Drive key check (worker release, R§2).
pub const DRIVE_KEY_CHECK_PLAINTEXT: &[u8] = b"daemonclient-drive-key-check-v1";

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum CryptoError {
    #[error("the encryption salt is not valid base64")]
    BadSalt,
    #[error("an encrypted part is shorter than its IV and tag ({0} bytes)")]
    Truncated(usize),
    #[error("an encrypted part failed authentication (wrong key or damaged data)")]
    Authentication,
    #[error("the system random number generator failed")]
    Random,
    #[error("a part is too large to encrypt (over 64 GiB)")]
    PartTooLarge,
}

/// An AES-256 key. Wiped from memory when dropped; never printed.
pub struct Key {
    bytes: Zeroizing<[u8; 32]>,
}

impl std::fmt::Debug for Key {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Key([redacted])")
    }
}

impl Key {
    /// For test vectors only: the raw key the JavaScript exported.
    #[cfg(test)]
    pub(crate) fn from_raw(raw: [u8; 32]) -> Self {
        Self {
            bytes: Zeroizing::new(raw),
        }
    }

    fn cipher(&self) -> Aes256Gcm {
        Aes256Gcm::new(&(*self.bytes).into())
    }
}

/// Decodes base64 the way the browser's `atob` does ("forgiving-base64"):
/// ASCII whitespace is ignored and padding is optional.
pub fn forgiving_base64(input: &str) -> Option<Vec<u8>> {
    let cleaned: String = input.chars().filter(|c| !c.is_ascii_whitespace()).collect();
    let engine = base64::engine::GeneralPurpose::new(
        &base64::alphabet::STANDARD,
        base64::engine::GeneralPurposeConfig::new()
            .with_decode_padding_mode(base64::engine::DecodePaddingMode::Indifferent)
            .with_decode_allow_trailing_bits(true),
    );
    engine.decode(cleaned).ok()
}

/// PBKDF2-HMAC-SHA256, 100,000 iterations. Slow on purpose (~0.1 s on a
/// phone): call it off the async threads (`spawn_blocking`).
pub fn derive_key(password: &str, salt_b64: &str) -> Result<Key, CryptoError> {
    let salt = forgiving_base64(salt_b64).ok_or(CryptoError::BadSalt)?;
    let mut out = Zeroizing::new([0u8; 32]);
    pbkdf2::pbkdf2_hmac::<sha2::Sha256>(password.as_bytes(), &salt, PBKDF2_ITERATIONS, &mut *out);
    Ok(Key { bytes: out })
}

/// Encrypts one part with a fresh random IV: `[IV][ciphertext][tag]`.
pub fn encrypt_part(key: &Key, plaintext: &[u8]) -> Result<Vec<u8>, CryptoError> {
    let mut iv = [0u8; IV_LEN];
    getrandom::fill(&mut iv).map_err(|_| CryptoError::Random)?;
    encrypt_part_with_iv(key, &iv, plaintext)
}

/// The deterministic core of `encrypt_part`. Public to the crate so tests can
/// compare against fixed-IV vectors; production code always uses a random IV.
pub(crate) fn encrypt_part_with_iv(
    key: &Key,
    iv: &[u8; IV_LEN],
    plaintext: &[u8],
) -> Result<Vec<u8>, CryptoError> {
    let mut out = Vec::with_capacity(IV_LEN + plaintext.len() + TAG_LEN);
    out.extend_from_slice(iv);
    out.extend_from_slice(plaintext);
    let (_, body) = out.split_at_mut(IV_LEN);
    // AES-GCM's only failure is a plaintext over 64 GiB; parts are 19 MiB.
    let tag = key
        .cipher()
        .encrypt_inout_detached(&Nonce::from(*iv), &[], body.into())
        .map_err(|_| CryptoError::PartTooLarge)?;
    out.extend_from_slice(&tag);
    Ok(out)
}

/// Decrypts one part **in place** (no second 19 MiB buffer) and returns the
/// plaintext as a view into the same allocation. Nothing is returned unless
/// the GCM tag verifies — unauthenticated bytes never leave this function.
pub fn decrypt_part(key: &Key, part: Vec<u8>) -> Result<Bytes, CryptoError> {
    let len = part.len();
    if len < IV_LEN + TAG_LEN {
        return Err(CryptoError::Truncated(len));
    }
    let mut part = part;
    let body_end = len - TAG_LEN;
    let (head, rest) = part.split_at_mut(IV_LEN);
    let (body, tag) = rest.split_at_mut(body_end - IV_LEN);
    let iv = Nonce::try_from(&*head).map_err(|_| CryptoError::Truncated(len))?;
    let tag = Tag::try_from(&*tag).map_err(|_| CryptoError::Truncated(len))?;
    key.cipher()
        .decrypt_inout_detached(&iv, &[], body.into(), &tag)
        .map_err(|_| CryptoError::Authentication)?;
    Ok(Bytes::from(part).slice(IV_LEN..body_end))
}

/// True when `check_b64` (from `GET /api/drive/zke`) decrypts with `key` to
/// the agreed constant — i.e. the Drive password the user typed is right.
pub fn verify_drive_key(key: &Key, check_b64: &str) -> bool {
    let Some(part) = forgiving_base64(check_b64) else {
        return false;
    };
    match decrypt_part(key, part) {
        Ok(plain) => subtle::ConstantTimeEq::ct_eq(&plain[..], DRIVE_KEY_CHECK_PLAINTEXT).into(),
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::Digest;

    #[derive(serde::Deserialize)]
    struct Vectors {
        keys: Vec<KeyVec>,
        js_parts: Vec<JsPart>,
        fixed: Vec<Fixed>,
        drive_key_check: Check,
    }
    #[derive(serde::Deserialize)]
    struct KeyVec {
        password: String,
        salt_b64: String,
        key_hex: String,
    }
    #[derive(serde::Deserialize)]
    struct JsPart {
        plaintext_len: usize,
        part_b64: String,
    }
    #[derive(serde::Deserialize)]
    struct Fixed {
        plaintext_len: usize,
        iv_hex: String,
        part_sha256: String,
        part_len: usize,
    }
    #[derive(serde::Deserialize)]
    struct Check {
        key_index: usize,
        check_b64: String,
    }

    fn vectors() -> Vectors {
        serde_json::from_str(include_str!("../../compat/vectors.json")).unwrap()
    }
    fn pattern(n: usize) -> Vec<u8> {
        (0..n)
            .map(|i| u8::try_from((i * 31 + 7) % 251).unwrap())
            .collect()
    }
    fn key_of(v: &KeyVec) -> Key {
        Key::from_raw(hex::decode(&v.key_hex).unwrap().try_into().unwrap())
    }

    #[test]
    fn derives_the_same_key_as_production_javascript() {
        for v in vectors().keys {
            let key = derive_key(&v.password, &v.salt_b64).unwrap();
            assert_eq!(
                hex::encode(*key.bytes),
                v.key_hex,
                "password {:?}",
                v.password
            );
        }
    }

    #[test]
    fn decrypts_parts_production_javascript_encrypted() {
        let v = vectors();
        let key = key_of(&v.keys[0]);
        for p in v.js_parts {
            let part = forgiving_base64(&p.part_b64).unwrap();
            let plain = decrypt_part(&key, part).unwrap();
            assert_eq!(
                &plain[..],
                &pattern(p.plaintext_len)[..],
                "len {}",
                p.plaintext_len
            );
        }
    }

    #[test]
    fn fixed_iv_output_is_byte_identical_to_webcrypto() {
        let v = vectors();
        let key = key_of(&v.keys[0]);
        for f in v.fixed {
            let iv: [u8; 12] = hex::decode(&f.iv_hex).unwrap().try_into().unwrap();
            let part = encrypt_part_with_iv(&key, &iv, &pattern(f.plaintext_len)).unwrap();
            assert_eq!(part.len(), f.part_len);
            assert_eq!(hex::encode(sha2::Sha256::digest(&part)), f.part_sha256);
        }
    }

    #[test]
    fn round_trips_and_uses_a_fresh_iv_each_time() {
        let key = key_of(&vectors().keys[0]);
        let a = encrypt_part(&key, b"same plaintext").unwrap();
        let b = encrypt_part(&key, b"same plaintext").unwrap();
        assert_ne!(a[..IV_LEN], b[..IV_LEN]);
        assert_eq!(&decrypt_part(&key, a).unwrap()[..], b"same plaintext");
    }

    #[test]
    fn rejects_wrong_key_tampering_and_truncation() {
        let v = vectors();
        let right = key_of(&v.keys[0]);
        let wrong = key_of(&v.keys[1]);
        let part = encrypt_part(&right, b"secret").unwrap();
        assert_eq!(
            decrypt_part(&wrong, part.clone()).unwrap_err(),
            CryptoError::Authentication
        );
        let mut flipped = part.clone();
        flipped[IV_LEN] ^= 1;
        assert_eq!(
            decrypt_part(&right, flipped).unwrap_err(),
            CryptoError::Authentication
        );
        let mut bad_tag = part.clone();
        *bad_tag.last_mut().unwrap() ^= 1;
        assert_eq!(
            decrypt_part(&right, bad_tag).unwrap_err(),
            CryptoError::Authentication
        );
        for n in [0, 1, 27] {
            assert_eq!(
                decrypt_part(&right, part[..n].to_vec()).unwrap_err(),
                CryptoError::Truncated(n)
            );
        }
        // 28 bytes = an encrypted empty part with a damaged tag: authentication, not a panic.
        assert_eq!(
            decrypt_part(&right, vec![0u8; 28]).unwrap_err(),
            CryptoError::Authentication
        );
    }

    #[test]
    fn verifies_the_drive_key_check() {
        let v = vectors();
        let check = &v.drive_key_check;
        assert!(verify_drive_key(
            &key_of(&v.keys[check.key_index]),
            &check.check_b64
        ));
        assert!(!verify_drive_key(&key_of(&v.keys[1]), &check.check_b64));
        assert!(!verify_drive_key(&key_of(&v.keys[0]), "not base64 at all!"));
        let other = encrypt_part(&key_of(&v.keys[0]), b"something else").unwrap();
        let b64 = base64::engine::general_purpose::STANDARD.encode(other);
        assert!(!verify_drive_key(&key_of(&v.keys[0]), &b64));
    }

    #[test]
    fn salt_decoding_matches_atob() {
        assert_eq!(forgiving_base64("c2FsdA=="), Some(b"salt".to_vec()));
        assert_eq!(forgiving_base64("c2FsdA"), Some(b"salt".to_vec()));
        assert_eq!(forgiving_base64(" c2Fs\ndA== "), Some(b"salt".to_vec()));
        assert_eq!(forgiving_base64("c2F*dA=="), None);
        // atob ignores non-zero bits after the last whole byte; so must we.
        assert_eq!(forgiving_base64("c2FsdB=="), Some(b"salt".to_vec()));
        assert!(matches!(derive_key("p", "%%%"), Err(CryptoError::BadSalt)));
    }

    #[test]
    fn vectors_were_made_from_the_current_javascript() {
        // The JS→Rust half is a snapshot: if either file changes, regenerate
        // compat/vectors.json (node compat/gen-vectors.mjs).
        let made_from: serde_json::Value =
            serde_json::from_str(include_str!("../../compat/vectors.json")).unwrap();
        for (source, field) in [
            (
                include_str!("../../../../drive/src/crypto.js"),
                "sha256_of_source",
            ),
            (
                include_str!("../../../../drive/src/zke-unlock.js"),
                "sha256_of_key_check_source",
            ),
        ] {
            assert_eq!(
                hex::encode(sha2::Sha256::digest(source.as_bytes())),
                made_from[field].as_str().unwrap(),
                "{field}"
            );
        }
    }

    #[test]
    fn debug_output_never_shows_key_bytes() {
        let key = key_of(&vectors().keys[0]);
        assert_eq!(format!("{key:?}"), "Key([redacted])");
    }
}
