<script lang="ts">
  import { goto } from '$app/navigation';
  import AuthPageLayout from '$lib/components/layouts/AuthPageLayout.svelte';
  import { eventManager } from '$lib/managers/event-manager.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { serverConfigManager } from '$lib/managers/server-config-manager.svelte';
  import { Route } from '$lib/route';
  import { oauth } from '$lib/utils';
  import { getServerErrorMessage, handleError } from '$lib/utils/handle-error';
  import { login, type LoginResponseDto } from '@immich/sdk';
  import { Alert, Button, Field, Input, PasswordInput, Stack } from '@immich/ui';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import type { PageData } from './$types';

  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();

  let errorMessage: string = $state('');
  let email = $state('');
  let password = $state('');
  let oauthError = $state('');
  let loading = $state(false);
  let oauthLoading = $state(true);

  const serverConfig = $derived(serverConfigManager.value);

  const onSuccess = async (user: LoginResponseDto) => {
    await goto(data.continueUrl, { invalidateAll: true });
    eventManager.emit('AuthLogin', user);
  };

  const onFirstLogin = () => goto(Route.changePassword());
  const onOnboarding = () => goto(Route.onboarding());

  onMount(async () => {
    if (!featureFlagsManager.value.oauth) {
      oauthLoading = false;
      return;
    }

    if (oauth.isCallback(globalThis.location)) {
      try {
        const user = await oauth.login(globalThis.location);

        if (!user.isOnboarded) {
          await onOnboarding();
          return;
        }

        await onSuccess(user);
        return;
      } catch (error) {
        console.error('Error [login-form] [oauth.callback]', error);
        oauthError = getServerErrorMessage(error) || $t('errors.unable_to_complete_oauth_login');
        oauthLoading = false;
        return;
      }
    }

    try {
      if (
        (featureFlagsManager.value.oauthAutoLaunch && !oauth.isAutoLaunchDisabled(globalThis.location)) ||
        oauth.isAutoLaunchEnabled(globalThis.location)
      ) {
        await goto(Route.login({ autoLaunch: 0 }), { replaceState: true });
        await oauth.authorize(globalThis.location);
        return;
      }
    } catch (error) {
      handleError(error, $t('errors.unable_to_connect'));
    }

    oauthLoading = false;
  });

  const handleLogin = async () => {
    try {
      errorMessage = '';
      loading = true;
      const user = await login({ loginCredentialDto: { email, password } });

      if (user.accessToken) {
        const maxAge = 7 * 24 * 60 * 60;
        document.cookie = `immich_access_token=${user.accessToken}; Path=/; SameSite=Lax; Secure; Max-Age=${maxAge}`;
        document.cookie = `immich_is_authenticated=true; Path=/; SameSite=Lax; Secure; Max-Age=${maxAge}`;
        navigator.serviceWorker?.controller?.postMessage({ type: 'SET_TOKEN', token: user.accessToken });
        if ((user as any).workerUrl) {
          navigator.serviceWorker?.controller?.postMessage({ type: 'SET_WORKER_URL', workerUrl: (user as any).workerUrl });
        }
      }

      if (user.isAdmin && !serverConfig.isOnboarded) {
        await onOnboarding();
        return;
      }

      // change the user password before we onboard them
      if (!user.isAdmin && user.shouldChangePassword) {
        await onFirstLogin();
        return;
      }

      // We want to onboard after the first login since their password will change
      // and handleLogin will be called again (relogin). We then do onboarding on that next call.
      if (!user.isOnboarded) {
        await onOnboarding();
        return;
      }

      await onSuccess(user);
      return;
    } catch (error) {
      errorMessage = getServerErrorMessage(error) || $t('errors.incorrect_email_or_password');
      loading = false;
      return;
    }
  };

  const handleOAuthLogin = async () => {
    oauthLoading = true;
    oauthError = '';
    const success = await oauth.authorize(globalThis.location);
    if (!success) {
      oauthLoading = false;
      oauthError = $t('errors.unable_to_login_with_oauth');
    }
  };

  const onsubmit = async (event: Event) => {
    event.preventDefault();
    await handleLogin();
  };
</script>

<AuthPageLayout title={data.meta.title}>
  <Stack gap={3}>
    {#if serverConfig.loginPageMessage}
      <Alert color="primary" class="mb-2">
        <!-- eslint-disable-next-line svelte/no-at-html-tags -->
        {@html serverConfig.loginPageMessage}
      </Alert>
    {/if}

    {#if !oauthLoading && featureFlagsManager.value.passwordLogin}
      <form {onsubmit} class="flex flex-col gap-3">
        {#if errorMessage}
          <Alert color="danger" title={errorMessage} closable />
        {/if}

        <Field label={$t('email')}>
          <Input id="email" name="email" type="email" autocomplete="email" bind:value={email} />
        </Field>

        <Field label={$t('password')}>
          <PasswordInput id="password" bind:value={password} autocomplete="current-password" />
        </Field>

        <Button type="submit" size="medium" shape="round" fullWidth {loading} class="mt-4">{$t('to_login')}</Button>
      </form>
    {/if}

    {#if featureFlagsManager.value.oauth}
      {#if featureFlagsManager.value.passwordLogin}
        <div class="inline-flex w-full items-center justify-center my-2">
          <hr class="my-2 h-px w-3/4 border-0 bg-gray-200 dark:bg-gray-600" />
          <span
            class="absolute start-1/2 -translate-x-1/2 bg-gray-50 px-3 font-medium text-gray-900 dark:bg-neutral-900 dark:text-white uppercase"
          >
            {$t('or')}
          </span>
        </div>
      {/if}
      {#if oauthError}
        <Alert color="danger" title={oauthError} closable />
      {/if}
      <Button
        shape="round"
        loading={loading || oauthLoading}
        disabled={loading || oauthLoading}
        size="medium"
        fullWidth
        color={featureFlagsManager.value.passwordLogin ? 'secondary' : 'primary'}
        onclick={handleOAuthLogin}
      >
        {serverConfig.oauthButtonText}
      </Button>
    {/if}

    {#if !featureFlagsManager.value.passwordLogin && !featureFlagsManager.value.oauth}
      <Alert color="warning" title={$t('login_has_been_disabled')} />
    {/if}

    <div class="inline-flex w-full items-center justify-center">
      <hr class="my-2 h-px w-3/4 border-0 bg-gray-200 dark:bg-gray-600" />
    </div>
    
    <div class="flex flex-col items-center justify-center gap-1">
      <span class="text-xs text-gray-500 dark:text-gray-400">Don't have an account?</span>
      <a href="https://app.daemonclient.uz" target="_blank" class="w-full">
        <Button shape="round" size="medium" fullWidth color="secondary" class="border-2 border-immich-primary text-immich-primary hover:bg-immich-primary/10">
          Create Account
        </Button>
      </a>
    </div>
  </Stack>
</AuthPageLayout>
