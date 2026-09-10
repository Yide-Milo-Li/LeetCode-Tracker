/**
 * Historical progress import log and detail modal component.
 */
import React, { useEffect, useState } from 'react';
import { api, type ProgressImportSummary } from '../api.ts';
import type { Language } from '../i18n.ts';
import { useWorkspace } from '../workspace.tsx';
import { Dialog, Feedback, Pagination } from './ui.tsx';

/** Review a durable import result without describing imported observations as automatic synchronization. */
export function ImportResult({ result, lang }: { result: ProgressImportSummary; lang: Language }) {
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
export function ImportHistory({ lang }: { lang: Language }) {
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
          <article className="history-card" key={item.id}>
            <div>
              <h3>{new Date(item.importedAt).toLocaleString(zh ? 'zh-CN' : 'en-US')}</h3>
              <p className="muted">
                {zh
                  ? `总计 ${item.totalCandidates} · 新增 ${item.insertedCount} · 更新 ${item.updatedCount}`
                  : `Total ${item.totalCandidates} · Inserted ${item.insertedCount} · Updated ${item.updatedCount}`}
              </p>
            </div>
            <button
              className="btn btn-secondary"
              onClick={async () => {
                try {
                  const detail = await api.getProgressImportResult(item.id);
                  setResult(detail);
                } catch (err) {
                  setError(String((err as Error).message));
                }
              }}
            >
              {zh ? '明细' : 'Details'}
            </button>
          </article>
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
