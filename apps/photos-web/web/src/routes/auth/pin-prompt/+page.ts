import { safeContinue } from '$lib/utils/safe-continue';
import { getAuthStatus } from '@immich/sdk';
import { Route } from '$lib/route';
import { authenticate } from '$lib/utils/auth';
import { getFormatter } from '$lib/utils/i18n';
import type { PageLoad } from './$types';

export const load = (async ({ url }) => {
  await authenticate(url);

  const { pinCode } = await getAuthStatus();

  const $t = await getFormatter();

  return {
    meta: {
      title: $t('pin_verification'),
    },
    hasPinCode: !!pinCode,
    continueUrl: safeContinue(url.searchParams.get('continue'), Route.locked()),
  };
}) satisfies PageLoad;
