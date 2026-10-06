// Media fetch scheduler — decides which media request may spend the user's
// worker invocations and Telegram rate limit next.
//
// Ports the design of Nuke's image pipeline (https://github.com/kean/Nuke,
// MIT License, Copyright (c) 2015-2026 Alexander Grebenyuk): the priority
// queue of Sources/Nuke/Pipeline/TaskQueue.swift (per-priority buckets, a
// concurrency limit with reserved slots, priority changes on queued and running
// work, isSuspended) and the token bucket of
// Sources/Nuke/Internal/RateLimiter.swift (work cancelled while waiting never
// spends a token). Written fresh in TypeScript; see NOTICE.
//
// What it adds, per docs/mobile/SPEC.md §4.9 (D15, D17) — the mobile core
// follows the same rules:
//   - Classes, highest first: OPENED (what the viewer shows) > NEXT (neighbour
//     preloads, hover playback, other media) > VISIBLE (grid thumbnails) >
//     BACKGROUND.
//   - D17: while OPENED work is in flight nothing lower STARTS (running work
//     finishes); one slot is reserved so OPENED never waits for one. A stuck
//     OPENED job lifts the suspension after `maxSuspendMs`.
//   - VISIBLE is newest-request-first: after a long scroll the tiles on screen
//     were requested last.
//   - NEXT has its own cap, so it can't starve VISIBLE.
//   - A 429 (or /proxy's 503 + Retry-After) pauses EVERYONE once; the job that
//     hit it goes back in its queue instead of retrying on its own.
//   - Identical requests share one job; a queued job is dropped only once
//     every caller has cancelled. A started job runs to completion — its
//     result is cached, so the next visit is free.
//
// Pure (no service-worker globals) so it unit-tests in plain vitest.

import type { AssetBinaryKind } from './telegram-media';

export type MediaClass = 'opened' | 'next' | 'visible' | 'background';

const RANK: Record<MediaClass, number> = { opened: 3, next: 2, visible: 1, background: 0 };
const CLASSES: MediaClass[] = ['opened', 'next', 'visible', 'background'];

/** What a request is for, so its class can be re-decided when the viewer moves. */
export interface MediaTag {
  assetId: string;
  kind: AssetBinaryKind;
  size: string;
}

/** Class of a media request, given the asset the viewer is showing (if any). */
export function classifyMedia(tag: MediaTag, viewingAssetId?: string): MediaClass {
  if (viewingAssetId !== undefined && tag.assetId === viewingAssetId) {
    return 'opened';
  }
  // Mirrors selectFileIds: preview/fullsize are the viewer's renditions; an
  // empty or unknown size resolves to the grid thumbnail.
  const gridThumbnail = tag.kind === 'thumbnail' && tag.size !== 'preview' && tag.size !== 'fullsize';
  return gridThumbnail ? 'visible' : 'next';
}

const ASSET_ID = /^[\da-f-]{1,64}$/i;

/**
 * `{type:'viewing', assetId}` from the page — `assetId: null` when the viewer
 * closed, returned as `{assetId: undefined}`. Undefined when malformed.
 */
export function parseViewingMessage(data: unknown): { assetId: string | undefined } | undefined {
  if (typeof data !== 'object' || data === null) {
    return undefined;
  }
  const { type, assetId } = data as { type?: unknown; assetId?: unknown };
  if (type !== 'viewing') {
    return undefined;
  }
  if (assetId === null) {
    return { assetId: undefined };
  }
  return typeof assetId === 'string' && ASSET_ID.test(assetId) ? { assetId: assetId.toLowerCase() } : undefined;
}

