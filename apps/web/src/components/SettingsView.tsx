/** Application preferences, grouped into four tabs; catalog and progress imports live in their own workspaces. */
import React, { useEffect, useRef, useState } from 'react';
import { Eye, EyeOff, Download, Upload, Archive, AlertTriangle, ChevronDown } from 'lucide-react';
import {
  defaultGeminiFallbackModels,
  defaultGeminiModel,
  defaultOpenaiModel,
  fixedProviderModels,
  getDefaultReasoningEffort,
  getSupportedReasoningEfforts,
  normalizeGeminiModel,
  normalizeOpenaiModel,
  resolveModelReasoningEffort,
  supportedGeminiModels,
  supportedOpenaiModels,
  type ReasoningEffort,
  type ThemePalette,
} from '../../../../packages/contracts/src/sync.ts';
import { api } from '../api.ts';
import { snapshotBundleSchema, type SnapshotBundle } from '../../../../packages/contracts/src/notes.ts';
import { MAX_BUNDLE_BYTES } from '../../../../packages/contracts/src/migration.ts';
import { clearPracticeIntents } from '../practice-service.ts';
import { translations, type Language } from '../i18n.ts';
import { localizeApiError } from '../error-i18n.ts';
import { brandIconUrl } from '../brand-icons.ts';
import { PALETTE_OPTIONS } from '../palettes.ts';
import { useWorkspace } from '../workspace.tsx';
import { ExportLink } from './ExportLink.tsx';
import { TimezoneField } from './TimezoneField.tsx';
import { PageHeader, Feedback, Field, InfoPopover } from './ui.tsx';

export type ThemeMode = 'light' | 'dark' | 'system';
export type SettingsSection = 'general' | 'appearance' | 'ai' | 'data';
const SECTIONS: SettingsSection[] = ['general', 'appearance', 'ai', 'data'];

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
}

export { PALETTE_OPTIONS, type PaletteOption } from '../palettes.ts';

export type ProviderType = 'gemini' | 'openai' | 'deepseek';

export const PROVIDER_PRESET_MODELS: Record<ProviderType, string[]> = {
  gemini: [...supportedGeminiModels],
  openai: [...supportedOpenaiModels],
  deepseek: [fixedProviderModels.deepseek],
};

const OPENAI_MODEL_LABELS: Record<string, string> = {
  'gpt-6-luna': 'GPT-6 Luna',
  'gpt-6.1-terra': 'GPT-6.1 Terra',
};


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

