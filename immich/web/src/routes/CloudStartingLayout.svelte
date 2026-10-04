<script lang="ts">
  // Shown instead of the error page when the user's own worker can't be reached
  // at all (see $lib/utils/worker-unreachable). For a brand-new account that is
  // Cloudflare still issuing the certificate for its new workers.dev subdomain —
  // it fixes itself within a few minutes — so say so and keep checking. The wait
  // is capped: past WAIT_CAP_MS the cause is something else (a network blocking
  // workers.dev, an ad blocker, a deleted worker), so stop reloading and say that.
  import { Button, Card, CardBody, CardHeader, CardTitle, Link, Logo, Text } from '@immich/ui';
  import { onDestroy } from 'svelte';
  import { endSharedSession } from '$lib/utils/sso';
  import { clearWait, sessionStore, waitStartedAt, waitedTooLong } from '$lib/utils/worker-unreachable';

  const RETRY_SECONDS = 20;
  const storage = sessionStore();
  const started = storage ? waitStartedAt(storage) : null;
  // No usable storage → we could never tell when to stop, so only retry by hand.
  const gaveUp = storage ? waitedTooLong(storage) : false;
  const autoRetry = started !== null && !gaveUp;

  let left = $state(RETRY_SECONDS);
  let signingOut = $state(false);

  const timer = autoRetry
    ? setInterval(() => {
        if (document.hidden) {
          return; // don't burn requests in a background tab
        }
        left -= 1;
        if (left <= 0) {
          clearInterval(timer);
          location.reload();
        }
      }, 1000)
    : undefined;
  onDestroy(() => clearInterval(timer));

  // The stored worker URL must be gone before navigating, or the next page asks
  // the unreachable worker again. The service worker confirms on a reply port;
  // give up waiting after 2 s rather than hang.
  async function signOut() {
    signingOut = true;
    try {
      const controller = navigator.serviceWorker?.controller;
      if (controller) {
        await new Promise<void>((resolve) => {
          const channel = new MessageChannel();
          const timeout = setTimeout(resolve, 2000);
          channel.port1.onmessage = () => {
            clearTimeout(timeout);
            resolve();
          };
          controller.postMessage({ type: 'RESET_SESSION' }, [channel.port2]);
        });
      }
      // End the shared *.daemonclient.uz session too, as the normal logout does —
      // otherwise the login page silently signs the user straight back in, onto
      // this same screen. Best effort, bounded: never hang the button.
      await Promise.race([endSharedSession(), new Promise((resolve) => setTimeout(resolve, 2000))]);
      if (storage) {
        clearWait(storage); // the next account in this tab starts with a fresh clock
      }
      // The two cookies this site sets from script. (The shared `__session` cookie
      // is HttpOnly on .daemonclient.uz — only endSharedSession above can end it.)
      for (const name of ['immich_access_token', 'immich_is_authenticated']) {
        document.cookie = `${name}=; Path=/; Max-Age=0; SameSite=Lax; Secure`;
      }
    } finally {
      // Whatever failed above, leave this screen — never strand the user on it.
      location.assign('/auth/login');
    }
  }
</script>

<div class="flex flex-col h-dvh w-dvw">
  <section>
    <div class="flex place-items-center border-b px-6 py-4 dark:border-b-immich-dark-gray">
      <Link href="/photos">
        <Logo variant="inline" />
      </Link>
    </div>
  </section>

  <div class="flex flex-1 w-full place-content-center place-items-center overflow-hidden bg-black/30">
    <div class="max-w-[95vw] w-[36rem]" role="status">
      <Card color="secondary">
        <CardHeader>
          <CardTitle tag="h1" size="medium" class="text-primary">
            {gaveUp ? "We can't reach your private cloud" : "Your private cloud isn't ready yet"}
          </CardTitle>
        </CardHeader>
        <CardBody class="flex flex-col gap-3">
          {#if gaveUp}
            <Text>
              It has been unreachable for more than five minutes. Your network may be blocking workers.dev, an ad blocker
              may be interfering, or something is wrong with your cloud. Try again, or sign out and back in.
            </Text>
          {:else}
            <Text>
              If you just signed up, it is still being created — this usually takes 1–3 minutes, and nothing is wrong.
              Your photos will open on their own when it is ready.
            </Text>
            {#if autoRetry}
              <Text size="small" color="muted">Checking again in {left}s…</Text>
            {/if}
          {/if}
          <div class="flex gap-2">
            <Button size="small" onclick={() => location.reload()}>{gaveUp ? 'Try again' : 'Check now'}</Button>
            <Button size="small" variant="ghost" disabled={signingOut} onclick={signOut}>Sign out</Button>
          </div>
        </CardBody>
      </Card>
    </div>
  </div>
</div>
