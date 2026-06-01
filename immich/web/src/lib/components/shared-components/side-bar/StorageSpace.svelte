<script lang="ts">
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { locale } from '$lib/stores/preferences.store';
  import { userInteraction } from '$lib/stores/user.svelte';
  import { requestServerInfo } from '$lib/utils/auth';
  import { getByteUnitString } from '$lib/utils/byte-units';
  import { LoadingSpinner, Meter } from '@immich/ui';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  let hasQuota = $derived(authManager.user.quotaSizeInBytes !== null);
  let availableBytes = $derived(
    (hasQuota && authManager.authenticated
      ? authManager.user.quotaSizeInBytes
      : userInteraction.serverInfo?.diskSizeRaw) || 0,
  );
  let usedBytes = $derived(
    (hasQuota && authManager.authenticated
      ? authManager.user.quotaUsageInBytes
      : userInteraction.serverInfo?.diskUseRaw) || 0,
  );
  // Any diskSizeRaw above 1 PB is treated as unlimited — show ∞ instead of
  // an auto-formatted giant number that looks like a specific limit.
  const ONE_PB = 1e15;
  let isUnlimited = $derived(availableBytes > ONE_PB);
  let availableLabel = $derived(isUnlimited ? '∞' : getByteUnitString(availableBytes, $locale));
  // For the meter ratio, avoid divide-by-zero and cap at ~1 PB effective capacity
  let meterTotal = $derived(isUnlimited ? Math.max(usedBytes * 10, ONE_PB) : availableBytes);

  const thresholds = [
    { from: 0.8, className: 'bg-warning' },
    { from: 0.95, className: 'bg-danger' },
  ];

  onMount(async () => {
    if (userInteraction.serverInfo && authManager.authenticated) {
      return;
    }
    await requestServerInfo();
  });
</script>

<div
  class="p-4 bg-light-100 ms-4 rounded-lg text-sm min-w-52"
  title={$t('storage_usage', {
    values: {
      used: getByteUnitString(usedBytes, $locale, 3),
      available: availableLabel,
    },
  })}
>
  {#if userInteraction.serverInfo}
    <Meter
      size="tiny"
      class="bg-light-200"
      containerClass="gap-2 leading-6"
      label={$t('storage')}
      valueLabel={$t('storage_usage', {
        values: {
          used: getByteUnitString(usedBytes, $locale),
          available: availableLabel,
        },
      })}
      value={usedBytes / meterTotal}
      {thresholds}
    />
  {:else}
    <p class="font-medium text-immich-dark-gray dark:text-white mb-4">{$t('storage')}</p>
    <LoadingSpinner />
  {/if}
</div>
