// Decides which media request may spend the user's rate limit next. Every
// manifest read and every proxied Telegram call is a Cloudflare Worker
// invocation, so the service worker paces them here instead of firing them as
// fast as the page asks.
//
// Two priorities:
//   interactive — what the user opened: originals, the viewer's preview /
//     fullsize renditions, video playback. Starts at once, uncapped. While any
//     is in flight no NEW thumbnail work starts (running thumbnails finish).
//   thumbnail — the timeline grid. Capped, and served newest-first: after a
//     long scroll the tiles on screen now were requested last, so they go
//     before the ones scrolled past. A queued request whose page request was
//     cancelled is dropped instead of being downloaded for nobody.
//
// Concurrent requests for the same `key` share one job. The job is dropped
// from the queue only once EVERY caller has gone; once started it always runs
// to completion, because its result is cached and the next visit is free.
//
// Pure (no SW globals) so it unit-tests in plain vitest.

import type { AssetBinaryKind } from './telegram-media';

export type MediaPriority = 'interactive' | 'thumbnail';

/** Grid-size thumbnails are background work; anything the viewer shows is interactive. */
export function classifyMediaRequest(kind: AssetBinaryKind, size: string): MediaPriority {
  if (kind !== 'thumbnail') return 'interactive';
  // Mirrors selectFileIds: preview/fullsize are the viewer's renditions; an
  // empty or unknown size resolves to the grid thumbnail.
  return size === 'preview' || size === 'fullsize' ? 'interactive' : 'thumbnail';
}

export function abortError(): Error {
  return new DOMException('The media request was cancelled', 'AbortError');
}

export function isAbortError(error: unknown): boolean {
  return (error as { name?: unknown } | null)?.name === 'AbortError';
}

interface Job {
  key?: string;
  priority: MediaPriority;
  task: () => Promise<unknown>;
  started: boolean;
  /** Callers still waiting on this job and able to cancel; `Infinity` once one can't. */
  wanted: number;
  promise: Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

export interface ScheduleOptions {
  priority: MediaPriority;
  /** Deduplicate: concurrent calls with the same key share one task run. */
  key?: string;
  /** The page's cancellation (FetchEvent.request.signal). */
  signal?: AbortSignal;
}

export class MediaScheduler {
  readonly #thumbnailConcurrency: number;
  #activeInteractive = 0;
  #activeThumbnail = 0;
  /** Waiting thumbnail jobs, oldest first; dispatched from the end. */
  readonly #queue: Job[] = [];
  readonly #byKey = new Map<string, Job>();

  constructor(options: { thumbnailConcurrency: number }) {
    this.#thumbnailConcurrency = options.thumbnailConcurrency;
  }

  stats() {
    return { interactive: this.#activeInteractive, thumbnail: this.#activeThumbnail, queued: this.#queue.length };
  }

  schedule<T>(options: ScheduleOptions, task: () => Promise<T>): Promise<T> {
    const { priority, key, signal } = options;
    if (signal?.aborted) return Promise.reject(abortError());

    let job = key === undefined ? undefined : this.#byKey.get(key);
    if (!job) {
      job = this.#createJob(priority, task, key);
      if (priority === 'interactive') {
        this.#start(job);
      } else {
        this.#queue.push(job);
        this.#pump();
      }
    } else if (!job.started && priority === 'interactive') {
      // The user opened something already queued as a thumbnail: run it now.
      this.#queue.splice(this.#queue.indexOf(job), 1);
      job.priority = 'interactive';
      this.#start(job);
    }
    job.wanted = signal ? job.wanted + 1 : Infinity;

    const result = job.promise as Promise<T>;
    if (!signal) return result;
    return this.#withAbort(job, result, signal);
  }

  #createJob(priority: MediaPriority, task: () => Promise<unknown>, key?: string): Job {
    let resolve!: (value: unknown) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<unknown>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // A job every caller abandoned rejects with nobody listening.
    promise.catch(() => {});
    const job: Job = { key, priority, task, started: false, wanted: 0, promise, resolve, reject };
    if (key !== undefined) this.#byKey.set(key, job);
    return job;
  }

  // Settle this caller on its own abort without disturbing other callers.
  #withAbort<T>(job: Job, result: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        reject(abortError());
        job.wanted--;
        if (!job.started && job.wanted <= 0) this.#drop(job);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      result.then(
        (value) => {
          signal.removeEventListener('abort', onAbort);
          resolve(value);
        },
        (error) => {
          signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      );
    });
  }

  #drop(job: Job) {
    const index = this.#queue.indexOf(job);
    if (index !== -1) this.#queue.splice(index, 1);
    if (job.key !== undefined && this.#byKey.get(job.key) === job) this.#byKey.delete(job.key);
    job.reject(abortError());
  }

  #pump() {
    while (
      this.#activeInteractive === 0 &&
      this.#activeThumbnail < this.#thumbnailConcurrency &&
      this.#queue.length > 0
    ) {
      this.#start(this.#queue.pop()!);
    }
  }

  #start(job: Job) {
    job.started = true;
    const interactive = job.priority === 'interactive';
    if (interactive) this.#activeInteractive++;
    else this.#activeThumbnail++;

    let run: Promise<unknown>;
    try {
      run = Promise.resolve(job.task());
    } catch (error) {
      run = Promise.reject(error);
    }
    run
      .finally(() => {
        if (interactive) this.#activeInteractive--;
        else this.#activeThumbnail--;
        if (job.key !== undefined && this.#byKey.get(job.key) === job) this.#byKey.delete(job.key);
      })
      .then(job.resolve, job.reject)
      .finally(() => this.#pump());
  }
}
