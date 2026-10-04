// "The user's own worker could not be reached at all" — shared by the service
// worker (which answers for it) and the app (which recognises it).
//
// The commonest cause is a brand-new account: Cloudflare issues the TLS
// certificate for the account's new workers.dev subdomain a minute or two after
// setup, and until then every fetch to the worker fails the handshake. The
// service worker used to answer that with a generic 503, which the app showed
// as a bare "Error: 503". Tagged, the app can say "your private cloud is still
// being created" and retry instead.

export const WORKER_UNREACHABLE = 'DC_WORKER_UNREACHABLE';

export function workerUnreachableResponse(): Response {
  return new Response(
    JSON.stringify({
      message: "Your private cloud can't be reached right now",
      error: WORKER_UNREACHABLE,
      statusCode: 503,
    }),
    { status: 503, headers: { 'Content-Type': 'application/json', 'Retry-After': '20' } },
  );
}

// The SDK's HttpError carries `status` and the parsed JSON body as `data`.
export function isWorkerUnreachable(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const { status, data } = error as { status?: unknown; data?: unknown };
  return (
    status === 503 && !!data && typeof data === 'object' && (data as { error?: unknown }).error === WORKER_UNREACHABLE
  );
}

// Cap the "still being created" screen. Cloudflare has issued a new subdomain's
// certificate within a few minutes in every observed case; past this, the cause
// is something else (carrier blocking workers.dev, an ad blocker, a deleted
// worker) and the screen must stop reloading and say so plainly.
export const WAIT_CAP_MS = 5 * 60_000; // same as the dashboard's give-up
const WAIT_KEY = 'dc-cloud-wait-started';

type SessionStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

// When the current wait began, remembered across the screen's own reloads.
// null when storage is unusable — the caller then must not auto-reload, since it
// could never tell when to stop.
export function waitStartedAt(storage: SessionStore, now = Date.now()): number | null {
  try {
    const raw = storage.getItem(WAIT_KEY);
    // A start in the future (clock moved back, tampering) would never reach the
    // cap — treat it as a fresh start instead.
    if (raw !== null && Number.isFinite(Number(raw)) && Number(raw) <= now) {
      return Number(raw);
    }
    storage.setItem(WAIT_KEY, String(now));
    return now;
  } catch {
    return null;
  }
}

export function waitedTooLong(storage: SessionStore, now = Date.now()): boolean {
  try {
    const raw = storage.getItem(WAIT_KEY);
    return raw !== null && Number.isFinite(Number(raw)) && now - Number(raw) >= WAIT_CAP_MS;
  } catch {
    return false;
  }
}

export function clearWait(storage: SessionStore): void {
  try {
    storage.removeItem(WAIT_KEY);
  } catch {
    // nothing to clear
  }
}

// sessionStorage, or null when the browser refuses access (reading the property
// itself can throw when site data is blocked). Callers treat null as "can't keep
// a clock" and retry only by hand.
export function sessionStore(get: () => Storage = () => sessionStorage): Storage | null {
  try {
    return get() ?? null;
  } catch {
    return null;
  }
}

// The service worker's decision when a fetch to a worker failed outright (TLS,
// DNS, network, or an error page without CORS headers). The USER'S OWN worker —
// commonly a brand-new account still waiting on its certificate — gets the
// tagged response the app shows as "isn't ready yet". The shared entry point
// failing is an outage on our side: keep a plain 503 rather than tell a visitor
// their cloud is being created. Compared without trailing slashes.
export function unreachableResponseFor(base: string, sharedEntry: string): Response {
  const strip = (u: string) => u.replace(/\/+$/, '');
  if (strip(base) !== strip(sharedEntry)) {
    return workerUnreachableResponse();
  }
  return new Response(JSON.stringify({ message: 'Service temporarily unavailable' }), {
    status: 503,
    headers: { 'Content-Type': 'application/json', 'Retry-After': '5' },
  });
}
