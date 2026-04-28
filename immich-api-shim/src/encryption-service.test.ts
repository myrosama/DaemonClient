import { describe, it, expect, beforeAll } from 'vitest';
import { EncryptionService } from './encryption-service';

describe('EncryptionService', () => {
  let service: EncryptionService;

  beforeAll(async () => {
    service = new EncryptionService();
    // Create a 32-byte test key (AES-256 requires 32 bytes)
    const testKey = 'test-master-key-32byte-pad-12345';
    await service.initialize(testKey);
  });

  it('should encrypt and decrypt token', async () => {
    const token = 'cf_api_token_123456789';

    const encrypted = await service.encryptToken(token);
    expect(encrypted).not.toBe(token);
    expect(encrypted.length).toBeGreaterThan(0);

    const decrypted = await service.decryptToken(encrypted);
    expect(decrypted).toBe(token);
  });

  it('should produce different ciphertext for same plaintext', async () => {
    const token = 'same_token';

    const encrypted1 = await service.encryptToken(token);
    const encrypted2 = await service.encryptToken(token);

    expect(encrypted1).not.toBe(encrypted2);

    const decrypted1 = await service.decryptToken(encrypted1);
    const decrypted2 = await service.decryptToken(encrypted2);

    expect(decrypted1).toBe(token);
    expect(decrypted2).toBe(token);
  });

  it('should throw error if not initialized', async () => {
    const uninitializedService = new EncryptionService();

    await expect(
      uninitializedService.encryptToken('test')
    ).rejects.toThrow('not initialized');
  });
});
