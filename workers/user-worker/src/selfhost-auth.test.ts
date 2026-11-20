import { describe, it, expect } from 'vitest';
import { isSelfHost, sessionScope } from './selfhost-auth';

// A self-hosted install runs the same stack as the managed service — its own
// Cloudflare Worker + D1, its own Telegram bot, its own Firebase project — so
// the only thing that differs per install is the session-signing secret.

describe('isSelfHost', () => {
  it('treats SELF_HOST=1 as self-hosted and anything else as managed', () => {
    expect(isSelfHost({ SELF_HOST: '1' } as any)).toBe(true);
    expect(isSelfHost({ SELF_HOST: 'true' } as any)).toBe(true);
    expect(isSelfHost({ SELF_HOST: '0' } as any)).toBe(false);
    expect(isSelfHost({} as any)).toBe(false);
  });
});

describe('sessionScope', () => {
  it('uses the per-install secret when one is set', () => {
    const secret = 'a-32-plus-character-install-secret-value';
    expect(sessionScope({ SESSION_SECRET: secret, APP_IDENTIFIER: 'default-daemon-client' } as any)).toBe(secret);
  });

  it('refuses to sign a self-hosted session without a secret', () => {
    // Falling back to the public APP_IDENTIFIER here would make every
    // self-hosted session forgeable by anyone who has read this repository.
    expect(() => sessionScope({ SELF_HOST: '1', APP_IDENTIFIER: 'default' } as any)).toThrow(/SESSION_SECRET/);
    expect(() => sessionScope({ SELF_HOST: '1', SESSION_SECRET: 'short' } as any)).toThrow(/SESSION_SECRET/);
  });

  it('still serves managed workers that have not been redeployed with a secret yet', () => {
    // Removing this fallback before the fleet rolls over would log everyone out.
    expect(sessionScope({ APP_IDENTIFIER: 'default-daemon-client' } as any)).toBe('default-daemon-client');
  });
});
