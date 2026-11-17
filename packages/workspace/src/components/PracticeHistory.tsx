import { useWorkspaceEnvironment } from '../context.tsx';
/**
 * Historical practice logs list with pagination for catalog problem detail view.
 */
import React, { useEffect, useRef, useState } from 'react';
import { useBusinessRefresh } from '../hooks/useBusinessRefresh.ts';
import { type CatalogProblem, type PracticeRecord } from '../api.ts';
import type { Language } from '../i18n.ts';
import { localizeApiError } from '../error-i18n.ts';
import { useWorkspace } from '../workspace.tsx';
import { Feedback, Pagination } from './ui.tsx';
import { practiceTime } from './PracticeRecordCard.tsx';

export interface PracticeHistoryProps {
  problem: CatalogProblem;
  lang: Language;
}

/**
 * Page through all manual practices for a catalog problem, including revoked audit records.
 */
export function PracticeHistory({ problem, lang }: PracticeHistoryProps) {
  const environment = useWorkspaceEnvironment();
  const api = environment.client;

  const workspace = useWorkspace();
  const root = useRef<HTMLElement>(null);
  const externalRevision = useBusinessRefresh(['libraryGeneration', 'practice'], root);
  const [page, setPage] = useState(1);
  const [records, setRecords] = useState<PracticeRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true);
    api
      .getPracticeRecords({ questionFrontendId: problem.questionFrontendId, status: 'all', page, limit: 20 })
      .then((result) => {
        if (active) {
          setRecords(result.items);
          setTotal(result.total);
          setError('');
        }
      })
      .catch((err) => {
        if (active) setError(localizeApiError(err, lang));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [problem.questionFrontendId, page, workspace.revision, externalRevision]);

  return (
    <section ref={root}>
      <h3>{lang === 'zh' ? '练习记录' : 'Practice history'}</h3>
      {error && <Feedback>{error}</Feedback>}
      {loading ? (
        <p role="status">…</p>
      ) : !records.length ? (
        <p className="muted">{lang === 'zh' ? '暂无已知记录' : 'No known records'}</p>
      ) : (
        records.map((record) => (
          <button
            className="history-row"
            key={record.id}
            onClick={() => workspace.openPractice({ mode: 'detail', record })}
          >
            <span>{practiceTime(record, lang, workspace.timezone)}</span>
            <span>
              {record.status === 'revoked'
                ? lang === 'zh'
                  ? '已撤销'
                  : 'Revoked'
                : record.completed
                  ? '✓'
                  : '—'}
            </span>
          </button>
        ))
      )}
      <Pagination page={page} total={total} limit={20} onPage={setPage} lang={lang} />
    </section>
  );
}
