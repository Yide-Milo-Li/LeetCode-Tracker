/** Application preferences, grouped into four tabs; catalog and progress imports live in their own workspaces. */
import React, { useEffect, useRef, useState } from 'react';
import { Eye, EyeOff, Copy, Check, ClipboardPaste, Download, Upload, Archive, Database, AlertTriangle, Cpu, Server, Power, Play, Pause, RefreshCw, Key, Shield, ShieldAlert, ChevronDown, ChevronUp } from 'lucide-react';
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
import { api, mcpApi, type McpSettingsConfig, type McpClientCredential, type McpStatus, type McpClientMode, type PendingAgentOperation } from '../api.ts';
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
import { isTauri, getAutostartStatus, setAutostartStatus } from '../platform/index.ts';

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

  // Desktop background runtime state
  const isDesktop = isTauri();
  const [autostartEnabled, setAutostartEnabled] = useState<boolean | null>(null);
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
  const [pendingOperations, setPendingOperations] = useState<PendingAgentOperation[]>([]);

  const loadMcpConfigData = async () => {
    setMcpLoading(true);
    try {
      const [cfg, status, ops] = await Promise.all([
        mcpApi.getConfig(),
        mcpApi.getStatus(),
        mcpApi.listPendingOperations().catch(() => ({ operations: [] })),
      ]);
      setMcpConfig(cfg);
      setMcpStatus(status);
      setPendingOperations(ops.operations);
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
    let previousApprovals: number | null = null;
    let polling = false;
    const handleFocus = () => {
      if (polling || document.visibilityState === 'hidden' || root.current?.closest('[hidden]')) return;
      polling = true;
      void (async () => {
        try {
          const [status,versions] = await Promise.all([mcpApi.getStatus(),api.getBusinessVersions()]);
          if (!active) return;
          setMcpStatus(status);
          setMcpConfig(current => current ? {...current,aiAccessPaused:status.aiAccessPaused}:current);
          if (previousApprovals !== versions.approvals) {
            const res=await mcpApi.listPendingOperations();
            if (active) setPendingOperations(res.operations);
            previousApprovals=versions.approvals;
          }
        } catch { /* Preserve the visible queue on transient runtime failures. */ }
        finally { polling=false; }
      })();
    };
    const poll = setInterval(handleFocus, 2000);
    window.addEventListener('focus', handleFocus);
    window.addEventListener('hashchange', handleFocus);
    document.addEventListener('visibilitychange', handleFocus);

    return () => {
      active = false;
      clearInterval(poll);
      window.removeEventListener('focus', handleFocus);
      window.removeEventListener('hashchange', handleFocus);
      document.removeEventListener('visibilitychange', handleFocus);
    };
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

  const handleUpdateClientMode = async (id: string, mode: McpClientMode) => {
    try {
      await mcpApi.updateClientMode(id, mode);
      setMcpConfig((prev) =>
        prev
          ? {
              ...prev,
              clients: prev.clients.map((c) => (c.id === id ? { ...c, mode } : c)),
            }
          : prev
      );
      setMcpSuccess(zh ? '已更新连接访问模式' : 'Connection mode updated');
      setTimeout(() => setMcpSuccess(null), 3000);
    } catch (err) {
      setMcpError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleSaveReviewModel = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value.trim() || null;
    try {
      const updated = await mcpApi.updateConfig({ reviewModel: val });
      setMcpConfig(updated);
      setMcpSuccess(zh ? '已更新写入审核模型' : 'Review model updated');
      setTimeout(() => setMcpSuccess(null), 3000);
    } catch (err) {
      setMcpError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleProceedOperation = async (id: string) => {
    try {
      await mcpApi.proceedOperation(id);
      setMcpSuccess(zh ? '操作已批准执行' : 'Operation approved and applied');
      const ops = await mcpApi.listPendingOperations();
      setPendingOperations(ops.operations);
      setTimeout(() => setMcpSuccess(null), 3000);
    } catch (err) {
      setMcpError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleRejectOperation = async (id: string) => {
    try {
      await mcpApi.rejectOperation(id, 'User rejected from desktop UI');
      setMcpSuccess(zh ? '操作已拒绝' : 'Operation rejected');
      const ops = await mcpApi.listPendingOperations();
      setPendingOperations(ops.operations);
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
  const root = useRef<HTMLDivElement>(null);
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
    <div className="settings-view" ref={root}>
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
                    ? autostartEnabled === null ? (zh ? '自启状态未知' : 'Autostart status unknown') : autostartEnabled
                      ? (zh ? '已启用：开机后无窗口后台常驻' : 'Enabled: Headless tray on system boot')
                      : (zh ? '未启用：仅在手动启动时运行' : 'Disabled: Manual launch only')
                    : (zh ? '当前为浏览器模式，开机自启需在桌面应用中配置' : 'Browser mode: configure autostart in desktop app')}
                </div>
              </div>
              <button
                type="button"
                className={`btn ${autostartEnabled ? 'btn-secondary' : 'btn-primary'} btn-sm`}
                onClick={() => void handleToggleAutostart()}
                disabled={!isDesktop || autostartLoading || autostartEnabled === null}
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
                  backgroundColor: !mcpStatus || mcpStatus.state !== 'ready' ? 'var(--surface-muted)' : mcpConfig?.aiAccessPaused ? 'var(--warning-subtle, #fef7e0)' : 'var(--success-subtle, #e6f4ea)',
                  color: !mcpStatus || mcpStatus.state !== 'ready' ? 'var(--text-muted)' : mcpConfig?.aiAccessPaused ? 'var(--warning, #b06000)' : 'var(--success, #137333)',
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
                          {client.revoked ? (zh ? '已撤销' : 'Revoked') : (zh ? '凭证有效' : 'Credential valid')}
                        </span>
                      </div>
                      <div style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>
                        {zh ? '最近成功调用：' : 'Last successful call: '}
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

                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '10px', flexWrap: 'wrap' }}>
                      <span style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>{zh ? '访问权限：' : 'Access Mode: '}</span>
                      <select
                        aria-label={zh ? `${client.name} 访问权限` : `${client.name} Access Mode`}
                        disabled={client.revoked}
                        value={client.mode ?? 'read_only'}
                        onChange={(e) => void handleUpdateClientMode(client.id, e.target.value as McpClientMode)}
                        style={{ fontSize: '0.8125rem', padding: '3px 8px', borderRadius: '4px' }}
                      >
                        <option value="read_only">{zh ? '只读' : 'Read-only'}</option>
                        <option value="model_review">{zh ? '模型审核' : 'Model review'}</option>
                        <option value="full_access">Full access</option>
                      </select>
                      {client.mode === 'full_access' && (
                        <span
                          style={{
                            fontSize: '0.75rem',
                            padding: '2px 8px',
                            borderRadius: '4px',
                            backgroundColor: 'var(--warning-subtle, #fef7e0)',
                            color: 'var(--warning-text, #b06000)',
                            border: '1px solid var(--warning, #f9ab00)',
                          }}
                        >
                          {zh ? '仅 Tracker 练习、笔记和计划' : 'Tracker practice, notes & plan only'}
                        </span>
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
                          {mcpConfig?.connection ? <>
                            <div>
                              <strong>Codex Desktop — config.toml</strong>
                              <pre style={{overflowX:'auto'}}>{'[mcp_servers.leetcode_tracker]\ncommand = '+JSON.stringify(mcpConfig.connection.nodePath)+'\nargs = '+JSON.stringify([mcpConfig.connection.proxyPath,'--config',mcpConfig.connection.configPath,'--client',client.id])}</pre>
                            </div>
                            <div>
                              <strong>DSH — cordis.patch.yml</strong>
                              <pre style={{overflowX:'auto'}}>{'- insert:\n    - id: tracker-readonly\n      name: "@deepseek-ai/dsh-mcp-client"\n      config:\n        serverName: leetcode_tracker\n        transport: stdio\n        command: '+JSON.stringify(mcpConfig.connection.nodePath)+'\n        args: '+JSON.stringify([mcpConfig.connection.proxyPath,'--config',mcpConfig.connection.configPath,'--client',client.id])}</pre>
                            </div>
                            <div>
                              <strong>Claude Desktop / Cursor / Cline</strong>
                              <pre style={{overflowX:'auto'}}>{JSON.stringify({mcpServers:{'leetcode-tracker':{command:mcpConfig.connection.nodePath,args:[mcpConfig.connection.proxyPath,'--config',mcpConfig.connection.configPath,'--client',client.id]}}},null,2)}</pre>
                            </div>
                          </> : <p>{zh ? '运行时路径不可用，请重新加载设置。' : 'Runtime paths unavailable. Reload Settings.'}</p>}
                          <div>
                            <strong>{zh ? 'ChatGPT 网页版 — Secure MCP Tunnel' : 'ChatGPT Web — Secure MCP Tunnel'}</strong>
                            <p>{zh ? '从官方发布页安装 tunnel-client。在 Platform 创建 Tunnel，并关联目标 ChatGPT workspace。控制面凭证由 Tunnel 管理。将复制的 Tracker Token 保存为私有文本文件，内容为 Bearer 加空格和 Token。普通请求与启动探测使用同一文件；请在 Tracker 中明确恢复 AI 访问。轮换后更新该文件并重启 Tunnel。' : 'Install official tunnel-client, create a Tunnel in Platform and associate its ChatGPT workspace. Tunnel owns its control-plane credential. Save the copied Tracker Token in a private text file as Bearer, a space and the Token. Use the same file for calls and startup probes; explicitly resume AI access in Tracker. After rotation, update the file and restart Tunnel.'}</p>
                            <a href="https://developers.openai.com/api/docs/guides/secure-mcp-tunnels" target="_blank" rel="noreferrer">{zh ? '官方 Tunnel 指南' : 'Official Tunnel guide'}</a>
                            <pre style={{overflowX:'auto'}}>{'tunnel-client init --sample sample_mcp_remote_no_auth --profile tracker --tunnel-id <TUNNEL_ID> --mcp-server-url http://127.0.0.1:'+ (mcpStatus?.listeningPort ?? mcpConfig?.port ?? 30138)+'/mcp\n'+
                              'tunnel-client doctor --profile tracker --explain --mcp.extra-headers "Authorization: file:C:/private/tracker-auth.txt" --mcp.discovery-extra-headers "Authorization: file:C:/private/tracker-auth.txt"\n'+
                              'tunnel-client run --profile tracker --mcp.extra-headers "Authorization: file:C:/private/tracker-auth.txt" --mcp.discovery-extra-headers "Authorization: file:C:/private/tracker-auth.txt"'}</pre>
                            <p>{zh ? '在 ChatGPT 开发者模式中创建连接，选择 Tunnel 和同一 Tunnel ID。Tracker 不创建或自动管理 Tunnel。' : 'Create a developer-mode connection in ChatGPT, select Tunnel and the same Tunnel ID. Tracker does not create or manage tunnels.'}</p>
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

          {/* Operation Review Model */}
          <div
            style={{
              padding: '16px',
              backgroundColor: 'var(--surface-muted)',
              borderRadius: '8px',
              border: '1px solid var(--border)',
              display: 'flex',
              flexDirection: 'column',
              gap: '10px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 600 }}>
              <Shield size={18} />
              <span>{zh ? '写入审核模型 (Operation Review Model)' : 'Operation Review Model'}</span>
            </div>
            <p style={{ margin: 0, fontSize: '0.875rem', color: 'var(--text-muted)' }}>
              {zh
                ? '在“模型审核”模式下，外部 AI 发起的操作由独立的审核模型评估风险。默认使用当前主模型。'
                : 'In Model Review mode, an independent model evaluates operation risk. Uses active primary model by default.'}
            </p>
            <div style={{ maxWidth: '360px' }}>
              <select
                aria-label={zh ? '写入审核模型' : 'Operation Review Model'}
                value={mcpConfig?.reviewModel ?? ''}
                onChange={(e) => void handleSaveReviewModel(e)}
                style={{ width: '100%', fontSize: '0.875rem' }}
              >
                <option value="">{zh ? '使用当前主模型（默认）' : 'Use active primary model (default)'}</option>
                {currentPresetModels.map((m) => (
                  <option key={m} value={m}>
                    {m.replace('models/', '')}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Pending Approvals */}
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
                <ShieldAlert size={18} />
                <span>{zh ? '待批准操作 (Pending Approvals)' : 'Pending Approvals'}</span>
                {pendingOperations.length > 0 && (
                  <span
                    style={{
                      fontSize: '0.75rem',
                      padding: '1px 8px',
                      borderRadius: '10px',
                      backgroundColor: 'var(--warning-subtle, #fef7e0)',
                      color: 'var(--warning, #e37400)',
                      fontWeight: 700,
                    }}
                  >
                    {pendingOperations.length}
                  </span>
                )}
              </div>
            </div>

            {pendingOperations.length === 0 ? (
              <p style={{ margin: 0, fontSize: '0.875rem', color: 'var(--text-muted)' }}>
                {zh
                  ? '暂无待批准操作。当外部 AI 在模型审核模式下发起高风险修改（如覆盖笔记、批量换题）时，将在此列出等待批准。'
                  : 'No pending approvals. High-impact operations from external agents in review mode will appear here.'}
              </p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                {pendingOperations.map((op) => {
                  let summary: { action?: string; target?: string; diffSummary?: string; riskLevel?: string; reviewReason?: string } = {};
                  try {
                    summary = JSON.parse(op.summaryJson ?? '{}');
                  } catch {}
                  const client = mcpConfig?.clients.find((c) => c.id === op.clientId);
                  const clientName = client?.name || op.clientId;
                  const remainingMins = Math.max(0, Math.round((op.expiresAt - Date.now()) / 60000));
                  return (
                    <div
                      key={op.id}
                      style={{
                        padding: '14px',
                        backgroundColor: 'var(--surface)',
                        borderRadius: '6px',
                        border: '1px solid var(--border)',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '8px',
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '6px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                          <code style={{ fontWeight: 600, fontSize: '0.875rem' }}>{op.toolName}</code>
                          <span style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>via {clientName}</span>
                          {summary.riskLevel && (
                            <span
                              style={{
                                fontSize: '0.75rem',
                                padding: '1px 6px',
                                borderRadius: '4px',
                                backgroundColor:
                                  summary.riskLevel === 'high'
                                    ? 'var(--error-subtle, #fce8e6)'
                                    : summary.riskLevel === 'medium'
                                    ? 'var(--warning-subtle, #fef7e0)'
                                    : 'var(--success-subtle, #e6f4ea)',
                                color:
                                  summary.riskLevel === 'high'
                                    ? 'var(--error, #c5221f)'
                                    : summary.riskLevel === 'medium'
                                    ? 'var(--warning, #e37400)'
                                    : 'var(--success, #137333)',
                              }}
                            >
                              Risk: {summary.riskLevel}
                            </span>
                          )}
                        </div>
                        <span style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>
                          {zh ? `剩余 ${remainingMins} 分钟有效` : `${remainingMins}m remaining`}
                        </span>
                      </div>
                      {summary.target && (
                        <div style={{ fontSize: '0.8125rem' }}>
                          <span style={{ color: 'var(--text-muted)' }}>{zh ? '目标：' : 'Target: '}</span>
                          <strong>{summary.target}</strong>
                        </div>
                      )}
                      {summary.diffSummary && (
                        <div
                          style={{
                            fontSize: '0.8125rem',
                            padding: '6px 10px',
                            backgroundColor: 'var(--surface-muted)',
                            borderRadius: '4px',
                            fontFamily: 'monospace',
                          }}
                        >
                          {summary.diffSummary}
                        </div>
                      )}
                      {op.preview && (
                        <details className="agent-approval-details">
                          <summary>{zh ? '查看实际修改前后差异' : 'Inspect actual before and after changes'}</summary>
                          {op.preview.changes.map((change,index) => (
                            <section key={index} style={{marginTop:'12px'}}>
                              <strong>{change.label}</strong>
                              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'16px',marginTop:'6px'}}>
                                {[['before',zh?'修改前':'Before',change.before],['after',zh?'修改后':'After',change.after]].map(([key,label,value]) => (
                                  <div key={String(key)}><span style={{color:'var(--text-muted)'}}>{String(label)}</span>
                                    <pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',maxHeight:'280px',overflow:'auto',padding:'8px',background:'var(--surface-muted)',fontSize:'0.8125rem'}}>{typeof value==='string'?value:JSON.stringify(value,null,2)}</pre>
                                  </div>
                                ))}
                              </div>
                            </section>
                          ))}
                          {op.preview.cascades.length>0 && <section style={{marginTop:'12px'}}>
                            <strong>{zh ? '将连带撤销以下练习记录' : 'These practice records will also be revoked'}</strong>
                            <ul>{op.preview.cascades.map(record=><li key={record.recordId}>{record.recordId} · v{record.revision}</li>)}</ul>
                          </section>}
                          {op.preview.planDate && <p>{op.preview.planDate} · {op.preview.timezone}</p>}
                        </details>
                      )}
                      {summary.reviewReason && (
                        <div style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>
                          <em>{zh ? `审核理由：${summary.reviewReason}` : `Review reason: ${summary.reviewReason}`}</em>
                        </div>
                      )}
                      <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
                        <button
                          type="button"
                          className="btn btn-primary btn-sm"
                          disabled={op.reviewState === 'reviewing' || op.reviewState === 'unreviewed'}
                          onClick={() => void handleProceedOperation(op.id)}
                        >
                          <Check size={14} />
                          <span>{zh ? '批准 (Proceed)' : 'Proceed'}</span>
                        </button>
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          onClick={() => void handleRejectOperation(op.id)}
                        >
                          <span>{zh ? '拒绝 (Reject)' : 'Reject'}</span>
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
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
