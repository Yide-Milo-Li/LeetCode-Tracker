/**
 * Application-wide display preferences: language, theme, palette, editor toggles and timezone.
 *
 * Loads the saved settings once, applies theme/palette/language to `<html>`, keeps the app icon
 * in sync with the effective light/dark mode, and persists edits through a serial queue so a slow
 * earlier write can never land after a newer selection. Extracted from `App.tsx` unchanged.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.ts';
import { applyAppIcon } from '../brand-icons.ts';
import type { Language } from '../i18n.ts';
import type { ThemePalette } from '../../../../packages/contracts/src/sync.ts';

export type ThemeMode = 'light' | 'dark' | 'system';

export interface PreferenceChange {
  language?: Language;
  theme?: ThemeMode;
  palette?: ThemePalette;
  promptSwapFeedback?: boolean;
  notesFormatOnSave?: boolean;
}

export interface Preferences {
  lang: Language;
  theme: ThemeMode;
  palette: ThemePalette;
  promptSwapFeedback: boolean;
  /** `null` until settings load, so the notes editor can wait for the real value. */
  notesFormatOnSave: boolean | null;
  /** Effective dark mode after resolving `system` against the OS preference. */
  resolvedDark: boolean;
  timezone: string | null;
  /** Timezone is saved by its own settings form; this only mirrors the result locally. */
  setTimezone: (timezone: string | null) => void;
  /** Last settings load or save failure, cleared by the next preference change. */
  errorCause: unknown;
  /** Apply a change immediately and queue its persistence. */
  persistPreference: (value: PreferenceChange) => void;
}

export function usePreferences(): Preferences {
  const [lang, setLang] = useState<Language>('en');
  const [theme, setTheme] = useState<ThemeMode>('system');
  const [palette, setPalette] = useState<ThemePalette>('default');
  const [promptSwapFeedback, setPromptSwapFeedback] = useState<boolean>(true);
  const [notesFormatOnSave, setNotesFormatOnSave] = useState<boolean | null>(null);
  const [resolvedDark, setResolvedDark] = useState(false);
  const [timezone, setTimezone] = useState<string | null>(null);
  const [errorCause, setErrorCause] = useState<unknown>(null);
  const preferenceRevision = useRef(0);
  const preferenceQueue = useRef(Promise.resolve());

  useEffect(() => {
    const version = preferenceRevision.current;
    let active = true;
    api
      .getSettings()
      .then((settings) => {
        if (!active) return;
        const formatOnSave = settings.notesFormatOnSave ?? true;
        // A change made while loading wins over the loaded values.
        if (version === preferenceRevision.current) {
          setLang(settings.language);
          setTheme(settings.theme);
          setPalette(settings.palette ?? 'default');
          setPromptSwapFeedback(settings.promptSwapFeedback ?? true);
          setNotesFormatOnSave(formatOnSave);
          setTimezone(settings.timezone);
        } else {
          setNotesFormatOnSave((current) => current ?? formatOnSave);
        }
      })
      .catch((err) => {
        if (active) setErrorCause(err);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const dark = theme === 'dark' || (theme === 'system' && media.matches);
      document.documentElement.classList.toggle('dark', dark);
      document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
      setResolvedDark(dark);
    };
    apply();
    media.addEventListener('change', apply);
    if (palette && palette !== 'default') {
      document.documentElement.setAttribute('data-palette', palette);
    } else {
      document.documentElement.removeAttribute('data-palette');
    }
    return () => media.removeEventListener('change', apply);
  }, [theme, palette]);

  // The favicon and the native window/Dock icon follow the palette and the effective mode.
  useEffect(() => {
    void applyAppIcon(palette, resolvedDark);
  }, [palette, resolvedDark]);

  useEffect(() => {
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  }, [lang]);

  /** Queue preference writes so a slow previous response cannot persist an older selection last. */
  const persistPreference = useCallback((value: PreferenceChange) => {
    preferenceRevision.current++;
    setErrorCause(null);
    if (value.language) setLang(value.language);
    if (value.theme) setTheme(value.theme);
    if (value.palette) setPalette(value.palette);
    if (value.promptSwapFeedback !== undefined) setPromptSwapFeedback(value.promptSwapFeedback);
    if (value.notesFormatOnSave !== undefined) setNotesFormatOnSave(value.notesFormatOnSave);
    preferenceQueue.current = preferenceQueue.current.then(async () => {
      try {
        await api.updateSettings(value);
      } catch (err) {
        setErrorCause(err);
      }
    });
  }, []);

  return {
    lang,
    theme,
    palette,
    promptSwapFeedback,
    notesFormatOnSave,
    resolvedDark,
    timezone,
    setTimezone,
    errorCause,
    persistPreference,
  };
}
