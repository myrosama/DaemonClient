import { getServerFeatures, type ServerFeaturesDto } from '@immich/sdk';
import { eventManager } from '$lib/managers/event-manager.svelte';

class FeatureFlagsManager {
  #value?: ServerFeaturesDto = $state();

  constructor() {
    eventManager.on({
      SystemConfigUpdate: () => void this.#loadFeatureFlags(),
    });
  }

  async init() {
    await this.#loadFeatureFlags();
  }

  get value() {
    if (!this.#value) {
      throw new Error('Feature flags manager must be initialized first');
    }

    return this.#value;
  }

  async #loadFeatureFlags() {
    const features = await getServerFeatures();
    // The DaemonClient API advertises map and smartSearch (the mobile app reads
    // these flags), but the web app has no map style and smart search is a stub
    // that always returns nothing. Turn both off here so their menu entries and
    // buttons stay hidden instead of leading to dead pages.
    this.#value = { ...features, map: false, smartSearch: false };
  }
}

export const featureFlagsManager = new FeatureFlagsManager();