/** Messages are accepted only from our own pages, never from other workers or origins. */
export function isTrustedMessageSource(source: unknown, origin: string): boolean {
  if (typeof source !== 'object' || source === null) {
    return false;
  }
  const { type, url } = source as { type?: unknown; url?: unknown };
  if (type !== 'window' || typeof url !== 'string') {
    return false;
  }
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

export function abortError(): Error {
  return new DOMException('The media request was cancelled', 'AbortError');
}

export function isAbortError(error: unknown): boolean {
  return (error as { name?: unknown } | null)?.name === 'AbortError';
}

/** Thrown by a job that was rate-limited; the scheduler pauses everyone and re-queues it. */
export class RetryAfterError extends Error {
  constructor(readonly delayMs: number) {
    super(`rate limited, retry after ${delayMs} ms`);
    this.name = 'RetryAfterError';
  }
}

const DEFAULT_429_DELAY_MS = 2000;
const MAX_429_DELAY_MS = 60_000;
const MAX_503_DELAY_MS = 5000;

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/**
 * How long everyone should pause after this response, or undefined if it is
 * not a rate limit: HTTP 429 (Retry-After header), Telegram's JSON
 * `{error_code: 429, parameters: {retry_after}}` (whatever the HTTP status a
 * relay put on it), and /proxy's 503 + Retry-After (temporary database error,
 * a short pause). Does not consume the response body.
 */
export async function rateLimitDelay(response: Response): Promise<number | undefined> {
  const header = parseRetryAfter(response.headers.get('Retry-After'));
  if (response.status === 503) {
    return header === undefined ? undefined : Math.min(header, MAX_503_DELAY_MS);
  }
  let telegram: number | undefined;
  const json = (response.headers.get('Content-Type') ?? '').includes('application/json');
  if (json && (response.status === 429 || response.status === 200)) {
    try {
      const body = (await response.clone().json()) as {
        error_code?: unknown;
        parameters?: { retry_after?: unknown };
      };
      if (body?.error_code === 429) {
        const seconds = Number(body.parameters?.retry_after);
        telegram = Number.isFinite(seconds) ? seconds * 1000 : DEFAULT_429_DELAY_MS;
      }
    } catch {
      // Not JSON after all.
    }
  }
  if (response.status !== 429 && telegram === undefined) {
    return undefined;
  }
  return Math.min(telegram ?? header ?? DEFAULT_429_DELAY_MS, MAX_429_DELAY_MS);
}

/** Classic token bucket (Nuke's TokenBucket): starts full, refills at `rate` per second. */
export class TokenBucket {
  readonly #rate: number;
  readonly #burst: number;
  readonly #now: () => number;
  #tokens: number;
  #timestamp: number;

  constructor(options: { rate: number; burst: number; now?: () => number }) {
    this.#rate = options.rate;
    this.#burst = options.burst;
    this.#now = options.now ?? Date.now;
    this.#tokens = options.burst;
    this.#timestamp = this.#now();
  }

  tokens(): number {
    this.#refill();
    return this.#tokens;
  }

  tryTake(): boolean {
    this.#refill();
    if (this.#tokens < 1) {
      return false;
    }
    this.#tokens -= 1;
    return true;
  }

  msUntilToken(): number {
    this.#refill();
    return this.#tokens >= 1 ? 0 : Math.ceil(((1 - this.#tokens) / this.#rate) * 1000);
  }

  #refill() {
    const now = this.#now();
    this.#tokens = Math.min(this.#burst, this.#tokens + (this.#rate * Math.max(0, now - this.#timestamp)) / 1000);
    this.#timestamp = now;
  }
}

interface Job {
  key?: string;
  tag?: MediaTag;
  mediaClass: MediaClass;
  task: () => Promise<unknown>;
  epoch: number;
  started: boolean;
  startedAt: number;
  settled: boolean;
  /** Callers still waiting that can cancel. */
  waiters: number;
  /** A caller that can't cancel is waiting: never drop. */
  pinned: boolean;
  retries: number;
  promise: Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

export interface SchedulerOptions {
  /** Jobs running at once, all classes together. */
  maxConcurrent: number;
  /** Slots only OPENED may take (Nuke's reservedTaskCount). */
  reservedForOpened: number;
  /** NEXT jobs running at once, so neighbour preloads can't crowd out the grid. */
  maxNext: number;
  /** Token bucket: job starts per second, and how many may start back-to-back. */
  rate: number;
  burst: number;
  /** How many times a rate-limited job is re-queued before it fails. */
  maxRetries?: number;
  /** Longest an OPENED job may hold lower classes back (D17 safety valve). */
  maxSuspendMs?: number;
}

export interface ScheduleOptions {
  class: MediaClass;
  /** Coalesce: concurrent calls with the same key share one run. */
  key?: string;
  /** Lets reclassify() move the job when the viewer changes asset. */
  tag?: MediaTag;
  /** The caller's cancellation. Without one the caller can't cancel and the job is never dropped. */
  signal?: AbortSignal;
}

type Counts = Record<MediaClass, number>;

const zero = (): Counts => ({ opened: 0, next: 0, visible: 0, background: 0 });

export class MediaScheduler {
  static rank(mediaClass: MediaClass): number {
    return RANK[mediaClass];
  }

