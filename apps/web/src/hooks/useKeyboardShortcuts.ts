/**
 * Global power-user keyboard shortcuts hook for desktop navigation and quick actions.
 * Protects against input element conflicts, active IME composition, and open modal overlays.
 */
import { useEffect, useRef } from 'react';

/** Handlers and configuration options for keyboard shortcuts. */
export interface KeyboardShortcutHandlers {
  /** Callback to navigate to the Today execution view ('#today'). */
  onNavigateToday: () => void;
  /** Callback to navigate to the Problems catalog view ('#problems'). */
  onNavigateProblems: () => void;
  /** Callback to navigate to the Records activity view ('#records'). */
  onNavigateRecords: () => void;
  /** Callback to open the manual practice logging modal. */
  onOpenManualPractice: () => void;
  /** Callback to focus the search box in the problems catalog. */
  onFocusSearch: () => void;
  /** Callback to toggle the keyboard shortcuts cheat sheet modal. */
  onToggleHelp: () => void;
  /** Optional flag to enable or disable keyboard shortcuts. Defaults to true. */
  enabled?: boolean;
}

/**
 * Checks whether an event target or element is an interactive form element or editable surface.
 * Inspects tag names, contentEditable status, and ancestor editable containers.
 *
 * @param target The DOM event target or element to inspect.
 * @returns True if the element accepts text input, false otherwise.
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || !(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  return (
    tag === 'input' ||
    tag === 'textarea' ||
    tag === 'select' ||
    target.isContentEditable ||
    Boolean(target.closest('input, textarea, select, [contenteditable="true"]'))
  );
}

/**
 * Attaches a window-level keydown listener to execute desktop power-user shortcuts.
 * Automatically deactivates when typing in inputs, during IME composition, or when a modal overlay is mounted.
 * Uses a ref for handlers to ensure listener attachment remains stable across re-renders.
 *
 * @param handlers Handlers object containing navigation, action, and modal callbacks.
 */
export function useKeyboardShortcuts(handlers: KeyboardShortcutHandlers): void {
  const handlersRef = useRef(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  });

  const enabled = handlers.enabled ?? true;

  useEffect(() => {
    if (!enabled) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      // 1. Guard against IME composition (e.g. Pinyin / Japanese typing)
      if (event.isComposing || event.keyCode === 229) {
        return;
      }

      // 2. Allow system / browser modified shortcuts (Ctrl+R, Alt+Tab, Cmd+C, etc.)
      if (event.ctrlKey || event.metaKey || event.altKey) {
        return;
      }

      // 3. Guard against active typing in inputs/textareas or focused editable elements
      if (isEditableTarget(event.target) || isEditableTarget(document.activeElement)) {
        return;
      }

      // 4. Guard against active modal dialogs / drawers on screen
      if (document.querySelector('[data-overlay-host]')) {
        return;
      }

      const current = handlersRef.current;
      switch (event.key) {
        case '1':
          event.preventDefault();
          current.onNavigateToday();
          break;
        case '2':
          event.preventDefault();
          current.onNavigateProblems();
          break;
        case '3':
          event.preventDefault();
          current.onNavigateRecords();
          break;
        case 'n':
        case 'N':
          event.preventDefault();
          current.onOpenManualPractice();
          break;
        case '/':
          event.preventDefault();
          current.onFocusSearch();
          break;
        case '?':
          event.preventDefault();
          current.onToggleHelp();
          break;
        default:
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [enabled]);
}
