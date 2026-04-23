import { redirect } from '@sveltejs/kit';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { Route } from '$lib/route';
import { getFormatter } from '$lib/utils/i18n';
import type { PageLoad } from './$types';

export const ssr = false;
export const csr = true;

export const load = (async () => {
  try {
    await authManager.load();

    if (authManager.authenticated) {
      redirect(307, Route.photos());
    }

    // Not authenticated — send to login
    redirect(307, Route.login());
  } catch (redirectError: any) {
    if (redirectError?.status === 307) {
      throw redirectError;
    }
  }

  const $t = await getFormatter();

  return {
    meta: {
      title: $t('welcome') + ' 🎉',
      description: 'DaemonClient Photos — Your Secure Cloud Photos',
    },
  };
}) satisfies PageLoad;
