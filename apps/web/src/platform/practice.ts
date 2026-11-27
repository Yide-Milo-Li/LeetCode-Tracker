import type { ChatProblemRef } from '../chat/chat-context.ts';

export interface PracticeProblem extends ChatProblemRef {
  url: string;
}

export const PRACTICE_OPEN = 'lct-practice-open';
export const PRACTICE_SHORTCUT = 'lct-practice-shortcut';

/** Only catalog links carrying an explicit problem identity enter the native workspace. */
export function practiceTarget(anchor: HTMLAnchorElement, url: URL): PracticeProblem | null {
  const { practiceId: frontendId, practiceTitle: title } = anchor.dataset;
  if (!frontendId || !['https://leetcode.com', 'https://leetcode.cn'].includes(url.origin)
    || url.username || url.password || !/^\/problems\/[a-z\d-]+(?:\/|$)/i.test(url.pathname)) return null;
  return { frontendId, title, url: url.href };
}

type Command = 'practice_open' | 'practice_layout' | 'practice_on_problem' | 'practice_close';
export function practiceCommand<T = void>(command: Command, args?: Record<string, unknown>): Promise<T> {
  const bridge = (window as unknown as { __TAURI_INTERNALS__: { invoke<R>(command: string, args?: unknown): Promise<R> } }).__TAURI_INTERNALS__;
  return bridge.invoke<T>(command, args);
}
