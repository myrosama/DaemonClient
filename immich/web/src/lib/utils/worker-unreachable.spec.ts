import { getServerConfig } from '@immich/sdk';
import { describe, expect, it } from 'vitest';
import {
  WAIT_CAP_MS,
  WORKER_UNREACHABLE,
  clearWait,
  isWorkerUnreachable,
  sessionStore,
  unreachableResponseFor,
  waitStartedAt,
  waitedTooLong,
  workerUnreachableResponse,
} from './worker-unreachable';

// A brand-new account's worker can't be reached for its first minute or two
// (Cloudflare has not issued the certificate for its new workers.dev subdomain).
// The service worker answers for it with a tagged 503, and the app shows "still
// being created" instead of the raw "Error: 503" page. These pin both ends.

describe('workerUnreachableResponse (what the service worker sends)', () => {
  it('is a 503 the SDK will parse, carrying the tag and a retry hint', async () => {
    const res = workerUnreachableResponse();
    expect(res.status).toBe(503);
    expect(res.headers.get('Content-Type')).toBe('application/json');
    expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(0);
    const body = await res.json();
    expect(body.error).toBe(WORKER_UNREACHABLE);
    expect(body.statusCode).toBe(503);
    expect(typeof body.message).toBe('string');
  });
});

describe('isWorkerUnreachable (what the app checks)', () => {
  it('recognises the tagged 503 as the SDK hands it over (status + parsed body)', async () => {
    const data = await workerUnreachableResponse().json();
    expect(isWorkerUnreachable({ status: 503, data })).toBe(true);
  });

  it('survives the real SDK path: getServerConfig rejects with an error the app recognises', async () => {
    const error = await getServerConfig({
      baseUrl: 'https://worker.invalid/api',
      fetch: async () => workerUnreachableResponse(),
    }).catch((caught: unknown) => caught);
    expect(isWorkerUnreachable(error)).toBe(true);
  });

  it('does NOT swallow an ordinary 503 from the worker (untagged) — that is a different problem', () => {
    expect(isWorkerUnreachable({ status: 503, data: { message: 'Encryption key unavailable' } })).toBe(false);
  });

  it('ignores every other error shape', () => {
    for (const e of [
      undefined,
      null,
      new Error('boom'),
      { status: 500, data: { error: WORKER_UNREACHABLE } },
      { status: 503 },
      { status: 503, data: 'Service Unavailable' },
    ]) {
      expect(isWorkerUnreachable(e)).toBe(false);
    }
  });
});

// The friendly screen must not loop forever: an established user whose worker is
// unreachable for another reason (carrier block, ad blocker, deleted worker)
// would otherwise be told "nothing is wrong" indefinitely.
describe('the wait is capped (session-scoped)', () => {
  const storage = () => {
    const m = new Map<string, string>();
    return {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
      removeItem: (k: string) => void m.delete(k),
    };
  };

  it('remembers when the wait began and keeps it across reloads', () => {
    const s = storage();
    expect(waitStartedAt(s, 1000)).toBe(1000);
    expect(waitStartedAt(s, 5000)).toBe(1000);
  });

  it('gives up after WAIT_CAP_MS, not before', () => {
    const s = storage();
    waitStartedAt(s, 0);
    expect(waitedTooLong(s, WAIT_CAP_MS - 1)).toBe(false);
    expect(waitedTooLong(s, WAIT_CAP_MS)).toBe(true);
  });

  it('starts fresh once the cloud has been reached', () => {
    const s = storage();
    waitStartedAt(s, 0);
    clearWait(s);
    expect(waitStartedAt(s, 999)).toBe(999);
  });

  it('a storage that throws reports no start time (the screen then retries only by hand), and never throws', () => {
    const broken = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    };
    expect(waitStartedAt(broken, 1)).toBeNull();
    expect(waitedTooLong(broken, 10 ** 12)).toBe(false);
    expect(() => clearWait(broken)).not.toThrow();
  });
});

describe('robustness of the wait clock', () => {
  const storage = () => {
    const m = new Map<string, string>();
    return {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
      removeItem: (k: string) => void m.delete(k),
    };
  };

  it('a start time in the future (clock moved back, tampering) is treated as a fresh start, so the cap still applies', () => {
    const s = storage();
    s.setItem('dc-cloud-wait-started', String(10 ** 15));
    expect(waitStartedAt(s, 1000)).toBe(1000);
    expect(waitedTooLong(s, 1000 + WAIT_CAP_MS)).toBe(true);
  });

  it('sessionStore() returns null instead of throwing when the browser blocks storage access', () => {
    expect(
      sessionStore(() => {
        throw new DOMException('blocked', 'SecurityError');
      }),
    ).toBeNull();
    const s = storage();
    expect(sessionStore(() => s as unknown as Storage)).toBe(s);
  });
});

describe('unreachableResponseFor (the service worker\'s decision)', () => {
  const DEFAULT = 'https://api.daemonclient.uz';

  it("tags a failure of the user's OWN worker", async () => {
    const res = unreachableResponseFor('https://dc-a.sub.workers.dev', DEFAULT);
    expect(isWorkerUnreachable({ status: res.status, data: await res.json() })).toBe(true);
  });

  it('does NOT tag a failure of the shared entry point — an outage must not read as "being created"', async () => {
    for (const base of [DEFAULT, `${DEFAULT}/`, `${DEFAULT}//`]) {
      const res = unreachableResponseFor(base, DEFAULT);
      expect(res.status).toBe(503);
      expect(isWorkerUnreachable({ status: res.status, data: await res.json() })).toBe(false);
    }
  });
});
