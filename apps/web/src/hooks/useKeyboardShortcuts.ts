/**
 * Global power-user keyboard shortcuts hook for desktop navigation and quick actions.
 * Protects against input element conflicts, active IME composition, and open modal overlays.
 */
import { useEffect } from 'react';

export interface KeyboardShortcutHandlers {
  onNavigateToday: () => void;
  onNavigateProblems: () => void;
  onNavigateRecords: () => void;
  onOpenManualPractice: () => void;
  onFocusSearch: () => void;
  onToggleHelp: () => void;
  enabled?: boolean;
}

/** Check if an event target is an interactive form element or editable surface. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || !(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  return (
    tag === 'input' ||
    tag === 'textarea' ||
    tag === 'select' ||
    target.isContentEditable ||
    target.getAttribute('contenteditable') === 'true'
  );
}

/**
 * Attaches a window-level keydown listener to execute power-user shortcuts.
 * Automatically deactivates when typing in inputs or when an overlay modal is mounted.
 */
export function useKeyboardShortcuts({
  onNavigateToday,
  onNavigateProblems,
  onNavigateRecords,
  onOpenManualPractice,
  onFocusSearch,
  onToggleHelp,
  enabled = true,
}: KeyboardShortcutHandlers): void {
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

      // 3. Guard against active typing in inputs/textareas
      if (isEditableTarget(event.target)) {
        return;
      }

      // 4. Guard against active modal dialogs / drawers on screen
      if (document.querySelector('[data-overlay-host]')) {
        return;
      }

      switch (event.key) {
        case '1':
          event.preventDefault();
          onNavigateToday();
          break;
        case '2':
          event.preventDefault();
          onNavigateProblems();
          break;
        case '3':
          event.preventDefault();
          onNavigateRecords();
          break;
        case 'n':
        case 'N':
          event.preventDefault();
          onOpenManualPractice();
          break;
        case '/':
          event.preventDefault();
          onFocusSearch();
          break;
        case '?':
          event.preventDefault();
          onToggleHelp();
          break;
        default:
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [
    enabled,
    onNavigateToday,
    onNavigateProblems,
    onNavigateRecords,
    onOpenManualPractice,
    onFocusSearch,
    onToggleHelp,
  ]);
}
