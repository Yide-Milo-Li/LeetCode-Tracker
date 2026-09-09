/** Catalog-only JSONL workspace. Input generations protect previews and atomic commits. */
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
import { api, ApiError, type ImportHistoryItem, type ImportPreview, type ImportSummary } from '../api.ts';
import { translations, type Language } from '../i18n.ts';
import { useWorkspace } from '../workspace.tsx';
import { PageHeader, Feedback, Pagination, Dialog } from './ui.tsx';

/** Keep preview responses bound to the current input and serialize commit interaction. */
export function CatalogImportWorkspace({ lang }: { lang: Language }) {
  const t = translations[lang];
  const workspace = useWorkspace();
  const [historyPage, setHistoryPage] = useState(1);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyError, setHistoryError] = useState('');
  const [result, setResult] = useState<ImportSummary | null>(null);
  const historySeq = useRef(0);

  // Ingestion Mode ('upload' | 'paste')
  const [mode, setMode] = useState<'upload' | 'paste'>('upload');
  const [content, setContent] = useState('');
  const [selectedFileName, setSelectedFileName] = useState<string | null>(null);
  const [selectedFileSize, setSelectedFileSize] = useState<string | null>(null);

  // Preview & Ingestion status
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [commitLoading, setCommitLoading] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [alertMsg, setAlertMsg] = useState<{ type: 'success' | 'danger' | 'info'; text: string } | null>(
    null,
  );

  // History state
  const [history, setHistory] = useState<ImportHistoryItem[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // A generation covers file reads and previews; edits invalidate every older response.
  const inputGeneration = useRef(0);
  const previewGeneration = useRef<number | null>(null);
  const committing = useRef(false);

  useEffect(() => {
    void loadHistory();
    return () => {
      historySeq.current += 1;
    };
  }, [historyPage]);
  useEffect(
    () => () => {
      inputGeneration.current += 1;
    },
    [],
  );

  /** Invalidate pending reads and previews before changing the displayed input. */
  function invalidateInput() {
    if (uncertain) return inputGeneration.current;
    inputGeneration.current += 1;
    previewGeneration.current = null;
    setPreview(null);
    setPreviewLoading(false);
    setAlertMsg(null);
    return inputGeneration.current;
  }

  /** Refresh the recent committed imports after mounting or a successful write. */
  async function loadHistory() {
    const seq = ++historySeq.current;
    try {
      const res = await api.getImportHistory(historyPage, 20);
      if (seq !== historySeq.current) return;
      setHistory(res.items);
      setHistoryTotal(res.total);
      setHistoryError('');
    } catch (err) {
      if (seq === historySeq.current) setHistoryError(err instanceof Error ? err.message : String(err));
    }
  }

  /** Process a selected or dropped file with size validation before reading into memory. */
  function processFile(file: File) {
    if (committing.current || uncertain) return;
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
    if (committing.current || uncertain) return;
    if (!content.trim()) {
      setAlertMsg({
        type: 'danger',
        text: lang === 'zh' ? '请先上传文件或粘贴 JSONL 内容' : 'Please provide JSONL content first',
      });
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
    if (
      committing.current ||
      !preview ||
      preview.validCount === 0 ||
      previewGeneration.current !== inputGeneration.current
    )
      return;
    committing.current = true;

    setCommitLoading(true);
    setAlertMsg(null);
    try {
      const summary = await api.commitImport(preview.previewId);
      setUncertain(false);
      setResult(summary);
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
      // Successful catalog writes invalidate every dependent local view.
      workspace.notifyMutation();
      if (historyPage === 1) void loadHistory();
      else setHistoryPage(1);
    } catch (err) {
      setAlertMsg({ type: 'danger', text: err instanceof Error ? err.message : 'Commit failed' });
      // Only an explicit rejection releases the immutable preview. Lost responses retry its durable ID.
      setUncertain(!(err instanceof ApiError && err.status >= 400 && err.status < 500));
    } finally {
      committing.current = false;
      setCommitLoading(false);
    }
  }

  /** Clear the input and invalidate responses that may still arrive. */
  function handleClear() {
    if (committing.current || uncertain) return;
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
      <PageHeader
        title={lang === 'zh' ? '导入题库' : 'Import problems'}
        description={
          lang === 'zh'
            ? '添加你自行提供的 JSONL 题目数据。导入后即可搜索与记录练习。'
            : 'Add your own JSONL problem catalog, then search and record practices.'
        }
        back={{
          label: lang === 'zh' ? '返回题库' : 'Back to problems',
          run: () => workspace.navigate('problems'),
        }}
      />
      {/* User-owned JSONL ingestion remains separate from progress imports. */}
      <div className="card">
        <h2 className="card-title">
          <UploadCloud size={20} className="u-color-primary" />
          {t.workbenchTitle}
        </h2>
        <p className="card-desc">{t.workbenchDesc}</p>

        {alertMsg && (
          <div role="alert" className={`alert alert-${alertMsg.type}`}>
            {alertMsg.type === 'success' ? <CheckCircle2 size={18} /> : <AlertTriangle size={18} />}
            <span>{alertMsg.text}</span>
          </div>
        )}

        {uncertain && (
          <Feedback tone="warning">
            {lang === 'zh'
              ? '导入结果尚未确认。输入已冻结，请重试同一预览。'
              : 'Import result is unconfirmed. Input is frozen; retry the same preview.'}
          </Feedback>
        )}
        {/* Ingestion Mode Switcher */}
        <div className="u-display-flex u-gap-0-5rem u-margin-bottom-1-25rem">
          <button
            className={`btn btn-sm ${mode === 'upload' ? 'btn-primary' : 'btn-outline'}`}
            disabled={commitLoading || uncertain}
            onClick={() => setMode('upload')}
          >
            <UploadCloud size={14} />
            {t.tabUpload}
          </button>
          <button
            className={`btn btn-sm ${mode === 'paste' ? 'btn-primary' : 'btn-outline'}`}
            disabled={commitLoading || uncertain}
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
              role="button"
              tabIndex={commitLoading || uncertain ? -1 : 0}
              aria-label={t.dropzoneText}
              aria-disabled={commitLoading || uncertain}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  if (!committing.current && !uncertain) fileInputRef.current?.click();
                }
              }}
              onClick={() => {
                if (!committing.current && !uncertain) fileInputRef.current?.click();
              }}
              onDragOver={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
              onDragEnter={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                const file = e.dataTransfer?.files?.[0];
                if (file) processFile(file);
              }}
            >
              <input
                type="file"
                disabled={commitLoading || uncertain}
                ref={fileInputRef}
                accept=".jsonl,.txt,application/json"
                className="u-display-none"
                onChange={handleFileChange}
              />
              <UploadCloud size={36} className="u-margin-0-auto-0-5rem-auto u-color-text-muted" />
              <p className="u-font-weight-500 u-margin-bottom-0-25rem">{t.dropzoneText}</p>
              <p className="u-font-size-13px u-color-text-muted">
                UTF-8 encoded JSONL (max 10 MiB, 20,000 lines)
              </p>
            </div>
            {selectedFileName && (
              <div className="u-margin-top-0-75rem u-font-size-0-875rem u-color-primary">
                {t.selectedFile.replace('{name}', selectedFileName).replace('{size}', selectedFileSize ?? '')}
              </div>
            )}
          </div>
        ) : (
          <div>
            <textarea
              className="paste-textarea"
              aria-label={lang === 'zh' ? 'JSONL 内容' : 'JSONL content'}
              placeholder={t.pastePlaceholder}
              value={content}
              disabled={commitLoading || uncertain}
              onChange={(e) => {
                if (!committing.current && !uncertain) {
                  invalidateInput();
                  setContent(e.target.value);
                }
              }}
            />
          </div>
        )}

        {/* Form Action Buttons */}
        <div className="u-display-flex u-gap-0-75rem u-margin-top-1rem u-align-items-center">
          <button
            className="btn btn-primary"
            onClick={handlePreview}
            disabled={commitLoading || uncertain || previewLoading || !content.trim()}
          >
            {previewLoading ? (lang === 'zh' ? '正在分析...' : 'Analyzing...') : t.btnPreview}
          </button>
          {content.trim() && (
            <button className="btn btn-outline" disabled={commitLoading || uncertain} onClick={handleClear}>
              <RotateCcw size={14} />
              {t.btnClear}
            </button>
          )}
        </div>

        {/* 3. Preflight Preview Display */}
        {preview && (
          <div className="u-margin-top-2rem u-border-top-1px-solid-border-color u-padding-top-1-5rem">
            <h3 className="card-title u-font-size-1rem u-margin-bottom-1rem">{t.previewTitle}</h3>

            {/* Metrics Row */}
            <div className="metrics-grid u-grid-template-columns-repeat-auto-fit-minmax-130px-1fr">
              <div className="metric-card u-padding-0-75rem-1rem">
                <div className="metric-label">{t.metricTotalLines}</div>
                <div className="metric-value u-font-size-1-25rem">{preview.totalLines}</div>
              </div>
              <div className="metric-card u-padding-0-75rem-1rem">
                <div className="metric-label">{t.metricValid}</div>
                <div className="metric-value u-font-size-1-25rem u-color-primary">{preview.validCount}</div>
              </div>
              <div className="metric-card u-padding-0-75rem-1rem">
                <div className="metric-label">{t.metricInsert}</div>
                <div className="metric-value u-font-size-1-25rem u-color-easy">{preview.insertCount}</div>
              </div>
              <div className="metric-card u-padding-0-75rem-1rem">
                <div className="metric-label">{t.metricUpdate}</div>
                <div className="metric-value u-font-size-1-25rem u-color-primary">{preview.updateCount}</div>
              </div>
              <div className="metric-card u-padding-0-75rem-1rem">
                <div className="metric-label">{t.metricUnchanged}</div>
                <div className="metric-value u-font-size-1-25rem u-color-text-muted">
                  {preview.unchangedCount}
                </div>
              </div>
              <div className="metric-card u-padding-0-75rem-1rem">
                <div className="metric-label">{t.metricDuplicates}</div>
                <div className="metric-value u-font-size-1-25rem u-color-text-muted">
                  {preview.duplicateCount}
                </div>
              </div>
              <div className="metric-card u-padding-0-75rem-1rem">
                <div className="metric-label">{t.metricErrors}</div>
                <div className="metric-value u-font-size-1-25rem u-color-hard">{preview.errorCount}</div>
              </div>
            </div>

            {/* Error Table if any */}
            {preview.errors.length > 0 && (
              <div className="u-margin-bottom-1-5rem">
                <div className="u-font-weight-600 u-color-danger u-margin-bottom-0-5rem u-font-size-0-875rem">
                  {t.errorTableTitle.replace('{count}', String(preview.errors.length))}
                </div>
                <div className="table-container u-max-height-200px u-overflow-y-auto">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th className="u-width-70px">{t.tableLine}</th>
                        <th>{t.tableError}</th>
                        <th>{t.tableSnippet}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.errors.map((err, idx) => (
                        <tr key={idx}>
                          <td className="u-font-weight-600 u-color-danger">#{err.line}</td>
                          <td className="u-color-danger">{err.message}</td>
                          <td className="u-font-family-monospace u-font-size-13px u-color-text-muted">
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
              <div className="u-margin-bottom-1-5rem">
                <div className="u-font-weight-600 u-color-text-main u-margin-bottom-0-5rem u-font-size-0-875rem">
                  {t.sampleTitle.replace('{count}', String(preview.sampleItems.length))}
                </div>
                <div className="table-container u-max-height-240px u-overflow-y-auto">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th className="u-width-70px">{t.tableId}</th>
                        <th>{t.tableTitle}</th>
                        <th className="u-width-90px">{t.tableDifficulty}</th>
                        <th className="u-width-100px">{t.tableAction}</th>
                        <th>{t.tableChanges}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.sampleItems.map((item, idx) => (
                        <tr key={idx}>
                          <td className="u-font-weight-600">#{item.frontendId}</td>
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
                                backgroundColor:
                                  item.action === 'insert'
                                    ? 'var(--success-bg)'
                                    : item.action === 'update'
                                      ? 'var(--selected)'
                                      : 'var(--bg-card-muted)',
                                color:
                                  item.action === 'insert'
                                    ? 'var(--easy)'
                                    : item.action === 'update'
                                      ? 'var(--primary)'
                                      : 'var(--text-muted)',
                              }}
                            >
                              {item.action === 'insert'
                                ? t.actionInsert
                                : item.action === 'update'
                                  ? t.actionUpdate
                                  : t.actionUnchanged}
                            </span>
                          </td>
                          <td className="u-font-size-13px u-color-text-muted">
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
            <div className="u-display-flex u-align-items-center u-gap-1rem u-margin-top-1-25rem">
              <button
                className="btn btn-primary u-padding-0-625rem-1-25rem u-font-size-0-9375rem"
                onClick={handleCommit}
                disabled={commitLoading || preview.validCount === 0}
              >
                <CheckCircle2 size={16} />
                {commitLoading ? (lang === 'zh' ? '正在导入…' : 'Importing…') : t.btnCommit}
              </button>
              <span className="u-font-size-0-8125rem u-color-text-muted">
                {preview.validCount > 0
                  ? lang === 'zh'
                    ? `将把 ${preview.validCount} 道有效题目导入本地题库`
                    : `Will import ${preview.validCount} valid problems into your catalog`
                  : lang === 'zh'
                    ? '没有可提交的有效记录'
                    : 'No valid records to commit'}
              </span>
            </div>
          </div>
        )}
      </div>

      {/* 4. Import History Section */}
      <div className="card">
        <h2 className="card-title">
          <History size={20} className="u-color-primary" />
          {t.historyTitle}
        </h2>
        <p className="card-desc">{t.historyDesc}</p>

        {history.length === 0 ? (
          <p className="u-color-text-muted u-font-size-0-875rem">{t.noHistory}</p>
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
                    <td className="u-font-size-0-8125rem">
                      <button
                        className="text-link"
                        onClick={() => {
                          void api
                            .getImportResult(h.id)
                            .then(setResult)
                            .catch((err) => setHistoryError(String(err.message)));
                        }}
                      >
                        {new Date(h.importedAt).toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US', {
                          timeZone: workspace.timezone ?? 'UTC',
                        })}
                      </button>
                    </td>
                    <td>{h.totalLines}</td>
                    <td className="u-font-weight-600 u-color-primary">{h.validCount}</td>
                    <td className="u-color-easy">+{h.insertedCount}</td>
                    <td className="u-color-primary">{h.updatedCount}</td>
                    <td className="u-color-text-muted">{h.unchangedCount}</td>
                    <td className="u-color-text-muted">{h.duplicateCount}</td>
                    <td style={{ color: h.errorCount > 0 ? 'var(--danger)' : 'var(--text-muted)' }}>
                      {h.errorCount}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {historyError && (
          <Feedback retry={{ label: lang === 'zh' ? '重试' : 'Retry', run: () => void loadHistory() }}>
            {historyError}
          </Feedback>
        )}
        <Pagination lang={lang} page={historyPage} total={historyTotal} limit={20} onPage={setHistoryPage} />
      </div>
      {result && (
        <Dialog
          title={lang === 'zh' ? '题库导入结果' : 'Catalog import result'}
          lang={lang}
          onClose={() => setResult(null)}
        >
          <dl className="detail-grid">
            <dt>{t.metricTotalLines}</dt>
            <dd>{result.totalLines}</dd>
            <dt>{t.metricValid}</dt>
            <dd>{result.validCount}</dd>
            <dt>{t.metricInsert}</dt>
            <dd>{result.insertedCount}</dd>
            <dt>{t.metricUpdate}</dt>
            <dd>{result.updatedCount}</dd>
            <dt>{t.metricUnchanged}</dt>
            <dd>{result.unchangedCount}</dd>
            <dt>{t.metricDuplicates}</dt>
            <dd>{result.duplicateCount}</dd>
            <dt>{t.metricErrors}</dt>
            <dd>{result.errorCount}</dd>
          </dl>
          {result.errorsUnavailable && (
            <Feedback tone="warning">
              {lang === 'zh'
                ? '旧导入未保存错误明细。'
                : 'Error details were not stored for this legacy import.'}
            </Feedback>
          )}
          {result.errors.map((error, index) => (
            <article className="version-card" key={index}>
              <strong>
                #{error.line} {error.message}
              </strong>
              <pre>{error.snippet}</pre>
            </article>
          ))}
        </Dialog>
      )}
    </div>
  );
}
