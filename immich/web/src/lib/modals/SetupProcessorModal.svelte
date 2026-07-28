<script lang="ts">
  import { PUBLIC_DAEMONCLIENT_FIREBASE_PROJECT_ID } from '$env/static/public';
  import { Button, Modal, ModalBody, Text } from '@immich/ui';

  // Turn on AUTOMATIC HEIC thumbnails. Telegram thumbnails every format except
  // HEIC, so iPhone photos need a tiny converter — deployed on the USER's OWN
  // free Vercel account, so their photos are converted there, never on our
  // servers. Once connected, the worker converts new HEIC uploads and heals the
  // existing thumb-less ones automatically (no more manual "Fix HEIC").
  //
  // Works for everyone, old and new: this runs on photos.daemonclient.uz where
  // the browser already holds a worker session, so it calls the worker's
  // POST /api/server/processor directly — the same validator the CLI uses (https,
  // public, a real DaemonClient processor, owner-pinned, answers to THIS user).

  type Props = { onClose: () => void };
  let { onClose }: Props = $props();

  let phase = $state<'loading' | 'idle' | 'connected' | 'connecting' | 'error'>('loading');
  let currentUrl = $state<string | null>(null);
  let ownerUid = $state('');
  let url = $state('');
  let message = $state('');

  const projectId = PUBLIC_DAEMONCLIENT_FIREBASE_PROJECT_ID;

  // The one-click Vercel deploy: clones the repo, builds only the processor/
  // subdirectory, and prompts for the two env vars (values shown below to copy).
  const deployUrl = $derived(
    'https://vercel.com/new/clone?repository-url=' +
      encodeURIComponent('https://github.com/myrosama/DaemonClient') +
      '&root-directory=processor' +
      '&env=FIREBASE_PROJECT_ID,OWNER_UID' +
      '&envDescription=' + encodeURIComponent('Copy both from the DaemonClient window') +
      '&project-name=daemonclient-processor&repository-name=daemonclient-processor',
  );

  async function init() {
    try {
      const [pRes, uRes] = await Promise.all([
        fetch('/api/server/processor'),
        fetch('/api/users/me'),
      ]);
      if (pRes.ok) {
        const p = (await pRes.json()) as { url?: string | null; configured?: boolean };
        if (p.configured && p.url) { currentUrl = p.url; phase = 'connected'; }
        else phase = 'idle';
      } else {
        phase = 'idle';
      }
      if (uRes.ok) ownerUid = ((await uRes.json()) as { id?: string }).id ?? '';
    } catch {
      phase = 'idle';
    }
  }
  init();

  async function connect() {
    const clean = url.trim();
    if (!clean) { message = 'Paste the URL your Vercel deployment shows.'; phase = 'error'; return; }
    phase = 'connecting';
    message = '';
    try {
      const res = await fetch('/api/server/processor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: clean }),
      });
      const data = (await res.json().catch(() => ({}))) as { url?: string; message?: string };
      if (res.ok) { currentUrl = data.url ?? clean; phase = 'connected'; }
      else { message = data.message || 'That processor could not be connected.'; phase = 'error'; }
    } catch {
      message = 'Could not reach the processor — a fresh free deployment can take a minute to wake. Try again.';
      phase = 'error';
    }
  }

  async function disconnect() {
    phase = 'connecting';
    try {
      await fetch('/api/server/processor', { method: 'DELETE' });
    } catch { /* best effort */ }
    currentUrl = null;
    url = '';
    phase = 'idle';
  }
</script>

<Modal title="Automatic thumbnails" size="small" {onClose}>
  <ModalBody>
    {#if phase === 'loading'}
      <Text color="muted" size="small">Checking your setup…</Text>
    {:else if phase === 'connected'}
      <Text color="muted" size="small">
        Automatic HEIC thumbnails are <strong>on</strong>. New iPhone photos are thumbnailed on upload, and your
        existing HEIC photos fill in over the next few minutes. Nothing to do.
      </Text>
      <div class="mt-3 text-xs break-all rounded-lg bg-gray-100 dark:bg-immich-dark-gray p-3 font-mono">{currentUrl}</div>
      <div class="flex justify-between mt-4">
        <Button size="small" color="secondary" onclick={disconnect}>Disconnect</Button>
        <Button size="small" onclick={onClose}>Done</Button>
      </div>
    {:else}
      <Text color="muted" size="small">
        iPhone (HEIC) photos are the one format Telegram can't thumbnail, so they show a blank tile. Deploy a tiny
        free converter to your <strong>own</strong> Vercel account — your photos are converted there, never on our
        servers — and every HEIC photo, new and existing, gets a thumbnail automatically. Videos and other formats
        are unaffected.
      </Text>

      <div class="mt-4">
        <Text size="small" fontWeight="semi-bold">1 · Deploy the converter</Text>
        <Text size="tiny" color="muted" class="mt-1">
          Opens Vercel, clones the converter, and asks for two values — paste these:
        </Text>
        <div class="mt-2 text-xs rounded-lg bg-gray-100 dark:bg-immich-dark-gray p-3 font-mono space-y-1">
          <div><span class="opacity-60">FIREBASE_PROJECT_ID</span> = {projectId}</div>
          <div><span class="opacity-60">OWNER_UID</span> = {ownerUid || '(loading…)'}</div>
        </div>
        <div class="mt-2">
          <a href={deployUrl} target="_blank" rel="noopener noreferrer">
            <Button size="small">Deploy to Vercel ↗</Button>
          </a>
        </div>
      </div>

      <div class="mt-4">
        <Text size="small" fontWeight="semi-bold">2 · Paste the deployment URL</Text>
        <input
          bind:value={url}
          type="url"
          placeholder="https://daemonclient-processor-xxxx.vercel.app"
          class="w-full mt-2 rounded-lg border border-gray-300 dark:border-immich-dark-gray bg-transparent px-3 py-2 text-sm outline-none focus:border-primary"
        />
      </div>

      {#if phase === 'error'}
        <Text size="small" class="mt-3 text-red-500">{message}</Text>
      {/if}

      <div class="flex justify-end mt-4">
        <Button size="small" onclick={connect} disabled={phase === 'connecting'}>
          {phase === 'connecting' ? 'Connecting…' : 'Connect'}
        </Button>
      </div>
    {/if}
  </ModalBody>
</Modal>
