<script lang="ts">
  import { isFirefox } from '$lib/utils/asset-utils';
  import { cancelImageUrl } from '$lib/utils/sw-messaging';
  import { onDestroy, untrack } from 'svelte';
  import type { HTMLImgAttributes } from 'svelte/elements';
  import { imageRequestQueue } from '$lib/utils/request-queue';

  type Props = Omit<HTMLImgAttributes, 'onload' | 'onerror'> & {
    src: string | undefined;
    onStart?: () => void;
    onLoad?: () => void;
    onError?: (error: Error) => void;
    ref?: HTMLImageElement;
  };

  let { src, onStart, onLoad, onError, ref = $bindable(), ...rest }: Props = $props();

  let capturedSource: string | undefined = $state();
  let loaded = $state(false);
  let destroyed = false;

  $effect(() => {
    if (src !== undefined && capturedSource === undefined) {
      capturedSource = src;
      untrack(() => {
        onStart?.();
      });
    }
  });


  const completeLoad = () => {
    if (destroyed) {
      return;
    }
    loaded = true;
    onLoad?.();
  };

  const handleLoad = () => {
    if (destroyed || !src) {
      return;
    }

    if (isFirefox && ref) {
      ref.decode().then(completeLoad, completeLoad);
      return;
    }

    completeLoad();
  };

  let retryCount = 0;
  let retryTimer: ReturnType<typeof setTimeout>;

  const handleError = () => {
    if (destroyed || !src) {
      return;
    }
    
    if (retryCount < 3) {
      retryCount++;
      const delay = Math.min(1000 * Math.pow(2, retryCount), 5000);
      retryTimer = setTimeout(() => {
        if (!destroyed && src) {
          // Force reload by appending a cache-busting timestamp or just resetting intersected
          const currentSrc = capturedSource;
          capturedSource = undefined;
          setTimeout(() => {
            if (!destroyed) capturedSource = currentSrc;
          }, 50);
        }
      }, delay);
      return;
    }
    
    onError?.(new Error(`Failed to load image: ${src}`));
  };
  
  onDestroy(() => {
    destroyed = true;
    if (retryTimer) clearTimeout(retryTimer);
    if (capturedSource !== undefined) {
      cancelImageUrl(capturedSource);
    }
  });
  let isLazy = rest.loading === 'lazy';
  let intersected = $state(!isLazy);
  let observer: IntersectionObserver | undefined;
  let intersectionTimer: ReturnType<typeof setTimeout> | undefined;

  $effect(() => {
    if (!isLazy || !ref) return;

    observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          // Add a 150ms debounce to prevent loading during rapid scrolling
          intersectionTimer = setTimeout(() => {
            intersected = true;
            if (observer && ref) observer.unobserve(ref);
          }, 150);
        } else {
          // If it leaves the viewport before the timer finishes, cancel the load!
          if (intersectionTimer) clearTimeout(intersectionTimer);
        }
      }
    }, { rootMargin: '200px' }); // Start loading 200px before it enters the viewport

    observer.observe(ref);

    return () => {
      if (intersectionTimer) clearTimeout(intersectionTimer);
      if (observer) observer.disconnect();
    };
  });
</script>

{#if capturedSource}
  {#key capturedSource}
    <img
      bind:this={ref}
      src={intersected ? capturedSource : undefined}
      {...rest}
      loading="eager"
      style:visibility={isFirefox && !loaded ? 'hidden' : undefined}
      onload={handleLoad}
      onerror={handleError}
    />
  {/key}
{/if}
