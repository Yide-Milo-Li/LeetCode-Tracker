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
  const [appearance, setAppearance] = useState<Pick<PreferenceChange, 'theme' | 'palette'> | null>(null);
  const theme = appearance?.theme ?? 'system';
  const palette = appearance?.palette ?? 'default';
  const appearanceReady = appearance !== null;
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
        // Preserve individual appearance choices made while the settings request was in flight.
        setAppearance((chosen) => ({ theme: settings.theme, palette: settings.palette ?? 'default', ...chosen }));
        // A change made while loading wins over the loaded values.
        if (version === preferenceRevision.current) {
          setLang(settings.language);
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
      // The initial UI defaults must never clear the installed app's custom icon.
      if (appearanceReady) void applyAppIcon(palette, dark);
    };
    apply();
    media.addEventListener('change', apply);
    if (palette && palette !== 'default') {
      document.documentElement.setAttribute('data-palette', palette);
    } else {
      document.documentElement.removeAttribute('data-palette');
    }
    return () => media.removeEventListener('change', apply);
  }, [theme, palette, appearanceReady]);

  useEffect(() => {
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  }, [lang]);

  /** Queue preference writes so a slow previous response cannot persist an older selection last. */
  const persistPreference = useCallback((value: PreferenceChange) => {
    preferenceRevision.current++;
    setErrorCause(null);
    if (value.language) setLang(value.language);
    if (value.theme || value.palette) {
      setAppearance((current) => ({
        ...current,
        ...(value.theme && { theme: value.theme }),
        ...(value.palette && { palette: value.palette }),
      }));
    }
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
