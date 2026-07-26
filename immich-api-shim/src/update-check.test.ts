import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isNewerVersion, getUpdateStatus } from './update-check';

describe('isNewerVersion', () => {
  it('detects a newer version across each component', () => {
    expect(isNewerVersion('1.0.1', '1.0.0')).toBe(true);
    expect(isNewerVersion('1.1.0', '1.0.9')).toBe(true);
    expect(isNewerVersion('2.0.0', '1.99.99')).toBe(true);
  });

  it('does not nag when the install is current or ahead', () => {
    expect(isNewerVersion('1.0.0', '1.0.0')).toBe(false);
    expect(isNewerVersion('1.0.0', '1.0.1')).toBe(false);
    expect(isNewerVersion('1.0.0', '2.0.0')).toBe(false);
  });

  it('tolerates a v prefix and partial versions', () => {
    expect(isNewerVersion('v1.2.0', '1.1.0')).toBe(true);
    expect(isNewerVersion('v1.2', '1.1')).toBe(true);
    expect(isNewerVersion('2', '1.9.9')).toBe(true);
  });

  it('compares numerically, not lexically', () => {
    // The classic bug: "1.10.0" sorts before "1.9.0" as a string.
    expect(isNewerVersion('1.10.0', '1.9.0')).toBe(true);
    expect(isNewerVersion('1.9.0', '1.10.0')).toBe(false);
  });

  it('never reports an update for junk input', () => {
    expect(isNewerVersion('nightly', '1.0.0')).toBe(false);
    expect(isNewerVersion('', '1.0.0')).toBe(false);
    expect(isNewerVersion('1.0.0', 'unknown')).toBe(false);
  });
});

function makeEnv(store: Record<string, string> = {}, extra: Record<string, any> = {}) {
  return {
    BUILD_VERSION: '1.0.0',
    UPDATE_REPO: 'example/repo',
    DB: {
      prepare: (sql: string) => ({
        bind: (...args: any[]) => ({
          first: async () => (/SELECT value FROM config/i.test(sql) && store[args[0]] ? { value: store[args[0]] } : null),
          run: async () => {
            if (/INSERT OR REPLACE INTO config/i.test(sql)) store[args[0]] = args[1];
            return {};
          },
        }),
      }),
    },
    ...extra,
  } as any;
}

describe('getUpdateStatus', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('reports an available update and caches the answer', async () => {
    const store: Record<string, string> = {};
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ tag_name: 'v1.4.0', html_url: 'https://example.com/releases/v1.4.0' }),
      { status: 200 },
    ));
    vi.stubGlobal('fetch', fetchMock);

    const status = await getUpdateStatus(makeEnv(store));
    expect(status.updateAvailable).toBe(true);
    expect(status.latestVersion).toBe('v1.4.0');
    expect(status.currentVersion).toBe('1.0.0');
    expect(store.updateCheck).toBeTruthy();

    // Second call inside the TTL must be served from cache — a self-hosted
    // server should not spend GitHub's anonymous rate limit on every page view.
    await getUpdateStatus(makeEnv(store));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('says "up to date" when the latest release matches the build', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ tag_name: 'v1.0.0' }), { status: 200 })));
    const status = await getUpdateStatus(makeEnv());
    expect(status.updateAvailable).toBe(false);
  });

  it('degrades quietly when GitHub is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    const status = await getUpdateStatus(makeEnv());
    expect(status.updateAvailable).toBe(false);
    expect(status.currentVersion).toBe('1.0.0'); // still reports what is running
    expect(status.error).toMatch(/network down/);
  });

  it('handles a project with no releases yet (404) without claiming an update', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
    const status = await getUpdateStatus(makeEnv());
    expect(status.updateAvailable).toBe(false);
    expect(status.error).toMatch(/404/);
  });

  it('sends no identifying information about the install', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ tag_name: 'v1.0.0' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await getUpdateStatus(makeEnv({}, { SESSION_SECRET: 'super-secret-value-none-of-their-business' }));

    const [url, init] = fetchMock.mock.calls[0] as any;
    expect(String(url)).toBe('https://api.github.com/repos/example/repo/releases/latest');
    const serialized = JSON.stringify(init || {});
    expect(serialized).not.toMatch(/super-secret-value/);
    expect(init?.method ?? 'GET').toBe('GET'); // a GET carries no body
  });
});
