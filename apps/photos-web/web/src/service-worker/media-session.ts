// The service worker's per-session media state around the scheduler: which
// asset the viewer shows, the session generation that stops a previous user's
// in-flight work from writing caches, page cancel hints, and coalesced worker
// reads whose duplicates share one RESULT. Pure (no SW globals) so it tests in
// plain vitest.

import {
  abortError,
  classifyMedia,
  isAbortError,
  type MediaClass,
  type MediaScheduler,
  type MediaTag,
  rateLimitDelay,
  RetryAfterError,
} from './media-scheduler';

/** A fully-read response that any number of callers can turn back into a Response. */
export interface SharedResult {
  status: number;
  statusText: string;
  headers: [string, string][];
  buffer: ArrayBuffer;
}

const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

export async function toSharedResult(response: Response): Promise<SharedResult> {
  return {
    status: response.status,
    statusText: response.statusText,
    headers: [...response.headers.entries()],
    buffer: await response.arrayBuffer(),
  };
}

export function fromSharedResult(result: SharedResult): Response {
  // A BufferSource body is copied, so every caller gets its own readable body.
  return new Response(NULL_BODY_STATUS.has(result.status) ? undefined : result.buffer, {
    status: result.status,
    statusText: result.statusText,
    headers: result.headers,
  });
}

// A dropped connection or a bare 503 (a Cloudflare error page, no
// Retry-After) is retried twice after a short wait, inside the job: one lost
// packet must not fail a tile or turn the direct path off. A rate limit is not
// retried here — it pauses everyone (RetryAfterError).
const RETRY_DELAYS_MS = [250, 750];
// An answer that hasn't started within this long is abandoned (and not
// retried), so a hung connection can't hold a scheduler slot forever. Only the
// wait for the response headers is limited; a long body keeps streaming.
const HEADERS_TIMEOUT_MS = 30_000;

function timeoutError(): Error {
  const error = new Error('No response from the server in time');
  error.name = 'TimeoutError';
  return error;
}

function wait(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function fetchWithHeadersTimeout(input: string, init: RequestInit | undefined, fetcher: typeof fetch) {
  const outer = init?.signal;
  if (outer?.aborted) {
    throw abortError();
  }
  const controller = new AbortController();
  outer?.addEventListener('abort', () => controller.abort(), { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, HEADERS_TIMEOUT_MS);
  try {
    return await fetcher(input, { ...init, signal: controller.signal });
  } catch (error) {
    throw timedOut ? timeoutError() : error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * fetch() for media jobs: retries a dropped connection or a bare 503 twice,
 * limits the wait for an answer, and turns a rate-limit answer into
 * RetryAfterError so the scheduler pauses everyone.
 */
export async function pacedFetch(
  input: string,
  init?: RequestInit,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const last = attempt >= RETRY_DELAYS_MS.length;
    let response: Response;
    try {
      response = await fetchWithHeadersTimeout(input, init, fetcher);
    } catch (error) {
      if (last || isAbortError(error) || (error as Error)?.name === 'TimeoutError' || init?.signal?.aborted) {
        throw init?.signal?.aborted ? abortError() : error;
      }
      await wait(RETRY_DELAYS_MS[attempt], init?.signal);
      continue;
    }
    const delay = await rateLimitDelay(response);
    if (delay !== undefined) {
      throw new RetryAfterError(delay);
    }
    if (response.status === 503 && !last) {
      await response.body?.cancel().catch(() => {});
      await wait(RETRY_DELAYS_MS[attempt], init?.signal);
      continue;
    }
    return response;
  }
}

/**
 * Page cancel hints. Browsers don't propagate FetchEvent.request.signal (as of
 * 2026: Chromium crbug 823697, Firefox bug 1394102, WebKit bug 246069), so the
 * page also posts {type:'cancel', url}. One hint stands for one page request:
 * it releases ONE waiter on that URL. The scheduler drops a job only when no
 * waiter is left, so a hint can never fail another tile's identical request.
 */
type Ticket = { controller: AbortController; clientId: string };

export class CancelHints {
  readonly #byUrl = new Map<string, Ticket[]>();

  /**
   * One page request for `url`. `clientId` is the tab that sent it
   * (FetchEvent.clientId): a hint only ever releases a request of the tab that
   * sent the hint.
   */
  register(url: string, requestSignal?: AbortSignal, clientId = ''): { signal: AbortSignal; done: () => void } {
    const ticket: Ticket = { controller: new AbortController(), clientId };
    const onAbort = () => ticket.controller.abort();
    requestSignal?.addEventListener('abort', onAbort, { once: true });
    const pending = this.#byUrl.get(url) ?? [];
    pending.push(ticket);
    this.#byUrl.set(url, pending);
    const done = () => {
      requestSignal?.removeEventListener('abort', onAbort);
      this.#drop(url, ticket);
    };
    return { signal: ticket.controller.signal, done };
  }

  /** The page's hint: release the oldest pending request of that tab for `url`. */
  cancel(url: string, clientId = '') {
    const ticket = this.#byUrl.get(url)?.find((pending) => pending.clientId === clientId);
    if (ticket) {
      this.#drop(url, ticket);
      ticket.controller.abort();
    }
  }

  clear() {
    const all = [...this.#byUrl.values()].flat();
    this.#byUrl.clear();
    for (const ticket of all) ticket.controller.abort();
  }

  #drop(url: string, ticket: Ticket) {
    const list = this.#byUrl.get(url);
    const index = list?.indexOf(ticket) ?? -1;
    if (list && index !== -1) {
      list.splice(index, 1);
      if (list.length === 0) {
        this.#byUrl.delete(url);
      }
    }
  }
}

export class MediaSession {
  #generation = 0;
  #viewingAssetId: string | undefined;

  constructor(readonly scheduler: MediaScheduler) {}

  get generation(): number {
    return this.#generation;
  }

  get viewingAssetId(): string | undefined {
    return this.#viewingAssetId;
  }

  isCurrent(generation: number): boolean {
    return generation === this.#generation;
  }

  classify(tag: MediaTag): MediaClass {
    return classifyMedia(tag, this.#viewingAssetId);
  }

  /** The page's {type:'viewing'} hint: re-decide every queued and running job's class. */
  setViewing(assetId: string | undefined) {
    if (assetId === this.#viewingAssetId) {
      return;
    }
    this.#viewingAssetId = assetId;
    this.scheduler.reclassify((tag) => classifyMedia(tag, assetId));
  }

  /** Logout / user switch: fail all media work and forget the hint and pauses. */
  reset() {
    this.#generation++;
    this.#viewingAssetId = undefined;
    this.scheduler.clear();
  }

  schedule<T>(options: { tag: MediaTag; key?: string; signal?: AbortSignal }, task: () => Promise<T>): Promise<T> {
    return this.scheduler.schedule({ ...options, class: this.classify(options.tag) }, task);
  }

  /**
   * A coalesced, cacheable GET. Every identical caller gets its own Response
   * built from the one result; `store` runs once, only for an ok answer, and
   * only while the session that started the job is still current.
   */
  async sharedFetch(
    options: { tag: MediaTag; key: string; signal?: AbortSignal },
    send: () => Promise<Response>,
    store: (response: Response) => Promise<unknown>,
  ): Promise<Response> {
    const generation = this.#generation;
    const result = await this.schedule(options, async () => {
      const shared = await toSharedResult(await send());
      if (shared.status === 200 && this.isCurrent(generation)) {
        await store(fromSharedResult(shared)).catch(() => {});
      }
      return shared;
    });
    return fromSharedResult(result);
  }
}
