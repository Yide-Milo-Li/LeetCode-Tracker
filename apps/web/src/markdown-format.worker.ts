/** Run deterministic note formatting outside the interactive React thread. */
import { formatMarkdown } from '../../../packages/markdown/src/index.ts';

globalThis.addEventListener('message', (event: MessageEvent<string>) => {
  globalThis.postMessage(formatMarkdown(event.data));
});
