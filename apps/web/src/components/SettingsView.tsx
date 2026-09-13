/** Application preferences only; catalog and progress imports live in their respective workspaces. */
import React, { useEffect, useRef, useState } from 'react';
import { Eye, EyeOff, Copy, Check, ClipboardPaste, Download, Upload, Archive, Database, AlertTriangle } from 'lucide-react';
import { api } from '../api.ts';
import { translations, type Language } from '../i18n.ts';
import { useWorkspace } from '../workspace.tsx';
import { PageHeader, Feedback, Field, InfoPopover } from './ui.tsx';

interface SettingsViewProps {
  lang: Language;
  onLanguageChange: (lang: Language) => void;
  onThemeChange: (theme: 'light' | 'dark' | 'system') => void;
  currentTheme: 'light' | 'dark' | 'system';
  onTimezoneSaved?: (zone: string | null) => void;
}

const PRESET_MODELS = [
  'models/gemini-3.8-flash',
  'models/gemini-3.7-flash',
  'models/gemini-3.6-flash',
  'models/gemini-3.5-flash',
  'models/gemini-3.5-flash-lite',
  'models/gemini-2.5-flash',
  'models/gemini-2.5-pro',
];

/** Keep the timezone and AI drafts intact on background refresh; only explicit save changes preferences. */
export function SettingsView({
  lang,
  onLanguageChange,
  onThemeChange,
  currentTheme,
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

  // Gemini AI configuration state
  const [apiKey, setApiKey] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [primaryModel, setPrimaryModel] = useState('models/gemini-3.8-flash');
  const [isCustomPrimary, setIsCustomPrimary] = useState(false);
  const [fallbackModels, setFallbackModels] = useState<string[]>([
    'models/gemini-3.7-flash',
    'models/gemini-3.6-flash',
  ]);
  const [copied, setCopied] = useState(false);
  const [savingAi, setSavingAi] = useState(false);
  const [aiSaved, setAiSaved] = useState(false);
  const [aiError, setAiError] = useState('');
  const [testingAi, setTestingAi] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; model?: string; message?: string } | null>(null);
  const dirtyAi = useRef(false);

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
        if (active) {
          if (!dirty.current) setZone(settings.timezone ?? '');
          if (!dirtyAi.current) {
            setApiKey(settings.geminiApiKey ?? '');
            const effectivePrimary = settings.geminiModel ?? primaryModel;
            if (settings.geminiModel) {
              setPrimaryModel(settings.geminiModel);
              setIsCustomPrimary(!PRESET_MODELS.includes(settings.geminiModel));
            }
            if (settings.geminiFallbackModels) {
              setFallbackModels(
                [...new Set(settings.geminiFallbackModels)].filter((m) => m !== effectivePrimary)
              );
            }
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
    if (!apiKey) return;
    try {
      await navigator.clipboard.writeText(apiKey);
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
        setApiKey(text.trim());
        setAiSaved(false);
        setTestResult(null);
      }
    } catch {
      // Clipboard read failed or unpermitted
    }
  }

  /** Save Gemini API key and model hierarchy to local SQLite settings. */
  async function saveAiConfig(event: React.FormEvent) {
    event.preventDefault();
    setSavingAi(true);
    setAiError('');
    setAiSaved(false);
    const trimmedPrimary = primaryModel.trim();
    const sanitizedFallbacks = [...new Set(fallbackModels.map((m) => m.trim()).filter(Boolean))].filter(
      (m) => !trimmedPrimary || m !== trimmedPrimary
    );

    try {
      await api.updateSettings({
        geminiApiKey: apiKey.trim() || null,
        geminiModel: trimmedPrimary || null,
        geminiFallbackModels: sanitizedFallbacks.length > 0 ? sanitizedFallbacks : null,
      });
      setFallbackModels(sanitizedFallbacks);
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
    if (!apiKey.trim()) return;
    setTestingAi(true);
    setTestResult(null);
    setAiError('');
    try {
      const res = await api.testGeminiConnection({
        apiKey: apiKey.trim(),
        model: primaryModel.trim() || undefined,
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

      {/* Theme row */}
      <section className="preference-row">
        <div>
          <h2>{t.themeLabel}</h2>
          <InfoPopover
            label={zh ? '主题说明' : 'Theme help'}
            content={<p>{zh ? '跟随系统会响应桌面外观的变化。' : 'System mode follows your desktop appearance.'}</p>}
          />
        </div>
        <div className="segmented-control" aria-label={t.themeLabel}>
          {(['light', 'dark', 'system'] as const).map((theme) => (
            <button key={theme} aria-pressed={currentTheme === theme} onClick={() => onThemeChange(theme)}>
              {theme === 'light' ? t.themeLight : theme === 'dark' ? t.themeDark : t.themeSystem}
            </button>
          ))}
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

      {/* Gemini AI Configuration row */}
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
                    ? 'API 密钥及模型配置保存在本地 SQLite 数据库中，仅在生成计划与导入分析时向 Google Gemini 发送请求。'
                    : 'API keys and model choices are saved locally in your SQLite database, used only for planning and progress formatting.'}
                </p>
                <p>
                  {zh
                    ? '密钥默认以圆点掩码保护，点击眼睛图标随时切换查看明文。'
                    : 'API key is masked with dots by default. Click the eye icon to toggle visibility.'}
                </p>
              </div>
            }
          />
        </div>

        <form className="ai-settings-form" onSubmit={saveAiConfig}>
          {/* API Key field with eye toggle */}
          <Field label={t.apiKeyLabel}>
            <div className="input-with-action">
              <input
                type={showApiKey ? 'text' : 'password'}
                value={apiKey}
                onChange={(e) => {
                  dirtyAi.current = true;
                  setApiKey(e.target.value);
                  setAiSaved(false);
                  setTestResult(null);
                }}
                placeholder={t.apiKeyPlaceholder}
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
              disabled={!apiKey}
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
            {apiKey && (
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => {
                  dirtyAi.current = true;
                  setApiKey('');
                  setAiSaved(false);
                  setTestResult(null);
                }}
                title={t.clearApiKey}
              >
                <span>{t.clearApiKey}</span>
              </button>
            )}
          </div>

          {/* Preferred Model selection */}
          <Field label={t.preferredModelLabel}>
            <select
              value={isCustomPrimary ? 'custom' : primaryModel}
              onChange={(e) => {
                dirtyAi.current = true;
                setAiSaved(false);
                setTestResult(null);
                if (e.target.value === 'custom') {
                  setIsCustomPrimary(true);
                  if (PRESET_MODELS.includes(primaryModel)) {
                    setPrimaryModel('');
                  }
                } else {
                  const selectedModel = e.target.value;
                  setIsCustomPrimary(false);
                  setPrimaryModel(selectedModel);
                  setFallbackModels((prev) => prev.filter((item) => item !== selectedModel));
                }
              }}
            >
              <option value="models/gemini-3.8-flash">gemini-3.8-flash (Recommended)</option>
              <option value="models/gemini-3.7-flash">gemini-3.7-flash</option>
              <option value="models/gemini-3.6-flash">gemini-3.6-flash</option>
              <option value="models/gemini-3.5-flash">gemini-3.5-flash</option>
              <option value="models/gemini-3.5-flash-lite">gemini-3.5-flash-lite</option>
              <option value="models/gemini-2.5-flash">gemini-2.5-flash</option>
              <option value="models/gemini-2.5-pro">gemini-2.5-pro</option>
              <option value="custom">{t.customModelOption}</option>
            </select>
          </Field>

          {/* Custom primary model input when custom option is selected */}
          {isCustomPrimary && (
            <Field label={zh ? '自定义模型名称' : 'Custom Model Identifier'}>
              <input
                type="text"
                value={primaryModel}
                onChange={(e) => {
                  dirtyAi.current = true;
                  const newCustom = e.target.value;
                  setPrimaryModel(newCustom);
                  if (newCustom.trim()) {
                    setFallbackModels((prev) => prev.filter((item) => item !== newCustom.trim()));
                  }
                  setAiSaved(false);
                  setTestResult(null);
                }}
                placeholder={t.customModelPlaceholder}
              />
            </Field>
          )}

          {/* Candidate fallback models chips */}
          <div className="form-field">
            <span>{t.candidateModelsLabel}</span>
            <small>{t.candidateModelsDesc}</small>
            <div className="candidate-chips" role="group" aria-label={t.candidateModelsLabel}>
              {PRESET_MODELS.map((m) => {
                const isSelected = fallbackModels.includes(m);
                const isPrimary = m === primaryModel.trim();
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
                      setFallbackModels((prev) =>
                        prev.includes(m)
                          ? prev.filter((item) => item !== m)
                          : [...prev, m].filter((item) => item !== primaryModel.trim())
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
                <strong>{primaryModel.replace('models/', '') || '(none)'}</strong>
                {fallbackModels.length > 0 &&
                  fallbackModels.map((m) => (
                    <span key={m} className="chain-step">
                      {' → '}{m.replace('models/', '')}
                    </span>
                  ))}
              </span>
            </div>
          </div>

          {/* Save & Test Action Row */}
          <div className="action-row">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={handleTestConnection}
              disabled={testingAi || !apiKey.trim()}
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
                ? t.testAiSuccess.replace('{model}', testResult.model || primaryModel)
                : `${t.testAiFailed}: ${testResult.message}`}
            </Feedback>
          )}
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
