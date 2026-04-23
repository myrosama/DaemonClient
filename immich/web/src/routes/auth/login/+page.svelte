<script lang="ts">
  import { goto } from '$app/navigation';
  import { Route } from '$lib/route';
  import { auth } from '$lib/utils/daemon-firebase';
  import { signInWithEmailAndPassword, createUserWithEmailAndPassword } from 'firebase/auth';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import type { PageData } from './$types';

  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();

  let isLoginView = $state(true);
  let email = $state('');
  let password = $state('');
  let error = $state('');
  let isLoading = $state(false);
  let isExplanationVisible = $state(false);
  let isTermsModalOpen = $state(false);
  let hasAgreedToTerms = $state(false);

  const handleAuthAction = async (e: Event) => {
    e.preventDefault();

    if (!isLoginView && !hasAgreedToTerms) {
      error = "You must agree to the Terms of Use to create an account.";
      return;
    }
    if (!email || !password) {
      error = "Please enter email and password.";
      return;
    }

    isLoading = true;
    error = '';

    try {
      if (isLoginView) {
        await signInWithEmailAndPassword(auth, email, password);
      } else {
        await createUserWithEmailAndPassword(auth, email, password);
      }

      await authManager.load();

      if (!authManager.telegramConfigExists) {
        const driveUrl = globalThis.location.hostname === 'localhost'
          ? 'http://localhost:5173'
          : 'https://app.daemonclient.uz';
        globalThis.location.href = driveUrl;
        return;
      }

      await goto(data.continueUrl || Route.photos(), { invalidateAll: true });
    } catch (err: any) {
      const code = err?.code || '';
      error = code.includes('auth/') ? "Invalid credentials or account state." : "An unexpected error occurred.";
    } finally {
      isLoading = false;
    }
  };
</script>

<svelte:head>
  <title>DaemonClient Photos</title>
</svelte:head>

