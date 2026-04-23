<script lang="ts">
  import { goto } from '$app/navigation';
  import { Route } from '$lib/route';
  import { onMount } from 'svelte';

  // DaemonClient combines login + registration into one page
  onMount(() => {
    goto(Route.login(), { replaceState: true });
  });
</script>

<div class="flex items-center justify-center min-h-screen text-white">
  <p>Redirecting to login...</p>
</div>
