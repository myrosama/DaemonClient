// Registers the service worker ourselves (see svelte.config.js for why the
// default `window load`-gated auto-register is disabled) and waits for it to
// actually control this document before letting the app make its first API
// calls — those calls depend on the SW rewriting them to the per-user
// Cloudflare Worker, so running them uncontrolled sends them straight to the
// static origin instead.
//
// A document loaded before any service worker existed for this origin isn't
// controlled by the newly-registered one — UNLESS that worker claims it. The
// service worker's activate handler (src/service-worker/index.ts) already
// calls `skipWaiting()` on install and `clients.claim()` on activate, which
// fires `controllerchange` on exactly this document once claiming finishes.
// So on a browser's very first visit we just wait for that event instead of
// reloading — no navigation, no lost state, same outcome (this document is
// now controlled) with none of a full reload's cost.
//
// `controllerchange` never fires if registration/install/activation stalls
// (bad response, install-time script error, a proxy blocking it), so the
// wait is raced against a timeout: the worst case degrades to the old,
// recoverable behavior (proceed uncontrolled, let the app's normal
// connection-error handling take over) instead of hanging boot forever.
const READY_TIMEOUT_MS = 8000;

export async function ensureServiceWorkerReady(): Promise<void> {
  if (!globalThis.isSecureContext || !('serviceWorker' in navigator)) {
    return;
  }

  if (navigator.serviceWorker.controller) {
    return;
  }

  // Listen before registering: on an already-cached SW script, install +
  // activate + claim could in principle finish inside the gap between
  // register() resolving and us starting to listen.
  const claimed = new Promise<void>((resolve) => {
    navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true });
  });

  try {
    // Dev serves the raw TS file, which needs module scripting; the production
    // build bundles it to a classic script — matching SvelteKit's own generated
    // registration options for the two modes.
    await navigator.serviceWorker.register('/service-worker.js', import.meta.env.DEV ? { type: 'module' } : undefined);
  } catch {
    return;
  }

  if (navigator.serviceWorker.controller) {
    return;
  }

  await Promise.race([claimed, new Promise<void>((resolve) => setTimeout(resolve, READY_TIMEOUT_MS))]);
}