<!-- This uses the EXACT tailwind classes and HTML structure from DaemonClient App.jsx -->
<div class="flex flex-col items-center justify-center w-full min-h-screen p-4 py-8 font-sans text-white bg-[#111827]">
    <div class="w-full max-w-md">
        <div class="text-center mb-8">
            <div class="flex items-center justify-center mb-2">
                <img src="/daemonclient-logo.png" alt="DaemonClient Logo" class="h-16 w-auto" />
            </div>
            <h1 class="text-4xl font-bold text-white">DaemonClient</h1>
            <p class="text-indigo-300 mt-2">Your Secure Cloud Storage</p>
        </div>
        <div class="bg-gray-800 shadow-2xl rounded-xl p-8">
            <div class="flex border-b border-gray-700 mb-6">
                <button
                    onclick={() => { isLoginView = true; error = ''; }}
                    class={`w-1/2 py-3 text-lg font-semibold ${isLoginView ? 'text-indigo-400 border-b-2 border-indigo-400' : 'text-gray-500'}`}
                >
                    Login
                </button>
                <button
                    onclick={() => { isLoginView = false; error = ''; }}
                    class={`w-1/2 py-3 text-lg font-semibold ${!isLoginView ? 'text-indigo-400 border-b-2 border-indigo-400' : 'text-gray-500'}`}
                >
                    Sign Up
                </button>
            </div>
            <form onsubmit={handleAuthAction} class="space-y-6">
                <div>
                    <label for="email-auth" class="block text-sm font-medium text-gray-300 mb-2">Email Address</label>
                    <input
                        id="email-auth"
                        type="email"
                        bind:value={email}
                        class="w-full p-3 bg-gray-700 border border-gray-600 rounded-lg text-white"
                        required
                    />
                </div>
                <div>
                    <label for="password-auth" class="block text-sm font-medium text-gray-300 mb-2">Password</label>
                    <input
                        id="password-auth"
                        type="password"
                        bind:value={password}
                        class="w-full p-3 bg-gray-700 border border-gray-600 rounded-lg text-white"
                        required
                    />
                </div>

                {#if !isLoginView}
                    <div class="flex items-center">
                        <input
                            id="terms-agree"
                            type="checkbox"
                            bind:checked={hasAgreedToTerms}
                            class="h-4 w-4 rounded border-gray-500 bg-gray-700 text-indigo-600 focus:ring-indigo-500"
                        />
                        <label for="terms-agree" class="ml-2 block text-sm text-gray-300">
                            I agree to the{' '}
                            <button
                                type="button"
                                onclick={() => isTermsModalOpen = true}
                                class="font-medium text-indigo-400 hover:text-indigo-300"
                            >
                                Terms of Use
                            </button>
                        </label>
                    </div>
                {/if}

                {#if error}
                    <p class="text-red-400 text-sm text-center">{error}</p>
                {/if}
                <div>
                    <button
                        type="submit"
                        disabled={isLoading || (!isLoginView && !hasAgreedToTerms)}
                        class="w-full flex justify-center py-3 px-4 rounded-lg text-lg font-medium text-white bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-800 disabled:opacity-75"
                    >
                        {#if isLoading}
                            <svg class="animate-spin h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                            </svg>
                        {:else}
                            {isLoginView ? 'Log In' : 'Create Account'}
                        {/if}
                    </button>
                </div>
            </form>
        </div>
    </div>
    <div class="w-full max-w-2xl mt-8 text-center">
        <button onclick={() => isExplanationVisible = !isExplanationVisible} class="text-gray-400 hover:text-indigo-400 transition-colors py-2">
            What is DaemonClient?
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class={`inline-block ml-1 transition-transform duration-300 ${isExplanationVisible ? 'rotate-180' : ''}`}>
                <polyline points="6 9 12 15 18 9"></polyline>
            </svg>
        </button>
        <div class={`text-left overflow-hidden transition-all duration-500 ease-in-out ${isExplanationVisible ? 'max-h-[1000px] opacity-100 mt-4' : 'max-h-0 opacity-0'}`}>
            <div class="text-gray-300 space-y-4 bg-gray-800/50 backdrop-blur-sm p-6 rounded-lg shadow-lg border border-gray-700">
                <p>DaemonClient is a free, unlimited, zero-knowledge cloud storage platform. Store terabytes of files with military-grade encryption and no monthly fees.</p>
                <h3 class="text-lg font-semibold text-white pt-2">How It Works: A Decentralized Architecture</h3>
                <ul class="list-disc list-inside space-y-2 pl-2">
                    <li><strong>True Privacy:</strong> Your files are chunked, encrypted with AES-256-GCM, and stored in a private vault that only you can access. The DaemonClient developers have zero ability to see or access your files.</li>
                    <li><strong>Zero Cost:</strong> By using a novel decentralized architecture, DaemonClient provides terabytes of storage at absolutely no cost — forever.</li>
                    <li><strong>Full Control:</strong> You own the storage infrastructure. All file operations are managed client-side, directly in your browser, ensuring your data never passes through our servers after the initial setup.</li>
                </ul>
                <p class="pt-2 text-gray-400 text-sm">Setup takes under 3 minutes. Our automated wizard creates your private, encrypted storage vault and transfers full ownership to you.</p>
                <div class="pt-5 mt-5 border-t border-gray-700 text-center">
                    <a href="https://t.me/montclier49" target="_blank" rel="noopener noreferrer" class="text-sm text-gray-500 hover:text-indigo-400 transition-colors">A project by @montclier49</a>
                </div>
            </div>
        </div>
    </div>
    
    {#if isTermsModalOpen}
        <div class="fixed inset-0 bg-black/75 flex items-center justify-center p-4 z-50">
            <div class="bg-gray-800 rounded-xl p-8 max-w-2xl w-full max-h-[90vh] overflow-y-auto">
                <h2 class="text-2xl font-bold text-white mb-6">Terms of Use</h2>
                <div class="text-gray-300 space-y-4">
                    <p>By using DaemonClient, you agree to these terms:</p>
                    <p>1. You are solely responsible for the data you store. Since we use zero-knowledge encryption, we cannot help you recover lost passwords or decryption keys.</p>
                    <p>2. You must not use this service to store illegal content.</p>
                    <p>3. This is an open-source project provided "as is" without any warranties.</p>
                </div>
                <div class="mt-8 text-right">
                    <button onclick={() => isTermsModalOpen = false} class="px-6 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg font-medium transition-colors">
                        Close
                    </button>
                </div>
            </div>
        </div>
    {/if}
</div>
