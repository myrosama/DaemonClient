<script lang="ts">
  import BrokenAsset from '$lib/components/assets/BrokenAsset.svelte';
  import { Icon } from '@immich/ui';
  import { mdiEyeOffOutline } from '@mdi/js';
  import type { ClassValue } from 'svelte/elements';
  import { onMount, onDestroy } from 'svelte';
  import { imageRequestQueue } from '$lib/utils/request-queue';

  interface Props {
    url: string;
    altText: string | undefined;
    title?: string | null;
    heightStyle?: string | undefined;
    widthStyle: string;
    curve?: boolean;
    shadow?: boolean;
    circle?: boolean;
    hidden?: boolean;
    border?: boolean;
    highlighted?: boolean;
    hiddenIconClass?: string;
    class?: ClassValue;
    brokenAssetClass?: ClassValue;
    preload?: boolean;
    onComplete?: ((errored: boolean) => void) | undefined;
    asset?: any;
  }

  let {
    url,
    altText,
    title = null,
    heightStyle = undefined,
    widthStyle,
    curve = false,
    shadow = false,
    circle = false,
    hidden = false,
    border = false,
    highlighted = false,
    hiddenIconClass = 'text-white',
    onComplete = undefined,
    class: imageClass = '',
    brokenAssetClass = '',
    preload = true,
    asset = undefined,
  }: Props = $props();

  let loaded = $state(false);
  let errored = $state(false);
  let objectUrl = $state('');
  let destroyed = false;

  onDestroy(() => {
    destroyed = true;
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  });

  const setLoaded = () => {
    loaded = true;
    onComplete?.(false);
  };

  const setErrored = () => {
    errored = true;
    onComplete?.(true);
  };

  let sharedClasses = $derived([
    curve && 'rounded-xl',
    circle && 'rounded-full',
    shadow && 'shadow-lg',
    (circle || !heightStyle) && 'aspect-square',
    border && 'border-3 border-immich-dark-primary/80 hover:border-immich-primary',
    'transition-shadow duration-150',
    highlighted && 'ring-4 ring-immich-primary dark:ring-immich-dark-primary',
  ]);

  let style = $derived(
    `width: ${widthStyle}; height: ${heightStyle ?? ''}; filter: ${hidden ? 'grayscale(50%)' : 'none'}; opacity: ${hidden ? '0.5' : '1'};`,
  );

  function lazyLoad(node: HTMLElement, src: string) {
    let abortController: AbortController | null = null;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let retryCount = 0;
    let queueTicket: { promise: Promise<unknown>; cancel: () => void } | null = null;
    const MAX_RETRIES = 3;

    const performLoad = async () => {
      if (objectUrl || destroyed) return;

      abortController = new AbortController();
      const myAbort = abortController;

      try {
        // Take a slot in the global pacer. The `add` call returns a ticket so
        // we can drop our place in line if the tile scrolls back out before
        // it's our turn — keeps the queue from getting clogged with stale
        // requests during fast scroll.
        queueTicket = imageRequestQueue.add(async () => {
          if (destroyed || myAbort.signal.aborted) return;

          // Always take the server-side path. The user's per-user worker
          // (handleThumbnail in immich-api-shim) downloads from Telegram,
          // decrypts when needed, paces against the bot rate limit, and caches
          // the result for a year. Going client-side via daemonDrive would
          // mean 5 sequential fetches per tile and would explode at scale.
          const res = await fetch(src, { signal: myAbort.signal });
          if (!res.ok) throw new Error(`Network error: ${res.status}`);

          const type = res.headers.get('Content-Type') || '';
          if (type && !type.startsWith('image/')) {
            throw new Error(`Non-image response: ${type}`);
          }
          const blob = await res.blob();

          // Validate magic bytes — guards against worker returning Content-Type:
          // image/jpeg with encrypted/garbage bytes (e.g. stale CF edge cache).
          const headerBuffer = await blob.slice(0, 16).arrayBuffer();
          const bytes = new Uint8Array(headerBuffer);
          const headerText = String.fromCharCode(...bytes);
          const isHeic = type.includes('heic') || type.includes('heif')
            || headerText.includes('heic') || headerText.includes('heix')
            || headerText.includes('hevc') || headerText.includes('mif1');
          const isJpeg = bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF;
          const isPng = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47;
          const isWebp = bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46;
          const isGif = bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46;
          if (!isHeic && !isJpeg && !isPng && !isWebp && !isGif) {
            throw new Error(`Bytes don't match any known image format (first 4: ${[...bytes.slice(0,4)].map(b=>b.toString(16).padStart(2,'0')).join('')})`);
          }

          if (isHeic) {
            const { decodeHeicToBlob } = await import('$lib/utils/heic-decode');
            const finalBlob = await decodeHeicToBlob(blob);
            if (destroyed) return;
            objectUrl = URL.createObjectURL(finalBlob);
            // Persist a real thumbnail + thumbhash back to the worker so future
            // views (web AND the mobile app) are instant and skip this decode.
            // Fire-and-forget, deduped per session.
            if (asset?.id) {
              void import('$lib/utils/heic-backfill').then(({ backfillFromConvertedBlob }) =>
                backfillFromConvertedBlob(asset.id, finalBlob),
              );
            }
          } else {
            if (destroyed) return;
            objectUrl = URL.createObjectURL(blob);
          }
          setLoaded();
        });
        await queueTicket.promise;
      } catch (err: any) {
        if (err?.name === 'AbortError' || err?.message === 'cancelled') return;
        if (retryCount < MAX_RETRIES && !destroyed) {
          retryCount++;
          const delay = Math.pow(2, retryCount) * 500;
          setTimeout(performLoad, delay);
        } else if (!destroyed) {
          console.error('Thumbnail load failed after retries', src, err);
          setErrored();
        }
      } finally {
        queueTicket = null;
      }
    };

    const cancelInFlight = () => {
      if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
      if (queueTicket) { queueTicket.cancel(); queueTicket = null; }
      if (abortController) { abortController.abort(); abortController = null; }
    };

    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          if (objectUrl) return;
          // 80ms debounce: commit to a network call only if the tile has
          // dwelt in view briefly. Reduced from 150ms — most users pause
          // between scroll gestures longer than this, so we start the
          // download sooner without wasting requests on fast flings.
          if (debounceTimer) clearTimeout(debounceTimer);
          debounceTimer = setTimeout(performLoad, 80);
        } else {
          cancelInFlight();
        }
      });
    }, { rootMargin: '400px' });

    if (preload) {
      observer.disconnect();
      performLoad();
    } else {
      observer.observe(node);
    }

    return {
      update(newSrc: string) {
        if (src !== newSrc) {
          src = newSrc;
          cancelInFlight();
          if (objectUrl) {
            URL.revokeObjectURL(objectUrl);
            objectUrl = '';
          }
          loaded = false;
          errored = false;
          retryCount = 0;
          if (preload) {
            performLoad();
          } else {
            observer.disconnect();
            observer.observe(node);
          }
        }
      },
      destroy() {
        observer.disconnect();
        cancelInFlight();
        // Do NOT revoke objectUrl here. When the placeholder div unmounts to
        // reveal the <img> we just loaded, this destroy fires synchronously
        // and would invalidate the blob URL the img is about to render —
        // making the browser fire onerror and show the broken-asset icon.
        // The component's onDestroy is the only correct place to revoke.
      }
    };
  }
