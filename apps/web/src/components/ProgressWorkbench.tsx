/** Progress import workspace: Gemini proposes candidates; the local server matches, validates and commits. */
import React, { useEffect, useRef, useState } from 'react';
import {
  api,
  type GeminiStatus,
  type ProgressCandidateInput,
  type ProgressImportPreview,
  type ProgressImportSummary,
} from '../api.ts';
import type { Language } from '../i18n.ts';
import { useWorkspace } from '../workspace.tsx';
import { Feedback, Field, PageHeader, Pagination, Dialog } from './ui.tsx';
import { SnapshotBrowser } from './SnapshotBrowser.tsx';

/** Review a durable import result without describing imported observations as automatic synchronization. */
function ImportResult({ result, lang }: { result: ProgressImportSummary; lang: Language }) {
  const zh = lang === 'zh';
  return (
    <div>
      <Feedback tone="success">
        {zh ? '进度已导入' : 'Progress imported'} ·{' '}
        {new Date(result.importedAt).toLocaleString(zh ? 'zh-CN' : 'en-US')}
      </Feedback>
      <div className="summary-counts">
        <span>
          {zh ? '新增' : 'Inserted'} <strong>{result.insertedCount}</strong>
        </span>
        <span>
          {zh ? '更新' : 'Updated'} <strong>{result.updatedCount}</strong>
        </span>
        <span>
          {zh ? '未变' : 'Unchanged'} <strong>{result.unchangedCount}</strong>
        </span>
        <span>
          {zh ? '重复' : 'Duplicates'} <strong>{result.duplicateCount}</strong>
        </span>
        <span>
          {zh ? '冲突' : 'Conflicts'} <strong>{result.conflictCount}</strong>
        </span>
        <span>
          {zh ? '错误' : 'Errors'} <strong>{result.errorCount}</strong>
        </span>
      </div>
      {result.errors?.length > 0 && (
        <details open>
          <summary>{zh ? '错误明细' : 'Error details'}</summary>
          <ul>
            {result.errors.map((error, i) => (
              <li key={i}>
                #{error.index + 1} {error.message}
                {error.snippet && <pre>{error.snippet}</pre>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/** Page through committed batches and fetch their persisted result when selected. */
function ImportHistory({ lang }: { lang: Language }) {
  const workspace = useWorkspace();
  const zh = lang === 'zh';
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [items, setItems] = useState<Omit<ProgressImportSummary, 'errors'>[]>([]);
  const [result, setResult] = useState<ProgressImportSummary | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    api
      .getProgressImportHistory(page, 20)
      .then((data) => {
        if (active) {
          setItems(data.items);
          setTotal(data.total);
          setError('');
        }
      })
      .catch((err) => {
        if (active) setError(String(err.message));
      });
    return () => {
      active = false;
    };
  }, [page, workspace.revision, retry]);
  return (
    <section>
      <h2>{zh ? '进度导入历史' : 'Progress import history'}</h2>
      {error && (
        <Feedback retry={{ label: zh ? '重试' : 'Retry', run: () => setRetry((n) => n + 1) }}>
          {error}
        </Feedback>
      )}
      {!items.length ? (
        <p className="muted">{zh ? '暂无导入历史' : 'No import history yet'}</p>
      ) : (
        items.map((item) => (
          <button
            className="history-row"
            key={item.id}
            onClick={() => {
              void api
                .getProgressImportResult(item.id)
                .then(setResult)
                .catch((err) => setError(String(err.message)));
            }}
          >
            <span>
              {new Date(item.importedAt).toLocaleString(zh ? 'zh-CN' : 'en-US', {
                timeZone: workspace.timezone ?? 'UTC',
              })}
            </span>
            <span>
              +{item.insertedCount} · ↻{item.updatedCount} · {item.errorCount} {zh ? '错误' : 'errors'}
            </span>
          </button>
        ))
      )}
      <Pagination page={page} total={total} limit={20} lang={lang} onPage={setPage} />
      {result && (
        <Dialog title={zh ? '导入结果' : 'Import result'} lang={lang} onClose={() => setResult(null)}>
          <ImportResult result={result} lang={lang} />
        </Dialog>
      )}
    </section>
  );
}

/** Own the input generation and immutable commit intent; background refresh never edits the user's draft. */
export function ProgressWorkbench({ lang }: { lang: Language }) {
  const zh = lang === 'zh';
  const workspace = useWorkspace();
  const [step, setStep] = useState(0);
  const [raw, setRaw] = useState('');
  const [year, setYear] = useState(String(new Date().getFullYear()));
  const [zone, setZone] = useState(workspace.timezone ?? '');
  const [candidates, setCandidates] = useState<ProgressCandidateInput[]>([]);
  const [unparsed, setUnparsed] = useState<string[]>([]);
  const [preview, setPreview] = useState<ProgressImportPreview | null>(null);
  const [confirmed, setConfirmed] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<ProgressImportSummary | null>(null);
  const [status, setStatus] = useState<GeminiStatus | null>(null);
  const [busy, setBusy] = useState<'format' | 'preview' | 'commit' | null>(null);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const commitLock = useRef(false);
  const commitIntent = useRef<{ id: string; confirmed: string[] } | null>(null);
  const [uncertain, setUncertain] = useState(false);
  useEffect(() => {
    let active = true;
    api
      .getProgressImportStatus()
      .then((value) => {
        if (active) setStatus(value);
      })
      .catch((err) => {
        if (active) setError(String(err.message));
      });
    return () => {
      active = false;
      generation.current++;
    };
  }, []);
  const frozen = busy === 'commit' || uncertain;
  const steps = zh
    ? ['粘贴内容', '整理与预览', '处理冲突', '确认导入', '查看结果']
    : ['Paste content', 'Organize & preview', 'Resolve conflicts', 'Confirm import', 'View result'];
  /** Editing invalidates all prior previews and consent, including responses still in flight. */
  function invalidate() {
    if (frozen) return;
    generation.current++;
    setPreview(null);
    setConfirmed(new Set());
    setBusy(null);
    setError('');
    commitIntent.current = null;
  }
  /** Formatting supplies editable candidates only; it cannot authorize any database write. */
  async function format() {
    if (!raw.trim() || frozen) return;
    invalidate();
    const version = generation.current;
    setBusy('format');
    try {
      const data = await api.formatWithGemini(raw, year ? Number(year) : undefined);
      if (version !== generation.current) return;
      setCandidates(data.candidates);
      setUnparsed(data.unparsedSnippets);
      setStep(1);
    } catch (err) {
      if (version === generation.current) setError(String((err as Error).message));
    } finally {
      if (version === generation.current) setBusy(null);
    }
  }
  /** Bind every preview to the exact edited candidate set, year and explicitly selected source timezone. */
  async function makePreview() {
    if (frozen || !candidates.length) return;
    invalidate();
    const version = generation.current;
    setBusy('preview');
    try {
      const data = await api.previewProgressImport(
        candidates,
        undefined,
        year ? Number(year) : undefined,
        zone || undefined,
      );
      if (version !== generation.current) return;
      setPreview(data);
      setStep(2);
    } catch (err) {
      if (version === generation.current) setError(String((err as Error).message));
    } finally {
      if (version === generation.current) setBusy(null);
    }
  }
  /** Retry a lost response with the same preview and consent; server replay returns the original atomic result. */
  async function commit() {
    if (commitLock.current || !preview) return;
    if (!uncertain && Date.now() >= preview.expiresAt) {
      setError(
        zh ? '预览已过期，请重新预览并确认冲突。' : 'Preview expired. Preview again and reconfirm conflicts.',
      );
      setStep(1);
      setPreview(null);
      return;
    }
    commitIntent.current ??= { id: preview.previewId, confirmed: [...confirmed] };
    commitLock.current = true;
    setBusy('commit');
    setError('');
    try {
      const data = await api.commitProgressImport(commitIntent.current.id, commitIntent.current.confirmed);
      setResult(data);
      setStep(4);
      setUncertain(false);
      commitIntent.current = null;
      workspace.notifyMutation();
    } catch (err) {
      setError(String((err as Error).message));
      const stale = /expired|stale|revision|not found/i.test(String((err as Error).message));
      setUncertain(!stale);
      if (stale) {
        commitIntent.current = null;
        setPreview(null);
        setConfirmed(new Set());
        setStep(1);
      }
    } finally {
      commitLock.current = false;
      setBusy(null);
    }
  }
  const eligible =
    preview?.items.filter(
      (item) => item.allowedToCommit || (item.action === 'conflict' && confirmed.has(item.frontendId)),
    ).length ?? 0;
  return (
    <div className="import-workspace">
      <PageHeader
        title={zh ? '导入进度' : 'Import progress'}
        description={
          zh ? '把已有练习成果带进来，核对后保存。' : 'Bring in your practice progress, review it, then save.'
        }
        back={{ label: zh ? '返回进展' : 'Back to progress', run: () => workspace.navigate('records') }}
      />
      <ol className="workflow-steps">
        {steps.map((label, index) => (
          <li
            key={label}
            aria-current={step === index ? 'step' : undefined}
            className={step === index ? 'current' : step > index ? 'past' : ''}
          >
            <span>{index + 1}</span>
            {label}
          </li>
        ))}
      </ol>
      {error && <Feedback>{error}</Feedback>}
      {uncertain && (
        <Feedback tone="warning">
          {zh
            ? '提交结果未确认。内容与逐题确认已冻结，重试将核对同一次导入。'
            : 'Submission is unconfirmed. Content and decisions are frozen; retry checks the same import.'}
        </Feedback>
      )}
      {step === 0 && (
        <section className="import-stage">
          <h2>{zh ? '粘贴已有进度' : 'Paste your existing progress'}</h2>
          <p className="muted">
            {zh
              ? 'Gemini 仅整理候选数据，匹配和校验由本地服务完成。'
              : 'Gemini only organizes candidate data. Your local service handles matching and validation.'}
          </p>
          {status && !status.configured && (
            <Feedback tone="warning">
              {zh
                ? 'Gemini 未配置。你仍可以手动填写候选数据。'
                : 'Gemini is not configured. You can still enter candidates manually.'}
            </Feedback>
          )}
          <Field label={zh ? '进度内容' : 'Progress content'}>
            <textarea
              rows={9}
              value={raw}
              onChange={(e) => {
                invalidate();
                setRaw(e.target.value);
              }}
              placeholder={
                zh
                  ? '粘贴题号、最近日期、结果与累计提交次数…'
                  : 'Paste problem numbers, latest dates, results and cumulative submission counts…'
              }
            />
          </Field>
          <div className="form-grid">
            <Field label={zh ? '缺失年份时使用' : 'Year for dates without a year'}>
              <input
                type="number"
                min="1970"
                max="2100"
                value={year}
                onChange={(e) => {
                  invalidate();
                  setYear(e.target.value);
                }}
              />
            </Field>
            <Field label={zh ? '来源时区（IANA）' : 'Source timezone (IANA)'}>
              <input
                value={zone}
                onChange={(e) => {
                  invalidate();
                  setZone(e.target.value);
                }}
                placeholder={workspace.timezone ?? (zh ? '使用已设置时区' : 'Use configured timezone')}
              />
            </Field>
          </div>
          <div className="form-actions">
            <button
              className="btn btn-secondary"
              onClick={() => {
                invalidate();
                setRaw('');
                setCandidates([]);
                setUnparsed([]);
              }}
            >
              {zh ? '清空' : 'Clear'}
            </button>
            <button
              className="btn btn-secondary"
              disabled={busy !== null}
              onClick={() => {
                invalidate();
                setCandidates([
                  { frontendId: '', lastSubmitted: '', lastResult: 'Accepted', submissions: 1 },
                ]);
                setStep(1);
              }}
            >
              {zh ? '手动填写候选' : 'Enter candidates manually'}
            </button>
            <button
              className="btn btn-primary"
              disabled={!raw.trim() || busy !== null || !status?.configured}
              onClick={() => void format()}
            >
              {busy === 'format' ? (zh ? '整理中…' : 'Organizing…') : zh ? '整理内容' : 'Organize content'}
            </button>
          </div>
        </section>
      )}
      {step === 1 && (
        <section className="import-stage">
          <div className="section-heading">
            <h2>{zh ? '核对候选数据' : 'Review candidate data'}</h2>
            <button
              className="text-link"
              disabled={frozen}
              onClick={() => {
                invalidate();
                setStep(0);
              }}
            >
              {zh ? '返回内容' : 'Back to content'}
            </button>
          </div>
          {unparsed.length > 0 && (
            <Feedback tone="warning">
              <details open>
                <summary>
                  {zh ? '未整理的片段' : 'Unparsed snippets'} ({unparsed.length})
                </summary>
                {unparsed.map((snippet, i) => (
                  <pre key={i}>{snippet}</pre>
                ))}
              </details>
            </Feedback>
          )}
          <div className="table-container">
            <table className="data-table candidate-table">
              <thead>
                <tr>
                  {(zh
                    ? ['题号', '题名（可选）', '最近日期', '结果', '累计提交', '操作']
                    : ['Number', 'Title (optional)', 'Latest date', 'Result', 'Submissions', 'Action']
                  ).map((label) => (
                    <th key={label}>{label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {candidates.map((candidate, index) => (
                  <tr key={index}>
                    {(['frontendId', 'title', 'lastSubmitted', 'lastResult', 'submissions'] as const).map(
                      (field) => (
                        <td key={field}>
                          <input
                            aria-label={field + ' ' + (index + 1)}
                            value={candidate[field] ?? ''}
                            disabled={frozen}
                            onChange={(e) => {
                              invalidate();
                              setCandidates((old) =>
                                old.map((item, i) =>
                                  i === index ? { ...item, [field]: e.target.value } : item,
                                ),
                              );
                            }}
                          />
                        </td>
                      ),
                    )}
                    <td>
                      <button
                        className="text-link"
                        disabled={frozen}
                        onClick={() => {
                          invalidate();
                          setCandidates((old) => old.filter((_, i) => i !== index));
                        }}
                      >
                        {zh ? '移除' : 'Remove'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="form-actions">
            <button
              className="btn btn-secondary"
              disabled={frozen}
              onClick={() => {
                invalidate();
                setCandidates((old) => [
                  ...old,
                  { frontendId: '', lastSubmitted: '', lastResult: 'Accepted', submissions: 1 },
                ]);
              }}
            >
              {zh ? '添加候选' : 'Add candidate'}
            </button>
            <button
              className="btn btn-primary"
              disabled={!candidates.length || busy !== null || uncertain}
              onClick={() => void makePreview()}
            >
              {busy === 'preview' ? (zh ? '校验中…' : 'Validating…') : zh ? '生成预览' : 'Generate preview'}
            </button>
          </div>
        </section>
      )}
      {(step === 2 || step === 3) && preview && (
        <section className="import-stage">
          <h2>{steps[step]}</h2>
          <div className="summary-counts">
            <span>
              {zh ? '有效' : 'Valid'} <strong>{preview.validCount}</strong>
            </span>
            <span>
              {zh ? '冲突' : 'Conflicts'} <strong>{preview.conflictCount}</strong>
            </span>
            <span>
              {zh ? '错误' : 'Errors'} <strong>{preview.errorCount}</strong>
            </span>
            <span>
              {zh ? '重复' : 'Duplicates'} <strong>{preview.duplicateCount}</strong>
            </span>
          </div>
          <div className="preview-items">
            {preview.items.map((item, index) => (
              <article className={'preview-item ' + item.action} key={index}>
                <div className="section-heading">
                  <h3>
                    #{item.frontendId} {item.problemTitle}
                  </h3>
                  <span className="badge">
                    {
                      {
                        insert: zh ? '新增' : 'Insert',
                        update: zh ? '更新' : 'Update',
                        unchanged: zh ? '未变' : 'Unchanged',
                        conflict: zh ? '冲突' : 'Conflict',
                        duplicate: zh ? '重复' : 'Duplicate',
                        error: zh ? '错误' : 'Error',
                      }[item.action]
                    }
                  </span>
                </div>
                <div className="snapshot-diff">
                  {item.currentSnapshot && (
                    <div>
                      <small>{zh ? '当前快照' : 'Current snapshot'}</small>
                      <p>
                        {item.currentSnapshot.lastSubmittedAt} · {item.currentSnapshot.lastResult} ·{' '}
                        {item.currentSnapshot.totalSubmissions}
                      </p>
                    </div>
                  )}
                  <div>
                    <small>{zh ? '导入值' : 'Incoming value'}</small>
                    <p>
                      {item.incomingSnapshot.lastSubmittedAt} · {item.incomingSnapshot.lastResult} ·{' '}
                      {item.incomingSnapshot.totalSubmissions}
                    </p>
                  </div>
                </div>
                {(item.error || item.conflictReason) && (
                  <p className="warning-text">{item.error || item.conflictReason}</p>
                )}
                {item.action === 'conflict' && !item.error && (
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      disabled={step === 3 || frozen}
                      checked={confirmed.has(item.frontendId)}
                      onChange={(e) => {
                        const checked = e.target.checked;
                        setConfirmed((old) => {
                          const next = new Set(old);
                          checked ? next.add(item.frontendId) : next.delete(item.frontendId);
                          return next;
                        });
                      }}
                    />
                    {zh
                      ? '我已核对，允许覆盖此题快照'
                      : 'I reviewed this problem and allow its snapshot to be replaced'}
                  </label>
                )}
              </article>
            ))}
          </div>
          {preview.errors.length > 0 && (
            <details open>
              <summary>{zh ? '校验错误' : 'Validation errors'}</summary>
              <ul>
                {preview.errors.map((item, i) => (
                  <li key={i}>
                    #{item.index + 1} {item.message}
                  </li>
                ))}
              </ul>
            </details>
          )}
          <p className="coverage-note">
            {zh
              ? '未确认的冲突、重复和无效行将跳过。有效集合一次提交，累计次数按快照替换，不进行累加。'
              : 'Unconfirmed conflicts, duplicates and invalid rows are skipped. The valid set commits together; cumulative counts replace snapshot values rather than adding to them.'}
          </p>
          <p>
            {zh ? '本次选中可处理行数：' : 'Selected processable rows: '}
            {eligible} · {zh ? '预览有效至 ' : 'Preview valid until '}
            {new Date(preview.expiresAt).toLocaleTimeString(zh ? 'zh-CN' : 'en-US')}
          </p>
          <div className="form-actions">
            <button
              className="btn btn-secondary"
              disabled={frozen}
              onClick={() => {
                if (step === 3) setStep(2);
                else {
                  invalidate();
                  setStep(1);
                }
              }}
            >
              {zh ? '返回修改' : 'Back to edit'}
            </button>
            <button
              className="btn btn-primary"
              disabled={busy !== null || eligible === 0}
              onClick={() => (step === 2 ? setStep(3) : void commit())}
            >
              {busy === 'commit'
                ? zh
                  ? '导入中…'
                  : 'Importing…'
                : step === 2
                  ? zh
                    ? '继续确认'
                    : 'Continue to confirmation'
                  : uncertain
                    ? zh
                      ? '重试本次导入'
                      : 'Retry this import'
                    : zh
                      ? '确认导入'
                      : 'Confirm import'}
            </button>
          </div>
        </section>
      )}
      {step === 4 && result && (
        <section className="import-stage">
          <ImportResult result={result} lang={lang} />
          {preview && (
            <p className="coverage-note">
              {zh ? '本次保留原值的未确认冲突：' : 'Unconfirmed conflicts kept unchanged: '}
              {
                preview.items.filter((item) => item.action === 'conflict' && !confirmed.has(item.frontendId))
                  .length
              }
            </p>
          )}
          <div className="form-actions">
            <button
              className="btn btn-secondary"
              onClick={() => {
                invalidate();
                setRaw('');
                setCandidates([]);
                setUnparsed([]);
                setResult(null);
                setStep(0);
              }}
            >
              {zh ? '开始另一批导入' : 'Start another import'}
            </button>
            <button className="btn btn-primary" onClick={() => workspace.navigate('records')}>
              {zh ? '查看记录' : 'View records'}
            </button>
          </div>
        </section>
      )}
      <details className="workspace-details" open>
        <summary>{zh ? '浏览当前快照' : 'Browse current snapshots'}</summary>
        <SnapshotBrowser lang={lang} />
      </details>
      <details className="workspace-details">
        <summary>{zh ? '查看导入历史' : 'View import history'}</summary>
        <ImportHistory lang={lang} />
      </details>
    </div>
  );
}
