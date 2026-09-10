/**
 * Asynchronous mutex lock utility.
 * Serializes database write operations to avoid race conditions.
 */
export class AsyncLock {
  private queue: Promise<void> = Promise.resolve();

  /**
   * Run an asynchronous or synchronous function under the serialization mutex.
   * Ensures subsequent tasks run even if the current task throws.
   *
   * @param fn Function to execute under lock.
   * @returns Promise resolving to the return value of fn.
   */
  public async run<T>(fn: () => Promise<T> | T): Promise<T> {
    const result = this.queue.then(fn);
    this.queue = result.then(() => {}, () => {});
    return result;
  }
}
