/**
 * Multi-provider AI configuration draft for the Settings view.
 *
 * Owned by `SettingsView` (not the AI tab) so drafts, disclosure state and save/test feedback
 * survive switching between Settings tabs. Settings are loaded by the view's single mount fetch,
 * which hands the response to {@link AiProviderSettings.applyLoadedSettings}.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
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
  type OpenAIAuthMode,
  type OpenAIOAuthSummary,
  type ReasoningEffort,
} from '../../../../../packages/contracts/src/sync.ts';
import { api, type ChatGPTModel } from '../../api.ts';
import { openExternalUrl } from '../../platform/index.ts';
import { translations, type Language } from '../../i18n.ts';
import { localizeApiError } from '../../error-i18n.ts';
import { useWorkspace } from '../../workspace.tsx';
import { PROVIDER_PRESET_MODELS, type ProviderType } from './settings-model.ts';

type LoadedSettings = Awaited<ReturnType<typeof api.getSettings>>;

/** How often the Settings view re-reads the ChatGPT connection while a browser sign-in is pending. */
const CHATGPT_AUTH_CHECK_MS = 3_000;
/** Matches the server-side lifetime of an authorization `state`. */
const CHATGPT_AUTH_TIMEOUT_MS = 10 * 60 * 1000;

/** A ChatGPT session that can run requests: signed in, not rejected, plan usage granted. */
export function isChatGPTUsable(oauth: OpenAIOAuthSummary | null | undefined): boolean {
  return Boolean(oauth?.connected && !oauth.reconnectRequired && oauth.planScopeGranted);
}

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

  // OpenAI "Sign in with ChatGPT" state (device-local; the API key draft above is kept alongside it)
  const [openaiAuthMode, setOpenaiAuthMode] = useState<OpenAIAuthMode>('api_key');
  const [openaiOAuth, setOpenaiOAuth] = useState<OpenAIOAuthSummary | null>(null);
  const [chatgptModel, setChatgptModel] = useState('');
  const [chatgptModels, setChatgptModels] = useState<ChatGPTModel[]>([]);
  const [loadingChatgptModels, setLoadingChatgptModels] = useState(false);
  /** Epoch ms at which a pending browser sign-in is abandoned; null when none is pending. */
  const [chatgptAuthDeadline, setChatgptAuthDeadline] = useState<number | null>(null);
  const [chatgptBusy, setChatgptBusy] = useState(false);
  const [chatgptNotice, setChatgptNotice] = useState('');
  const [chatgptError, setChatgptError] = useState('');
  /** Whether a session existed when the pending sign-in started, to tell "declined plan use" from "unchanged". */
  const chatgptWasConnected = useRef(false);
  // Read through a ref so the polling effect does not restart when the workspace object changes.
  const notifyMutation = useRef(workspace.notifyMutation);
  notifyMutation.current = workspace.notifyMutation;
  const usingChatGPT = provider === 'openai' && openaiAuthMode === 'chatgpt';
  const chatgptUsable = isChatGPTUsable(openaiOAuth);

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

  /** Switch the OpenAI credential source shown in the form; it is stored on save. */
  const selectOpenaiAuthMode = (mode: OpenAIAuthMode) => {
    markAiDirty();
    setOpenaiAuthMode(mode);
    setShowApiKey(false);
  };

  /** Choose the model used with the ChatGPT plan. */
  const selectChatgptModel = (slug: string) => {
    markAiDirty();
    setChatgptModel(slug);
  };

  /**
   * Load the signed-in account's model list. A failure leaves the previous list in place and is
   * reported in `chatgptError`.
   */
  const loadChatgptModels = useCallback(async (refresh = false) => {
    setLoadingChatgptModels(true);
    try {
      const { models } = await api.getOpenAIChatGPTModels(refresh);
      setChatgptModels(models);
      // An unset or no-longer-offered model falls back to the account's first listed model.
      setChatgptModel((current) => (models.length > 0 && !models.some((m) => m.slug === current) ? models[0].slug : current));
      setChatgptError('');
    } catch (err) {
      setChatgptError(localizeApiError(err, lang));
    } finally {
      setLoadingChatgptModels(false);
    }
  }, [lang]);

  // The model picker needs the account's list as soon as a usable session exists.
  useEffect(() => {
    if (chatgptUsable) void loadChatgptModels();
    else setChatgptModels([]);
  }, [chatgptUsable, loadChatgptModels]);

  // While the browser sign-in is pending, poll the local server until the callback landed.
  useEffect(() => {
    if (chatgptAuthDeadline === null) return;
    const deadline = chatgptAuthDeadline;
    const zh = lang === 'zh';
    let cancelled = false;
    let reading = false;

    async function refreshStatus() {
      if (reading || document.visibilityState === 'hidden') return;
      reading = true;
      try {
        const next = await api.getOpenAIOAuthStatus();
        if (cancelled) return;
        if (isChatGPTUsable(next)) {
          // The server picked a default model during sign-in; adopt it without clobbering other drafts.
          const settings = await api.getSettings().catch(() => null);
          if (cancelled) return;
          setOpenaiOAuth(next);
          setOpenaiAuthMode('chatgpt');
          setChatgptError('');
          if (settings?.openaiChatgptModel) setChatgptModel(settings.openaiChatgptModel);
          // Signing in switches this device to the ChatGPT plan at once when OpenAI is already the saved provider.
          const active = settings?.llmProvider === 'openai' && settings.openaiAuthMode === 'chatgpt';
          if (active) setActiveProvider('openai');
          setChatgptNotice(active
            ? (zh
                ? '正在使用您的 ChatGPT 套餐。符合条件的 AI 请求将计入该套餐，可在 ChatGPT 设置中管理用量。'
                : "You're using your ChatGPT plan. Eligible AI requests in this app use it; manage usage in ChatGPT settings.")
            : (zh ? 'ChatGPT 已连接。保存后即可将 OpenAI 用于 AI 功能。' : 'ChatGPT connected. Save to use OpenAI for AI features.'));
          // Clearing the deadline tears down this effect, so finish applying the result first.
          setChatgptAuthDeadline(null);
          notifyMutation.current();
          return;
        }
        // Signed in without allowing plan usage: a new sign-in, but not one that can run requests.
        if (next.connected && !next.reconnectRequired && !next.planScopeGranted && !chatgptWasConnected.current) {
          setOpenaiOAuth(next);
          setChatgptAuthDeadline(null);
          setChatgptNotice('');
          setChatgptError(zh
            ? '已登录，但未允许使用 ChatGPT 套餐。请重新登录并同意授权，或改用 API 密钥。'
            : 'You signed in, but did not allow use of your ChatGPT plan. Sign in again and allow it, or use an API key instead.');
          return;
        }
      } catch {
        // A transient local status read can be retried while authorization is pending.
      } finally {
        reading = false;
      }
      if (!cancelled && Date.now() >= deadline) {
        setChatgptAuthDeadline(null);
        setChatgptNotice('');
        setChatgptError(zh ? 'ChatGPT 登录未完成，请重试。' : 'ChatGPT sign-in did not finish. Try again.');
      }
    }

    const refresh = () => void refreshStatus();
    const timer = window.setInterval(refresh, CHATGPT_AUTH_CHECK_MS);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    refresh();
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [chatgptAuthDeadline, lang]);

  /**
   * Open the ChatGPT sign-in in the system browser and start waiting for its callback.
   *
   * @param freshRegistration Register a new client so a different ChatGPT account can be used.
   */
  async function connectChatgpt(freshRegistration = false) {
    if (chatgptBusy) return;
    const zh = lang === 'zh';
    setChatgptBusy(true);
    setChatgptError('');
    setChatgptNotice('');
    setChatgptAuthDeadline(null);
    try {
      chatgptWasConnected.current = Boolean(openaiOAuth?.connected) && !freshRegistration;
      const deadline = Date.now() + CHATGPT_AUTH_TIMEOUT_MS;
      const { authUrl } = await api.connectOpenAIChatGPT({ freshRegistration });
      await openExternalUrl(authUrl);
      setChatgptAuthDeadline(deadline);
      setChatgptNotice(zh ? '请在浏览器中完成 ChatGPT 登录。连接状态会自动更新。' : 'Finish signing in to ChatGPT in your browser. This panel will update automatically.');
    } catch (err) {
      setChatgptError(localizeApiError(err, lang, zh ? '无法开始 ChatGPT 登录。' : 'Could not start ChatGPT sign-in.'));
    } finally {
      setChatgptBusy(false);
    }
  }

  /** Stop waiting for a pending browser sign-in; a later callback for it is still accepted by the server. */
  const cancelChatgptAuth = () => {
    setChatgptAuthDeadline(null);
    setChatgptNotice('');
  };

  /** Sign out of ChatGPT on this device; the stored OpenAI API key is not touched. */
  async function disconnectChatgpt() {
    if (chatgptBusy) return;
    const zh = lang === 'zh';
    setChatgptBusy(true);
    setChatgptError('');
    setChatgptAuthDeadline(null);
    try {
      const { revocationConfirmed, ...next } = await api.disconnectOpenAIChatGPT();
      setOpenaiOAuth(next);
      setActiveProvider((current) => (current === 'openai' && openaiAuthMode === 'chatgpt' ? null : current));
      setChatgptNotice(revocationConfirmed
        ? (zh ? '已断开 ChatGPT。' : 'ChatGPT disconnected.')
        : (zh
            ? '已在本机断开 ChatGPT，但未能确认 OpenAI 端的撤销。可在 ChatGPT 设置中断开此应用。'
            : 'ChatGPT was disconnected on this device, but OpenAI did not confirm the revocation. You can disconnect this app in ChatGPT settings.'));
      workspace.notifyMutation();
    } catch (err) {
      setChatgptError(localizeApiError(err, lang, zh ? '断开失败。' : 'Disconnect failed.'));
    } finally {
      setChatgptBusy(false);
    }
  }

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
    // OpenAI in ChatGPT mode is ready when the session is usable, regardless of a stored key.
    const savedReady = savedProvider === 'openai' && settings.openaiAuthMode === 'chatgpt'
      ? isChatGPTUsable(settings.openaiOAuth)
      : Boolean(savedKey);
    setActiveProvider(savedReady ? savedProvider : null);
    // Connection state is server-owned, so it refreshes even while the form has unsaved edits.
    setOpenaiOAuth(settings.openaiOAuth ?? null);
    if (dirtyAi.current) return;
    setOpenaiAuthMode(settings.openaiAuthMode ?? 'api_key');
    setChatgptModel(settings.openaiChatgptModel ?? '');
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
        // The API key above is saved unchanged in ChatGPT mode, so switching back needs no re-entry.
        openaiAuthMode,
        openaiChatgptModel: chatgptModel.trim() || null,
        deepseekApiKey: deepseekApiKey.trim() || null,
        deepseekModel: deepseekPrimaryModel.trim() || null,
        deepseekBaseUrl: deepseekBaseUrl.trim() || null,
        deepseekFallbackModels: cleanDeepseekFb,
        deepseekReasoningEffort,
      });
      setGeminiFallbackModels(cleanGeminiFb);
      setOpenaiFallbackModels(cleanOpenaiFb);
      setDeepseekFallbackModels(cleanDeepseekFb);
      setActiveProvider((usingChatGPT ? chatgptUsable : currentApiKey.trim()) ? provider : null);
      workspace.notifyMutation();
      setAiSaved(true);
      dirtyAi.current = false;
    } catch (err) {
      setAiError(localizeApiError(err, lang));
    } finally {
      setSavingAi(false);
    }
  }

  /** The visible draft has credentials to test: a usable ChatGPT session or a non-empty key. */
  const canTestConnection = usingChatGPT ? chatgptUsable : Boolean(currentApiKey.trim());

  /** Send a test ping to verify configured or drafted key and model connectivity. */
  async function handleTestConnection() {
    if (!canTestConnection) return;
    setTestingAi(true);
    setTestResult(null);
    setAiError('');
    try {
      const res = usingChatGPT
        ? await api.testLlmConnection({
            provider: 'openai',
            authMode: 'chatgpt',
            model: chatgptModel.trim() || undefined,
            reasoningEffort: currentReasoningEffort,
          })
        : provider === 'gemini'
        ? await api.testGeminiConnection({
            apiKey: currentApiKey.trim(),
            model: currentPrimaryModel.trim() || undefined,
            reasoningEffort: currentReasoningEffort,
          })
        : await api.testLlmConnection({
            provider,
            ...(provider === 'openai' ? { authMode: 'api_key' as const } : {}),
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
    canTestConnection,
    openaiAuthMode,
    selectOpenaiAuthMode,
    usingChatGPT,
    openaiOAuth,
    chatgptUsable,
    chatgptModel,
    selectChatgptModel,
    chatgptModels,
    loadingChatgptModels,
    loadChatgptModels,
    chatgptAuthPending: chatgptAuthDeadline !== null,
    chatgptBusy,
    chatgptNotice,
    chatgptError,
    connectChatgpt,
    cancelChatgptAuth,
    disconnectChatgpt,
  };
}

/** State and actions returned by {@link useAiProviderSettings}. */
export type AiProviderSettings = ReturnType<typeof useAiProviderSettings>;