  readonly #options: Required<SchedulerOptions>;
  readonly #bucket: TokenBucket;
  readonly #queues: Record<MediaClass, Job[]> = { opened: [], next: [], visible: [], background: [] };
  readonly #running = new Set<Job>();
  readonly #byKey = new Map<string, Job>();
  #pausedUntil = 0;
  #epoch = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #timerAt = 0;

  constructor(options: SchedulerOptions) {
    this.#options = { maxRetries: 3, maxSuspendMs: 15_000, ...options };
    this.#bucket = new TokenBucket({ rate: options.rate, burst: options.burst });
  }

  stats() {
    const running = zero();
    for (const job of this.#running) running[job.mediaClass]++;
    const queued = zero();
    for (const mediaClass of CLASSES) queued[mediaClass] = this.#queues[mediaClass].length;
    return { running, queued, tokens: this.#bucket.tokens(), pausedUntil: this.#pausedUntil };
  }

  schedule<T>(options: ScheduleOptions, task: () => Promise<T>): Promise<T> {
    const { key, signal } = options;
    if (signal?.aborted) {
      return Promise.reject(abortError());
    }

    let job = key === undefined ? undefined : this.#byKey.get(key);
    if (job) {
      if (RANK[options.class] > RANK[job.mediaClass]) {
        this.#setClass(job, options.class);
      } else if (!job.started && job.mediaClass === 'visible') {
        // Requested again: it's on screen now, so it's the newest request.
        this.#remove(job);
        this.#queues.visible.push(job);
      }
    } else {
      job = this.#createJob(options, task);
      this.#queues[job.mediaClass].push(job);
    }

    if (signal) {
      job.waiters++;
      const current = job;
      signal.addEventListener('abort', () => this.#release(current), { once: true });
    } else {
      job.pinned = true;
    }
    this.#pump();
    return job.promise as Promise<T>;
  }

  /** Re-decide the class of every tagged job, e.g. when the viewer changes asset. */
  reclassify(classify: (tag: MediaTag) => MediaClass) {
    for (const job of [...this.#running, ...CLASSES.flatMap((mediaClass) => this.#queues[mediaClass])]) {
      if (job.tag) {
        this.#setClass(job, classify(job.tag));
      }
    }
    this.#pump();
  }

  /** One shared pause for everyone (429). Never shortens a pause already running. */
  pause(ms: number) {
    this.#pausedUntil = Math.max(this.#pausedUntil, Date.now() + ms);
    this.#pump();
  }

  /** Logout / user switch: fail all work, forget pauses; old in-flight work can't resolve or hold slots. */
  clear() {
    this.#epoch++;
    const jobs = [...this.#running, ...CLASSES.flatMap((mediaClass) => this.#queues[mediaClass])];
    this.#running.clear();
    for (const mediaClass of CLASSES) this.#queues[mediaClass] = [];
    this.#byKey.clear();
    this.#pausedUntil = 0;
    this.#clearTimer();
    for (const job of jobs) {
      job.settled = true;
      job.reject(abortError());
    }
  }

  #createJob(options: ScheduleOptions, task: () => Promise<unknown>): Job {
    let resolve!: (value: unknown) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<unknown>((onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    });
    // A job every caller abandoned rejects with nobody listening.
    promise.catch(() => {});
    const job: Job = {
      key: options.key,
      tag: options.tag,
      mediaClass: options.class,
      task,
      epoch: this.#epoch,
      started: false,
      startedAt: 0,
      settled: false,
      waiters: 0,
      pinned: false,
      retries: 0,
      promise,
      resolve,
      reject,
    };
    if (options.key !== undefined) {
      this.#byKey.set(options.key, job);
    }
    return job;
  }

  #release(job: Job) {
    job.waiters--;
    if (!job.started && !job.settled && !job.pinned && job.waiters <= 0) {
      this.#remove(job);
      this.#forget(job);
      job.settled = true;
      job.reject(abortError());
    }
  }

  #setClass(job: Job, mediaClass: MediaClass) {
    if (job.mediaClass === mediaClass) {
      return;
    }
    const queued = !job.started && this.#remove(job);
    job.mediaClass = mediaClass;
    if (queued) {
      this.#queues[mediaClass].push(job);
    } else if (job.started && mediaClass === 'opened') {
      // Its suspension of lower classes counts from now.
      job.startedAt = Date.now();
    }
  }

  #remove(job: Job): boolean {
    const queue = this.#queues[job.mediaClass];
    const index = queue.indexOf(job);
    if (index === -1) {
      return false;
    }
    queue.splice(index, 1);
    return true;
  }

  #forget(job: Job) {
    if (job.key !== undefined && this.#byKey.get(job.key) === job) {
      this.#byKey.delete(job.key);
    }
  }

