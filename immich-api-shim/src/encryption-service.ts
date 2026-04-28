const IV_LENGTH = 12;

export class EncryptionService {
  private masterKey: CryptoKey | null = null;

  async initialize(masterKeyString: string): Promise<void> {
    this.masterKey = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(masterKeyString),
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  async encryptToken(token: string): Promise<string> {
    if (!this.masterKey) {
      throw new Error('Encryption service not initialized');
    }

    const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      this.masterKey,
      new TextEncoder().encode(token)
    );

    // Combine IV + encrypted data
    const combined = new Uint8Array(iv.length + encrypted.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(encrypted), iv.length);

    // Return as base64
    return btoa(String.fromCharCode(...combined));
  }

  async decryptToken(encryptedToken: string): Promise<string> {
    if (!this.masterKey) {
      throw new Error('Encryption service not initialized');
    }

    // Decode from base64
    const combined = Uint8Array.from(atob(encryptedToken), c => c.charCodeAt(0));

    // Extract IV and encrypted data
    const iv = combined.slice(0, IV_LENGTH);
    const encrypted = combined.slice(IV_LENGTH);

    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      this.masterKey,
      encrypted
    );

    return new TextDecoder().decode(decrypted);
  }
}

// Singleton instance
let encryptionServiceInstance: EncryptionService | null = null;

export function getEncryptionService(masterKey?: string): EncryptionService {
  if (!encryptionServiceInstance) {
    encryptionServiceInstance = new EncryptionService();
    if (masterKey) {
      encryptionServiceInstance.initialize(masterKey);
    }
  }
  return encryptionServiceInstance;
}
