import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isAbortError, MediaScheduler, parseViewingMessage, RetryAfterError, type MediaTag } from './media-scheduler';
import { CancelHints, fromSharedResult, MediaSession, pacedFetch, toSharedResult } from './media-session';

const flush = () => vi.advanceTimersByTimeAsync(0);

const newSession = (overrides: Partial<ConstructorParameters<typeof MediaScheduler>[0]> = {}) =>
  new MediaSession(
    new MediaScheduler({ maxConcurrent: 6, reservedForOpened: 1, maxNext: 2, rate: 1000, burst: 1000, ...overrides }),
  );

const thumb = (assetId: string): MediaTag => ({ assetId, kind: 'thumbnail', size: 'thumbnail' });
const preview = (assetId: string): MediaTag => ({ assetId, kind: 'thumbnail', size: 'preview' });

function gate<T>() {
  let open!: (value: T) => void;
  const promise = new Promise<T>((resolve) => (open = resolve));
  return { promise, open };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('viewing hint', () => {
  it('classifies the viewed asset as OPENED and its neighbours as NEXT', () => {
    const session = newSession();
    expect(session.classify(preview('a'))).toBe('next'); // nothing viewed yet
    session.setViewing('a');
    expect(session.classify(preview('a'))).toBe('opened');
    expect(session.classify(preview('b'))).toBe('next');
    expect(session.classify(thumb('b'))).toBe('visible');
    session.setViewing(undefined);
    expect(session.classify(preview('a'))).toBe('next');
  });

  it('a malformed hint changes nothing', () => {
    const session = newSession();
    session.setViewing('a');
    const parsed = parseViewingMessage({ type: 'viewing', assetId: { evil: true } });
    if (parsed) session.setViewing(parsed.assetId);
    expect(session.viewingAssetId).toBe('a');
  });

  it('raises a preview requested before the hint arrived (message/fetch race)', async () => {
    const session = newSession({ maxConcurrent: 2, reservedForOpened: 1 });
    const log: string[] = [];
    const block = gate<void>();
    void session.schedule({ tag: thumb('x') }, () => (log.push('grid'), block.promise));
    void session.schedule({ tag: preview('a') }, () => (log.push('preview'), Promise.resolve()));
    await flush();
    expect(log).toEqual(['grid']); // NEXT, waiting for the one lower slot
    session.setViewing('a');
    await flush();
    expect(log).toEqual(['grid', 'preview']); // OPENED takes the reserved slot
  });

  it('closing the viewer lifts the D17 suspension (no thumbnail stall)', async () => {
    const session = newSession();
    session.setViewing('a');
    const log: string[] = [];
    void session.schedule({ tag: preview('a') }, () => (log.push('opened'), new Promise(() => {})));
    void session.schedule({ tag: thumb('b') }, () => (log.push('grid'), Promise.resolve()));
    await flush();
    expect(log).toEqual(['opened']);
    session.setViewing(undefined);
    await flush();
    expect(log).toEqual(['opened', 'grid']);
  });
});

describe('reset() on logout / user switch', () => {
  it('fails queued work, clears the hint and pauses, and bumps the generation', async () => {
    const session = newSession();
    session.setViewing('a');
    session.scheduler.pause(60_000);
    const queued = session.schedule({ tag: thumb('b') }, () => Promise.resolve('old user'));
    const generation = session.generation;

    session.reset();
    await expect(queued).rejects.toSatisfy(isAbortError);
    expect(session.viewingAssetId).toBeUndefined();
    expect(session.scheduler.stats().pausedUntil).toBe(0);
    expect(session.isCurrent(generation)).toBe(false);
  });

  it('stops in-flight work from a previous session writing the cache', async () => {
    const session = newSession();
    const response = gate<Response>();
    const store = vi.fn(() => Promise.resolve());
    const pending = session.sharedFetch({ tag: thumb('a'), key: 'k' }, () => response.promise, store);
    await flush();
    session.reset(); // logout while the old user's bytes are on the wire
    response.open(new Response('old user bytes'));
    await expect(pending).rejects.toSatisfy(isAbortError);
    await flush();
    expect(store).not.toHaveBeenCalled();
  });
});

describe('sharedFetch (directWorkerFetch duplicates)', () => {
  it('runs one fetch and gives every duplicate its own readable response', async () => {
    const session = newSession();
    const send = vi.fn(() =>
      Promise.resolve(new Response('bytes', { status: 200, headers: { 'Content-Type': 'image/jpeg' } })),
    );
    const store = vi.fn((response: Response) => response.text());
    const options = { tag: thumb('a'), key: 'https://worker/api/assets/a/thumbnail?dcv=v4' };
    const [first, second] = await Promise.all([
      session.sharedFetch(options, send, store),
      session.sharedFetch(options, send, store),
    ]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(store).toHaveBeenCalledTimes(1);
    expect(await first.text()).toBe('bytes');
    expect(await second.text()).toBe('bytes');
    expect(second.headers.get('Content-Type')).toBe('image/jpeg');
  });

  it('shares a failure status but never stores it', async () => {
    const session = newSession();
    const store = vi.fn(() => Promise.resolve());
    const response = await session.sharedFetch(
      { tag: thumb('a'), key: 'k' },
      () => Promise.resolve(new Response('nope', { status: 404, statusText: 'Not Found' })),
      store,
    );
    expect(response.status).toBe(404);
    expect(response.statusText).toBe('Not Found');
    expect(store).not.toHaveBeenCalled();
  });

  it('retries a 429 once the shared pause ends, without its own backoff', async () => {
    const session = newSession();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(undefined, { status: 429, headers: { 'Retry-After': '2' } }))
      .mockResolvedValueOnce(new Response('ok'));
    const pending = session.sharedFetch(
      { tag: thumb('a'), key: 'k' },
      () => pacedFetch('https://worker/x', undefined, fetcher),
      () => Promise.resolve(),
    );
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    const response = await pending;
    expect(await response.text()).toBe('ok');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('round-trips null-body statuses', async () => {
    const result = await toSharedResult(new Response(undefined, { status: 204 }));
    expect(fromSharedResult(result).status).toBe(204);
  });
});

describe('pacedFetch', () => {
  it('turns a Telegram 429 into RetryAfterError and passes other answers through', async () => {
    const limited = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({ ok: false, error_code: 429, parameters: { retry_after: 5 } }, {
        status: 429,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    await expect(pacedFetch('u', undefined, limited)).rejects.toMatchObject({ delayMs: 5000 });
    await expect(pacedFetch('u', undefined, limited)).rejects.toBeInstanceOf(RetryAfterError);
    const forbidden = vi.fn<typeof fetch>().mockResolvedValue(new Response(undefined, { status: 403 }));
    const passed = await pacedFetch('u', undefined, forbidden);
    expect(passed.status).toBe(403);
  });
});

describe('CancelHints (cancel precision)', () => {
  it('one hint releases one waiter; the identical tile still gets its image', async () => {
    const session = newSession({ maxConcurrent: 2, reservedForOpened: 1 });
    const hints = new CancelHints();
    const block = gate<void>();
    void session.schedule({ tag: thumb('x') }, () => block.promise); // holds the lower slot
    const url = 'https://photos.example/api/assets/a/thumbnail?size=thumbnail';
    const tileOne = hints.register(url);
    const tileTwo = hints.register(url);
    const task = vi.fn(() => Promise.resolve('image'));
    const one = session.schedule({ tag: thumb('a'), key: url, signal: tileOne.signal }, task);
    const two = session.schedule({ tag: thumb('a'), key: url, signal: tileTwo.signal }, task);

    hints.cancel(url); // one tile scrolled away
    block.open();
    await expect(two).resolves.toBe('image');
    await expect(one).resolves.toBe('image');
    expect(task).toHaveBeenCalledTimes(1);

    tileOne.done();
    tileTwo.done();
    hints.cancel(url); // a late hint with nobody pending is a no-op
  });

  it('two hints drop the queued job before it costs a request', async () => {
    const session = newSession({ maxConcurrent: 2, reservedForOpened: 1 });
    const hints = new CancelHints();
    void session.schedule({ tag: thumb('x') }, () => new Promise(() => {}));
    const url = 'https://photos.example/api/assets/a/thumbnail';
    const task = vi.fn(() => Promise.resolve('image'));
    const waiters = [hints.register(url), hints.register(url)].map(({ signal }) =>
      session.schedule({ tag: thumb('a'), key: url, signal }, task),
    );
    hints.cancel(url);
    hints.cancel(url);
    for (const waiter of waiters) await expect(waiter).rejects.toSatisfy(isAbortError);
    expect(task).not.toHaveBeenCalled();
  });

  it('follows the request signal when a browser does propagate it', () => {
    const hints = new CancelHints();
    const request = new AbortController();
    const { signal } = hints.register('u', request.signal);
    request.abort();
    expect(signal.aborted).toBe(true);
  });
});
