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

/** A preset question about one problem; the chat turns it into an ordinary user message. */
export type ChatAction =
  /** The next rung of the hint ladder for the problem. */
  | { kind: 'hint' }
  /** `attempt` names one practice in display form, such as its date and result; omitted means the latest. */
  | { kind: 'review'; attempt?: string }
  /** Problems in the user's catalog that test the same pattern. */
  | { kind: 'similar' }
  /** Put the last answer into the problem's note, as a change the user confirms. */
  | { kind: 'save-note' };

/**
 * What a view hands to the chat when the user asks about a problem from outside the panel. With
 * no `action` the panel opens on the problem's conversation and sends nothing.
 */
export interface ChatAsk {
  problem: ChatProblemRef;
  action?: ChatAction;
}

/** A handoff to the chat; `id` changes on every request so repeating the same one runs again. */
export interface ChatAskRequest extends ChatAsk {
  id: number;
}
