/** Application preferences only; catalog and progress imports live in their respective workspaces. */
import React, { useEffect, useRef, useState } from 'react';
import { Eye, EyeOff, Copy, Check, ClipboardPaste, Download, Upload, Archive, Database, AlertTriangle } from 'lucide-react';
import { fixedProviderModels, type ThemePalette } from '../../../../packages/contracts/src/sync.ts';
import { api } from '../api.ts';
import { translations, type Language } from '../i18n.ts';
import { useWorkspace } from '../workspace.tsx';
import { PageHeader, Feedback, Field, InfoPopover } from './ui.tsx';

interface SettingsViewProps {
  lang: Language;
  onLanguageChange: (lang: Language) => void;
  onThemeChange: (theme: 'light' | 'dark') => void;
  currentTheme: 'light' | 'dark' | 'system';
  onPaletteChange?: (palette: ThemePalette) => void;
  currentPalette?: ThemePalette;
  onTimezoneSaved?: (zone: string | null) => void;
}

export interface PaletteOption {
  id: ThemePalette;
  nameKey: keyof typeof translations.en;
  type: 'dark' | 'light';
  canvas: string;
  surface: string;
  primary: string;
  accent: string;
}

export const PALETTE_OPTIONS: PaletteOption[] = [
  {
    id: 'default',
    nameKey: 'paletteDefault',
    type: 'light',
    canvas: '#f7f6f2',
    surface: '#ffffff',
    primary: '#42634b',
    accent: '#82561f',
  },
  {
    id: 'dracula',
    nameKey: 'paletteDracula',
    type: 'dark',
    canvas: '#282a36',
    surface: '#343746',
    primary: '#bd93f9',
    accent: '#ff79c6',
  },
  {
    id: 'nord',
    nameKey: 'paletteNord',
    type: 'dark',
    canvas: '#2e3440',
    surface: '#3b4252',
    primary: '#88c0d0',
    accent: '#a3be8c',
  },
  {
    id: 'catppuccin-mocha',
    nameKey: 'paletteCatppuccinMocha',
    type: 'dark',
    canvas: '#1e1e2e',
    surface: '#252538',
    primary: '#cba6f7',
    accent: '#f5c2e7',
  },
  {
    id: 'tokyo-night',
    nameKey: 'paletteTokyoNight',
    type: 'dark',
    canvas: '#1a1b26',
    surface: '#24283b',
    primary: '#7aa2f7',
    accent: '#bb9af7',
  },
  {
    id: 'one-dark',
    nameKey: 'paletteOneDark',
    type: 'dark',
    canvas: '#21252b',
    surface: '#282c34',
    primary: '#61afef',
    accent: '#c678dd',
  },
  {
    id: 'gruvbox-dark',
    nameKey: 'paletteGruvboxDark',
    type: 'dark',
    canvas: '#282828',
    surface: '#32302f',
    primary: '#fabd2f',
    accent: '#b8bb26',
  },
  {
    id: 'midnight-oled',
    nameKey: 'paletteMidnightOled',
    type: 'dark',
    canvas: '#000000',
    surface: '#0f1117',
    primary: '#10b981',
    accent: '#06b6d4',
  },
  {
    id: 'catppuccin-latte',
    nameKey: 'paletteCatppuccinLatte',
    type: 'light',
    canvas: '#eff1f5',
    surface: '#ffffff',
    primary: '#8839ef',
    accent: '#df8e1d',
  },
  {
    id: 'github-light',
    nameKey: 'paletteGithubLight',
    type: 'light',
    canvas: '#f6f8fa',
    surface: '#ffffff',
    primary: '#0969da',
    accent: '#1a7f37',
  },
];

export type ProviderType = 'gemini' | 'openai' | 'deepseek';

export const PROVIDER_PRESET_MODELS: Record<ProviderType, string[]> = {
  gemini: [
    'models/gemini-3.8-flash',
    'models/gemini-3.7-flash',
    'models/gemini-3.6-flash',
    'models/gemini-3.5-flash',
    'models/gemini-3.5-flash-lite',
    'models/gemini-2.5-flash',
    'models/gemini-2.5-pro',
  ],
  openai: [fixedProviderModels.openai],
  deepseek: [fixedProviderModels.deepseek],
};

