import { ExportLink } from './ExportLink.tsx';
/** Application preferences only; catalog and progress imports live in their respective workspaces. */
import React, { useEffect, useRef, useState } from 'react';
import {
  Eye,
  EyeOff,
  Copy,
  Check,
  ClipboardPaste,
  Download,
  Upload,
  Archive,
  Database,
  AlertTriangle,
  Cpu,
  Server,
  Power,
  Play,
  Pause,
  RefreshCw,
  Key,
  Shield,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { fixedProviderModels, type ThemePalette } from '../../../../packages/contracts/src/sync.ts';
import { api, mcpApi, type McpSettingsConfig, type McpClientCredential, type McpStatus } from '../api.ts';
import { snapshotBundleSchema, type SnapshotBundle } from '../../../../packages/contracts/src/notes.ts';
import { MAX_BUNDLE_BYTES } from '../../../../packages/contracts/src/migration.ts';
import { clearPracticeIntents } from '../practice-service.ts';
import { translations, type Language } from '../i18n.ts';
import { useWorkspace } from '../workspace.tsx';
import { PageHeader, Feedback, Field, InfoPopover } from './ui.tsx';
import { isTauri, getAutostartStatus, setAutostartStatus } from '../platform/index.ts';

interface SettingsViewProps {
  lang: Language;
  onLanguageChange: (lang: Language) => void;
  onThemeChange: (theme: 'light' | 'dark' | 'system') => void;
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

  // Desktop background runtime state
  const isDesktop = isTauri();
  const [autostartEnabled, setAutostartEnabled] = useState(false);
  const [autostartLoading, setAutostartLoading] = useState(false);

  // MCP AI Connection State
  const [mcpConfig, setMcpConfig] = useState<McpSettingsConfig | null>(null);
  const [mcpStatus, setMcpStatus] = useState<McpStatus | null>(null);
  const [mcpLoading, setMcpLoading] = useState(false);
  const [mcpError, setMcpError] = useState<string | null>(null);
  const [mcpSuccess, setMcpSuccess] = useState<string | null>(null);
  const [copiedTokenId, setCopiedTokenId] = useState<string | null>(null);
  const [mcpPortDraft, setMcpPortDraft] = useState<number>(30138);
  const [savingPort, setSavingPort] = useState(false);
  const [newClientName, setNewClientName] = useState('');
  const [creatingClient, setCreatingClient] = useState(false);
  const [expandedClientId, setExpandedClientId] = useState<string | null>(null);
  const [showTokens, setShowTokens] = useState<Record<string, boolean>>({});

  const loadMcpConfigData = async () => {
    setMcpLoading(true);
    try {
      const [cfg, status] = await Promise.all([mcpApi.getConfig(), mcpApi.getStatus()]);
      setMcpConfig(cfg);
      setMcpStatus(status);
      setMcpPortDraft(cfg.port);
    } catch {
      setMcpConfig(null); setMcpStatus(null);
      setMcpError(zh ? 'MCP 配置不可用' : 'MCP configuration unavailable');
    } finally {
      setMcpLoading(false);
    }
  };

  useEffect(() => {
    if (isTauri()) {
      getAutostartStatus().then(setAutostartEnabled).catch(() => {});
    }
    void loadMcpConfigData();
    let active = true;
    const poll = setInterval(() => {
      void mcpApi.getStatus().then(status => {
        if (!active) return;
        setMcpStatus(status);
        setMcpConfig(current => current ? { ...current, aiAccessPaused: status.aiAccessPaused } : current);
      }).catch(() => { if (active) setMcpStatus(null); });
    }, 2000);
    return () => { active = false; clearInterval(poll); };
  }, []);

  const handleToggleAutostart = async () => {
    setAutostartLoading(true);
    try {
      const next = !autostartEnabled;
      await setAutostartStatus(next);
      setAutostartEnabled(next);
    } catch (err) {
      setMcpError(err instanceof Error ? err.message : String(err));
    } finally {
      setAutostartLoading(false);
    }
  };

  const handleToggleAiPause = async () => {
    if (!mcpConfig) return;
    try {
      const next = !mcpConfig.aiAccessPaused;
      const updated = await mcpApi.updateConfig({ aiAccessPaused: next });
      setMcpConfig(updated);
      setMcpStatus(await mcpApi.getStatus());
      setMcpSuccess(
        next
          ? (zh ? '已暂停外部 AI 访问' : 'External AI access paused')
          : (zh ? '已恢复外部 AI 访问' : 'External AI access resumed')
      );
      setTimeout(() => setMcpSuccess(null), 3000);
    } catch (err) {
      setMcpError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleSavePort = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!mcpConfig || mcpPortDraft <= 0 || mcpPortDraft > 65535) return;
    setSavingPort(true);
    try {
      const updated = await mcpApi.updateConfig({ port: mcpPortDraft });
      setMcpConfig(updated);
      setMcpStatus(await mcpApi.getStatus());
      setMcpSuccess(
        zh
          ? '端口已更新，请重启桌面应用以使新端口生效。'
          : 'Port updated. Restart LeetCode Tracker for changes to take effect.'
      );
      setTimeout(() => setMcpSuccess(null), 5000);
    } catch (err) {
      setMcpError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingPort(false);
    }
  };

  const handleCreateClient = async (e: React.FormEvent, name = newClientName) => {
    e.preventDefault();
    if (!name.trim()) return;
    setCreatingClient(true);
    try {
      await mcpApi.createClient(name.trim());
      setNewClientName('');
      await loadMcpConfigData();
      setMcpSuccess(zh ? '已创建新连接凭证' : 'New connection created');
      setTimeout(() => setMcpSuccess(null), 3000);
    } catch (err) {
      setMcpError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreatingClient(false);
    }
  };

  const handleRotateClient = async (id: string) => {
    try {
      await mcpApi.rotateClient(id);
      await loadMcpConfigData();
      setMcpSuccess(zh ? '凭据密钥已重新生成' : 'Connection token rotated');
      setTimeout(() => setMcpSuccess(null), 3000);
    } catch (err) {
      setMcpError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleRevokeClient = async (id: string) => {
    try {
      await mcpApi.revokeClient(id);
      await loadMcpConfigData();
      setMcpSuccess(zh ? '连接已撤销' : 'Connection revoked');
      setTimeout(() => setMcpSuccess(null), 3000);
    } catch (err) {
      setMcpError(err instanceof Error ? err.message : String(err));
    }
  };

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedTokenId(id);
    setTimeout(() => setCopiedTokenId(null), 2000);
  };

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
  const [pendingBundle, setPendingBundle] = useState<SnapshotBundle | null>(null);
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
            content={<p>{zh ? '在浅色模式、深色模式或跟随系统之间切换。' : 'Switch between light, dark, or system display modes.'}</p>}
          />
        </div>
        <div className="segmented-control" aria-label={t.themeModeLabel}>
          {(['light', 'dark', 'system'] as const).map((mode) => (
            <button
              key={mode}
              aria-pressed={currentTheme === mode}
              onClick={() => {
                // When in a custom palette, switching mode reverts back to the default palette.
                if (currentPalette && currentPalette !== 'default') {
                  onPaletteChange('default');
                }
                onThemeChange(mode);
              }}
            >
              {mode === 'light' ? t.themeLight : mode === 'dark' ? t.themeDark : t.themeSystem}
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

      {/* Background Runtime row */}
      <section className="preference-row">
        <div>
          <h2>{zh ? '后台运行' : 'Background Runtime'}</h2>
          <p className="muted">
            {zh
              ? '开机静默启动与托盘常驻守护，随时为外部 AI 工具响应请求。'
              : 'Headless autostart and system tray daemon for external AI clients.'}
          </p>
          <InfoPopover
            label={zh ? '后台运行说明' : 'Background runtime help'}
            content={
              <div>
                <p>
                  {zh
                    ? '开启开机自启后，Windows 登录时在后台以 --background 参数静默启动服务，无窗口、无控制台窗口，系统托盘常驻。'
                    : 'When login autostart is enabled, LeetCode Tracker launches headlessly with --background on Windows login without opening a window.'}
                </p>
                <p>
                  {zh
                    ? '主窗口关闭时将自动最小化隐藏到系统托盘，后台 HTTP 与 MCP 保持运行；如需完全退出请在托盘菜单点击“退出”。'
                    : 'Closing the main window hides it to the system tray, keeping HTTP and MCP active. Use "Quit" in tray to stop.'}
                </p>
              </div>
            }
          />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div
            style={{
              padding: '16px',
              backgroundColor: 'var(--surface-muted)',
              borderRadius: '8px',
              border: '1px solid var(--border)',
              display: 'flex',
              flexDirection: 'column',
              gap: '12px',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 600 }}>
                <Cpu size={18} />
                <span>{zh ? 'Runtime 状态' : 'Runtime Status'}</span>
              </div>
              <span
                style={{
                  fontSize: '0.8125rem',
                  padding: '2px 8px',
                  borderRadius: '12px',
                  backgroundColor: 'var(--success-subtle, #e6f4ea)',
                  color: 'var(--success, #137333)',
                  fontWeight: 500,
                }}
              >
                {mcpStatus ? (zh ? 'Runtime 已就绪' : 'Runtime ready') : (zh ? 'Runtime 状态未知' : 'Runtime status unknown')}
              </span>
            </div>

            <p style={{ margin: 0, fontSize: '0.875rem', color: 'var(--text-muted)' }}>
              {zh
                ? '关闭主窗口时自动最小化到系统托盘，持续监听本地 API 与 MCP 请求，不中断正在执行的后台任务。'
                : 'Closing the window minimizes to system tray. Local API and MCP continue listening in the background.'}
            </p>

            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                paddingTop: '8px',
                borderTop: '1px solid var(--border)',
              }}
            >
              <div>
                <div style={{ fontWeight: 500, fontSize: '0.875rem' }}>
                  {zh ? '开机静默启动' : 'Start Silently on Login'}
                </div>
                <div style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>
                  {isDesktop
                    ? autostartEnabled
                      ? (zh ? '已启用：开机后无窗口后台常驻' : 'Enabled: Headless tray on system boot')
                      : (zh ? '未启用：仅在手动启动时运行' : 'Disabled: Manual launch only')
                    : (zh ? '当前为浏览器模式，开机自启需在桌面应用中配置' : 'Browser mode: configure autostart in desktop app')}
                </div>
              </div>
              <button
                type="button"
                className={`btn ${autostartEnabled ? 'btn-secondary' : 'btn-primary'} btn-sm`}
                onClick={() => void handleToggleAutostart()}
                disabled={!isDesktop || autostartLoading}
              >
                {autostartLoading ? '…' : autostartEnabled ? (zh ? '禁用自启' : 'Disable') : (zh ? '启用自启' : 'Enable')}
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* AI Connection (MCP) row */}
      <section className="preference-row">
        <div>
          <h2>{zh ? 'AI 连接' : 'AI Connection'}</h2>
          <p className="muted">
            {zh
              ? '通过标准 Model Context Protocol (MCP) 允许外部 AI 只读检索做题记录与学习进度。'
              : 'Connect external AI tools via official read-only Model Context Protocol (MCP).'}
          </p>
          <InfoPopover
            label={zh ? 'AI 连接与安全说明' : 'AI connection & security help'}
            content={
              <div>
                <p>
                  {zh
                    ? '提供 9 个只读工具（题库检索、题目详情、今日计划、练习记录、笔记摘要与分段、进度概览），不开放任何写入或修改能力。'
                    : 'Provides 9 read-only tools (search, problem details, today plan, practice records, notes chunking, progress). No write capabilities.'}
                </p>
                <p>
                  {zh
                    ? '外部 AI 查询不消耗您的 Gemini/OpenAI API 额度，全部由外部客户端与本地只读服务交互。'
                    : 'External AI queries do not use your tracker API quota; they run via external client tokens.'}
                </p>
                <p>
                  {zh
                    ? '支持一键暂停所有外部访问，暂停期间任何工具调用均被拦截并不返回业务数据。'
                    : 'You can pause external access at any time. When paused, all tools return an explicit pause message.'}
                </p>
              </div>
            }
          />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {/* Global Pause Card */}
          <div
            style={{
              padding: '16px',
              backgroundColor: mcpConfig?.aiAccessPaused ? 'var(--warning-subtle, #fef7e0)' : 'var(--surface-muted)',
              borderRadius: '8px',
              border: `1px solid ${mcpConfig?.aiAccessPaused ? 'var(--warning, #f9ab00)' : 'var(--border)'}`,
              display: 'flex',
              flexDirection: 'column',
              gap: '12px',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 600 }}>
                <Shield size={18} />
                <span>{zh ? '外部 AI 访问状态' : 'External AI Access State'}</span>
              </div>
              <span
                style={{
                  fontSize: '0.8125rem',
                  padding: '2px 8px',
                  borderRadius: '12px',
                  backgroundColor: mcpConfig?.aiAccessPaused ? 'var(--warning-subtle, #fef7e0)' : 'var(--success-subtle, #e6f4ea)',
                  color: mcpConfig?.aiAccessPaused ? 'var(--warning, #b06000)' : 'var(--success, #137333)',
                  fontWeight: 600,
                }}
              >
                {!mcpStatus || mcpStatus.state !== 'ready' ? (zh ? '外部访问不可用' : 'Unavailable') : mcpStatus.aiAccessPaused ? (zh ? '外部访问已暂停' : 'Paused') : (zh ? '外部访问就绪' : 'Active')}
              </span>
            </div>

            <p style={{ margin: 0, fontSize: '0.875rem', color: 'var(--text-muted)' }}>
              {mcpConfig?.aiAccessPaused
                ? (zh ? '当前已全局暂停外部 AI 访问。所有外部 MCP 请求将收到拦截提示，无法读取题库、笔记与做题历史。'
                  : 'External AI access is paused. External MCP clients receive a paused notice and cannot read your data.')
                : (zh ? '外部 AI 可通过持有有效凭证的专用连接只读检索你的做题数据。你可以随时从托盘或在此处暂停。'
                  : 'External AI clients can query study data using valid connection tokens. You can pause anytime here or from the tray.')}
            </p>

            <div>
              <button
                type="button"
                className={`btn ${mcpConfig?.aiAccessPaused ? 'btn-primary' : 'btn-secondary'} btn-sm`}
                onClick={() => void handleToggleAiPause()}
                disabled={!mcpConfig}
              >
                {mcpConfig?.aiAccessPaused ? <Play size={14} /> : <Pause size={14} />}
                <span>{mcpConfig?.aiAccessPaused ? (zh ? '恢复外部 AI 访问' : 'Resume Access') : (zh ? '暂停外部 AI 访问' : 'Pause Access')}</span>
              </button>
            </div>
          </div>

          {/* MCP Server Endpoint & Port Config */}
          <div
            style={{
              padding: '16px',
              backgroundColor: 'var(--surface-muted)',
              borderRadius: '8px',
              border: '1px solid var(--border)',
              display: 'flex',
              flexDirection: 'column',
              gap: '12px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 600 }}>
              <Server size={18} />
              <span>{zh ? 'MCP 服务端点' : 'MCP Server Endpoint'}</span>
            </div>

            <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
              <code style={{ padding: '4px 8px', borderRadius: '4px', backgroundColor: 'var(--surface)', border: '1px solid var(--border)', fontSize: '0.875rem' }}>
                {mcpStatus?.listeningPort ? `http://127.0.0.1:${mcpStatus.listeningPort}/mcp` : (zh ? '未监听' : 'Not listening')}
              </code>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={!mcpStatus?.listeningPort}
                onClick={() => copyToClipboard(`http://127.0.0.1:${mcpStatus?.listeningPort}/mcp`, 'endpoint')}
              >
                {copiedTokenId === 'endpoint' ? <Check size={14} /> : <Copy size={14} />}
                <span>{copiedTokenId === 'endpoint' ? (zh ? '已复制' : 'Copied') : (zh ? '复制地址' : 'Copy URL')}</span>
              </button>
            </div>

            <form onSubmit={handleSavePort} style={{ display: 'flex', gap: '10px', alignItems: 'flex-end', marginTop: '4px' }}>
              <div style={{ flex: 1, maxWidth: '180px' }}>
                <label style={{ display: 'block', fontSize: '0.8125rem', marginBottom: '4px', color: 'var(--text-muted)' }}>
                  {zh ? '监听端口 (Port)' : 'Port'}
                </label>
                <input
                  type="number"
                  min={1024}
                  max={65535}
                  value={mcpPortDraft}
                  onChange={(e) => setMcpPortDraft(parseInt(e.target.value, 10) || 30138)}
                  style={{ width: '100%' }}
                />
              </div>
              <button
                type="submit"
                className="btn btn-secondary btn-sm"
                disabled={savingPort || mcpPortDraft === mcpConfig?.port}
              >
                {savingPort ? '…' : (zh ? '更新端口' : 'Save Port')}
              </button>
            </form>
            <p role="status">
              {mcpStatus?.restartRequired && (zh ? `待重启生效端口：${mcpStatus.configuredPort}` : `Pending restart port: ${mcpStatus.configuredPort}`)}
              {mcpStatus?.errorCode && ` ${mcpStatus.errorCode}`}
            </p>
            <p style={{ margin: 0, fontSize: '0.75rem', color: 'var(--text-muted)' }}>
              {zh ? '默认端口 30138。端口冲突时 MCP 会报错停用，不静默改端口；修改后需重启应用生效。' : 'Default port is 30138. Port conflicts disable MCP rather than silently changing ports. Restart app to apply.'}
            </p>
          </div>

          {/* Named Client Credentials */}
          <div
            style={{
              padding: '16px',
              backgroundColor: 'var(--surface-muted)',
              borderRadius: '8px',
              border: '1px solid var(--border)',
              display: 'flex',
              flexDirection: 'column',
              gap: '14px',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 600 }}>
                <Key size={18} />
                <span>{zh ? '专用连接凭证 (Named Connections)' : 'Named Connections & Credentials'}</span>
              </div>
            </div>

            <p style={{ margin: 0, fontSize: '0.875rem', color: 'var(--text-muted)' }}>
              {zh
                ? '每个客户端（Claude Desktop、Cursor、Cline、ChatGPT 网页）拥有独立凭据，支持随时轮换或撤销，日志与命令不泄露密钥。'
                : 'Each client connection has an isolated bearer token with rotation and revocation support.'}
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {(mcpConfig?.clients || []).map((client) => {
                const isExpanded = expandedClientId === client.id;
                const isVisible = Boolean(showTokens[client.id]);
                const lastUsedText = client.lastSuccessfulCallAt
                  ? new Date(client.lastSuccessfulCallAt).toLocaleString()
                  : (zh ? '从未调用' : 'Never called');

                return (
                  <div
                    key={client.id}
                    style={{
                      padding: '12px 14px',
                      backgroundColor: 'var(--surface)',
                      borderRadius: '6px',
                      border: '1px solid var(--border)',
                      opacity: client.revoked ? 0.6 : 1,
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span style={{ fontWeight: 600, fontSize: '0.9375rem' }}>{client.name}</span>
                        <span
                          style={{
                            fontSize: '0.75rem',
                            padding: '1px 6px',
                            borderRadius: '10px',
                            backgroundColor: client.revoked ? 'var(--error-subtle, #fce8e6)' : 'var(--success-subtle, #e6f4ea)',
                            color: client.revoked ? 'var(--error, #c5221f)' : 'var(--success, #137333)',
                          }}
                        >
                          {client.revoked ? (zh ? '已撤销' : 'Revoked') : (zh ? '有效' : 'Active')}
                        </span>
                      </div>
                      <div style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>
                        {zh ? '最近调用：' : 'Last call: '}
                        <strong style={{ color: client.lastSuccessfulCallAt ? 'var(--text-primary)' : 'inherit' }}>{lastUsedText}</strong>
                      </div>
                    </div>

                    <div style={{ display: 'flex', gap: '6px', alignItems: 'center', marginTop: '10px' }}>
                      <input
                        type={isVisible ? 'text' : 'password'}
                        readOnly
                        value={client.token}
                        style={{
                          flex: 1,
                          fontSize: '0.8125rem',
                          fontFamily: 'monospace',
                          padding: '4px 8px',
                          backgroundColor: 'var(--surface-muted)',
                        }}
                      />
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        title={zh ? '显示/隐藏' : 'Show/Hide'}
                        onClick={() => setShowTokens((prev) => ({ ...prev, [client.id]: !prev[client.id] }))}
                      >
                        {isVisible ? <EyeOff size={14} /> : <Eye size={14} />}
                      </button>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        title={zh ? '复制密钥' : 'Copy Token'}
                        onClick={() => copyToClipboard(client.token, client.id)}
                      >
                        {copiedTokenId === client.id ? <Check size={14} /> : <Copy size={14} />}
                      </button>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        title={zh ? '轮换重置密钥' : 'Rotate Token'}
                        onClick={() => void handleRotateClient(client.id)}
                      >
                        <RefreshCw size={14} />
                        <span>{zh ? '轮换' : 'Rotate'}</span>
                      </button>
                      {!client.revoked && (
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          title={zh ? '撤销此连接' : 'Revoke Connection'}
                          onClick={() => void handleRevokeClient(client.id)}
                        >
                          <span>{zh ? '撤销' : 'Revoke'}</span>
                        </button>
                      )}
                    </div>

                    <div style={{ marginTop: '8px' }}>
                      <button
                        type="button"
                        className="text-link"
                        style={{ fontSize: '0.8125rem', display: 'flex', alignItems: 'center', gap: '4px' }}
                        onClick={() => setExpandedClientId(isExpanded ? null : client.id)}
                      >
                        <span>{isExpanded ? (zh ? '收起配置指南' : 'Hide Config Guide') : (zh ? '查看接入配置指南' : 'View Config Guide')}</span>
                        {isExpanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                      </button>

                      {isExpanded && (
                        <div
                          style={{
                            marginTop: '10px',
                            padding: '12px',
                            backgroundColor: 'var(--surface-muted)',
                            borderRadius: '6px',
                            border: '1px solid var(--border)',
                            fontSize: '0.8125rem',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: '10px',
                          }}
                        >
                          <div>
                            <strong>1. Claude Desktop / Cursor / Cline (stdio 代理配置)</strong>
                            <p style={{ margin: '4px 0', color: 'var(--text-muted)' }}>
                              {zh
                                ? '在客户端配置文件中添加 stdio 代理，使用本地凭证自动认证：'
                                : 'Add stdio proxy entry to your client configuration file:'}
                            </p>
                            <pre
                              style={{
                                margin: '4px 0',
                                padding: '8px',
                                backgroundColor: 'var(--surface)',
                                borderRadius: '4px',
                                overflowX: 'auto',
                                fontSize: '0.75rem',
                              }}
                            >
{JSON.stringify(
  {
    mcpServers: {
      'leetcode-tracker': {
        command: 'node',
        args: [
          '<TRACKER_INSTALL_DIR>/desktop-mcp-proxy.mjs',
          '--client',
          client.id,
        ],
      },
    },
  },
  null,
  2,
)}
                            </pre>
                          </div>

                          <div>
                            <strong>2. ChatGPT 网页版 (Secure MCP Tunnel)</strong>
                            <p style={{ margin: '4px 0', color: 'var(--text-muted)' }}>
                              {zh
                                ? '在本地运行 Secure Tunnel 转发至 LeetCode Tracker MCP：'
                                : 'Run Secure Tunnel locally forwarding to Tracker MCP:'}
                            </p>
                            <pre
                              style={{
                                margin: '4px 0',
                                padding: '8px',
                                backgroundColor: 'var(--surface)',
                                borderRadius: '4px',
                                overflowX: 'auto',
                                fontSize: '0.75rem',
                              }}
                            >
{`npx @modelcontextprotocol/tunnel-cli --port ${mcpConfig?.port ?? 30138} --header "Authorization: Bearer ${client.token}"`}
                            </pre>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Create Custom Connection Form */}
            <div style={{ display: 'flex', gap: 8 }}>
              {['Codex', 'DSH', 'ChatGPT'].map(name => <button key={name} className="btn btn-secondary btn-sm" disabled={creatingClient || !mcpConfig} onClick={e => void handleCreateClient(e, name)}>
                {zh ? `创建 ${name} 连接` : `Create ${name} connection`}
              </button>)}
            </div>
            <form onSubmit={handleCreateClient} style={{ display: 'flex', gap: '8px', alignItems: 'center', marginTop: '6px' }}>
              <input
                type="text"
                placeholder={zh ? '新连接名称（如：Work Laptop Cursor）' : 'Connection Name (e.g. Work Laptop Cursor)'}
                value={newClientName}
                onChange={(e) => setNewClientName(e.target.value)}
                style={{ flex: 1, fontSize: '0.875rem' }}
              />
              <button
                type="submit"
                className="btn btn-secondary btn-sm"
                disabled={creatingClient || !newClientName.trim()}
              >
                {creatingClient ? '…' : (zh ? '添加连接' : 'Add Connection')}
              </button>
            </form>

            {mcpSuccess && <Feedback tone="success">{mcpSuccess}</Feedback>}
            {mcpError && <Feedback tone="error">{mcpError}</Feedback>}
          </div>
        </div>
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
              <span>{zh ? '跨设备完整迁移' : 'Complete Device Migration'}</span>
            </div>
            <p style={{ margin: 0, fontSize: '0.875rem', color: 'var(--text-muted)' }}>
              {zh ? '一个文件包含题库、做题进度、笔记、学习计划和设置，可在 Windows 与 Mac 间双向导入。API Key 不会导出，请在新设备重新填写。'
                : 'One file contains your catalog, progress, notes, study plans and settings. Import it on Windows or Mac. API keys are excluded; configure them on the new device.'}
            </p>

            <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'center' }}>
              <ExportLink
                lang={lang}
                onExport={() => api.exportBundleFile()}
                href={api.getBundleExportUrl()}
                className="btn btn-primary btn-sm"
                download
              >
                <Download size={14} />
                <span>{zh ? '导出完整迁移包' : 'Export Complete Migration'}</span>
              </ExportLink>

              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => bundleFileInputRef.current?.click()}
                disabled={importingBundle}
              >
                <Upload size={14} />
                <span>{importingBundle ? (zh ? '正在还原…' : 'Restoring…') : zh ? '导入迁移包' : 'Import Migration'}</span>
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
            {pendingBundle && (
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
                  <span>{zh ? '确认替换当前设备的数据？' : 'Replace This Device’s Data?'}</span>
                </div>
                <p style={{ margin: 0 }}>
                  {pendingBundle.version === 2
                    ? `${zh ? '完整迁移' : 'Complete migration'} · v${pendingBundle.appVersion} · ${pendingBundle.tables.problems.length} ${zh ? '题目' : 'problems'} · ${pendingBundle.tables.practice_records.length} ${zh ? '练习记录' : 'practice records'} · ${pendingBundle.tables.progress_snapshots.length} ${zh ? '进度记录' : 'progress snapshots'} · ${pendingBundle.tables.problem_notes.length} ${zh ? '笔记' : 'notes'}`
                    : zh ? '旧版 v1：仅部分恢复，不包含题库或完整历史。请先确保本机已有对应题库。' : 'Legacy v1: partial restore only; no catalog or complete history. The matching catalog must already exist.'}
                </p>
                <p style={{ margin: 0, fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>
                  {zh
                    ? '这不是合并操作。确认后会先备份当前数据库，再替换相应数据；失败将保留原库。目标设备已有 API Key 保留。请先保存未完成编辑，成功后页面会重新加载。'
                    : 'This replaces data; it does not merge devices. A safety backup is created before writing, and failed restores preserve the original database. Local API keys remain. Save unfinished edits first; the app reloads after success.'}
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
          </div>
        </div>
      </section>
    </div>
  );
}
