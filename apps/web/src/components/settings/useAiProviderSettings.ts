/**
 * Multi-provider AI configuration draft for the Settings view.
 *
 * Owned by `SettingsView` (not the AI tab) so drafts, disclosure state and save/test feedback
 * survive switching between Settings tabs. Settings are loaded by the view's single mount fetch,
 * which hands the response to {@link AiProviderSettings.applyLoadedSettings}.
 */
import React, { useRef, useState } from 'react';
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
  type ReasoningEffort,
} from '../../../../../packages/contracts/src/sync.ts';
import { api } from '../../api.ts';
import { translations, type Language } from '../../i18n.ts';
import { localizeApiError } from '../../error-i18n.ts';
import { useWorkspace } from '../../workspace.tsx';
import { PROVIDER_PRESET_MODELS, type ProviderType } from './settings-model.ts';

type LoadedSettings = Awaited<ReturnType<typeof api.getSettings>>;

/** Outcome of the last connection test; null when none is shown. */
export type AiTestResult = { ok: boolean; model?: string; message?: string } | null;

/**
 * Hold per-provider AI drafts plus save and connection-test actions.
 *
 * Side effects: `saveAiConfig` persists every provider through `api.updateSettings` and notifies the
 * workspace; `handleTestConnection` calls the provider test endpoint with the visible draft. Errors
 * are localized into `aiError` or `testResult` instead of being thrown.
 */
export function useAiProviderSettings(lang: Language) {
  const t = translations[lang];
  const workspace = useWorkspace();

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
  const [testResult, setTestResult] = useState<AiTestResult>(null);
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

  /** Any edit to the visible AI draft invalidates the last save/test confirmation. */
  const markAiDirty = () => {
    dirtyAi.current = true;
    setAiSaved(false);
    setTestResult(null);
  };

  /** Switch the visible provider draft; the stored active provider changes only on save. */
  const selectProvider = (id: ProviderType) => {
    markAiDirty();
    setProvider(id);
    setShowApiKey(false);
  };

  /**
   * Apply a preferred-model select change: `custom` clears preset values, while a preset drops
   * itself from the fallback chain and resets an effort the new model does not support.
   */
  const selectPrimaryModel = (value: string) => {
    markAiDirty();
    if (value === 'custom') {
      setCurrentIsCustomPrimary(true);
      if (currentPresetModels.includes(currentPrimaryModel)) {
        setCurrentPrimaryModel('');
      }
    } else {
      const selectedModel = value;
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
  };

  /**
   * Hydrate AI state from a settings response.
   *
   * Always marks the form loaded and refreshes the active provider; the drafts are replaced only
   * while the user has not edited them yet (`dirtyAi`), so a background refresh never clobbers input.
   */
  const applyLoadedSettings = (settings: LoadedSettings) => {
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
  };

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

  return {
    aiLoaded,
    provider,
    activeProvider,
    showAdvanced,
    setShowAdvanced,
    showApiKey,
    setShowApiKey,
    savingAi,
    aiSaved,
    aiError,
    testingAi,
    testResult,
    currentApiKey,
    setCurrentApiKey,
    currentPrimaryModel,
    currentIsCustomPrimary,
    currentBaseUrl,
    setCurrentBaseUrl,
    currentFallbackModels,
    setCurrentFallbackModels,
    currentPresetModels,
    currentReasoningEffort,
    setCurrentReasoningEffort,
    currentSupportedEfforts,
    currentDefaultEffort,
    markAiDirty,
    selectProvider,
    selectPrimaryModel,
    applyLoadedSettings,
    saveAiConfig,
    handleTestConnection,
  };
}

/** State and actions returned by {@link useAiProviderSettings}. */
export type AiProviderSettings = ReturnType<typeof useAiProviderSettings>;
