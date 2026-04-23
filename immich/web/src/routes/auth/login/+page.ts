import { redirect } from '@sveltejs/kit';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { Route } from '$lib/route';
import { getFormatter } from '$lib/utils/i18n';
import type { PageLoad } from './$types';

export const load = (async ({ url }) => {
  const continueUrl = url.searchParams.get('continue') || Route.photos();

  // If already authenticated via Firebase, go straight to photos
  if (authManager.authenticated) {
    redirect(307, continueUrl);
  }

  const $t = await getFormatter();
  return {
    meta: {
      title: $t('login'),
    },
    continueUrl,
  };
}) satisfies PageLoad;
