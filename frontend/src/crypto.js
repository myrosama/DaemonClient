/**
 * ZKE (Zero-Knowledge Encryption) Module
 * 
 * Implements AES-256-GCM encryption with PBKDF2 key derivation.
 * All encryption/decryption happens client-side only.
 */

// Constants
const SALT_LENGTH = 16; // 128 bits
const IV_LENGTH = 12;   // 96 bits (recommended for GCM)
const KEY_LENGTH = 256; // bits
const PBKDF2_ITERATIONS = 100000;

/**
 * Generate a cryptographically secure random salt
 * @returns {Uint8Array} 16-byte salt
 */
export function generateSalt() {
    return crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
}

/**
 * Generate a cryptographically secure random IV
 * @returns {Uint8Array} 12-byte IV
 */
export function generateIV() {
    return crypto.getRandomValues(new Uint8Array(IV_LENGTH));
}

/**
 * Derive an AES-256 key from a password using PBKDF2
 * @param {string} password - User's password
 * @param {Uint8Array} salt - Salt for key derivation
 * @returns {Promise<CryptoKey>} Derived AES-GCM key
 */
export async function deriveKey(password, salt) {
    // Import password as raw key material
    const keyMaterial = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(password),
        'PBKDF2',
        false,
        ['deriveBits', 'deriveKey']
    );

    // Derive AES-256-GCM key
    return crypto.subtle.deriveKey(
        {
            name: 'PBKDF2',
            salt: salt,
            iterations: PBKDF2_ITERATIONS,
            hash: 'SHA-256'
        },
        keyMaterial,
        { name: 'AES-GCM', length: KEY_LENGTH },
        false, // not extractable
        ['encrypt', 'decrypt']
    );
}

/**
 * Encrypt data using AES-256-GCM
 * @param {ArrayBuffer} data - Data to encrypt
 * @param {CryptoKey} key - AES-GCM key
 * @returns {Promise<{encrypted: ArrayBuffer, iv: Uint8Array}>}
 */
export async function encryptData(data, key) {
    const iv = generateIV();

    const encrypted = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: iv },
        key,
        data
    );

    return { encrypted, iv };
}

/**
 * Decrypt data using AES-256-GCM
 * @param {ArrayBuffer} encryptedData - Data to decrypt
 * @param {CryptoKey} key - AES-GCM key
 * @param {Uint8Array} iv - Initialization vector used during encryption
 * @returns {Promise<ArrayBuffer>} Decrypted data
 */
export async function decryptData(encryptedData, key, iv) {
    return crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: iv },
        key,
        encryptedData
    );
}

/**
 * Encrypt a file chunk (convenience wrapper)
 * Prepends IV to encrypted data for storage
 * Format: [IV (12 bytes)][Encrypted Data]
 * 
 * @param {ArrayBuffer} chunk - Raw chunk data
 * @param {CryptoKey} key - AES-GCM key
 * @returns {Promise<ArrayBuffer>} IV + encrypted data combined
 */
export async function encryptChunk(chunk, key) {
    const { encrypted, iv } = await encryptData(chunk, key);

    // Combine IV + encrypted data into single buffer
    const combined = new Uint8Array(iv.length + encrypted.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(encrypted), iv.length);

    return combined.buffer;
}

/**
 * Decrypt a file chunk (convenience wrapper)
 * Extracts IV from prepended position
 * 
 * @param {ArrayBuffer} encryptedChunk - IV + encrypted data
 * @param {CryptoKey} key - AES-GCM key
 * @returns {Promise<ArrayBuffer>} Decrypted chunk data
 */
export async function decryptChunk(encryptedChunk, key) {
    const data = new Uint8Array(encryptedChunk);

    // Extract IV (first 12 bytes)
    const iv = data.slice(0, IV_LENGTH);

    // Extract encrypted data (rest)
    const encrypted = data.slice(IV_LENGTH);

    return decryptData(encrypted.buffer, key, iv);
}

/**
 * Convert Uint8Array to base64 string (for storage in Firestore)
 * @param {Uint8Array} bytes 
 * @returns {string}
 */
export function bytesToBase64(bytes) {
    return btoa(String.fromCharCode(...bytes));
}

/**
 * Convert base64 string to Uint8Array
 * @param {string} base64 
 * @returns {Uint8Array}
 */
export function base64ToBytes(base64) {
    return Uint8Array.from(atob(base64), c => c.charCodeAt(0));
}

/**
 * Generate a cryptographically secure random password
 * @param {number} length - Password length (default 32)
 * @returns {string} Random password string
 */
export function generatePassword(length = 32) {
    const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*';
    const values = crypto.getRandomValues(new Uint8Array(length));
    return Array.from(values, v => charset[v % charset.length]).join('');
}