/** Keep AI drafts intact on background refresh; only explicit save changes stored credentials. */
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
}: SettingsViewProps) {
  const t = translations[lang];
  const workspace = useWorkspace();
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

  // Multi-provider AI configuration state
  const [aiLoaded, setAiLoaded] = useState(false);
  const [provider, setProvider] = useState<ProviderType>('gemini');
  /** Provider whose key is persisted and in use; null means plans use local recommendations. */
  const [activeProvider, setActiveProvider] = useState<ProviderType | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Gemini state
  const [geminiApiKey, setGeminiApiKey] = useState('');
  const [geminiPrimaryModel, setGeminiPrimaryModel] = useState<string>(defaultGeminiModel);
  const [geminiIsCustomPrimary, setGeminiIsCustomPrimary] = useState(false);
  const [geminiFallbackModels, setGeminiFallbackModels] = useState<string[]>([
    ...defaultGeminiFallbackModels,
  ]);
  const [geminiReasoningEffort, setGeminiReasoningEffort] = useState<ReasoningEffort>(
    () => getDefaultReasoningEffort('gemini', defaultGeminiModel)
  );

  // OpenAI state
  const [openaiApiKey, setOpenaiApiKey] = useState('');
  const [openaiPrimaryModel, setOpenaiPrimaryModel] = useState<string>(defaultOpenaiModel);
  const [openaiIsCustomPrimary, setOpenaiIsCustomPrimary] = useState(false);
  const [openaiBaseUrl, setOpenaiBaseUrl] = useState('');
  const [openaiFallbackModels, setOpenaiFallbackModels] = useState<string[]>([]);
  const [openaiReasoningEffort, setOpenaiReasoningEffort] = useState<ReasoningEffort>(
    () => getDefaultReasoningEffort('openai', defaultOpenaiModel)
  );

  // DeepSeek state
  const [deepseekApiKey, setDeepseekApiKey] = useState('');
  const [deepseekPrimaryModel, setDeepseekPrimaryModel] = useState<string>(fixedProviderModels.deepseek);
  const [deepseekIsCustomPrimary, setDeepseekIsCustomPrimary] = useState(false);
  const [deepseekBaseUrl, setDeepseekBaseUrl] = useState('');
  const [deepseekFallbackModels, setDeepseekFallbackModels] = useState<string[]>([]);
  const [deepseekReasoningEffort, setDeepseekReasoningEffort] = useState<ReasoningEffort>(
    () => getDefaultReasoningEffort('deepseek', fixedProviderModels.deepseek)
  );

  // Shared AI form & action state
  const [showApiKey, setShowApiKey] = useState(false);
  const [savingAi, setSavingAi] = useState(false);
  const [aiSaved, setAiSaved] = useState(false);
  const [aiError, setAiError] = useState('');
  const [testingAi, setTestingAi] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; model?: string; message?: string } | null>(null);
  const dirtyAi = useRef(false);

  // Active provider helpers
  const currentApiKey = provider === 'gemini' ? geminiApiKey : provider === 'openai' ? openaiApiKey : deepseekApiKey;
  /** Update only the currently displayed provider draft. */
  const setCurrentApiKey = (val: string) => {
    if (provider === 'gemini') setGeminiApiKey(val);
    else if (provider === 'openai') setOpenaiApiKey(val);
    else setDeepseekApiKey(val);
  };

  const currentPrimaryModel = provider === 'gemini' ? geminiPrimaryModel : provider === 'openai' ? openaiPrimaryModel : deepseekPrimaryModel;
  const setCurrentPrimaryModel = (val: string) => {
    if (provider === 'gemini') setGeminiPrimaryModel(val);
    else if (provider === 'openai') setOpenaiPrimaryModel(val);
    else setDeepseekPrimaryModel(val);
  };

  const currentIsCustomPrimary = provider === 'gemini' ? geminiIsCustomPrimary : provider === 'openai' ? openaiIsCustomPrimary : deepseekIsCustomPrimary;
  const setCurrentIsCustomPrimary = (val: boolean) => {
    if (provider === 'gemini') setGeminiIsCustomPrimary(val);
    else if (provider === 'openai') setOpenaiIsCustomPrimary(val);
    else setDeepseekIsCustomPrimary(val);
  };

  const currentBaseUrl = provider === 'openai' ? openaiBaseUrl : provider === 'deepseek' ? deepseekBaseUrl : '';
  const setCurrentBaseUrl = (val: string) => {
    if (provider === 'openai') setOpenaiBaseUrl(val);
    else if (provider === 'deepseek') setDeepseekBaseUrl(val);
  };

  const currentFallbackModels = provider === 'gemini' ? geminiFallbackModels : provider === 'openai' ? openaiFallbackModels : deepseekFallbackModels;
  const setCurrentFallbackModels = (updater: string[] | ((prev: string[]) => string[])) => {
    if (provider === 'gemini') {
      setGeminiFallbackModels(typeof updater === 'function' ? updater(geminiFallbackModels) : updater);
    } else if (provider === 'openai') {
      setOpenaiFallbackModels(typeof updater === 'function' ? updater(openaiFallbackModels) : updater);
    } else {
      setDeepseekFallbackModels(typeof updater === 'function' ? updater(deepseekFallbackModels) : updater);
    }
  };

  const currentPresetModels = PROVIDER_PRESET_MODELS[provider];

  const currentReasoningEffort =
    provider === 'gemini'
      ? geminiReasoningEffort
      : provider === 'openai'
      ? openaiReasoningEffort
      : deepseekReasoningEffort;
  const setCurrentReasoningEffort = (val: ReasoningEffort) => {
    if (provider === 'gemini') setGeminiReasoningEffort(val);
    else if (provider === 'openai') setOpenaiReasoningEffort(val);
    else setDeepseekReasoningEffort(val);
  };
  const currentSupportedEfforts = getSupportedReasoningEfforts(provider, currentPrimaryModel);
  const currentDefaultEffort = getDefaultReasoningEffort(provider, currentPrimaryModel);
  const providerName = (id: ProviderType) => (id === 'gemini' ? 'Gemini' : id === 'openai' ? 'OpenAI' : 'DeepSeek');

  /** Any edit to the visible AI draft invalidates the last save/test confirmation. */
  const markAiDirty = () => {
    dirtyAi.current = true;
    setAiSaved(false);
    setTestResult(null);
  };

  // Bundle export / import state
  const [importingBundle, setImportingBundle] = useState(false);
  const [bundleSuccess, setBundleSuccess] = useState('');
  const [bundleError, setBundleError] = useState('');
  const [pendingBundle, setPendingBundle] = useState<SnapshotBundle | null>(null);
  const bundleFileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let active = true;
    api
      .getSettings()
      .then((settings) => {
        if (!active) return;
        setOwnPromptSwapFeedback(settings.promptSwapFeedback ?? true);
        setOwnNotesFormatOnSave(settings.notesFormatOnSave ?? true);
        setAiLoaded(true);
        const savedProvider = settings.llmProvider ?? 'gemini';
        const savedKey =
          savedProvider === 'gemini' ? settings.geminiApiKey : savedProvider === 'openai' ? settings.openaiApiKey : settings.deepseekApiKey;
        setActiveProvider(savedKey ? savedProvider : null);
        if (dirtyAi.current) return;
        if (settings.llmProvider) {
          setProvider(settings.llmProvider);
        }

        // Gemini
        if (settings.geminiApiKey !== undefined) setGeminiApiKey(settings.geminiApiKey ?? '');
        const effGemini = normalizeGeminiModel(settings.geminiModel) ?? defaultGeminiModel;
        setGeminiPrimaryModel(effGemini);
        setGeminiIsCustomPrimary(false);
        setGeminiReasoningEffort(resolveModelReasoningEffort('gemini', effGemini, settings.geminiReasoningEffort));
        if (settings.geminiFallbackModels) {
          setGeminiFallbackModels(
            [...new Set(
              settings.geminiFallbackModels
                .map((m) => normalizeGeminiModel(m))
                .filter((m): m is NonNullable<typeof m> => m !== null)
            )].filter((m) => m !== effGemini)
          );
        } else {
          setGeminiFallbackModels(defaultGeminiFallbackModels.filter((m) => m !== effGemini));
        }

        // OpenAI
        if (settings.openaiApiKey !== undefined) setOpenaiApiKey(settings.openaiApiKey ?? '');
        // Ignore legacy model choices outside the supported OpenAI models.
        const effOpenai = normalizeOpenaiModel(settings.openaiModel) ?? defaultOpenaiModel;
        setOpenaiPrimaryModel(effOpenai);
        setOpenaiIsCustomPrimary(false);
        setOpenaiFallbackModels([]);
        setOpenaiReasoningEffort(resolveModelReasoningEffort('openai', effOpenai, settings.openaiReasoningEffort));
        if (settings.openaiBaseUrl !== undefined) setOpenaiBaseUrl(settings.openaiBaseUrl ?? '');

        // DeepSeek
        if (settings.deepseekApiKey !== undefined) setDeepseekApiKey(settings.deepseekApiKey ?? '');
        // Legacy DeepSeek choices must not reactivate an unsupported model.
        setDeepseekPrimaryModel(fixedProviderModels.deepseek);
        setDeepseekIsCustomPrimary(false);
        setDeepseekFallbackModels([]);
        setDeepseekReasoningEffort(
          resolveModelReasoningEffort('deepseek', fixedProviderModels.deepseek, settings.deepseekReasoningEffort)
        );
        if (settings.deepseekBaseUrl !== undefined) setDeepseekBaseUrl(settings.deepseekBaseUrl ?? '');
      })
      .catch((err) => {
        if (active) setLoadError(localizeApiError(err, lang));
      });
    return () => {
      active = false;
    };
  }, []);

  /** Save multi-provider AI keys and models to local SQLite settings. */
  async function saveAiConfig(event: React.FormEvent) {
    event.preventDefault();
    if (!aiLoaded || savingAi || testingAi) return;
    setSavingAi(true);
    setAiError('');
    setAiSaved(false);

    /** Remove empty or duplicate entries before persisting each provider chain. */
    const sanitizeFb = (list: string[], primary: string) => {
      const trimmed = primary.trim();
      return [...new Set(list.map((m) => m.trim()).filter(Boolean))].filter(
        (m) => !trimmed || m !== trimmed
      );
    };

    const cleanGeminiFb = sanitizeFb(geminiFallbackModels, geminiPrimaryModel);
    const cleanOpenaiFb = sanitizeFb(openaiFallbackModels, openaiPrimaryModel);
    const cleanDeepseekFb = sanitizeFb(deepseekFallbackModels, deepseekPrimaryModel);

    try {
      await api.updateSettings({
        llmProvider: provider,
        geminiApiKey: geminiApiKey.trim() || null,
        geminiModel: geminiPrimaryModel.trim() || null,
        geminiFallbackModels: cleanGeminiFb,
        geminiReasoningEffort,
        openaiApiKey: openaiApiKey.trim() || null,
        openaiModel: openaiPrimaryModel.trim() || null,
        openaiBaseUrl: openaiBaseUrl.trim() || null,
        openaiFallbackModels: cleanOpenaiFb,
        openaiReasoningEffort,
        deepseekApiKey: deepseekApiKey.trim() || null,
        deepseekModel: deepseekPrimaryModel.trim() || null,
        deepseekBaseUrl: deepseekBaseUrl.trim() || null,
        deepseekFallbackModels: cleanDeepseekFb,
        deepseekReasoningEffort,
      });
      setGeminiFallbackModels(cleanGeminiFb);
      setOpenaiFallbackModels(cleanOpenaiFb);
      setDeepseekFallbackModels(cleanDeepseekFb);
      setActiveProvider(currentApiKey.trim() ? provider : null);
      workspace.notifyMutation();
      setAiSaved(true);
      dirtyAi.current = false;
    } catch (err) {
      setAiError(localizeApiError(err, lang));
    } finally {
      setSavingAi(false);
    }
  }

  /** Send a test ping to verify configured or drafted key and model connectivity. */
  async function handleTestConnection() {
    if (!currentApiKey.trim()) return;
    setTestingAi(true);
    setTestResult(null);
    setAiError('');
    try {
      const res = provider === 'gemini'
        ? await api.testGeminiConnection({
            apiKey: currentApiKey.trim(),
            model: currentPrimaryModel.trim() || undefined,
            reasoningEffort: currentReasoningEffort,
          })
        : await api.testLlmConnection({
            provider,
            apiKey: currentApiKey.trim(),
            model: currentPrimaryModel.trim() || undefined,
            baseUrl: currentBaseUrl.trim() || undefined,
            reasoningEffort: currentReasoningEffort,
          });
      setTestResult({ ok: true, model: res.model });
    } catch (err) {
      setTestResult({
        ok: false,
        message: localizeApiError(err, lang, t.testAiFailed),
      });
    } finally {
      setTestingAi(false);
    }
  }

  /** Read selected JSON snapshot bundle file. */
  function handleSelectBundleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBundleError('');
    setBundleSuccess('');

    setPendingBundle(null);
    if (file.size > MAX_BUNDLE_BYTES) {
      setBundleError(zh ? '迁移文件不能超过 64 MiB。' : 'Migration files must not exceed 64 MiB.');
      e.target.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const text = String(reader.result);
        const parsed = snapshotBundleSchema.parse(JSON.parse(text));
        setPendingBundle(parsed);
      } catch {
        setBundleError(zh ? '无效或不支持的迁移文件。' : 'Invalid or unsupported migration file.');
      }
    };
    reader.onerror = () => {
      setBundleError(zh ? '读取文件失败。' : 'Failed to read file.');
    };
    reader.readAsText(file);
    e.target.value = '';
  }

  /** Execute atomic snapshot bundle restoration with automatic safety backup. */
  async function handleConfirmRestore() {
    if (!pendingBundle) return;
    setImportingBundle(true);
    setBundleError('');
    setBundleSuccess('');

    try {
      const res = await api.importBundle(pendingBundle);
      if (res.ok) {
        setBundleSuccess(
          zh
            ? `还原成功！已恢复 ${res.result.restoredRecords} 条做题记录与 ${res.result.restoredNotes} 篇笔记。系统安全快照已自动归档至：${res.result.safetyBackupPath}`
            : `Restore complete! Restored ${res.result.restoredRecords} records and ${res.result.restoredNotes} notes. Pre-restore safety backup created at: ${res.result.safetyBackupPath}`
        );
        workspace.notifyMutation();
        clearPracticeIntents();
        // Reload drops every old workspace draft and reapplies the imported language/theme/settings.
        window.location.reload();
      } else {
        setBundleError(zh ? '还原失败。' : 'Restore failed.');
      }
    } catch (err) {
      setBundleError(localizeApiError(err, lang, zh ? '还原失败。' : 'Restore failed.'));
    } finally {
      setImportingBundle(false);
      setPendingBundle(null);
    }
  }

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
        <div role="tabpanel" id="settings-panel-general" aria-labelledby="settings-tab-general" className="settings-panel">
          <section className="preference-row">
            <div className="preference-label">
              <h2>{t.langLabel}</h2>
            </div>
            <div className="segmented-control" aria-label={t.langLabel}>
              <button aria-pressed={lang === 'zh'} onClick={() => onLanguageChange('zh')}>
                简体中文
              </button>
              <button aria-pressed={lang === 'en'} onClick={() => onLanguageChange('en')}>
                English
              </button>
            </div>
          </section>

          <section className="preference-row">
            <div className="preference-label">
              <h2>{t.timezoneLabel}</h2>
              <p>
                {zh
                  ? '决定"今天"从何时开始，用于每日计划和活动日期。更改不会改写已有记录的时间。'
                  : 'Decides when "today" starts for daily plans and activity dates. Existing record times are kept.'}
              </p>
            </div>
            <TimezoneField lang={lang} value={workspace.timezone} onSaved={(zone) => onTimezoneSaved?.(zone)} hideLabel />
          </section>

          <section className="preference-row">
            <div className="preference-label">
              <h2>{zh ? '换题或移除时询问原因' : 'Ask for reason when swapping or removing'}</h2>
              <p>
                {zh
                  ? '开启后，在今日计划中换题或移除题目时会弹出可选反馈窗口；关闭后直接执行操作。'
                  : 'When enabled, swapping or removing a Today problem opens an optional feedback prompt; when off, the action runs directly.'}
              </p>
            </div>
            <div
              className="segmented-control"
              aria-label={zh ? '换题或移除时询问原因' : 'Ask for reason when swapping or removing'}
            >
              <button
                type="button"
                aria-pressed={promptSwapFeedback}
                onClick={() => updatePromptSwapFeedback(true)}
              >
                {zh ? '弹出反馈窗口' : 'Show prompt'}
              </button>
              <button
                type="button"
                aria-pressed={!promptSwapFeedback}
                onClick={() => updatePromptSwapFeedback(false)}
              >
                {zh ? '不弹出' : "Don't show"}
              </button>
            </div>
          </section>

          <section className="preference-row">
            <div className="preference-label">
              <h2>{t.notesFormatOnSave}</h2>
              <p>
                {zh
                  ? '开启后，保存笔记时会自动整理 Markdown 排版（可在保存后随时撤销）。'
                  : 'Automatically clean up Markdown formatting when saving a note (can be undone immediately after saving).'}
              </p>
            </div>
            <div className="segmented-control" role="group" aria-label={t.notesFormatOnSave}>
              <button
                type="button"
                aria-pressed={notesFormatOnSave}
                onClick={() => updateNotesFormatOnSave(true)}
              >
                {zh ? '开启' : 'On'}
              </button>
              <button
                type="button"
                aria-pressed={!notesFormatOnSave}
                onClick={() => updateNotesFormatOnSave(false)}
              >
                {zh ? '关闭' : 'Off'}
              </button>
            </div>
          </section>
        </div>
      )}

      {section === 'appearance' && (
        <div role="tabpanel" id="settings-panel-appearance" aria-labelledby="settings-tab-appearance" className="settings-panel">
          <section className="preference-row">
            <div className="preference-label">
              <h2>{t.themeModeLabel}</h2>
              <p>{zh ? '跟随系统时，配色会回到默认主题。' : 'Following the system uses the default palette.'}</p>
            </div>
            <div className="segmented-control" aria-label={t.themeModeLabel}>
              {(['light', 'dark', 'system'] as const).map((mode) => (
                <button
                  key={mode}
                  aria-pressed={currentTheme === mode}
                  onClick={() => {
                    // Keep a palette that already matches the new mode; otherwise fall back to default.
                    const nextPalette = paletteForMode(currentPalette, mode);
                    if (nextPalette !== currentPalette) onPaletteChange(nextPalette);
                    onThemeChange(mode);
                  }}
                >
                  {mode === 'light' ? t.themeLight : mode === 'dark' ? t.themeDark : t.themeSystem}
                </button>
              ))}
            </div>
          </section>

          <section className="preference-row is-stacked">
            <div className="preference-label">
              <h2>{t.paletteLabel}</h2>
              <p>{t.paletteDesc}</p>
            </div>
            <div className="palette-grid" role="radiogroup" aria-label={t.paletteLabel}>
              {PALETTE_OPTIONS.map((pal) => {
                const isSelected = currentPalette === pal.id;
                return (
                  <button
                    key={pal.id}
                    type="button"
                    role="radio"
                    aria-checked={isSelected}
                    className={`palette-card ${isSelected ? 'active' : ''}`}
                    onClick={() => {
                      onPaletteChange(pal.id);
                      if (pal.type === 'dark' && currentTheme !== 'dark') {
                        onThemeChange('dark');
                      } else if (pal.type === 'light' && currentTheme !== 'light' && pal.id !== 'default') {
                        onThemeChange('light');
                      }
                    }}
                  >
                    <div className="palette-preview" aria-hidden="true">
                      <div className="palette-swatches">
                        <span style={{ backgroundColor: pal.canvas }} />
                        <span style={{ backgroundColor: pal.surface }} />
                        <span style={{ backgroundColor: pal.primary }} />
                        <span style={{ backgroundColor: pal.accent }} />
                      </div>
                      <img src={brandIconUrl(pal.id, resolvedDark)} alt="" width="40" height="40" />
                    </div>
                    <div className="palette-meta">
                      <span className="palette-name">{t[pal.nameKey] as string}</span>
                      <span className={`palette-badge ${pal.type}`}>
                        {pal.id === 'default' ? (zh ? '自适应' : 'Auto') : pal.type === 'dark' ? (zh ? '暗色' : 'Dark') : (zh ? '浅色' : 'Light')}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          </section>
        </div>
      )}

      {section === 'ai' && (
        <div role="tabpanel" id="settings-panel-ai" aria-labelledby="settings-tab-ai" className="settings-panel">
          <section className="preference-row">
            <div className="preference-label">
              <h2>{t.geminiSettingsTitle}</h2>
              <InfoPopover
                label={zh ? 'AI 配置说明' : 'AI configuration help'}
                content={
                  <div>
                    <p>
                      {zh
                        ? 'API 密钥及模型配置保存在本地 SQLite 数据库中，仅在生成计划与导入分析时向所选 AI 服务商发送请求。'
                        : 'API keys and model choices are saved locally in your SQLite database, used only for planning and progress formatting.'}
                    </p>
                    <p>
                      {zh
                        ? '各提供商的配置独立保存，切换提供商不会清除其他提供商已保存的密钥。'
                        : 'Each provider keeps its own configuration. Switching providers preserves existing keys.'}
                    </p>
                  </div>
                }
              />
              <p>{t.geminiSettingsDesc}</p>
              <p className={`ai-status ${activeProvider ? 'is-on' : ''}`} role="status">
                {activeProvider
                  ? zh
                    ? `正在使用 ${providerName(activeProvider)}`
                    : `Using ${providerName(activeProvider)}`
                  : zh
                    ? '未配置：使用本地推荐'
                    : 'Not configured: using local recommendations'}
              </p>
            </div>

            <form className="ai-settings-form" onSubmit={saveAiConfig}>
              <fieldset className="ai-settings-form settings-fieldset" disabled={!aiLoaded || savingAi || testingAi}>
                <div className="form-field">
                  <span>{t.aiProviderLabel}</span>
                  <div className="segmented-control" aria-label={t.aiProviderLabel}>
                    {(['gemini', 'openai', 'deepseek'] as const).map((id) => (
                      <button
                        key={id}
                        type="button"
                        aria-pressed={provider === id}
                        onClick={() => {
                          markAiDirty();
                          setProvider(id);
                          setShowApiKey(false);
                        }}
                      >
                        {id === 'gemini' ? t.providerGemini : id === 'openai' ? t.providerOpenAI : t.providerDeepSeek}
                      </button>
                    ))}
                  </div>
                </div>

                <Field label={`${t.apiKeyLabel} (${providerName(provider)})`}>
                  <div className="input-with-action">
                    <input
                      type={showApiKey ? 'text' : 'password'}
                      value={currentApiKey}
                      onChange={(e) => {
                        markAiDirty();
                        setCurrentApiKey(e.target.value);
                      }}
                      placeholder={
                        provider === 'gemini'
                          ? t.apiKeyPlaceholder
                          : provider === 'openai'
                          ? (zh ? '输入或粘贴您的 OpenAI API 密钥...' : 'Enter or paste your OpenAI API key...')
                          : (zh ? '输入或粘贴您的 DeepSeek API 密钥...' : 'Enter or paste your DeepSeek API key...')
                      }
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <button
                      type="button"
                      className="icon-action-btn"
                      onClick={() => setShowApiKey((prev) => !prev)}
                      aria-label={showApiKey ? t.hideApiKey : t.showApiKey}
                      title={showApiKey ? t.hideApiKey : t.showApiKey}
                    >
                      {showApiKey ? <EyeOff size={18} aria-hidden="true" /> : <Eye size={18} aria-hidden="true" />}
                    </button>
                  </div>
                </Field>

                <button
                  type="button"
                  className="disclosure-toggle"
                  aria-expanded={showAdvanced}
                  aria-controls="ai-advanced-options"
                  onClick={() => setShowAdvanced((open) => !open)}
                >
                  <ChevronDown size={16} aria-hidden="true" />
                  {zh ? '高级选项：模型与接口地址' : 'Advanced: model and endpoint'}
                </button>

                {showAdvanced && (
                  <div id="ai-advanced-options" className="advanced-options">
                    {provider !== 'gemini' && (
                      <Field label={t.baseUrlLabel}>
                        <input
                          type="text"
                          value={currentBaseUrl}
                          onChange={(e) => {
                            markAiDirty();
                            setCurrentBaseUrl(e.target.value);
                          }}
                          placeholder={provider === 'openai' ? 'https://api.openai.com/v1' : 'https://api.deepseek.com'}
                        />
                      </Field>
                    )}

                    <Field label={t.preferredModelLabel}>
                      <select
                        value={currentIsCustomPrimary ? 'custom' : currentPrimaryModel}
                        onChange={(e) => {
                          markAiDirty();
                          if (e.target.value === 'custom') {
                            setCurrentIsCustomPrimary(true);
                            if (currentPresetModels.includes(currentPrimaryModel)) {
                              setCurrentPrimaryModel('');
                            }
                          } else {
                            const selectedModel = e.target.value;
                            setCurrentIsCustomPrimary(false);
                            setCurrentPrimaryModel(selectedModel);
                            setCurrentFallbackModels((prev) => prev.filter((item) => item !== selectedModel));
                            // Keep the reasoning effort only while the newly selected model supports it.
                            if (provider === 'gemini') {
                              if (!getSupportedReasoningEfforts('gemini', selectedModel).includes(geminiReasoningEffort)) {
                                setGeminiReasoningEffort(getDefaultReasoningEffort('gemini', selectedModel));
                              }
                            } else if (provider === 'openai') {
                              if (!getSupportedReasoningEfforts('openai', selectedModel).includes(openaiReasoningEffort)) {
                                setOpenaiReasoningEffort(getDefaultReasoningEffort('openai', selectedModel));
                              }
                            }
                          }
                        }}
                      >
                        {currentPresetModels.map((m, idx) => (
                          <option key={m} value={m}>
                            {provider === 'openai' ? (OPENAI_MODEL_LABELS[m] ?? m) : provider === 'deepseek' ? 'DeepSeek V4.1 Flash' : m.replace('models/', '')}{idx === 0 ? (zh ? '（推荐）' : ' (Recommended)') : ''}
                          </option>
                        ))}
                      </select>
                    </Field>

                    <Field
                      label={t.reasoningEffortLabel}
                      hint={
                        provider === 'gemini'
                          ? (zh
                              ? '通过 thinkingConfig.thinkingLevel 控制 Gemini 思考深度。'
                              : 'Controls Gemini reasoning depth via thinkingConfig.thinkingLevel.')
                          : provider === 'openai'
                          ? (zh
                              ? `通过 reasoning_effort 控制 ${OPENAI_MODEL_LABELS[currentPrimaryModel] ?? currentPrimaryModel} 推理强度。`
                              : `Controls ${OPENAI_MODEL_LABELS[currentPrimaryModel] ?? currentPrimaryModel} reasoning depth via reasoning_effort.`)
                          : (zh
                              ? '通过 reasoning_effort 与 thinking 开关控制 DeepSeek V4.1 Flash 思考模式。'
                              : 'Controls DeepSeek V4.1 Flash thinking mode via reasoning_effort and thinking.')
                      }
                    >
                      <select
                        aria-label={t.reasoningEffortLabel}
                        value={currentReasoningEffort}
                        onChange={(e) => {
                          markAiDirty();
                          setCurrentReasoningEffort(e.target.value as ReasoningEffort);
                        }}
                      >
                        {currentSupportedEfforts.map((effort) => {
                          const labelText =
                            provider === 'gemini'
                              ? effort.toUpperCase()
                              : provider === 'deepseek'
                              ? effort === 'none'
                                ? (zh ? 'none（关闭思考模式）' : 'none (thinking: disabled)')
                                : (zh ? `${effort}（开启思考模式）` : `${effort} (thinking: enabled)`)
                              : effort === 'none'
                              ? (zh ? 'none（关闭推理）' : 'none (no reasoning)')
                              : effort;
                          const defaultBadge = effort === currentDefaultEffort ? (zh ? '（默认）' : ' (Default)') : '';
                          return (
                            <option key={effort} value={effort}>
                              {labelText}{defaultBadge}
                            </option>
                          );
                        })}
                      </select>
                    </Field>

                    {provider === 'gemini' && (
                      <div className="form-field">
                        <span>{t.candidateModelsLabel}</span>
                        <small>{t.candidateModelsDesc}</small>
                        <div className="candidate-chips" role="group" aria-label={t.candidateModelsLabel}>
                          {currentPresetModels.map((m) => {
                            const isSelected = currentFallbackModels.includes(m);
                            const isPrimary = m === currentPrimaryModel.trim();
                            return (
                              <button
                                key={m}
                                type="button"
                                className={`candidate-chip ${isSelected ? 'active' : ''}`}
                                aria-pressed={isSelected}
                                disabled={isPrimary}
                                onClick={() => {
                                  if (isPrimary) return;
                                  markAiDirty();
                                  setCurrentFallbackModels((prev) =>
                                    prev.includes(m)
                                      ? prev.filter((item) => item !== m)
                                      : [...prev, m].filter((item) => item !== currentPrimaryModel.trim())
                                  );
                                }}
                              >
                                {m.replace('models/', '')}
                              </button>
                            );
                          })}
                        </div>
                        <div className="fallback-chain-preview">
                          <span className="chain-label">{t.fallbackChainLabel}:</span>
                          <span className="chain-path">
                            <strong>{currentPrimaryModel.replace('models/', '') || (zh ? '（未选择）' : '(none)')}</strong>
                            {currentFallbackModels.map((m) => (
                              <span key={m} className="chain-step">
                                {' → '}{m.replace('models/', '')}
                              </span>
                            ))}
                          </span>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                <div className="action-row">
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={handleTestConnection}
                    disabled={testingAi || !currentApiKey.trim()}
                  >
                    {testingAi ? t.testingAi : t.testAiConnection}
                  </button>
                  <button className="btn btn-primary" disabled={savingAi}>
                    {savingAi ? '…' : t.saveAiSettings}
                  </button>
                </div>

                {aiError && <Feedback tone="error">{aiError}</Feedback>}
                {aiSaved && <Feedback tone="success">{t.aiSettingsSaved}</Feedback>}
                {testResult && (
                  <Feedback tone={testResult.ok ? 'success' : 'error'}>
                    {testResult.ok
                      ? t.testAiSuccess.replace('{model}', testResult.model || currentPrimaryModel)
                      : testResult.message && testResult.message !== t.testAiFailed
                      ? `${t.testAiFailed}${zh ? '：' : ': '}${testResult.message}`
                      : t.testAiFailed}
                  </Feedback>
                )}
              </fieldset>
            </form>
          </section>
        </div>
      )}

      {section === 'data' && (
        <div role="tabpanel" id="settings-panel-data" aria-labelledby="settings-tab-data" className="settings-panel">
          <section className="preference-row">
            <div className="preference-label">
              <h2>{zh ? '跨设备迁移' : 'Move to another device'}</h2>
              <InfoPopover
                label={zh ? '数据安全与迁移说明' : 'Data portability help'}
                content={
                  <div>
                    <p>
                      {zh
                        ? '所有做题记录、笔记与配置保存在本地 SQLite 中，完全离线运行。'
                        : 'All practice logs, notes, and settings reside in your local SQLite database, 100% offline.'}
                    </p>
                    <p>
                      {zh
                        ? '执行还原前，系统会自动在本地生成一份时间戳安全快照，确保随时可回退。'
                        : 'Before restoring a bundle, the app creates a timestamped safety backup so you can always roll back.'}
                    </p>
                  </div>
                }
              />
              <p>
                {zh
                  ? '一个文件包含题库、进度、笔记、学习安排和设置，可在 Windows 与 Mac 间互相导入。API Key 不会导出。'
                  : 'One file holds your catalog, progress, notes, study schedule and settings. Works across Windows and Mac. API keys are not exported.'}
              </p>
            </div>

            <div className="settings-stack">
              <div className="action-row">
                <ExportLink
                  lang={lang}
                  onExport={() => api.exportBundleFile()}
                  href={api.getBundleExportUrl()}
                  className="btn btn-primary"
                  download
                >
                  <Download size={16} />
                  <span>{zh ? '导出迁移包' : 'Export migration file'}</span>
                </ExportLink>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => bundleFileInputRef.current?.click()}
                  disabled={importingBundle}
                >
                  <Upload size={16} />
                  <span>{importingBundle ? (zh ? '正在还原…' : 'Restoring…') : zh ? '导入迁移包' : 'Import migration file'}</span>
                </button>
                <input
                  ref={bundleFileInputRef}
                  type="file"
                  accept=".json,application/json"
                  hidden
                  onChange={handleSelectBundleFile}
                />
              </div>

              {pendingBundle && (
                <div className="restore-confirm" role="alertdialog" aria-labelledby="restore-confirm-title">
                  <div className="restore-confirm-title" id="restore-confirm-title">
                    <AlertTriangle size={16} aria-hidden="true" />
                    <span>{zh ? '确认替换当前设备的数据？' : 'Replace This Device’s Data?'}</span>
                  </div>
                  <p>
                    {pendingBundle.version !== 1
                      ? `${zh ? '完整迁移' : 'Complete migration'} · v${pendingBundle.appVersion} · ${pendingBundle.tables.problems.length} ${zh ? '题目' : 'problems'} · ${pendingBundle.tables.practice_records.length} ${zh ? '练习记录' : 'practice records'} · ${pendingBundle.tables.progress_snapshots.length} ${zh ? '进度记录' : 'progress snapshots'} · ${pendingBundle.tables.problem_notes.length} ${zh ? '笔记' : 'notes'}`
                      : zh ? '旧版 v1：仅部分恢复，不包含题库或完整历史。请先确保本机已有对应题库。' : 'Legacy v1: partial restore only; no catalog or complete history. The matching catalog must already exist.'}
                  </p>
                  <p className="restore-confirm-note">
                    {zh
                      ? '这不是合并操作。确认后会先备份当前数据库，再替换相应数据；失败将保留原库。目标设备已有 API Key 保留。请先保存未完成编辑，成功后页面会重新加载。'
                      : 'This replaces data; it does not merge devices. A safety backup is created before writing, and failed restores preserve the original database. Local API keys remain. Save unfinished edits first; the app reloads after success.'}
                  </p>
                  <div className="action-row">
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      onClick={() => void handleConfirmRestore()}
                      disabled={importingBundle}
                    >
                      {importingBundle ? '…' : zh ? '确认并还原' : 'Confirm & Restore'}
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => setPendingBundle(null)}
                      disabled={importingBundle}
                    >
                      {zh ? '取消' : 'Cancel'}
                    </button>
                  </div>
                </div>
              )}

              {bundleSuccess && <Feedback tone="success">{bundleSuccess}</Feedback>}
              {bundleError && <Feedback tone="error">{bundleError}</Feedback>}
            </div>
          </section>

          <section className="preference-row">
            <div className="preference-label">
              <h2>{zh ? '导出到笔记工具' : 'Export to note apps'}</h2>
              <p>
                {zh
                  ? 'Obsidian 题库与笔记骨架（.zip），或 Notion 可导入的 CSV 表格。'
                  : 'An Obsidian vault of problems and note skeletons (.zip), or CSV tables for Notion.'}
              </p>
            </div>
            <div className="action-row">
              <ExportLink
                lang={lang}
                onExport={() => api.exportObsidianZip('all', lang)}
                href={api.getObsidianZipUrl('all', lang)}
                className="btn btn-secondary btn-sm"
                title={t.exportObsidianTitle}
              >
                <Archive size={14} />
                <span>{t.exportObsidianVault}</span>
              </ExportLink>
              <ExportLink
                lang={lang}
                onExport={() => api.exportNotionCsv('summary')}
                href={api.getNotionCsvUrl('summary')}
                className="btn btn-secondary btn-sm"
                title={t.exportNotionSummaryTitle}
              >
                <Download size={14} />
                <span>{t.exportNotionSummary}</span>
              </ExportLink>
              <ExportLink
                lang={lang}
                onExport={() => api.exportNotionCsv('history')}
                href={api.getNotionCsvUrl('history')}
                className="btn btn-secondary btn-sm"
                title={t.exportNotionHistoryTitle}
              >
                <Download size={14} />
                <span>{t.exportNotionHistory}</span>
              </ExportLink>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
