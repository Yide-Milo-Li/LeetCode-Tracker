/**
 * The problem the user is currently looking at, published by the view that shows it so the chat
 * can offer it as context without that view knowing about the chat.
 */
import { useSyncExternalStore } from 'react';

export interface ChatProblemRef {
  frontendId: string;
  title?: string;
}

const listeners = new Set<() => void>();
let current: ChatProblemRef | null = null;

/** Publish the problem in view, or `null` when the view no longer shows one. */
export function setChatProblem(problem: ChatProblemRef | null): void {
  if (problem?.frontendId === current?.frontendId && problem?.title === current?.title) return;
  current = problem;
  listeners.forEach(listener => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The problem in front of the user right now, if a view shows one. */
export function useChatProblem(): ChatProblemRef | null {
  return useSyncExternalStore(subscribe, () => current, () => current);
}
