/** "AI assistant" Settings tab: provider choice, API key, advanced model options, save and test. */
import { Eye, EyeOff, ChevronDown } from 'lucide-react';
import type { ReasoningEffort } from '../../../../../packages/contracts/src/sync.ts';
import { translations, type Language } from '../../i18n.ts';
import { Feedback, Field, InfoPopover } from '../ui.tsx';
import { OPENAI_MODEL_LABELS, providerName } from './settings-model.ts';
import type { AiProviderSettings } from './useAiProviderSettings.ts';

interface AiProviderSectionProps {
  lang: Language;
  /** AI draft state owned by the parent so it survives tab switches. */
  ai: AiProviderSettings;
}

/** Render the AI tab panel; every edit and request goes through the `ai` state object. */
export function AiProviderSection({ lang, ai }: AiProviderSectionProps) {
  const t = translations[lang];
  const zh = lang === 'zh';
  const {
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
    saveAiConfig,
    handleTestConnection,
  } = ai;

  return (
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
                    onClick={() => selectProvider(id)}
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
                    onChange={(e) => selectPrimaryModel(e.target.value)}
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
  );
}
