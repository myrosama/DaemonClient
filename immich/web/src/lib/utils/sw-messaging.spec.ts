import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadWithServiceWorker() {
  const postMessage = vi.fn();
  vi.stubGlobal('isSecureContext', true);
  vi.stubGlobal('navigator', { ...navigator, serviceWorker: { controller: { postMessage } } });
  vi.resetModules();
  const module = await import('./sw-messaging');
  return { ...module, postMessage };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('viewing hint', () => {
  it('tells the service worker which asset the viewer shows, once per change', async () => {
    const { setViewingAsset, clearViewingAsset, postMessage } = await loadWithServiceWorker();
    setViewingAsset('a');
    setViewingAsset('a');
    setViewingAsset('b');
    clearViewingAsset('a'); // a viewer that no longer owns the hint can't clear it
    clearViewingAsset('b');
    expect(postMessage.mock.calls.map(([message]) => message)).toEqual([
      { type: 'viewing', assetId: 'a' },
      { type: 'viewing', assetId: 'b' },
      { type: 'viewing', assetId: null },
    ]);
  });
});
