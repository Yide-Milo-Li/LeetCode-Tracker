/**
 * Settings and data ingestion workbench.
 * Provides preference toggles, file upload / text paste, preflight preview inspection,
 * atomic commit execution, and historical import audit log.
 */
import React, { useEffect, useState, useRef } from 'react';
import {
  UploadCloud,
  FileText,
  CheckCircle2,
  AlertTriangle,
  RotateCcw,
  Sparkles,
  History,
  Languages,
  Palette,
  Globe,
} from 'lucide-react';
import {
  api,
  type ImportHistoryItem,
  type ImportPreview,
} from '../api.ts';
import { translations, type Language } from '../i18n.ts';

interface SettingsViewProps {
  lang: Language;
  onLanguageChange: (lang: Language) => void;
  onThemeChange: (theme: 'light' | 'dark' | 'system') => void;
  currentTheme: 'light' | 'dark' | 'system';
}

/** Keep preview responses bound to the current input and serialize commit interaction. */
export const SettingsView: React.FC<SettingsViewProps> = ({
  lang,
  onLanguageChange,
  onThemeChange,
  currentTheme,
}) => {
  const t = translations[lang];

  // Ingestion Mode ('upload' | 'paste')
  const [mode, setMode] = useState<'upload' | 'paste'>('upload');
  const [content, setContent] = useState('');
  const [selectedFileName, setSelectedFileName] = useState<string | null>(null);
  const [selectedFileSize, setSelectedFileSize] = useState<string | null>(null);

  // Preview & Ingestion status
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [commitLoading, setCommitLoading] = useState(false);
  const [alertMsg, setAlertMsg] = useState<{ type: 'success' | 'danger' | 'info'; text: string } | null>(null);

  // History state
  const [history, setHistory] = useState<ImportHistoryItem[]>([]);
  const [currentTimezone, setCurrentTimezone] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // A generation covers file reads and previews; edits invalidate every older response.
  const inputGeneration = useRef(0);
  const previewGeneration = useRef<number | null>(null);
  const committing = useRef(false);

  useEffect(() => {
    loadHistory();
    api.getSettings()
      .then((s) => {
        if (s.timezone) setCurrentTimezone(s.timezone);
      })
      .catch((err) => console.error('Failed to load timezone:', err));
    return () => { inputGeneration.current += 1; };
  }, []);

  async function handleTimezoneChange(newTz: string | null) {
    setCurrentTimezone(newTz);
    try {
      await api.updateSettings({ timezone: newTz });
    } catch (err) {
      console.error('Failed to save timezone:', err);
    }
  }

  /** Invalidate pending reads and previews before changing the displayed input. */
  function invalidateInput() {
    inputGeneration.current += 1;
    previewGeneration.current = null;
    setPreview(null);
    setPreviewLoading(false);
    setAlertMsg(null);
    return inputGeneration.current;
  }

  /** Refresh the recent committed imports after mounting or a successful write. */
  async function loadHistory() {
    try {
      const res = await api.getImportHistory(1, 10);
      setHistory(res.items);
    } catch (err) {
      console.error('Failed to load history:', err);
    }
  }

  /** Process a selected or dropped file with size validation before reading into memory. */
  function processFile(file: File) {
    if (committing.current) return;
    const generation = invalidateInput();
    setContent('');

    if (file.size > 10 * 1024 * 1024) {
      setSelectedFileName(file.name);
      setSelectedFileSize(`${(file.size / 1024).toFixed(1)} KB`);
      setAlertMsg({ type: 'danger', text: t.fileTooLarge });
      return;
    }

    setSelectedFileName(file.name);
    const sizeInKb = (file.size / 1024).toFixed(1);
    setSelectedFileSize(`${sizeInKb} KB`);

    const reader = new FileReader();
    reader.onload = (event) => {
      if (generation !== inputGeneration.current) return;
      const text = event.target?.result as string;
      setContent(text);
      setPreview(null);
      setAlertMsg(null);
    };
    reader.onerror = () => {
      if (generation !== inputGeneration.current) return;
      setAlertMsg({ type: 'danger', text: t.fileReadFailed });
    };
    reader.readAsText(file);
  }

  /** Read the latest selected file; ignore reads superseded by an edit or clear. */
  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) processFile(file);
  }

  /** Only expose a response if its source content is still current. */
  async function handlePreview() {
    if (committing.current) return;
    if (!content.trim()) {
      setAlertMsg({ type: 'danger', text: lang === 'zh' ? '请先上传文件或粘贴 JSONL 内容' : 'Please provide JSONL content first' });
      return;
    }

    const generation = invalidateInput();
    setPreviewLoading(true);
    setAlertMsg(null);
    try {
      const p = await api.previewImport(content);
      if (generation !== inputGeneration.current) return;
      previewGeneration.current = generation;
      setPreview(p);
    } catch (err) {
      if (generation !== inputGeneration.current) return;
      setAlertMsg({ type: 'danger', text: err instanceof Error ? err.message : 'Preview generation failed' });
    } finally {
      if (generation === inputGeneration.current) setPreviewLoading(false);
    }
  }

  /** Commit only the current preview, freezing inputs until the request settles. */
  async function handleCommit() {
    if (committing.current || !preview || preview.validCount === 0 ||
        previewGeneration.current !== inputGeneration.current) return;
    committing.current = true;

    setCommitLoading(true);
    setAlertMsg(null);
    try {
      const summary = await api.commitImport(preview.previewId);
      setAlertMsg({
        type: 'success',
        text: t.importSuccessMsg
          .replace('{inserted}', String(summary.insertedCount))
          .replace('{updated}', String(summary.updatedCount))
          .replace('{unchanged}', String(summary.unchangedCount)),
      });
      inputGeneration.current += 1;
      previewGeneration.current = null;
      // Clear input and preview
      setPreview(null);
      setContent('');
      setSelectedFileName(null);
      setSelectedFileSize(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
      // Refresh history
      loadHistory();
    } catch (err) {
      setAlertMsg({ type: 'danger', text: err instanceof Error ? err.message : 'Commit failed' });
    } finally {
      committing.current = false;
      setCommitLoading(false);
    }
  }

  /** Clear the input and invalidate responses that may still arrive. */
  function handleClear() {
    if (committing.current) return;
    invalidateInput();
    setContent('');
    setPreview(null);
    setSelectedFileName(null);
    setSelectedFileSize(null);
    setAlertMsg(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  return (
    <div>
      {/* 1. Preferences Section */}
      <div className="card">
        <h2 className="card-title">
          <Sparkles size={20} style={{ color: 'var(--primary)' }} />
          {t.preferencesTitle}
        </h2>
        <p className="card-desc">{t.preferencesDesc}</p>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2rem' }}>
          <div>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.875rem', fontWeight: 600, marginBottom: '0.5rem' }}>
              <Languages size={16} />
              {t.langLabel}
            </label>
            <div className="nav-tabs">
              <button
                className={`nav-tab-btn ${lang === 'en' ? 'active' : ''}`}
                onClick={() => onLanguageChange('en')}
              >
                English
              </button>
              <button
                className={`nav-tab-btn ${lang === 'zh' ? 'active' : ''}`}
                onClick={() => onLanguageChange('zh')}
              >
                简体中文
              </button>
            </div>
          </div>

          <div>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.875rem', fontWeight: 600, marginBottom: '0.5rem' }}>
              <Palette size={16} />
              {t.themeLabel}
            </label>
            <div className="nav-tabs">
              <button
                className={`nav-tab-btn ${currentTheme === 'light' ? 'active' : ''}`}
                onClick={() => onThemeChange('light')}
              >
                {t.themeLight}
              </button>
              <button
                className={`nav-tab-btn ${currentTheme === 'dark' ? 'active' : ''}`}
                onClick={() => onThemeChange('dark')}
              >
                {t.themeDark}
              </button>
              <button
                className={`nav-tab-btn ${currentTheme === 'system' ? 'active' : ''}`}
                onClick={() => onThemeChange('system')}
              >
                {t.themeSystem}
              </button>
            </div>
          </div>

          <div>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.875rem', fontWeight: 600, marginBottom: '0.5rem' }}>
              <Globe size={16} />
              {t.timezoneLabel}
            </label>
            <select
              className="select-field"
              value={currentTimezone || ''}
              onChange={(e) => handleTimezoneChange(e.target.value || null)}
              style={{ minWidth: '200px' }}
            >
              <option value="">UTC (Default)</option>
              <option value="Asia/Shanghai">Asia/Shanghai (CST +08:00)</option>
              <option value="Asia/Tokyo">Asia/Tokyo (JST +09:00)</option>
              <option value="America/New_York">America/New_York (EST/EDT)</option>
              <option value="America/Los_Angeles">America/Los_Angeles (PST/PDT)</option>
              <option value="Europe/London">Europe/London (GMT/BST)</option>
              <option value="Europe/Paris">Europe/Paris (CET/CEST)</option>
            </select>
          </div>
        </div>
      </div>

      {/* 2. Ingestion Workbench Section */}
      <div className="card">
        <h2 className="card-title">
          <UploadCloud size={20} style={{ color: 'var(--primary)' }} />
          {t.workbenchTitle}
        </h2>
        <p className="card-desc">{t.workbenchDesc}</p>

        {alertMsg && (
          <div role="alert" className={`alert alert-${alertMsg.type}`}>
            {alertMsg.type === 'success' ? <CheckCircle2 size={18} /> : <AlertTriangle size={18} />}
            <span>{alertMsg.text}</span>
          </div>
        )}

        {/* Ingestion Mode Switcher */}
        <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.25rem' }}>
          <button
            className={`btn btn-sm ${mode === 'upload' ? 'btn-primary' : 'btn-outline'}`}
            disabled={commitLoading}
            onClick={() => setMode('upload')}
          >
            <UploadCloud size={14} />
            {t.tabUpload}
          </button>
          <button
            className={`btn btn-sm ${mode === 'paste' ? 'btn-primary' : 'btn-outline'}`}
            disabled={commitLoading}
            onClick={() => setMode('paste')}
          >
            <FileText size={14} />
            {t.tabPaste}
          </button>
        </div>

        {/* Input Area */}
        {mode === 'upload' ? (
          <div>
            <div
              className="upload-dropzone"
              onClick={() => { if (!committing.current) fileInputRef.current?.click(); }}
              onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
              onDragEnter={(e) => { e.preventDefault(); e.stopPropagation(); }}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                const file = e.dataTransfer?.files?.[0];
                if (file) processFile(file);
              }}
            >
              <input
                type="file"
                disabled={commitLoading}
                ref={fileInputRef}
                accept=".jsonl,.txt,application/json"
                style={{ display: 'none' }}
                onChange={handleFileChange}
              />
              <UploadCloud size={36} style={{ margin: '0 auto 0.5rem auto', color: 'var(--text-muted)' }} />
              <p style={{ fontWeight: 500, marginBottom: '0.25rem' }}>{t.dropzoneText}</p>
              <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                UTF-8 encoded JSONL (max 10 MiB, 20,000 lines)
              </p>
            </div>
            {selectedFileName && (
              <div style={{ marginTop: '0.75rem', fontSize: '0.875rem', color: 'var(--primary)' }}>
                {t.selectedFile.replace('{name}', selectedFileName).replace('{size}', selectedFileSize ?? '')}
              </div>
            )}
          </div>
        ) : (
          <div>
            <textarea
              className="paste-textarea"
              placeholder={t.pastePlaceholder}
              value={content}
              disabled={commitLoading}
              onChange={(e) => { if (!committing.current) { invalidateInput(); setContent(e.target.value); } }}
            />
          </div>
        )}

        {/* Form Action Buttons */}
        <div style={{ display: 'flex', gap: '0.75rem', marginTop: '1rem', alignItems: 'center' }}>
          <button
            className="btn btn-primary"
            onClick={handlePreview}
            disabled={commitLoading || previewLoading || !content.trim()}
          >
            {previewLoading ? (lang === 'zh' ? '正在分析...' : 'Analyzing...') : t.btnPreview}
          </button>
          {content.trim() && (
            <button className="btn btn-outline" disabled={commitLoading} onClick={handleClear}>
              <RotateCcw size={14} />
              {t.btnClear}
            </button>
          )}
        </div>

        {/* 3. Preflight Preview Display */}
        {preview && (
          <div style={{ marginTop: '2rem', borderTop: '1px solid var(--border-color)', paddingTop: '1.5rem' }}>
            <h3 className="card-title" style={{ fontSize: '1rem', marginBottom: '1rem' }}>
              {t.previewTitle}
            </h3>

            {/* Metrics Row */}
            <div className="metrics-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))' }}>
              <div className="metric-card" style={{ padding: '0.75rem 1rem' }}>
                <div className="metric-label">{t.metricTotalLines}</div>
                <div className="metric-value" style={{ fontSize: '1.25rem' }}>{preview.totalLines}</div>
              </div>
              <div className="metric-card" style={{ padding: '0.75rem 1rem' }}>
                <div className="metric-label">{t.metricValid}</div>
                <div className="metric-value" style={{ fontSize: '1.25rem', color: 'var(--primary)' }}>{preview.validCount}</div>
              </div>
              <div className="metric-card" style={{ padding: '0.75rem 1rem' }}>
                <div className="metric-label">{t.metricInsert}</div>
                <div className="metric-value" style={{ fontSize: '1.25rem', color: 'var(--easy)' }}>{preview.insertCount}</div>
              </div>
              <div className="metric-card" style={{ padding: '0.75rem 1rem' }}>
                <div className="metric-label">{t.metricUpdate}</div>
                <div className="metric-value" style={{ fontSize: '1.25rem', color: 'var(--primary)' }}>{preview.updateCount}</div>
              </div>
              <div className="metric-card" style={{ padding: '0.75rem 1rem' }}>
                <div className="metric-label">{t.metricUnchanged}</div>
                <div className="metric-value" style={{ fontSize: '1.25rem', color: 'var(--text-muted)' }}>{preview.unchangedCount}</div>
              </div>
              <div className="metric-card" style={{ padding: '0.75rem 1rem' }}>
                <div className="metric-label">{t.metricDuplicates}</div>
                <div className="metric-value" style={{ fontSize: '1.25rem', color: 'var(--text-muted)' }}>{preview.duplicateCount}</div>
              </div>
              <div className="metric-card" style={{ padding: '0.75rem 1rem' }}>
                <div className="metric-label">{t.metricErrors}</div>
                <div className="metric-value" style={{ fontSize: '1.25rem', color: 'var(--hard)' }}>{preview.errorCount}</div>
              </div>
            </div>

            {/* Error Table if any */}
            {preview.errors.length > 0 && (
              <div style={{ marginBottom: '1.5rem' }}>
                <div style={{ fontWeight: 600, color: 'var(--danger)', marginBottom: '0.5rem', fontSize: '0.875rem' }}>
                  {t.errorTableTitle.replace('{count}', String(preview.errors.length))}
                </div>
                <div className="table-container" style={{ maxHeight: 200, overflowY: 'auto' }}>
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th style={{ width: '70px' }}>{t.tableLine}</th>
                        <th>{t.tableError}</th>
                        <th>{t.tableSnippet}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.errors.map((err, idx) => (
                        <tr key={idx}>
                          <td style={{ fontWeight: 600, color: 'var(--danger)' }}>#{err.line}</td>
                          <td style={{ color: 'var(--danger)' }}>{err.message}</td>
                          <td style={{ fontFamily: 'monospace', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                            {err.snippet || '-'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Sample Changes Preview */}
            {preview.sampleItems.length > 0 && (
              <div style={{ marginBottom: '1.5rem' }}>
                <div style={{ fontWeight: 600, color: 'var(--text-main)', marginBottom: '0.5rem', fontSize: '0.875rem' }}>
                  {t.sampleTitle.replace('{count}', String(preview.sampleItems.length))}
                </div>
                <div className="table-container" style={{ maxHeight: 240, overflowY: 'auto' }}>
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th style={{ width: '70px' }}>{t.tableId}</th>
                        <th>{t.tableTitle}</th>
                        <th style={{ width: '90px' }}>{t.tableDifficulty}</th>
                        <th style={{ width: '100px' }}>{t.tableAction}</th>
                        <th>{t.tableChanges}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.sampleItems.map((item, idx) => (
                        <tr key={idx}>
                          <td style={{ fontWeight: 600 }}>#{item.frontendId}</td>
                          <td>{item.title}</td>
                          <td>
                            <span className={`badge badge-${item.difficulty.toLowerCase()}`}>
                              {item.difficulty}
                            </span>
                          </td>
                          <td>
                            <span
                              className="badge"
                              style={{
                                backgroundColor: item.action === 'insert' ? 'var(--success-bg)' : item.action === 'update' ? '#dbeafe' : 'var(--bg-card-muted)',
                                color: item.action === 'insert' ? 'var(--easy)' : item.action === 'update' ? '#1d4ed8' : 'var(--text-muted)',
                              }}
                            >
                              {item.action === 'insert' ? t.actionInsert : item.action === 'update' ? t.actionUpdate : t.actionUnchanged}
                            </span>
                          </td>
                          <td style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                            {item.changes && item.changes.length > 0 ? item.changes.join(', ') : '-'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Commit Button */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginTop: '1.25rem' }}>
              <button
                className="btn btn-primary"
                onClick={handleCommit}
                disabled={commitLoading || preview.validCount === 0}
                style={{ padding: '0.625rem 1.25rem', fontSize: '0.9375rem' }}
              >
                <CheckCircle2 size={16} />
                {commitLoading ? (lang === 'zh' ? '正在写入数据库...' : 'Writing to SQLite...') : t.btnCommit}
              </button>
              <span style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>
                {preview.validCount > 0
                  ? (lang === 'zh' ? `将把 ${preview.validCount} 道有效题目原子提交至本地 SQLite` : `Will atomically persist ${preview.validCount} valid problems into local SQLite`)
                  : (lang === 'zh' ? '没有可提交的有效记录' : 'No valid records to commit')}
              </span>
            </div>
          </div>
        )}
      </div>

      {/* 4. Import History Section */}
      <div className="card">
        <h2 className="card-title">
          <History size={20} style={{ color: 'var(--primary)' }} />
          {t.historyTitle}
        </h2>
        <p className="card-desc">{t.historyDesc}</p>

        {history.length === 0 ? (
          <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem' }}>{t.noHistory}</p>
        ) : (
          <div className="table-container">
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t.historyDate}</th>
                  <th>{t.metricTotalLines}</th>
                  <th>{t.historyValid}</th>
                  <th>{t.historyIns}</th>
                  <th>{t.historyUpd}</th>
                  <th>{t.historyUnchanged}</th>
                  <th>{t.historyDup}</th>
                  <th>{t.historyErr}</th>
                </tr>
              </thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.id}>
                    <td style={{ fontSize: '0.8125rem' }}>
                      {new Date(h.importedAt).toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US')}
                    </td>
                    <td>{h.totalLines}</td>
                    <td style={{ fontWeight: 600, color: 'var(--primary)' }}>{h.validCount}</td>
                    <td style={{ color: 'var(--easy)' }}>+{h.insertedCount}</td>
                    <td style={{ color: '#1d4ed8' }}>{h.updatedCount}</td>
                    <td style={{ color: 'var(--text-muted)' }}>{h.unchangedCount}</td>
                    <td style={{ color: 'var(--text-muted)' }}>{h.duplicateCount}</td>
                    <td style={{ color: h.errorCount > 0 ? 'var(--danger)' : 'var(--text-muted)' }}>
                      {h.errorCount}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
