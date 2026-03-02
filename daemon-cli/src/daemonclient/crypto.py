# daemonclient/crypto.py
"""
ZKE (Zero-Knowledge Encryption) module.

Byte-compatible with the web app's crypto.js:
  - AES-256-GCM
  - PBKDF2 key derivation (SHA-256, 100 000 iterations)
  - Chunk format: [IV 12 bytes][ciphertext + GCM tag]
"""

import base64
import os

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.hazmat.primitives import hashes

# Must match crypto.js constants exactly
SALT_LENGTH = 16       # 128 bits
IV_LENGTH = 12         # 96 bits (recommended for GCM)
KEY_LENGTH_BYTES = 32  # 256 bits
PBKDF2_ITERATIONS = 100_000


def derive_key(password: str, salt: bytes) -> bytes:
    """Derive a 256-bit AES key from a password and salt (PBKDF2-SHA256).

    Produces the same raw key bytes as the JS ``deriveKey()`` function.
    """
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=KEY_LENGTH_BYTES,
        salt=salt,
        iterations=PBKDF2_ITERATIONS,
    )
    return kdf.derive(password.encode("utf-8"))


def encrypt_chunk(plaintext: bytes, key: bytes) -> bytes:
    """Encrypt a chunk with AES-256-GCM.

    Returns ``iv || ciphertext_with_tag`` — identical layout to the JS
    ``encryptChunk()`` function.
    """
    iv = os.urandom(IV_LENGTH)
    aesgcm = AESGCM(key)
    ct = aesgcm.encrypt(iv, plaintext, None)  # ct includes GCM tag
    return iv + ct


def decrypt_chunk(data: bytes, key: bytes) -> bytes:
    """Decrypt a chunk produced by ``encrypt_chunk`` (or the JS equivalent).

    Expects ``iv || ciphertext_with_tag``.
    """
    iv = data[:IV_LENGTH]
    ct = data[IV_LENGTH:]
    aesgcm = AESGCM(key)
    return aesgcm.decrypt(iv, ct, None)


# --- base64 helpers (match JS bytesToBase64 / base64ToBytes) ---

def bytes_to_base64(b: bytes) -> str:
    return base64.b64encode(b).decode("ascii")


def base64_to_bytes(s: str) -> bytes:
    return base64.b64decode(s)
