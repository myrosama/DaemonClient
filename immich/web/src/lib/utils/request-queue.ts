// Browser-side pacer for thumbnail/preview fetches. Limits how many requests
// the page is willing to have in flight to the user's worker at once. The
// worker has its own per-bot pacer for Telegram; this one keeps the browser
// from issuing 200 simultaneous fetches when the timeline first paints.
//
// `add()` returns a ticket whose `cancel()` removes the task from the queue
// IF it hasn't started yet. Already-running tasks must be cancelled via the
// caller's own AbortController inside the task body.

type Task<T> = () => Promise<T>;

interface Ticket<T> {
  promise: Promise<T>;
  cancel: () => void;
}

interface QueueItem<T> {
  task: Task<T>;
  resolve: (val: T) => void;
  reject: (err: any) => void;
  cancelled: boolean;
}

class PacedRequestQueue {
  private queue: QueueItem<any>[] = [];
  private activeCount = 0;
  // 12 in-flight: worker-side TgQueue caps at 10 Telegram calls anyway, so
  // having slightly more browser slots means the pipeline stays full even
  // when some slots are waiting on D1/auth overhead before hitting Telegram.
  private maxConcurrency = 12;

  add<T>(task: Task<T>): Ticket<T> {
    let item!: QueueItem<T>;
    const promise = new Promise<T>((resolve, reject) => {
      item = { task, resolve, reject, cancelled: false };
      this.queue.push(item);
      this.process();
    });
    return {
      promise,
      cancel: () => {
        if (item.cancelled) return;
        item.cancelled = true;
        const idx = this.queue.indexOf(item);
        if (idx >= 0) {
          this.queue.splice(idx, 1);
          item.reject(new Error('cancelled'));
        }
      },
    };
  }

  private process() {
    while (this.activeCount < this.maxConcurrency && this.queue.length > 0) {
      const item = this.queue.shift()!;
      if (item.cancelled) continue;
      this.activeCount++;
      Promise.resolve()
        .then(() => item.task())
        .then(item.resolve, item.reject)
        .finally(() => {
          this.activeCount--;
          this.process();
        });
    }
  }
}

export const imageRequestQueue = new PacedRequestQueue();
