<script lang="ts">
  import AuthPageLayout from '$lib/components/layouts/AuthPageLayout.svelte';
  import { Route } from '$lib/route';
  import {Button, Heading, Stack} from '@immich/ui';
</script>

<AuthPageLayout>
  <div class="flex flex-col place-items-center text-center gap-12">
    <Heading size="large" color="primary" tag="h1">Welcome to DaemonClient Photos</Heading>
    <Stack>
      <Button href={Route.login()} size="large" shape="round">
        <span class="px-2 font-semibold">Get Started</span>
      </Button>
    </Stack>
  </div>
</AuthPageLayout>
