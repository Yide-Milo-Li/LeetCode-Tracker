import type { FormatResult } from '../../../packages/markdown/src/index.ts';

let idleWorker: Worker | undefined;
let idleTimeout: ReturnType<typeof setTimeout> | undefined;

export function releaseIdleFormatter(): void {
  clearTimeout(idleTimeout);
  idleWorker?.terminate();
  idleWorker = undefined;
}

/** Lease one worker per in-flight draft, keeping one warm between successive saves. */
export function formatNoteInWorker(source: string): Promise<FormatResult> {
  const skipped: FormatResult = { content: source, status: 'skipped', reason: 'unsafe' };
  return new Promise(resolve => {
    let worker: Worker;
    try {
      worker = idleWorker ?? new Worker(new URL('./markdown-format.worker.ts', import.meta.url), { type: 'module' });
    } catch {
      resolve(skipped);
      return;
    }
    idleWorker = undefined;
    clearTimeout(idleTimeout);
    const timer = setTimeout(() => finish(skipped, false), 5000);
    const finish = (result: FormatResult, reusable: boolean) => {
      clearTimeout(timer);
      worker.onmessage = worker.onerror = worker.onmessageerror = null;
      if (reusable && !idleWorker) {
        idleWorker = worker;
        idleTimeout = setTimeout(releaseIdleFormatter, 30_000);
      } else {
        worker.terminate();
      }
      resolve(result);
    };
    worker.onmessage = (event: MessageEvent<FormatResult>) => {
      const result = event.data;
      if (result && typeof result.content === 'string' && ['formatted', 'unchanged', 'skipped'].includes(result.status)) {
        finish(result, true);
      } else finish(skipped, false);
    };
    worker.onerror = worker.onmessageerror = () => finish(skipped, false);
    try { worker.postMessage(source); }
    catch { finish(skipped, false); }
  });
}
