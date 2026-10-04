import { describe, expect, it } from 'vitest';
import { classifyMediaRequest, isAbortError, MediaScheduler } from './media-scheduler';

// A task whose completion the test controls, recording when it started.
function deferredTask<T = string>(log: string[], name: string, value?: T) {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const done = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const task = () => {
    log.push(name);
    return done;
  };
  return { task, finish: () => resolve((value ?? name) as T), fail: (e: unknown) => reject(e) };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('classifyMediaRequest', () => {
  it('grid-size thumbnails are background work', () => {
    expect(classifyMediaRequest('thumbnail', 'thumbnail')).toBe('thumbnail');
    // No size param (album covers, map markers) resolves to the grid thumb too.
    expect(classifyMediaRequest('thumbnail', '')).toBe('thumbnail');
  });

  it('viewer renditions, originals and video are interactive', () => {
    expect(classifyMediaRequest('thumbnail', 'preview')).toBe('interactive');
    expect(classifyMediaRequest('thumbnail', 'fullsize')).toBe('interactive');
    expect(classifyMediaRequest('original', '')).toBe('interactive');
    expect(classifyMediaRequest('playback', '')).toBe('interactive');
  });
});

describe('MediaScheduler', () => {
  it('caps concurrent thumbnail work', async () => {
    const s = new MediaScheduler({ thumbnailConcurrency: 2 });
    const log: string[] = [];
    const a = deferredTask(log, 'a');
    const b = deferredTask(log, 'b');
    const c = deferredTask(log, 'c');
    s.schedule({ priority: 'thumbnail' }, a.task);
    s.schedule({ priority: 'thumbnail' }, b.task);
    const pc = s.schedule({ priority: 'thumbnail' }, c.task);
    await tick();
    expect(log).toEqual(['a', 'b']);
    expect(s.stats()).toEqual({ interactive: 0, thumbnail: 2, queued: 1 });

    a.finish();
    await tick();
    expect(log).toEqual(['a', 'b', 'c']);
    c.finish();
    await expect(pc).resolves.toBe('c');
  });

  it('runs queued thumbnails newest-first', async () => {
    const s = new MediaScheduler({ thumbnailConcurrency: 1 });
    const log: string[] = [];
    const first = deferredTask(log, 'first');
    s.schedule({ priority: 'thumbnail' }, first.task);
    const tasks = ['old', 'mid', 'new'].map((n) => deferredTask(log, n));
    for (const t of tasks) s.schedule({ priority: 'thumbnail' }, t.task);
    await tick();

    first.finish();
    await tick();
    expect(log).toEqual(['first', 'new']);
    tasks[2].finish();
    await tick();
    expect(log).toEqual(['first', 'new', 'mid']);
    tasks[1].finish();
    await tick();
    expect(log).toEqual(['first', 'new', 'mid', 'old']);
  });

  it('starts interactive work immediately even when thumbnails fill every slot', async () => {
    const s = new MediaScheduler({ thumbnailConcurrency: 1 });
    const log: string[] = [];
    s.schedule({ priority: 'thumbnail' }, deferredTask(log, 't1').task);
    s.schedule({ priority: 'thumbnail' }, deferredTask(log, 't2').task);
    const open = deferredTask(log, 'open', 'bytes');
    const p = s.schedule({ priority: 'interactive' }, open.task);
    await tick();
    expect(log).toEqual(['t1', 'open']);
    open.finish();
    await expect(p).resolves.toBe('bytes');
  });

  it('holds new thumbnail work while interactive work is in flight, then resumes', async () => {
    const s = new MediaScheduler({ thumbnailConcurrency: 4 });
    const log: string[] = [];
    const inflightThumb = deferredTask(log, 'inflight');
    const pInflight = s.schedule({ priority: 'thumbnail' }, inflightThumb.task);
    await tick();

    const open = deferredTask(log, 'open');
    s.schedule({ priority: 'interactive' }, open.task);
    const later = deferredTask(log, 'later');
    const pLater = s.schedule({ priority: 'thumbnail' }, later.task);
    await tick();
    // Slots are free, but the opened image owns the rate limit.
    expect(log).toEqual(['inflight', 'open']);

    // An already-running thumbnail is allowed to finish.
    inflightThumb.finish();
    await expect(pInflight).resolves.toBe('inflight');
    await tick();
    expect(log).toEqual(['inflight', 'open']);

    open.finish();
    await tick();
    expect(log).toEqual(['inflight', 'open', 'later']);
    later.finish();
    await expect(pLater).resolves.toBe('later');
  });

  it('keeps thumbnails paused until every interactive job has drained', async () => {
    const s = new MediaScheduler({ thumbnailConcurrency: 4 });
    const log: string[] = [];
    const v1 = deferredTask(log, 'v1');
    const v2 = deferredTask(log, 'v2');
    s.schedule({ priority: 'interactive' }, v1.task);
    s.schedule({ priority: 'interactive' }, v2.task);
    s.schedule({ priority: 'thumbnail' }, deferredTask(log, 'thumb').task);
    await tick();
    v1.finish();
    await tick();
    expect(log).toEqual(['v1', 'v2']);
    v2.finish();
    await tick();
    expect(log).toEqual(['v1', 'v2', 'thumb']);
  });

  it('resumes thumbnails after interactive work fails', async () => {
    const s = new MediaScheduler({ thumbnailConcurrency: 4 });
    const log: string[] = [];
    const open = deferredTask(log, 'open');
    const pOpen = s.schedule({ priority: 'interactive' }, open.task);
    s.schedule({ priority: 'thumbnail' }, deferredTask(log, 'thumb').task);
    open.fail(new Error('telegram down'));
    await expect(pOpen).rejects.toThrow('telegram down');
    await tick();
    expect(log).toEqual(['open', 'thumb']);
  });

  it('drops a queued thumbnail whose request was aborted', async () => {
    const s = new MediaScheduler({ thumbnailConcurrency: 1 });
    const log: string[] = [];
    const busy = deferredTask(log, 'busy');
    s.schedule({ priority: 'thumbnail' }, busy.task);
    const ac = new AbortController();
    const pStale = s.schedule({ priority: 'thumbnail', signal: ac.signal }, deferredTask(log, 'stale').task);
    const keep = deferredTask(log, 'keep');
    s.schedule({ priority: 'thumbnail' }, keep.task);
    await tick();

    ac.abort();
    await expect(pStale).rejects.toSatisfy(isAbortError);
    expect(s.stats().queued).toBe(1);

    busy.finish();
    keep.finish();
    await tick();
    await tick();
    expect(log).toEqual(['busy', 'keep']);
  });

  it('never starts work whose signal was already aborted', async () => {
    const s = new MediaScheduler({ thumbnailConcurrency: 4 });
    const log: string[] = [];
    const ac = new AbortController();
    ac.abort();
    await expect(
      s.schedule({ priority: 'thumbnail', signal: ac.signal }, deferredTask(log, 't').task),
    ).rejects.toSatisfy(isAbortError);
    await expect(
      s.schedule({ priority: 'interactive', signal: ac.signal }, deferredTask(log, 'i').task),
    ).rejects.toSatisfy(isAbortError);
    expect(log).toEqual([]);
    expect(s.stats()).toEqual({ interactive: 0, thumbnail: 0, queued: 0 });
  });

  it('lets started work finish when its caller aborts, freeing the caller at once', async () => {
    const s = new MediaScheduler({ thumbnailConcurrency: 1 });
    const log: string[] = [];
    const ac = new AbortController();
    const t = deferredTask(log, 't');
    const p = s.schedule({ priority: 'thumbnail', signal: ac.signal }, t.task);
    await tick();
    ac.abort();
    await expect(p).rejects.toSatisfy(isAbortError);
    // The download keeps its slot until it lands (its result still gets cached).
    expect(s.stats().thumbnail).toBe(1);
    t.finish();
    await tick();
    expect(s.stats().thumbnail).toBe(0);
  });

  describe('shared (deduplicated) work', () => {
    it('runs one task for concurrent callers with the same key', async () => {
      const s = new MediaScheduler({ thumbnailConcurrency: 4 });
      const log: string[] = [];
      const t = deferredTask(log, 'shared');
      const p1 = s.schedule({ priority: 'thumbnail', key: 'k' }, t.task);
      const p2 = s.schedule({ priority: 'thumbnail', key: 'k' }, deferredTask(log, 'dup').task);
      await tick();
      t.finish();
      await expect(Promise.all([p1, p2])).resolves.toEqual(['shared', 'shared']);
      expect(log).toEqual(['shared']);
    });

    it('keeps a queued shared job while another caller still wants it', async () => {
      const s = new MediaScheduler({ thumbnailConcurrency: 1 });
      const log: string[] = [];
      const busy = deferredTask(log, 'busy');
      s.schedule({ priority: 'thumbnail' }, busy.task);
      const a = new AbortController();
      const b = new AbortController();
      const shared = deferredTask(log, 'shared');
      const pA = s.schedule({ priority: 'thumbnail', key: 'k', signal: a.signal }, shared.task);
      const pB = s.schedule({ priority: 'thumbnail', key: 'k', signal: b.signal }, shared.task);
      await tick();

      a.abort();
      await expect(pA).rejects.toSatisfy(isAbortError);
      expect(s.stats().queued).toBe(1);

      busy.finish();
      await tick();
      expect(log).toEqual(['busy', 'shared']);
      shared.finish();
      await expect(pB).resolves.toBe('shared');
    });

    it('drops a queued shared job once every caller has aborted', async () => {
      const s = new MediaScheduler({ thumbnailConcurrency: 1 });
      const log: string[] = [];
      const busy = deferredTask(log, 'busy');
      s.schedule({ priority: 'thumbnail' }, busy.task);
      const a = new AbortController();
      const b = new AbortController();
      const pA = s.schedule({ priority: 'thumbnail', key: 'k', signal: a.signal }, deferredTask(log, 'x').task);
      const pB = s.schedule({ priority: 'thumbnail', key: 'k', signal: b.signal }, deferredTask(log, 'x').task);
      a.abort();
      b.abort();
      await expect(pA).rejects.toSatisfy(isAbortError);
      await expect(pB).rejects.toSatisfy(isAbortError);
      expect(s.stats().queued).toBe(0);
      busy.finish();
      await tick();
      expect(log).toEqual(['busy']);

      // The key is free again: a fresh request runs a fresh job.
      const again = deferredTask(log, 'again');
      const p = s.schedule({ priority: 'thumbnail', key: 'k' }, again.task);
      await tick();
      again.finish();
      await expect(p).resolves.toBe('again');
    });

    it('a caller without a signal keeps the shared job alive', async () => {
      const s = new MediaScheduler({ thumbnailConcurrency: 1 });
      const log: string[] = [];
      const busy = deferredTask(log, 'busy');
      s.schedule({ priority: 'thumbnail' }, busy.task);
      const a = new AbortController();
      const shared = deferredTask(log, 'shared');
      s.schedule({ priority: 'thumbnail', key: 'k', signal: a.signal }, shared.task).catch(() => {});
      const pPlain = s.schedule({ priority: 'thumbnail', key: 'k' }, shared.task);
      a.abort();
      busy.finish();
      await tick();
      shared.finish();
      await expect(pPlain).resolves.toBe('shared');
    });

    it('an interactive caller promotes a queued shared thumbnail job', async () => {
      const s = new MediaScheduler({ thumbnailConcurrency: 1 });
      const log: string[] = [];
      s.schedule({ priority: 'thumbnail' }, deferredTask(log, 'busy').task);
      const shared = deferredTask(log, 'shared');
      s.schedule({ priority: 'thumbnail', key: 'k' }, shared.task);
      await tick();
      expect(log).toEqual(['busy']);

      const p = s.schedule({ priority: 'interactive', key: 'k' }, shared.task);
      await tick();
      expect(log).toEqual(['busy', 'shared']);
      expect(s.stats()).toEqual({ interactive: 1, thumbnail: 1, queued: 0 });
      shared.finish();
      await expect(p).resolves.toBe('shared');
    });

    it('propagates a shared failure to every caller and frees the key', async () => {
      const s = new MediaScheduler({ thumbnailConcurrency: 1 });
      const log: string[] = [];
      const t = deferredTask(log, 't');
      const p1 = s.schedule({ priority: 'thumbnail', key: 'k' }, t.task);
      const p2 = s.schedule({ priority: 'thumbnail', key: 'k' }, t.task);
      t.fail(new Error('boom'));
      await expect(p1).rejects.toThrow('boom');
      await expect(p2).rejects.toThrow('boom');
      expect(s.stats()).toEqual({ interactive: 0, thumbnail: 0, queued: 0 });
    });
  });

  it('a synchronous throw from a task releases its slot', async () => {
    const s = new MediaScheduler({ thumbnailConcurrency: 1 });
    const p = s.schedule({ priority: 'thumbnail' }, () => {
      throw new Error('sync');
    });
    await expect(p).rejects.toThrow('sync');
    expect(s.stats().thumbnail).toBe(0);
  });
});
