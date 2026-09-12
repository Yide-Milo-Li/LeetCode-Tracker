/** Catalog-only JSONL workspace. Input generations protect previews and atomic commits. */
import React, { useEffect, useState, useRef } from 'react';
import {
  UploadCloud,
  FileText,
  CheckCircle2,
  AlertTriangle,
  RotateCcw,
  Sparkles,
  Languages,
  Palette,
  Globe,
} from 'lucide-react';
import { api, ApiError, type ImportHistoryItem, type ImportPreview, type ImportSummary } from '../api.ts';
import { translations, type Language } from '../i18n.ts';
import { useWorkspace } from '../workspace.tsx';
import { PageHeader, Feedback, InfoPopover } from './ui.tsx';
import { CatalogPreviewSummary } from './CatalogPreviewSummary.tsx';
import { CatalogImportHistory } from './CatalogImportHistory.tsx';

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
        back={{
          label: lang === 'zh' ? '返回题库' : 'Back to problems',
          run: () => workspace.navigate('problems'),
        }}
      />
      {/* User-owned JSONL ingestion remains separate from progress imports. */}
      <div className="import-stage">
        <InfoPopover label={lang === 'zh' ? 'JSONL 格式说明' : 'JSONL format help'} content={<p>{t.workbenchDesc}</p>} />

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
          <CatalogPreviewSummary
            preview={preview}
            lang={lang}
            commitLoading={commitLoading}
            onCommit={handleCommit}
          />
        )}
      </div>

      {/* 4. Import History Section */}
      <CatalogImportHistory
        history={history}
        lang={lang}
        timezone={workspace.timezone}
        historyError={historyError}
        historyPage={historyPage}
        historyTotal={historyTotal}
        onPageChange={setHistoryPage}
        onRetryHistory={() => void loadHistory()}
        result={result}
        onViewResult={(id) => {
          void api
            .getImportResult(id)
            .then(setResult)
            .catch((err) => setHistoryError(String(err.message)));
        }}
        onCloseResult={() => setResult(null)}
      />
    </div>
  );
}
