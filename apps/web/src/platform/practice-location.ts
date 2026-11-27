import { api } from '../api.ts';
import { practiceCommand, type PracticeProblem } from './practice.ts';

export type PracticeLocation = PracticeProblem | 'off-page' | 'unknown' | 'loading' | 'unavailable';

/** Read the native top-level URL so pushState, redirects and Back all use the same source. */
export function followPracticeLocation(initial: PracticeProblem, changed: (value: PracticeLocation) => void) {
  const initialUrl = new URL(initial.url);
  const initialSlug = initialUrl.pathname.split('/')[2];
  const cache = new Map([[initialSlug, initial]]);
  let observed: string | null | undefined;
  let pending: AbortController | undefined;
  let reading = false;
  let stopped = false;
  let retryAt = 0;

  async function resolve(url: string, slug: string, request: AbortController) {
    try {
      const { problem } = await api.getCatalogProblemBySlug(slug, { signal: request.signal });
      if (request.signal.aborted) return;
      // Navigation can overtake a catalog response between two location checks.
      const current = await practiceCommand<string | null>('practice_location');
      if (request.signal.aborted) return;
      if (current !== url) {
        observed = undefined;
        void check();
        return;
      }
      if (!problem) { changed('unknown'); return; }
      const next = { frontendId: problem.questionFrontendId, title: problem.title, url };
      cache.set(slug, next);
      changed(next);
    } catch {
      if (request.signal.aborted) return;
      retryAt = Date.now() + 3000;
      changed('unavailable');
    }
  }

  async function check() {
    if (reading || document.hidden || stopped || (observed === undefined && Date.now() < retryAt)) return;
    reading = true;
    try {
      const url = await practiceCommand<string | null>('practice_location');
      if (stopped || (url === observed && (!retryAt || Date.now() < retryAt))) return;
      observed = url;
      retryAt = 0;
      pending?.abort();
      if (!url) { changed('off-page'); return; }
      const slug = new URL(url).pathname.split('/')[2];
      const known = cache.get(slug);
      if (known) { changed({ ...known, url }); return; }
      changed('loading');
      pending = new AbortController();
      void resolve(url, slug, pending);
    } catch {
      if (stopped) return;
      pending?.abort();
      if (observed !== undefined || !retryAt) changed('unavailable');
      observed = undefined;
      retryAt = Date.now() + 3000;
    } finally {
      reading = false;
    }
  }
  const timer = window.setInterval(check, 350);
  document.addEventListener('visibilitychange', check);
  void check();
  return () => {
    stopped = true;
    pending?.abort();
    window.clearInterval(timer);
    document.removeEventListener('visibilitychange', check);
  };
}
