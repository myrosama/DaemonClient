import { cancelImageUrl } from '$lib/utils/sw-messaging';

export function loadImage(src: string, onLoad: () => void, onError: () => void, onStart?: () => void) {
  let destroyed = false;
  // Cancel only a load still in flight: a hint for a finished one would release
  // some other component's identical request instead.
  let settled = false;

  const handleLoad = () => {
    settled = true;
    if (!destroyed) onLoad();
  };
  const handleError = () => {
    settled = true;
    if (!destroyed) onError();
  };

  const img = document.createElement('img');
  img.addEventListener('load', handleLoad);
  img.addEventListener('error', handleError);

  onStart?.();
  img.src = src;

  return () => {
    destroyed = true;
    img.removeEventListener('load', handleLoad);
    img.removeEventListener('error', handleError);
    if (!settled) cancelImageUrl(src);
    img.remove();
  };
}

export type LoadImageFunction = typeof loadImage;