/** Keep the timezone and AI drafts intact on background refresh; only explicit save changes preferences. */
export function SettingsView({
  lang,
  onLanguageChange,
  onThemeChange,
  currentTheme,
  onPaletteChange = () => {},
  currentPalette = 'default',
  onTimezoneSaved,
}: SettingsViewProps) {
  const t = translations[lang];
  const workspace = useWorkspace();
  const zh = lang === 'zh';

  // Timezone state
  const [zone, setZone] = useState(workspace.timezone ?? '');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const dirty = useRef(false);

  // Multi-provider AI configuration state
  const [aiLoaded, setAiLoaded] = useState(false);
  const [provider, setProvider] = useState<ProviderType>('gemini');

  // Gemini state
  const [geminiApiKey, setGeminiApiKey] = useState('');
  const [geminiPrimaryModel, setGeminiPrimaryModel] = useState('models/gemini-3.8-flash');
  const [geminiIsCustomPrimary, setGeminiIsCustomPrimary] = useState(false);
  const [geminiFallbackModels, setGeminiFallbackModels] = useState<string[]>([
    'models/gemini-3.7-flash',
    'models/gemini-3.6-flash',
  ]);

  // OpenAI state
  const [openaiApiKey, setOpenaiApiKey] = useState('');
  const [openaiPrimaryModel, setOpenaiPrimaryModel] = useState<string>(fixedProviderModels.openai);
  const [openaiIsCustomPrimary, setOpenaiIsCustomPrimary] = useState(false);
  const [openaiBaseUrl, setOpenaiBaseUrl] = useState('');
  const [openaiFallbackModels, setOpenaiFallbackModels] = useState<string[]>([]);

  // DeepSeek state
  const [deepseekApiKey, setDeepseekApiKey] = useState('');
  const [deepseekPrimaryModel, setDeepseekPrimaryModel] = useState<string>(fixedProviderModels.deepseek);
  const [deepseekIsCustomPrimary, setDeepseekIsCustomPrimary] = useState(false);
  const [deepseekBaseUrl, setDeepseekBaseUrl] = useState('');
  const [deepseekFallbackModels, setDeepseekFallbackModels] = useState<string[]>([]);

  // Shared AI form & action state
  const [showApiKey, setShowApiKey] = useState(false);
  const [copied, setCopied] = useState(false);
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

  // Bundle export / import state
  const [importingBundle, setImportingBundle] = useState(false);
  const [bundleSuccess, setBundleSuccess] = useState('');
  const [bundleError, setBundleError] = useState('');
  const [pendingBundle, setPendingBundle] = useState<unknown | null>(null);
  const bundleFileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let active = true;
    api
      .getSettings()
      .then((settings) => {
        if (active) setAiLoaded(true);
        if (active) {
          if (!dirty.current) setZone(settings.timezone ?? '');
          if (!dirtyAi.current) {
            if (settings.llmProvider) {
              setProvider(settings.llmProvider);
            }

            // Gemini
            if (settings.geminiApiKey !== undefined) setGeminiApiKey(settings.geminiApiKey ?? '');
            const effGemini = settings.geminiModel ?? 'models/gemini-3.8-flash';
            if (settings.geminiModel) {
              setGeminiPrimaryModel(settings.geminiModel);
              setGeminiIsCustomPrimary(!PROVIDER_PRESET_MODELS.gemini.includes(settings.geminiModel));
            }
            if (settings.geminiFallbackModels) {
              setGeminiFallbackModels(
                [...new Set(settings.geminiFallbackModels)].filter((m) => m !== effGemini)
              );
            }

            // OpenAI
            if (settings.openaiApiKey !== undefined) setOpenaiApiKey(settings.openaiApiKey ?? '');
            // Ignore legacy model choices: the application offers only Luna for OpenAI.
            setOpenaiPrimaryModel(fixedProviderModels.openai);
            setOpenaiIsCustomPrimary(false);
            setOpenaiFallbackModels([]);
            if (settings.openaiBaseUrl !== undefined) setOpenaiBaseUrl(settings.openaiBaseUrl ?? '');

            // DeepSeek
            if (settings.deepseekApiKey !== undefined) setDeepseekApiKey(settings.deepseekApiKey ?? '');
            // Legacy DeepSeek choices must not reactivate an unsupported model.
            setDeepseekPrimaryModel(fixedProviderModels.deepseek);
            setDeepseekIsCustomPrimary(false);
            setDeepseekFallbackModels([]);
            if (settings.deepseekBaseUrl !== undefined) setDeepseekBaseUrl(settings.deepseekBaseUrl ?? '');

          }
        }
      })
      .catch((err) => {
        if (active) setError(String(err.message));
      });
    return () => {
      active = false;
    };
  }, []);

  /** Validate IANA names locally and wait for server persistence before publishing the new timezone. */
  async function saveZone(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError('');
    setSaved(false);
    try {
      if (zone.trim()) new Intl.DateTimeFormat('en', { timeZone: zone.trim() });
      const settings = await api.updateSettings({ timezone: zone.trim() || null });
      onTimezoneSaved?.(settings.timezone);
      workspace.notifyMutation();
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  /** Copy API key to clipboard with visual confirmation. */
  async function handleCopyApiKey() {
    if (!currentApiKey) return;
    try {
      await navigator.clipboard.writeText(currentApiKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard write failed or unpermitted
    }
  }

  /** Paste API key from clipboard into draft. */
  async function handlePasteApiKey() {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        dirtyAi.current = true;
        setCurrentApiKey(text.trim());
        setAiSaved(false);
        setTestResult(null);
      }
    } catch {
      // Clipboard read failed or unpermitted
    }
  }

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
        openaiApiKey: openaiApiKey.trim() || null,
        openaiModel: openaiPrimaryModel.trim() || null,
        openaiBaseUrl: openaiBaseUrl.trim() || null,
        openaiFallbackModels: cleanOpenaiFb,
        deepseekApiKey: deepseekApiKey.trim() || null,
        deepseekModel: deepseekPrimaryModel.trim() || null,
        deepseekBaseUrl: deepseekBaseUrl.trim() || null,
        deepseekFallbackModels: cleanDeepseekFb,
      });
      setGeminiFallbackModels(cleanGeminiFb);
      setOpenaiFallbackModels(cleanOpenaiFb);
      setDeepseekFallbackModels(cleanDeepseekFb);
      workspace.notifyMutation();
      setAiSaved(true);
      dirtyAi.current = false;
    } catch (err) {
      setAiError(err instanceof Error ? err.message : String(err));
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
          })
        : await api.testLlmConnection({
            provider,
            apiKey: currentApiKey.trim(),
            model: currentPrimaryModel.trim() || undefined,
            baseUrl: currentBaseUrl.trim() || undefined,
          });
      setTestResult({ ok: true, model: res.model });
    } catch (err) {
      setTestResult({
        ok: false,
        message: err instanceof Error ? err.message : String(err),
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

    const reader = new FileReader();
    reader.onload = () => {
      try {
        const text = String(reader.result);
        const parsed = JSON.parse(text);
        setPendingBundle(parsed);
      } catch {
        setBundleError(zh ? '无效的 JSON 文件格式。' : 'Invalid JSON file format.');
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
      } else {
        setBundleError(zh ? '还原失败。' : 'Restore failed.');
      }
    } catch (err) {
      setBundleError(err instanceof Error ? err.message : String(err));
    } finally {
      setImportingBundle(false);
      setPendingBundle(null);
    }
  }

  return (
    <div className="settings-view">
      <PageHeader title={zh ? '设置' : 'Settings'} />

      {/* Language row */}
      <section className="preference-row">
        <div>
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

      {/* Theme Mode row */}
      <section className="preference-row">
        <div>
          <h2>{t.themeModeLabel}</h2>
          <InfoPopover
            label={zh ? '模式说明' : 'Mode help'}
            content={<p>{zh ? '在明亮模式和暗色模式之间快速切换。' : 'Switch between light and dark display modes.'}</p>}
          />
        </div>
        <div className="segmented-control" aria-label={t.themeModeLabel}>
          {(['light', 'dark'] as const).map((mode) => (
            <button key={mode} aria-pressed={currentTheme === mode} onClick={() => onThemeChange(mode)}>
              {mode === 'light' ? t.themeLight : t.themeDark}
            </button>
          ))}
        </div>
      </section>

      {/* Custom Theme Palettes Gallery */}
      <section className="preference-row palette-selection-section">
        <div>
          <h2>{t.paletteLabel}</h2>
          <p className="muted">{t.paletteDesc}</p>
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
                <div className="palette-swatches">
                  <span style={{ backgroundColor: pal.canvas }} title="Canvas" />
                  <span style={{ backgroundColor: pal.surface }} title="Surface" />
                  <span style={{ backgroundColor: pal.primary }} title="Primary" />
                  <span style={{ backgroundColor: pal.accent }} title="Accent" />
                </div>
                <div className="palette-meta">
                  <span className="palette-name">{t[pal.nameKey] as string}</span>
                  <span className={`palette-badge ${pal.type}`}>
                    {pal.type === 'dark' ? (zh ? '暗色' : 'Dark') : (zh ? '浅色' : 'Light')}
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      </section>

      {/* Timezone row */}
      <section className="preference-row">
        <div>
          <h2>{t.timezoneLabel}</h2>
          <p className="muted">
            {zh
              ? '用于今日计划和活动日期统计。更改不会改写原始记录时间。'
              : 'Used for daily plans and activity dates. Changing it preserves original record times.'}
          </p>
        </div>
        <form className="timezone-form" onSubmit={saveZone}>
          <Field label={zh ? 'IANA 时区' : 'IANA timezone'}>
            <input
              list="timezone-options"
              value={zone}
              onChange={(e) => {
                dirty.current = true;
                setZone(e.target.value);
                setSaved(false);
              }}
              placeholder={zh ? '尚未配置' : 'Not configured'}
            />
          </Field>
          <datalist id="timezone-options">
            {[
              'UTC',
              'Asia/Shanghai',
              'Asia/Tokyo',
              'America/Los_Angeles',
              'America/New_York',
              'Europe/London',
              'Europe/Paris',
            ].map((z) => (
              <option key={z} value={z} />
            ))}
          </datalist>
          <div className="action-row">
            <button
              type="button"
              className="text-link"
              onClick={() => {
                dirty.current = true;
                setZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
                setSaved(false);
              }}
            >
              {zh ? '使用浏览器建议' : 'Use browser suggestion'}
            </button>
            <button className="btn btn-primary" disabled={saving}>
              {saving ? '…' : zh ? '保存时区' : 'Save timezone'}
            </button>
          </div>
          {error && <Feedback>{error}</Feedback>}
          {saved && <Feedback tone="success">{zh ? '时区已保存' : 'Timezone saved'}</Feedback>}
        </form>
      </section>

      {/* Multi-provider AI Assistant Configuration row */}
      <section className="preference-row">
        <div>
          <h2>{t.geminiSettingsTitle}</h2>
          <p className="muted">{t.geminiSettingsDesc}</p>
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
                    ? '各提供商（Gemini、OpenAI、DeepSeek）的配置独立持久化，切换提供商不会清除其他提供商已保存的密钥。'
                    : 'Configurations for Gemini, OpenAI, and DeepSeek are stored independently. Switching providers preserves existing keys.'}
                </p>
                <p>
                  {zh
                    ? '密钥默认以圆点掩码保护，点击眼睛图标随时切换查看明文。'
                    : 'API keys are masked with dots by default. Click the eye icon to toggle visibility.'}
                </p>
              </div>
            }
          />
        </div>

        <form className="ai-settings-form" onSubmit={saveAiConfig}>
          <fieldset className="ai-settings-form" disabled={!aiLoaded || savingAi || testingAi} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
          {/* AI Provider Segmented Control */}
          <div className="form-field">
            <span>{t.aiProviderLabel}</span>
            <div className="segmented-control" aria-label={t.aiProviderLabel}>
              <button
                type="button"
                aria-pressed={provider === 'gemini'}
                onClick={() => {
                  dirtyAi.current = true;
                  setProvider('gemini');
                  setShowApiKey(false);
                  setCopied(false);
                  setAiSaved(false);
                  setTestResult(null);
                }}
              >
                {t.providerGemini}
              </button>
              <button
                type="button"
                aria-pressed={provider === 'openai'}
                onClick={() => {
                  dirtyAi.current = true;
                  setProvider('openai');
                  setShowApiKey(false);
                  setCopied(false);
                  setAiSaved(false);
                  setTestResult(null);
                }}
              >
                {t.providerOpenAI}
              </button>
              <button
                type="button"
                aria-pressed={provider === 'deepseek'}
                onClick={() => {
                  dirtyAi.current = true;
                  setProvider('deepseek');
                  setShowApiKey(false);
                  setCopied(false);
                  setAiSaved(false);
                  setTestResult(null);
                }}
              >
                {t.providerDeepSeek}
              </button>
            </div>
          </div>

          {/* API Key field with eye toggle */}
          <Field label={`${t.apiKeyLabel} (${provider === 'gemini' ? 'Gemini' : provider === 'openai' ? 'OpenAI' : 'DeepSeek'})`}>
            <div className="input-with-action">
              <input
                type={showApiKey ? 'text' : 'password'}
                value={currentApiKey}
                onChange={(e) => {
                  dirtyAi.current = true;
                  setCurrentApiKey(e.target.value);
                  setAiSaved(false);
                  setTestResult(null);
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

          {/* Quick API Key Copy / Paste / Clear bar */}
          <div className="api-key-actions">
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={handleCopyApiKey}
              disabled={!currentApiKey}
              title={t.copyApiKey}
            >
              {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
              <span>{copied ? t.keyCopied : t.copyApiKey}</span>
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={handlePasteApiKey}
              title={t.pasteApiKey}
            >
              <ClipboardPaste size={14} aria-hidden="true" />
              <span>{t.pasteApiKey}</span>
            </button>
            {currentApiKey && (
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => {
                  dirtyAi.current = true;
                  setCurrentApiKey('');
                  setAiSaved(false);
                  setTestResult(null);
                }}
                title={t.clearApiKey}
              >
                <span>{t.clearApiKey}</span>
              </button>
            )}
          </div>

          {/* Base URL field for OpenAI and DeepSeek */}
          {provider !== 'gemini' && (
            <Field label={t.baseUrlLabel}>
              <input
                type="text"
                value={currentBaseUrl}
                onChange={(e) => {
                  dirtyAi.current = true;
                  setCurrentBaseUrl(e.target.value);
                  setAiSaved(false);
                  setTestResult(null);
                }}
                placeholder={
                  provider === 'openai'
                    ? 'https://api.openai.com/v1'
                    : 'https://api.deepseek.com'
                }
              />
            </Field>
          )}

          {/* Preferred Model selection */}
          <Field label={t.preferredModelLabel}>
            <select
              value={currentIsCustomPrimary ? 'custom' : currentPrimaryModel}
              onChange={(e) => {
                dirtyAi.current = true;
                setAiSaved(false);
                setTestResult(null);
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
                }
              }}
            >
              {currentPresetModels.map((m, idx) => (
                <option key={m} value={m}>
                  {provider === 'openai' ? 'GPT-5.6 Luna' : provider === 'deepseek' ? 'DeepSeek V4.1 Flash' : m.replace('models/', '')}{idx === 0 ? (zh ? '（推荐）' : ' (Recommended)') : ''}
                </option>
              ))}
              {provider === 'gemini' && <option value="custom">{t.customModelOption}</option>}
            </select>
          </Field>

          {/* Custom primary model input when custom option is selected */}
          {provider === 'gemini' && currentIsCustomPrimary && (
            <Field label={zh ? '自定义模型名称' : 'Custom Model Identifier'}>
              <input
                type="text"
                value={currentPrimaryModel}
                onChange={(e) => {
                  dirtyAi.current = true;
                  const newCustom = e.target.value;
                  setCurrentPrimaryModel(newCustom);
                  if (newCustom.trim()) {
                    setCurrentFallbackModels((prev) => prev.filter((item) => item !== newCustom.trim()));
                  }
                  setAiSaved(false);
                  setTestResult(null);
                }}
                placeholder={
                  provider === 'gemini'
                    ? 'models/gemini-custom'
                    : provider === 'openai'
                    ? 'gpt-4o'
                    : 'deepseek-chat'
                }
              />
            </Field>
          )}

          {/* Candidate fallback models chips */}
          {provider === 'gemini' && <div className="form-field">
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
                      dirtyAi.current = true;
                      setAiSaved(false);
                      setTestResult(null);
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

            {/* Fallback chain preview */}
            <div className="fallback-chain-preview">
              <span className="chain-label">{t.fallbackChainLabel}:</span>
              <span className="chain-path">
                <strong>{currentPrimaryModel.replace('models/', '') || '(none)'}</strong>
                {currentFallbackModels.length > 0 &&
                  currentFallbackModels.map((m) => (
                    <span key={m} className="chain-step">
                      {' → '}{m.replace('models/', '')}
                    </span>
                  ))}
              </span>
            </div>
          </div>}

          {/* Save & Test Action Row */}
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
                : `${t.testAiFailed}: ${testResult.message}`}
            </Feedback>
          )}
        </fieldset>
        </form>
      </section>

      {/* Data Management & Portable Snapshots row */}
      <section className="preference-row">
        <div>
          <h2>{t.dataManagementTitle}</h2>
          <p className="muted">{t.dataManagementDesc}</p>
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
                    ? '执行还原前，系统会自动在本地生成一份时间戳安全快照（.db.bak），确保随时可回退，零数据丢失风险。'
                    : 'Before restoring a bundle, the system automatically creates a timestamped safety SQLite backup (.db.bak) for zero data loss.'}
                </p>
              </div>
            }
          />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {/* Bundle Export & Import */}
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '12px',
              padding: '16px',
              backgroundColor: 'var(--surface-muted)',
              borderRadius: '8px',
              border: '1px solid var(--border)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 600 }}>
              <Database size={18} />
              <span>{zh ? '全量数据备份与还原（JSON Snapshot Bundle）' : 'Full Data Backup & Restore (JSON Snapshot Bundle)'}</span>
            </div>
            <p style={{ margin: 0, fontSize: '0.875rem', color: 'var(--text-muted)' }}>
              {t.exportJsonBundleDesc}
            </p>

            <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'center' }}>
              <a
                href={api.getBundleExportUrl()}
                className="btn btn-primary btn-sm"
                download
              >
                <Download size={14} />
                <span>{t.exportJsonBundle}</span>
              </a>

              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => bundleFileInputRef.current?.click()}
                disabled={importingBundle}
              >
                <Upload size={14} />
                <span>{importingBundle ? (zh ? '正在还原…' : 'Restoring…') : t.importJsonBundle}</span>
              </button>

              <input
                ref={bundleFileInputRef}
                type="file"
                accept=".json,application/json"
                style={{ display: 'none' }}
                onChange={handleSelectBundleFile}
              />
            </div>

            {/* Pending restore confirmation prompt */}
            {Boolean(pendingBundle) && (
              <div
                style={{
                  padding: '12px 14px',
                  backgroundColor: 'var(--warning-subtle)',
                  borderRadius: '6px',
                  border: '1px solid var(--warning)',
                  marginTop: '8px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '8px',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 600, color: 'var(--text-primary)' }}>
                  <AlertTriangle size={16} />
                  <span>{zh ? '确认无损还原备份？' : 'Confirm Backup Restoration?'}</span>
                </div>
                <p style={{ margin: 0, fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>
                  {zh
                    ? '导入备份将更新系统配置、策略与做题记录。系统已自动在后台为您创建当前数据库的安全快照。'
                    : 'Restoring will merge/update settings, strategies, and practice records. An automated safety backup will be created before writing.'}
                </p>
                <div style={{ display: 'flex', gap: '8px' }}>
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

          {/* External Knowledge Base Export */}
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '12px',
              padding: '16px',
              backgroundColor: 'var(--surface-muted)',
              borderRadius: '8px',
              border: '1px solid var(--border)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 600 }}>
              <Archive size={18} />
              <span>{zh ? '知识库导出（Obsidian & Notion）' : 'Knowledge Base Export (Obsidian & Notion)'}</span>
            </div>
            <p style={{ margin: 0, fontSize: '0.875rem', color: 'var(--text-muted)' }}>
              {zh
                ? '一键导出支持本地双向链接的 Obsidian 题库与 Markdown 笔记骨架包，或 Notion 双结构化 CSV 表格。'
                : 'Export complete Obsidian vault skeleton archive (.zip) and Notion CSV tables.'}
            </p>

            <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
              <a
                href={api.getObsidianZipUrl('all', lang)}
                className="btn btn-secondary btn-sm"
                title="Download 4,000+ problem Obsidian vault skeleton"
              >
                <Archive size={14} />
                <span>{t.exportObsidianVault}</span>
              </a>

              <a
                href={api.getNotionCsvUrl('summary')}
                className="btn btn-secondary btn-sm"
                title="Download Notion Problems Summary CSV"
              >
                <Download size={14} />
                <span>{t.exportNotionCsv} (题库表)</span>
              </a>

              <a
                href={api.getNotionCsvUrl('history')}
                className="btn btn-secondary btn-sm"
                title="Download Notion Practice History CSV"
              >
                <Download size={14} />
                <span>{t.exportNotionCsv} (做题历史表)</span>
              </a>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
