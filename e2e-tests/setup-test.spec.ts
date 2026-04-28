import { describe, it, expect } from 'vitest';

describe('Per-User Worker Setup E2E', () => {
  it('should validate Cloudflare API token', async () => {
    const testToken = process.env.TEST_CF_TOKEN;
    
    if (!testToken) {
      console.warn('Skipping test: TEST_CF_TOKEN not set');
      return;
    }

    const response = await fetch('http://localhost:8787/validate-cf-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: testToken })
    });

    const data = await response.json();
    expect(data.valid).toBe(true);
    expect(data.accountId).toBeDefined();
  });

  it.skip('should deploy worker to user account', async () => {
    // Full deployment test - requires actual CF account
    // Skip in CI, run manually with real credentials
  });
});