  /** The next job allowed to start now, by class, slots and D17; undefined if none. */
  #pick(now: number): Job | undefined {
    const { maxConcurrent, reservedForOpened, maxNext, maxSuspendMs } = this.#options;
    if (this.#running.size >= maxConcurrent) {
      return undefined;
    }
    if (this.#queues.opened.length > 0) {
      return this.#queues.opened[0];
    }
    let lower = 0;
    let next = 0;
    for (const job of this.#running) {
      if (job.mediaClass === 'opened') {
        if (now - job.startedAt < maxSuspendMs) {
          return undefined; // D17: OPENED in flight, nothing lower starts
        }
        continue;
      }
      lower++;
      if (job.mediaClass === 'next') {
        next++;
      }
    }
    if (lower >= Math.max(1, maxConcurrent - reservedForOpened)) {
      return undefined;
    }
    if (this.#queues.next.length > 0 && next < maxNext) {
      return this.#queues.next[0];
    }
    if (this.#queues.visible.length > 0) {
      return this.#queues.visible.at(-1); // newest first
    }
    return this.#queues.background[0];
  }

  #pump() {
    for (;;) {
      const now = Date.now();
      if (now < this.#pausedUntil) {
        this.#wakeAt(this.#pausedUntil);
        return;
      }
      const job = this.#pick(now);
      if (!job) {
        this.#wakeForSuspension(now);
        return;
      }
      // Nuke's rule: a token is spent only by work that actually starts.
      if (!this.#bucket.tryTake()) {
        this.#wakeAt(now + this.#bucket.msUntilToken());
        return;
      }
      this.#remove(job);
      this.#start(job);
    }
  }

  // A long-running OPENED job lifts its suspension after maxSuspendMs.
  #wakeForSuspension(now: number) {
    const waiting = CLASSES.some((mediaClass) => mediaClass !== 'opened' && this.#queues[mediaClass].length > 0);
    if (!waiting) {
      return;
    }
    let earliest = Infinity;
    for (const job of this.#running) {
      if (job.mediaClass === 'opened') {
        const expiry = job.startedAt + this.#options.maxSuspendMs;
        if (expiry > now) {
          earliest = Math.min(earliest, expiry);
        }
      }
    }
    if (earliest !== Infinity) {
      this.#wakeAt(earliest);
    }
  }

  #wakeAt(at: number) {
    if (this.#timer !== undefined && this.#timerAt <= at) {
      return;
    }
    this.#clearTimer();
    this.#timerAt = at;
    this.#timer = setTimeout(
      () => {
        this.#timer = undefined;
        this.#pump();
      },
      Math.max(0, at - Date.now()),
    );
  }

  #clearTimer() {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
  }

  #start(job: Job) {
    job.started = true;
    job.startedAt = Date.now();
    this.#running.add(job);

    let run: Promise<unknown>;
    try {
      run = Promise.resolve(job.task());
    } catch (error) {
      run = Promise.reject(error);
    }
    run.then(
      (value) =>
        this.#finish(job, () => {
          this.#forget(job);
          job.settled = true;
          job.resolve(value);
        }),
      (error: unknown) => this.#finish(job, () => this.#failed(job, error)),
    );
  }

  #finish(job: Job, settle: () => void) {
    if (job.epoch !== this.#epoch || job.settled) {
      return; // cleared (logout) while running: already rejected, slot already freed
    }
    this.#running.delete(job);
    settle();
    this.#pump();
  }

  #failed(job: Job, error: unknown) {
    const wanted = job.pinned || job.waiters > 0;
    if (error instanceof RetryAfterError && wanted && job.retries < this.#options.maxRetries) {
      // Back in its queue at the front of the pick order; the pause covers everyone.
      job.retries++;
      job.started = false;
      if (job.mediaClass === 'visible') {
        this.#queues.visible.push(job);
      } else {
        this.#queues[job.mediaClass].unshift(job);
      }
      this.#pausedUntil = Math.max(this.#pausedUntil, Date.now() + error.delayMs);
      return;
    }
    if (error instanceof RetryAfterError) {
      this.#pausedUntil = Math.max(this.#pausedUntil, Date.now() + error.delayMs);
    }
    this.#forget(job);
    job.settled = true;
    job.reject(error);
  }
}

