import { fail } from './errors.ts';
/** A failed write cannot poison the next operation in the serialization queue. */
export class AsyncLock {
  private queue: Promise<void> = Promise.resolve();
  run<T>(fn: () => T | Promise<T>): Promise<T> {
    const result = this.queue.then(fn);
    this.queue = result.then(() => {}, () => {});
    return result;
  }
}
/** Counts queued work before its first await and owns exclusive restore admission. */
export class OperationGate {
  private active = 0;
  private restoring = false;
  private closing = false;
  private readonly idle = new Set<() => void>();
  isBusy(): boolean { return this.active > 0 || this.restoring; }
  assertAvailable(restore = false): void {
    if (this.closing || this.restoring || (restore && this.active > 0)) {
      fail(409, {error:'PROFILE_BUSY', message:'Wait for active operations to finish, then retry.'});
    }
  }
  async run<T>(fn: () => T | Promise<T>, restore = false): Promise<T> {
    this.assertAvailable(restore);
    if (restore) this.restoring = true;
    this.active += 1;
    try { return await fn(); }
    finally {
      this.active -= 1;
      if (restore) this.restoring = false;
      if (this.active === 0) { for (const resolve of this.idle) resolve(); this.idle.clear(); }
    }
  }
  /** Closing immediately stops admission and keeps storage alive until existing work settles. */
  async drain(): Promise<void> {
    this.closing = true;
    if (this.active > 0) await new Promise<void>(resolve => this.idle.add(resolve));
  }
}
