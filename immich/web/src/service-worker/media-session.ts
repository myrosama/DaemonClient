// The service worker's per-session media state around the scheduler: which
// asset the viewer shows, the session generation that stops a previous user's
// in-flight work from writing caches, page cancel hints, and coalesced worker
// reads whose duplicates share one RESULT. Pure (no SW globals) so it tests in
// plain vitest.

import {
  classifyMedia,
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

/** fetch() that turns a rate-limit answer into RetryAfterError, so the scheduler pauses everyone. */
export async function pacedFetch(
  input: string,
  init?: RequestInit,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  const response = await fetcher(input, init);
  const delay = await rateLimitDelay(response);
  if (delay !== undefined) {
    throw new RetryAfterError(delay);
  }
  return response;
}

/**
 * Page cancel hints. Browsers don't propagate FetchEvent.request.signal (as of
 * 2026: Chromium crbug 823697, Firefox bug 1394102, WebKit bug 246069), so the
 * page also posts {type:'cancel', url}. One hint stands for one page request:
 * it releases ONE waiter on that URL. The scheduler drops a job only when no
 * waiter is left, so a hint can never fail another tile's identical request.
 */
export class CancelHints {
  readonly #byUrl = new Map<string, AbortController[]>();

  register(url: string, requestSignal?: AbortSignal): { signal: AbortSignal; done: () => void } {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    requestSignal?.addEventListener('abort', onAbort, { once: true });
    const pending = this.#byUrl.get(url) ?? [];
    pending.push(controller);
    this.#byUrl.set(url, pending);
    const done = () => {
      requestSignal?.removeEventListener('abort', onAbort);
      const list = this.#byUrl.get(url);
      const index = list?.indexOf(controller) ?? -1;
      if (list && index !== -1) {
        list.splice(index, 1);
        if (list.length === 0) {
          this.#byUrl.delete(url);
        }
      }
    };
    return { signal: controller.signal, done };
  }

  cancel(url: string) {
    const list = this.#byUrl.get(url);
    const controller = list?.shift();
    if (list?.length === 0) {
      this.#byUrl.delete(url);
    }
    controller?.abort();
  }

  clear() {
    const all = [...this.#byUrl.values()].flat();
    this.#byUrl.clear();
    for (const controller of all) controller.abort();
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
