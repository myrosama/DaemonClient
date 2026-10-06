import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  classifyMedia,
  isAbortError,
  isTrustedMessageSource,
  MediaScheduler,
  parseViewingMessage,
  rateLimitDelay,
  RetryAfterError,
  TokenBucket,
  type MediaClass,
  type MediaTag,
} from './media-scheduler';

// A task whose completion the test controls, recording when it started.
function deferredTask<T = string>(log: string[], name: string, value?: T) {
  let resolve!: (result: T) => void;
  let reject!: (error: unknown) => void;
  const done = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  const task = () => {
    log.push(name);
    return done;
  };
  return { task, finish: () => resolve((value ?? name) as T), fail: (error: unknown) => reject(error) };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

// Generous limits so a test only meets the limit it is about.
const roomy = { maxConcurrent: 6, reservedForOpened: 1, maxNext: 2, rate: 1000, burst: 1000 };

const tag = (assetId: string, kind: MediaTag['kind'] = 'thumbnail', size = 'thumbnail'): MediaTag => ({
  assetId,
  kind,
  size,
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('classifyMedia', () => {
  it('puts grid thumbnails in VISIBLE', () => {
    expect(classifyMedia(tag('a'))).toBe('visible');
    // No size param (album covers, map markers) resolves to the grid thumb too.
    expect(classifyMedia(tag('a', 'thumbnail', ''), 'b')).toBe('visible');
  });

  it('puts what the viewer shows in OPENED', () => {
    expect(classifyMedia(tag('a', 'thumbnail', 'preview'), 'a')).toBe('opened');
    expect(classifyMedia(tag('a', 'thumbnail', 'fullsize'), 'a')).toBe('opened');
    expect(classifyMedia(tag('a', 'original', ''), 'a')).toBe('opened');
    expect(classifyMedia(tag('a', 'playback', ''), 'a')).toBe('opened');
    // The viewer's own placeholder thumbnail is part of what is opened.
    expect(classifyMedia(tag('a'), 'a')).toBe('opened');
  });

  it('puts other non-thumbnail media (neighbour preloads, hover playback) in NEXT', () => {
    expect(classifyMedia(tag('b', 'thumbnail', 'preview'), 'a')).toBe('next');
    expect(classifyMedia(tag('b', 'original', ''), 'a')).toBe('next');
    expect(classifyMedia(tag('b', 'playback', ''))).toBe('next');
  });
});

describe('viewing hint messages', () => {
  it('accepts an asset id or null', () => {
    expect(parseViewingMessage({ type: 'viewing', assetId: 'b4a3c1d2-0000-4000-8000-00000000abcd' })).toEqual({
      assetId: 'b4a3c1d2-0000-4000-8000-00000000abcd',
    });
    // eslint-disable-next-line unicorn/no-null -- the page posts null when the viewer closes
    expect(parseViewingMessage({ type: 'viewing', assetId: null })).toEqual({ assetId: undefined });
  });

  it('ignores malformed messages', () => {
    for (const data of [
      undefined,
      'viewing',
      { type: 'viewing' },
      { type: 'viewing', assetId: 42 },
      { type: 'viewing', assetId: '' },
      { type: 'viewing', assetId: '../../etc' },
      { type: 'viewing', assetId: 'x'.repeat(100) },
      { type: 'other', assetId: 'abc' },
    ]) {
      expect(parseViewingMessage(data)).toBeUndefined();
    }
  });

  it('trusts only same-origin window clients', () => {
    const origin = 'https://photos.example';
    expect(isTrustedMessageSource({ type: 'window', url: 'https://photos.example/photos' }, origin)).toBe(true);
    expect(isTrustedMessageSource({ type: 'window', url: 'https://evil.example/' }, origin)).toBe(false);
    expect(isTrustedMessageSource({ type: 'worker', url: 'https://photos.example/w.js' }, origin)).toBe(false);
    expect(isTrustedMessageSource({ type: 'window', url: 'not a url' }, origin)).toBe(false);
    expect(isTrustedMessageSource(undefined, origin)).toBe(false);
  });
});

describe('MediaScheduler — classes and slots', () => {
  it('dequeues the highest class first', async () => {
    const s = new MediaScheduler({ ...roomy, maxConcurrent: 2, reservedForOpened: 1 });
    const log: string[] = [];
    const blocker = deferredTask(log, 'blocker');
    void s.schedule({ class: 'visible' }, blocker.task);
    await flush();
    const tasks = {
      background: deferredTask(log, 'background'),
      visible: deferredTask(log, 'visible'),
      next: deferredTask(log, 'next'),
    };
    void s.schedule({ class: 'background' }, tasks.background.task);
    void s.schedule({ class: 'visible' }, tasks.visible.task);
    void s.schedule({ class: 'next' }, tasks.next.task);
    await flush();
    expect(log).toEqual(['blocker']); // one lower slot only; the other is reserved

    blocker.finish();
    await flush();
    tasks.next.finish();
    await flush();
    tasks.visible.finish();
    await flush();
    expect(log).toEqual(['blocker', 'next', 'visible', 'background']);
  });

  it('keeps a reserved slot so OPENED never waits for one', async () => {
    const s = new MediaScheduler({ ...roomy, maxConcurrent: 3, reservedForOpened: 1 });
    const log: string[] = [];
    for (let index = 0; index < 5; index++) {
      void s.schedule({ class: 'visible' }, deferredTask(log, `v${index}`).task);
    }
    await flush();
    expect(log).toHaveLength(2); // 3 slots, 1 reserved

    void s.schedule({ class: 'opened' }, deferredTask(log, 'opened').task);
    await flush();
    expect(log.at(-1)).toBe('opened');
    expect(s.stats().running).toMatchObject({ opened: 1, visible: 2 });
  });

  it('suspends lower classes while OPENED is in flight and resumes after (D17)', async () => {
    const s = new MediaScheduler(roomy);
    const log: string[] = [];
    const opened = deferredTask(log, 'opened');
    const running = deferredTask(log, 'running-thumb');
    void s.schedule({ class: 'visible' }, running.task);
    await flush();
    void s.schedule({ class: 'opened' }, opened.task);
    void s.schedule({ class: 'visible' }, deferredTask(log, 'thumb').task);
    void s.schedule({ class: 'next' }, deferredTask(log, 'next').task);
    await flush();
    expect(log).toEqual(['running-thumb', 'opened']);

    running.finish(); // running work finishes; still nothing lower starts
    await flush();
    expect(log).toEqual(['running-thumb', 'opened']);

    opened.finish();
    await flush();
    expect(log).toEqual(['running-thumb', 'opened', 'next', 'thumb']);
  });

  it('lifts the suspension when a stuck OPENED job exceeds maxSuspendMs', async () => {
    const s = new MediaScheduler({ ...roomy, maxSuspendMs: 5000 });
    const log: string[] = [];
    void s.schedule({ class: 'opened' }, deferredTask(log, 'stuck').task);
    void s.schedule({ class: 'visible' }, deferredTask(log, 'thumb').task);
    await flush();
    expect(log).toEqual(['stuck']);
    await vi.advanceTimersByTimeAsync(5000);
    expect(log).toEqual(['stuck', 'thumb']);
  });

  it('does not let NEXT starve VISIBLE beyond its own cap', async () => {
    const s = new MediaScheduler({ ...roomy, maxConcurrent: 4, reservedForOpened: 1, maxNext: 2 });
    const log: string[] = [];
    for (let index = 0; index < 6; index++) {
      void s.schedule({ class: 'next' }, deferredTask(log, `n${index}`).task);
    }
    void s.schedule({ class: 'visible' }, deferredTask(log, 'thumb').task);
    await flush();
    expect(log).toEqual(['n0', 'n1', 'thumb']);
  });

  it('serves VISIBLE newest request first (LIFO)', async () => {
    const s = new MediaScheduler({ ...roomy, maxConcurrent: 2, reservedForOpened: 1 });
    const log: string[] = [];
    const first = deferredTask(log, 'first');
    void s.schedule({ class: 'visible' }, first.task);
    await flush();
    const rest = ['older', 'middle', 'newest'].map((name) => deferredTask(log, name));
    for (const task of rest) void s.schedule({ class: 'visible' }, task.task);
    first.finish();
    await flush();
    rest[2].finish();
    await flush();
    rest[1].finish();
    await flush();
    expect(log).toEqual(['first', 'newest', 'middle', 'older']);
  });

  it('moves a re-requested VISIBLE job to the front', async () => {
    const s = new MediaScheduler({ ...roomy, maxConcurrent: 2, reservedForOpened: 1 });
    const log: string[] = [];
    const first = deferredTask(log, 'first');
    void s.schedule({ class: 'visible' }, first.task);
    await flush();
    void s.schedule({ class: 'visible', key: 'a' }, deferredTask(log, 'a').task);
    void s.schedule({ class: 'visible', key: 'b' }, deferredTask(log, 'b').task);
    void s.schedule({ class: 'visible', key: 'a' }, deferredTask(log, 'a-again').task);
    first.finish();
    await flush();
    expect(log).toEqual(['first', 'a']);
  });

  it('raises the priority of a queued job requested again at a higher class', async () => {
    const s = new MediaScheduler({ ...roomy, maxConcurrent: 2, reservedForOpened: 1 });
    const log: string[] = [];
    const blocker = deferredTask(log, 'blocker');
    void s.schedule({ class: 'visible' }, blocker.task);
    await flush();
    const thumb = deferredTask(log, 'thumb');
    const first = s.schedule({ class: 'visible', key: 'k' }, thumb.task);
    const second = s.schedule({ class: 'opened', key: 'k' }, deferredTask(log, 'unused').task);
    await flush();
    expect(log).toEqual(['blocker', 'thumb']); // took the reserved slot at once
    thumb.finish();
    await expect(first).resolves.toBe('thumb');
    await expect(second).resolves.toBe('thumb');
  });

  it('raises a running job so it frees its lower slot and suspends lower work', async () => {
    const s = new MediaScheduler({ ...roomy, maxConcurrent: 2, reservedForOpened: 1 });
    const log: string[] = [];
    const t: MediaTag = tag('a', 'thumbnail', 'preview');
    const preview = deferredTask(log, 'preview');
    void s.schedule({ class: 'next', tag: t }, preview.task);
    void s.schedule({ class: 'visible' }, deferredTask(log, 'thumb').task);
    await flush();
    expect(log).toEqual(['preview']); // the preview holds the only lower slot
    s.reclassify((jobTag) => classifyMedia(jobTag, 'a'));
    await flush();
    expect(s.stats().running).toMatchObject({ opened: 1, next: 0 });
    expect(log).toEqual(['preview']); // now OPENED: its slot is free, but D17 suspends lower work
    preview.finish();
    await flush();
    expect(log).toEqual(['preview', 'thumb']);
  });
});

describe('MediaScheduler — coalescing and cancellation', () => {
  it('shares one run between identical requests', async () => {
    const s = new MediaScheduler(roomy);
    const log: string[] = [];
    const job = deferredTask(log, 'shared');
    const a = s.schedule({ class: 'visible', key: 'k' }, job.task);
    const b = s.schedule({ class: 'visible', key: 'k' }, job.task);
    await flush();
    job.finish();
    await expect(a).resolves.toBe('shared');
    await expect(b).resolves.toBe('shared');
    expect(log).toEqual(['shared']);
  });

  it('drops a queued job only when nobody waits for it any more (refcount)', async () => {
    const s = new MediaScheduler({ ...roomy, maxConcurrent: 2, reservedForOpened: 1 });
    const log: string[] = [];
    const blocker = deferredTask(log, 'blocker');
    void s.schedule({ class: 'visible' }, blocker.task);
    await flush();
    const one = new AbortController();
    const two = new AbortController();
    const job = deferredTask(log, 'shared');
    const a = s.schedule({ class: 'visible', key: 'k', signal: one.signal }, job.task);
    const b = s.schedule({ class: 'visible', key: 'k', signal: two.signal }, job.task);

    one.abort(); // one tile scrolled away; the other still wants it
    blocker.finish();
    await flush();
    expect(log).toEqual(['blocker', 'shared']);
    job.finish();
    // The hint can't tell which identical tile cancelled, so nobody is failed.
    await expect(a).resolves.toBe('shared');
    await expect(b).resolves.toBe('shared');
  });

  it('drops the queued job once every waiter has cancelled', async () => {
    const s = new MediaScheduler({ ...roomy, maxConcurrent: 2, reservedForOpened: 1 });
    const log: string[] = [];
    void s.schedule({ class: 'visible' }, deferredTask(log, 'blocker').task);
    await flush();
    const one = new AbortController();
    const two = new AbortController();
    const a = s.schedule({ class: 'visible', key: 'k', signal: one.signal }, deferredTask(log, 'x').task);
    const b = s.schedule({ class: 'visible', key: 'k', signal: two.signal }, deferredTask(log, 'x').task);
    one.abort();
    two.abort();
    await expect(a).rejects.toSatisfy(isAbortError);
    await expect(b).rejects.toSatisfy(isAbortError);
    expect(s.stats().queued.visible).toBe(0);
  });

  it('never drops a job a caller without a signal waits for', async () => {
    const s = new MediaScheduler({ ...roomy, maxConcurrent: 2, reservedForOpened: 1 });
    const log: string[] = [];
    const blocker = deferredTask(log, 'blocker');
    void s.schedule({ class: 'visible' }, blocker.task);
    await flush();
    const controller = new AbortController();
    const job = deferredTask(log, 'x');
    void s.schedule({ class: 'visible', key: 'k', signal: controller.signal }, job.task);
    const pinned = s.schedule({ class: 'visible', key: 'k' }, job.task);
    controller.abort();
    blocker.finish();
    await flush();
    job.finish();
    await expect(pinned).resolves.toBe('x');
  });

  it('rejects at once when the signal is already aborted', async () => {
    const s = new MediaScheduler(roomy);
    const task = vi.fn(() => Promise.resolve('x'));
    await expect(s.schedule({ class: 'visible', signal: AbortSignal.abort() }, task)).rejects.toSatisfy(isAbortError);
    expect(task).not.toHaveBeenCalled();
  });
});

describe('MediaScheduler — rate limit', () => {
  it('takes a token only when a job starts; cancelled-while-waiting spends nothing', async () => {
    const s = new MediaScheduler({ ...roomy, rate: 1, burst: 2 });
    const log: string[] = [];
    void s.schedule({ class: 'visible' }, () => (log.push('a'), Promise.resolve()));
    void s.schedule({ class: 'visible' }, () => (log.push('b'), Promise.resolve()));
    await flush();
    expect(s.stats().tokens).toBeCloseTo(0);

    // 20 tiles flung past while the bucket is empty, all cancelled.
    const controllers = Array.from({ length: 20 }, () => new AbortController());
    const flung = controllers.map((controller, index) =>
      s.schedule({ class: 'visible', signal: controller.signal }, () => (log.push(`f${index}`), Promise.resolve())),
    );
    for (const controller of controllers) controller.abort();
    await Promise.allSettled(flung);
    void s.schedule({ class: 'visible' }, () => (log.push('wanted'), Promise.resolve()));

    await vi.advanceTimersByTimeAsync(1000);
    expect(log).toEqual(['a', 'b', 'wanted']); // the one token went to the wanted tile
  });

  it('TokenBucket refills at its rate up to the burst', () => {
    let now = 0;
    const bucket = new TokenBucket({ rate: 10, burst: 3, now: () => now });
    expect([bucket.tryTake(), bucket.tryTake(), bucket.tryTake(), bucket.tryTake()]).toEqual([true, true, true, false]);
    expect(bucket.msUntilToken()).toBe(100);
    now = 10_000;
    expect(bucket.tokens()).toBe(3);
  });
});

describe('MediaScheduler — shared 429 pause', () => {
  it('pauses everyone once for retry_after and retries the job after it', async () => {
    const s = new MediaScheduler(roomy);
    const log: string[] = [];
    let calls = 0;
    const limited = s.schedule({ class: 'visible' }, () => {
      calls++;
      log.push(`limited#${calls}`);
      return calls === 1 ? Promise.reject(new RetryAfterError(3000)) : Promise.resolve('ok');
    });
    await flush();
    void s.schedule({ class: 'opened' }, () => (log.push('opened'), Promise.resolve()));
    await vi.advanceTimersByTimeAsync(2999);
    expect(log).toEqual(['limited#1']); // even OPENED waits out a 429
    await vi.advanceTimersByTimeAsync(1);
    await expect(limited).resolves.toBe('ok');
    expect(log).toEqual(['limited#1', 'opened', 'limited#2']);
  });

  it('gives up after maxRetries', async () => {
    const s = new MediaScheduler({ ...roomy, maxRetries: 1 });
    const result = s.schedule({ class: 'visible' }, () => Promise.reject(new RetryAfterError(100)));
    const assertion = expect(result).rejects.toBeInstanceOf(RetryAfterError);
    await vi.advanceTimersByTimeAsync(500);
    await assertion;
  });

  it('reads the delay from HTTP 429, Telegram JSON, and 503 + Retry-After', async () => {
    expect(await rateLimitDelay(new Response(undefined, { status: 429, headers: { 'Retry-After': '7' } }))).toBe(7000);
    const telegram = Response.json({ ok: false, error_code: 429, parameters: { retry_after: 12 } }, {
      status: 429,
      headers: { 'Content-Type': 'application/json' },
    });
    expect(await rateLimitDelay(telegram)).toBe(12_000);
    // Telegram's JSON can arrive under a 200 when relayed.
    const relayed = Response.json({ ok: false, error_code: 429, parameters: { retry_after: 2 } }, {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
    expect(await rateLimitDelay(relayed)).toBe(2000);
    expect(await rateLimitDelay(new Response(undefined, { status: 429 }))).toBe(2000); // no hint: default
    // /proxy's temporary database error: a SHORT pause, capped.
    expect(await rateLimitDelay(new Response(undefined, { status: 503, headers: { 'Retry-After': '30' } }))).toBe(5000);
    expect(await rateLimitDelay(new Response(undefined, { status: 503 }))).toBeUndefined();
    expect(await rateLimitDelay(new Response('{}', { status: 200 }))).toBeUndefined();
    expect(await rateLimitDelay(new Response(undefined, { status: 403 }))).toBeUndefined();
  });
});

describe('MediaScheduler — clear() on logout / user switch', () => {
  it('rejects queued and running work, clears the pause, and frees the slots', async () => {
    const s = new MediaScheduler({ ...roomy, maxConcurrent: 2, reservedForOpened: 1 });
    const log: string[] = [];
    const running = deferredTask(log, 'running');
    const a = s.schedule({ class: 'visible' }, running.task);
    const b = s.schedule({ class: 'visible' }, deferredTask(log, 'queued').task);
    s.pause(60_000);
    await flush();
    s.clear();
    await expect(a).rejects.toSatisfy(isAbortError);
    await expect(b).rejects.toSatisfy(isAbortError);

    // The new session starts at once: no pause, no slot held by old work.
    void s.schedule({ class: 'visible' }, deferredTask(log, 'new-session').task);
    await flush();
    expect(log).toEqual(['running', 'new-session']);

    running.finish(); // the old job landing later changes nothing
    await flush();
    expect(s.stats().running.visible).toBe(1);
  });
});

describe('MediaScheduler — classes used by the SW', () => {
  it.each<[MediaClass, number]>([
    ['opened', 3],
    ['next', 2],
    ['visible', 1],
    ['background', 0],
  ])('%s has rank %d', (mediaClass, rank) => {
    expect(MediaScheduler.rank(mediaClass)).toBe(rank);
  });
});
