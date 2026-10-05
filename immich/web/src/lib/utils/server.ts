import { defaults } from '@immich/sdk';
import { memoize } from 'lodash-es';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
import { serverConfigManager } from '$lib/managers/server-config-manager.svelte';
import { initLanguage } from '$lib/utils';

type Fetch = typeof fetch;

async function _init(fetch: Fetch) {
  // set event.fetch on the fetch-client used by @immich/sdk
  // https://kit.svelte.dev/docs/load#making-fetch-requests
  // https://github.com/oazapfts/oazapfts/blob/main/README.md#fetch-options
  defaults.fetch = fetch;
  await initLanguage();

  // Feature flags depend on neither the server config nor the user, so fetch
  // them alongside those instead of after them (one less serial round trip).
  // Errors are held until the config says whether they matter.
  const featureFlags = featureFlagsManager.init().then(
    () => undefined,
    (error: unknown) => ({ error }),
  );

  await serverConfigManager.init();
  await authManager.load();

  const featureFlagsFailure = await featureFlags;
  if (featureFlagsFailure && !serverConfigManager.value.maintenanceMode) {
    throw featureFlagsFailure.error;
  }
}

export const init = memoize(_init, () => 'singlevalue');

// `init` ran once, before login, against the shared entry point. After a login
// the user's own worker is the one to ask — forget the memoized run so the next
// root load re-initialises against it (and, if that worker can't be reached yet,
// shows "your private cloud is still being created" instead of a stuck spinner).
export const resetInit = () => {
  init.cache.clear?.();
};