</script>

{#if errored}
  <div
    class={['bg-gray-300 dark:bg-gray-700 flex items-center justify-center', sharedClasses, brokenAssetClass].filter(Boolean).join(' ')}
    {style}
  >
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="w-8 h-8 text-gray-500 dark:text-gray-400 opacity-50">
      <path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/>
    </svg>
  </div>
{:else if objectUrl}
  <!-- svelte-ignore a11y_missing_attribute -->
  <img
    src={objectUrl}
    class={['object-cover', sharedClasses, imageClass].filter(Boolean).join(' ')}
    {style}
    alt=""
    draggable={false}
    title={title ?? undefined}
    onload={() => { loaded = true; onComplete?.(false); }}
    onerror={() => {
      console.error('[ImageThumbnail] img tag failed to render objectUrl', { url, objectUrlLen: objectUrl.length });
      objectUrl = '';
      setErrored();
    }}
  />
{:else}
  <div
    use:lazyLoad={url}
    class={['bg-gray-300 dark:bg-gray-700 animate-pulse', sharedClasses, imageClass].filter(Boolean).join(' ')}
    {style}
  ></div>
{/if}

{#if hidden}
  <div class="absolute start-1/2 top-1/2 translate-x-[-50%] translate-y-[-50%] transform">
    <Icon title={title ?? undefined} icon={mdiEyeOffOutline} size="2em" class={hiddenIconClass} />
  </div>
{/if}
