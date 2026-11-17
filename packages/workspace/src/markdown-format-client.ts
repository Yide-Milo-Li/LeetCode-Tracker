import type { FormatResult } from '../../markdown/src/index.ts';

/** Resolve every operation, including worker errors and timeouts, without losing the draft. */
export function formatNoteInWorker(source: string): Promise<FormatResult> {
  return new Promise(resolve => {
    if (typeof Worker === 'undefined') {
      resolve({ content: source, status: 'skipped', reason: 'unsafe' });
      return;
    }
    let worker: Worker;
    try { worker = new Worker(new URL('./markdown-format.worker.ts', import.meta.url), { type: 'module' }); }
    catch { resolve({ content: source, status: 'skipped', reason: 'unsafe' }); return; }
    let settled = false;
    const finish = (result: FormatResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ content: source, status: 'skipped', reason: 'unsafe' }), 5000);
    worker.onmessage = (event: MessageEvent<FormatResult>) => {
      const result = event.data;
      if (!result || typeof result.content !== 'string' || !['formatted', 'unchanged', 'skipped'].includes(result.status)) {
        finish({ content: source, status: 'skipped', reason: 'unsafe' });
      } else finish(result);
    };
    worker.onerror = () => finish({ content: source, status: 'skipped', reason: 'unsafe' });
    try { worker.postMessage(source); }
    catch { finish({ content: source, status: 'skipped', reason: 'unsafe' }); }
  });
}
