/**
 * Chat preferences kept on this device, like the conversation itself. They are not part of the
 * profile, backups or device sync.
 */
import { useSyncExternalStore } from 'react';

const DATA_ACCESS_KEY = 'leetcode_tracker_chat_data_access_v1';
const CHAT_OPENED_KEY = 'leetcode_tracker_chat_opened_v1';
const listeners = new Set<() => void>();

/** First-use visibility is kept on the device, alongside chat placement. */
export function hasOpenedChat(): boolean {
  try {
    return localStorage.getItem(CHAT_OPENED_KEY) === 'yes';
  } catch {
    return false;
  }
}

export function rememberChatOpened(): void {
  try {
    localStorage.setItem(CHAT_OPENED_KEY, 'yes');
  } catch {
    // The launcher can still tuck away for the remainder of this session.
  }
}

/**
 * Whether the AI may look up tracker data while answering. On unless the user turned it off; a
 * device without usable storage keeps the default.
 */
export function getChatDataAccess(): boolean {
  try {
    return localStorage.getItem(DATA_ACCESS_KEY) !== 'off';
  } catch {
    return true;
  }
}

/** Store the choice and tell every open view; it applies from the next question. */
export function setChatDataAccess(allowed: boolean): void {
  try {
    if (allowed) localStorage.removeItem(DATA_ACCESS_KEY);
    else localStorage.setItem(DATA_ACCESS_KEY, 'off');
  } catch {
    // Without storage the choice cannot be kept, so the default stays in effect.
  }
  listeners.forEach(listener => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useChatDataAccess(): boolean {
  return useSyncExternalStore(subscribe, getChatDataAccess, () => true);
}
