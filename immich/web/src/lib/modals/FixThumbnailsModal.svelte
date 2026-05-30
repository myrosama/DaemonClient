<script lang="ts">
  import { backfillAssetById } from '$lib/utils/heic-backfill';
  import { Button, Modal, ModalBody, Text } from '@immich/ui';

  type Props = { onClose: () => void };
  let { onClose }: Props = $props();

  let phase = $state<'idle' | 'scanning' | 'running' | 'done'>('idle');
  let total = $state(0);
  let processed = $state(0);
  let fixed = $state(0);
  let failed = $state(0);
  let cancel = false;

  // Find IMAGE assets with no stored ThumbHash — these are the ones whose
  // thumbnail the worker couldn't generate (HEIC, HEIC live-photo stills). The
  // timeline bucket payload exposes id/isImage/thumbhash as parallel arrays.
  async function findCandidates(): Promise<string[]> {
    const res = await fetch('/api/timeline/buckets?isTrashed=false');
    if (!res.ok) return [];
    const buckets = (await res.json()) as Array<{ timeBucket: string }>;
    const ids: string[] = [];
    for (const b of buckets) {
      if (cancel) break;
      const r = await fetch(`/api/timeline/bucket?timeBucket=${encodeURIComponent(b.timeBucket)}&isTrashed=false`);
      if (!r.ok) continue;
      const d = (await r.json()) as { id?: string[]; isImage?: boolean[]; thumbhash?: (string | null)[] };
      const id = d.id ?? [];
      const isImage = d.isImage ?? [];
      const thumbhash = d.thumbhash ?? [];
      for (let i = 0; i < id.length; i++) {
        if (isImage[i] && !thumbhash[i]) ids.push(id[i]);
      }
    }
    return ids;
  }

  async function start() {
    cancel = false;
    phase = 'scanning';
    processed = fixed = failed = 0;
    const ids = await findCandidates();
    total = ids.length;
    phase = 'running';
    // Sequential (concurrency 1): HEIC decode is memory-heavy; running many at
    // once crashes the tab. Each item fetches the original, decodes in-browser,
    // and stores a thumbnail + thumbhash on the worker.
    for (const id of ids) {
      if (cancel) break;
      const ok = await backfillAssetById(id);
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

<Modal title="Fix HEIC & missing thumbnails" size="small" onClose={close}>
  <ModalBody>
    <Text color="muted" size="small">
      Generates thumbnails and blur placeholders for photos the server can't process itself (HEIC and HEIC
      live-photo stills). Your browser does the conversion and saves the result, so it works on the phone app too
      afterwards. Keep this tab open until it finishes.
    </Text>

    {#if phase === 'idle'}
      <div class="flex justify-end mt-4">
        <Button size="small" onclick={start}>Start</Button>
      </div>
    {:else if phase === 'scanning'}
      <Text class="mt-4">Scanning your library…</Text>
    {:else if phase === 'running' || phase === 'done'}
      <div class="mt-4">
        <Text size="small" color="muted">{processed} / {total} processed · {fixed} fixed{failed ? ` · ${failed} failed` : ''}</Text>
        <div class="w-full h-2 bg-gray-200 dark:bg-immich-dark-gray rounded-full mt-2 overflow-hidden">
          <div
            class="h-full bg-primary transition-all duration-200"
            style={`width: ${total ? Math.round((processed / total) * 100) : 0}%`}
          ></div>
        </div>
        {#if phase === 'done'}
          <Text class="mt-3">
            {total === 0 ? 'Nothing to fix — all photos already have thumbnails. 🎉' : `Done. Fixed ${fixed} of ${total}. Refresh to see them.`}
          </Text>
          <div class="flex justify-end mt-3">
            <Button size="small" onclick={close}>Close</Button>
          </div>
        {/if}
      </div>
    {/if}
  </ModalBody>
</Modal>
