/** Application preferences, grouped into four tabs; catalog and progress imports live in their own workspaces. */
import { useEffect, useState } from 'react';
import type { ThemePalette } from '../../../../packages/contracts/src/sync.ts';
import type { DesktopAgentStatus } from '../../../../packages/contracts/src/desktop-agent.ts';
import { api } from '../api.ts';
import type { Language } from '../i18n.ts';
import { localizeApiError } from '../error-i18n.ts';
import { PageHeader, Feedback } from './ui.tsx';
import { SECTIONS, type SettingsSection, type ThemeMode } from './settings/settings-model.ts';
import { useAiProviderSettings } from './settings/useAiProviderSettings.ts';
import { useBundleRestore } from './settings/useBundleRestore.ts';
import { useDeviceSync } from './settings/useDeviceSync.ts';
import { GeneralSection } from './settings/GeneralSection.tsx';
import { AppearanceSection } from './settings/AppearanceSection.tsx';
import { AiProviderSection } from './settings/AiProviderSection.tsx';
import { DataSection } from './settings/DataSection.tsx';

// Public names keep their original import path for App, SetupGuide and tests.
export {
  PROVIDER_PRESET_MODELS,
  paletteForMode,
  type ProviderType,
  type SettingsSection,
  type ThemeMode,
} from './settings/settings-model.ts';

interface SettingsViewProps {
  lang: Language;
  onLanguageChange: (lang: Language) => void;
  onThemeChange: (theme: ThemeMode) => void;
  currentTheme: ThemeMode;
  resolvedDark?: boolean;
  onPaletteChange?: (palette: ThemePalette) => void;
  currentPalette?: ThemePalette;
  promptSwapFeedback?: boolean;
  onPromptSwapFeedbackChange?: (enabled: boolean) => void;
  notesFormatOnSave?: boolean | null;
  onNotesFormatOnSaveChange?: (enabled: boolean) => void;
  onTimezoneSaved?: (zone: string | null) => void;
  /** Controlled tab; omit to let the view manage its own. */
  section?: SettingsSection;
  onSectionChange?: (section: SettingsSection) => void;
  desktopAgent?: DesktopAgentStatus;
}

export { PALETTE_OPTIONS, type PaletteOption } from '../palettes.ts';

/**
 * Settings shell: tab strip, the single settings load on mount, and state that must outlive a tab.
 *
 * Keep AI drafts intact on background refresh; only explicit save changes stored credentials.
 */
export function SettingsView({
  lang,
  onLanguageChange,
  onThemeChange,
  currentTheme,
  resolvedDark = currentTheme === 'dark',
  onPaletteChange = () => {},
  currentPalette = 'default',
  promptSwapFeedback: controlledPromptSwapFeedback,
  onPromptSwapFeedbackChange,
  notesFormatOnSave: controlledNotesFormatOnSave,
  onNotesFormatOnSaveChange,
  onTimezoneSaved,
  section: controlledSection,
  onSectionChange,
  desktopAgent,
}: SettingsViewProps) {
  const zh = lang === 'zh';

  const [ownSection, setOwnSection] = useState<SettingsSection>('general');
  const section = controlledSection ?? ownSection;
  const selectSection = (next: SettingsSection) => {
    setOwnSection(next);
    onSectionChange?.(next);
  };

  const [ownPromptSwapFeedback, setOwnPromptSwapFeedback] = useState(true);
  const promptSwapFeedback = controlledPromptSwapFeedback ?? ownPromptSwapFeedback;
  const [ownNotesFormatOnSave, setOwnNotesFormatOnSave] = useState(true);
  const notesFormatOnSave = controlledNotesFormatOnSave ?? ownNotesFormatOnSave;

  /** Update the optional swap/removal feedback prompt preference via parent callback or API. */
  function updatePromptSwapFeedback(enabled: boolean) {
    setOwnPromptSwapFeedback(enabled);
    if (onPromptSwapFeedbackChange) {
      onPromptSwapFeedbackChange(enabled);
    } else {
      void api.updateSettings({ promptSwapFeedback: enabled }).catch((err) => {
        setLoadError(localizeApiError(err, lang));
      });
    }
  }

  /** Update the notes format-on-save preference via parent callback or API. */
  function updateNotesFormatOnSave(enabled: boolean) {
    setOwnNotesFormatOnSave(enabled);
    if (onNotesFormatOnSaveChange) {
      onNotesFormatOnSaveChange(enabled);
    } else {
      void api.updateSettings({ notesFormatOnSave: enabled }).catch((err) => {
        setLoadError(localizeApiError(err, lang));
      });
    }
  }

  const [loadError, setLoadError] = useState('');

  const ai = useAiProviderSettings(lang);
  const bundle = useBundleRestore(lang);
  const sync = useDeviceSync(lang, section === 'data');

  useEffect(() => {
    let active = true;
    api
      .getSettings()
      .then((settings) => {
        if (!active) return;
        setOwnPromptSwapFeedback(settings.promptSwapFeedback ?? true);
        setOwnNotesFormatOnSave(settings.notesFormatOnSave ?? true);
        ai.applyLoadedSettings(settings);
      })
      .catch((err) => {
        if (active) setLoadError(localizeApiError(err, lang));
      });
    return () => {
      active = false;
    };
  }, []);

  const sectionLabel: Record<SettingsSection, string> = {
    general: zh ? '通用' : 'General',
    appearance: zh ? '外观' : 'Appearance',
    ai: zh ? 'AI 助手' : 'AI assistant',
    data: zh ? '数据' : 'Data',
  };

  return (
    <div className="settings-view">
      <PageHeader title={zh ? '设置' : 'Settings'} />
      {loadError && <Feedback>{loadError}</Feedback>}

      <div className="page-tabs" role="tablist" aria-label={zh ? '设置分组' : 'Settings sections'}>
        {SECTIONS.map((id, index) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`settings-tab-${id}`}
            aria-selected={section === id}
            aria-controls={`settings-panel-${id}`}
            tabIndex={section === id ? 0 : -1}
            onClick={() => selectSection(id)}
            onKeyDown={(e) => {
              if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
              e.preventDefault();
              const next = SECTIONS[(index + (e.key === 'ArrowRight' ? 1 : SECTIONS.length - 1)) % SECTIONS.length];
              selectSection(next);
              setTimeout(() => document.getElementById(`settings-tab-${next}`)?.focus(), 0);
            }}
          >
            {sectionLabel[id]}
          </button>
        ))}
      </div>

      {section === 'general' && (
        <GeneralSection
          lang={lang}
          onLanguageChange={onLanguageChange}
          onTimezoneSaved={onTimezoneSaved}
          promptSwapFeedback={promptSwapFeedback}
          onPromptSwapFeedbackChange={updatePromptSwapFeedback}
          notesFormatOnSave={notesFormatOnSave}
          onNotesFormatOnSaveChange={updateNotesFormatOnSave}
          desktopAgent={desktopAgent}
        />
      )}

      {section === 'appearance' && (
        <AppearanceSection
          lang={lang}
          currentTheme={currentTheme}
          resolvedDark={resolvedDark}
          currentPalette={currentPalette}
          onThemeChange={onThemeChange}
          onPaletteChange={onPaletteChange}
        />
      )}

      {section === 'ai' && <AiProviderSection lang={lang} ai={ai} />}

      {section === 'data' && <DataSection lang={lang} bundle={bundle} sync={sync} />}
    </div>
  );
}
