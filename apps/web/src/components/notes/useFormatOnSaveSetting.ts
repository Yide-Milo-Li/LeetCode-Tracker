/**
 * Format-on-save preference resolution for the notes workspace.
 *
 * Settings can pass the preference in (controlled), signal that it is still loading (`null`),
 * or omit it, in which case the settings API is consulted once per change of the prop.
 */
import { useEffect, useRef, type MutableRefObject } from 'react';
import { api } from '../../api.ts';

/** Refs read synchronously by the save chain; they never trigger re-renders. */
export interface FormatOnSaveSetting {
  /** Whether the preference has been resolved; unresolved preferences never format. */
  settingReady: MutableRefObject<boolean>;
  /** Resolved preference value; only meaningful when `settingReady` is true. */
  settingValue: MutableRefObject<boolean>;
}

/**
 * Track the effective format-on-save preference in refs.
 *
 * @param controlledFormatOnSave Controlled value from Settings, `null` while loading, or
 *   `undefined` to fall back to `api.getSettings()`.
 * @returns Refs that the save handler reads at save time. A failed settings request leaves the
 *   preference unresolved so the draft is saved as typed rather than guessing an opt-in.
 */
export function useFormatOnSaveSetting(controlledFormatOnSave: boolean | null | undefined): FormatOnSaveSetting {
  const settingReady = useRef(typeof controlledFormatOnSave === 'boolean');
  const settingValue = useRef(controlledFormatOnSave === true);

  useEffect(() => {
    if (typeof controlledFormatOnSave === 'boolean') {
      settingValue.current = controlledFormatOnSave;
      settingReady.current = true;
      return;
    }
    if (controlledFormatOnSave === null) {
      settingValue.current = false;
      settingReady.current = false;
      return;
    }
    let active = true;
    settingReady.current = false;
    settingValue.current = false;
    // If preferences are unavailable or not yet loaded, preserve the draft rather than guessing an opt-in.
    api
      .getSettings()
      .then((settings) => {
        if (active) {
          settingValue.current = settings.notesFormatOnSave ?? true;
          settingReady.current = true;
        }
      })
      .catch(() => {
        if (active) {
          settingValue.current = false;
          settingReady.current = false;
        }
      });
    return () => { active = false; };
  }, [controlledFormatOnSave]);

  return { settingReady, settingValue };
}
