import { ServiceWorkerMessenger } from './sw-messenger';

const hasServiceWorker = globalThis.isSecureContext && 'serviceWorker' in navigator;
const messenger = hasServiceWorker ? new ServiceWorkerMessenger(navigator.serviceWorker) : undefined;

export function cancelImageUrl(url: string | undefined | null) {
  if (!url || !messenger) {
    return;
  }
  messenger.send('cancel', { url });
}

// The asset the viewer shows. The service worker loads it before anything else
// (SPEC §4.9, D17) and can't tell it from a neighbour preload by URL alone.
let viewingAssetId: string | null = null;

export function setViewingAsset(assetId: string) {
  if (!messenger || assetId === viewingAssetId) {
    return;
  }
  viewingAssetId = assetId;
  messenger.send('viewing', { assetId });
}

/** The viewer that showed `assetId` closed; a no-op if another viewer has since taken over. */
export function clearViewingAsset(assetId: string) {
  if (!messenger || assetId !== viewingAssetId) {
    return;
  }
  viewingAssetId = null;
  messenger.send('viewing', { assetId: null });
}
