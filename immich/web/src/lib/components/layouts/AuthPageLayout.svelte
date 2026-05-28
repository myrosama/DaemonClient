<script lang="ts">
  import { Card, CardBody, CardHeader, Heading, immichLogo, Logo, VStack } from '@immich/ui';
  import type { Snippet } from 'svelte';
  interface Props {
    title?: string;
    children?: Snippet;
    withHeader?: boolean;
    withBackdrop?: boolean;
  }

  let { title, children, withHeader = true, withBackdrop = true }: Props = $props();
</script>

<section class="min-w-dvw flex min-h-dvh items-center justify-center relative isolate overflow-hidden">
  {#if withBackdrop}
    <div class="absolute -z-10 w-full h-full flex place-items-center place-content-center">
      <img
        src="/daemonclient-logo.png"
        class="max-w-(--breakpoint-md) mx-auto h-full mb-2 antialiased overflow-hidden opacity-30"
        alt="DaemonClient logo"
      />
      <div
        class="w-full h-[99%] absolute inset-s-0 top-0 backdrop-blur-[200px] bg-transparent dark:bg-immich-dark-bg/20"
      ></div>
    </div>
  {/if}

  <Card color="secondary" class="w-full max-w-md border m-4 max-h-[90vh] overflow-hidden flex flex-col">
    {#if withHeader}
      <CardHeader class="mt-4">
        <VStack gap={2}>
          <img src="/daemonclient-logo.png" alt="DaemonClient Logo" class="h-20 w-20 object-contain mx-auto" />
          <Heading size="medium" class="font-semibold" color="primary" tag="h1">{title}</Heading>
        </VStack>
      </CardHeader>
    {/if}

    <CardBody class="p-6 overflow-y-auto scrollbar-hidden">
      {@render children?.()}
    </CardBody>
  </Card>
</section>
