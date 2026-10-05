import { commandPaletteManager } from '@immich/ui';
import { init } from '$lib/utils/server';
import { ensureServiceWorkerReady } from '$lib/utils/sw-register';
import type { LayoutLoad } from './$types';

export const ssr = false;
export const csr = true;

export const load = (async ({ fetch }) => {
  let error;
  try {
    await ensureServiceWorkerReady();
    await init(fetch);
  } catch (initError) {
    error = initError;
  }

  commandPaletteManager.enable();

  return {
    error,
    meta: {
      title: 'Immich',
    },
  };
}) satisfies LayoutLoad;
