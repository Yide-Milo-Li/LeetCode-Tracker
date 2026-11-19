/**
 * Shared Settings view types, constants and pure helpers.
 *
 * Lives outside `SettingsView.tsx` so section components and hooks can import them without a
 * circular dependency; `SettingsView.tsx` re-exports the public names from its original path.
 */
import {
  fixedProviderModels,
  supportedGeminiModels,
  supportedOpenaiModels,
  type ThemePalette,
} from '../../../../../packages/contracts/src/sync.ts';
import { PALETTE_OPTIONS } from '../../palettes.ts';

export type ThemeMode = 'light' | 'dark' | 'system';
export type SettingsSection = 'general' | 'appearance' | 'practice' | 'ai' | 'clients' | 'sync' | 'data';
/** Tab order of the Settings view; arrow-key navigation wraps around the visible subset. */
export const SECTIONS: SettingsSection[] = ['general', 'appearance', 'practice', 'ai', 'clients', 'sync', 'data'];
/** Tabs that only make sense inside the desktop host (the MCP bridge lives in the Tauri sidecar). */
const DESKTOP_ONLY_SECTIONS: ReadonlySet<SettingsSection> = new Set(['clients']);

/** Tabs to show for the current host, in display order. */
export function visibleSections(desktop: boolean): SettingsSection[] {
  return desktop ? SECTIONS : SECTIONS.filter((id) => !DESKTOP_ONLY_SECTIONS.has(id));
}

export type ProviderType = 'gemini' | 'openai' | 'deepseek';

export const PROVIDER_PRESET_MODELS: Record<ProviderType, string[]> = {
  gemini: [...supportedGeminiModels],
  openai: [...supportedOpenaiModels],
  deepseek: [fixedProviderModels.deepseek],
};

/** Display names for OpenAI model ids; unknown ids fall back to the raw id. */
export const OPENAI_MODEL_LABELS: Record<string, string> = {
  'gpt-6-luna': 'GPT-6 Luna',
  'gpt-6.1-terra': 'GPT-6.1 Terra',
};

/** Human-readable provider brand name used in labels and status text. */
export const providerName = (id: ProviderType) => (id === 'gemini' ? 'Gemini' : id === 'openai' ? 'OpenAI' : 'DeepSeek');

/**
 * Keep a palette only while it matches the requested mode.
 *
 * The default palette adapts to both modes. A light or dark palette survives a switch to its own
 * mode; anything else (including "system", whose effective mode can change) falls back to default.
 */
export function paletteForMode(palette: ThemePalette, mode: ThemeMode): ThemePalette {
  if (palette === 'default') return palette;
  const type = PALETTE_OPTIONS.find((option) => option.id === palette)?.type;
  return type === mode ? palette : 'default';
}
