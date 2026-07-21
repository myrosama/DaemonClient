<script lang="ts">
  import { backfillVideoById } from '$lib/utils/video-backfill';
  import { Button, Modal, ModalBody, Text } from '@immich/ui';

  type Props = { onClose: () => void };
  let { onClose }: Props = $props();

  let phase = $state<'idle' | 'scanning' | 'running' | 'done'>('idle');
  let total = $state(0);
  let processed = $state(0);
  let fixed = $state(0);
  let failed = $state(0);
  let cancel = false;

  // Ask the worker for video assets that have no thumbnail yet.
  // Uses ?type=video so the default pending-thumbnail-fix response (images only)
  // is left untouched — no risk of inflating the HEIC tool's candidate list.
  async function findCandidates(): Promise<string[]> {
    try {
      const res = await fetch('/api/assets/pending-thumbnail-fix?type=video');
      if (res.ok) {
        const d = (await res.json()) as { ids?: string[] };
        if (Array.isArray(d.ids)) return d.ids;
      }
    } catch {
      // swallow — show "nothing found" rather than crashing
    }
    return [];
  }

  async function start() {
    cancel = false;
    phase = 'scanning';
    processed = fixed = failed = 0;
    const ids = await findCandidates();
    total = ids.length;
    phase = 'running';
    // Sequential (concurrency 1): video decode + canvas capture can be
    // memory-heavy; running many at once risks crashing the tab.
    for (const id of ids) {
      if (cancel) break;
      const ok = await backfillVideoById(id);
      ok ? fixed++ : failed++;
      processed++;
    }
    phase = 'done';
  }

  function close() {
    cancel = true;
    onClose();
  }
</script>

<Modal title="Fix video thumbnails" size="small" onClose={close}>
  <ModalBody>
    <Text color="muted" size="small">
      Extracts a poster frame from each video that has no thumbnail yet. Your browser does the work — the
      native player when it can, otherwise ffmpeg in your browser for codecs it can't decode (e.g. HEVC),
      which downloads the video once. Keep this tab open until it finishes; HEVC videos take a bit longer.
    </Text>

    {#if phase === 'idle'}
      <div class="flex justify-end mt-4">
        <Button size="small" onclick={start}>Start</Button>
      </div>
    {:else if phase === 'scanning'}
      <Text class="mt-4">Scanning your library…</Text>
    {:else if phase === 'running' || phase === 'done'}
      <div class="mt-4">
        <Text size="small" color="muted"
          >{processed} / {total} processed · {fixed} fixed{failed ? ` · ${failed} skipped` : ''}</Text
        >
        <div class="w-full h-2 bg-gray-200 dark:bg-immich-dark-gray rounded-full mt-2 overflow-hidden">
          <div
            class="h-full bg-primary transition-all duration-200"
            style={`width: ${total ? Math.round((processed / total) * 100) : 0}%`}
          ></div>
        </div>
        {#if phase === 'done'}
          <Text class="mt-3">
            {total === 0
              ? 'Nothing to fix — all videos already have thumbnails.'
              : `Done. Fixed ${fixed} of ${total}.${fixed > 0 ? ' Refresh to see them.' : ''}`}
          </Text>
          <div class="flex justify-end mt-3">
            <Button size="small" onclick={close}>Close</Button>
          </div>
        {/if}
      </div>
    {/if}
  </ModalBody>
</Modal>
