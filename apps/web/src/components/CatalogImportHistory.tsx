/**
 * Catalog import history log table and detail modal viewer.
 */
import React from 'react';
import type { ImportHistoryItem, ImportSummary } from '../api.ts';
import { translations, type Language } from '../i18n.ts';
import { Dialog, Feedback, Pagination } from './ui.tsx';

interface CatalogImportHistoryProps {
  history: ImportHistoryItem[];
  lang: Language;
  timezone?: string | null;
  historyError: string | null;
  historyPage: number;
  historyTotal: number;
  onPageChange: (page: number) => void;
  onRetryHistory: () => void;
  result: ImportSummary | null;
  onViewResult: (id: string) => void;
  onCloseResult: () => void;
}

/**
 * Render catalog import history records, pagination controls, and modal error/stats dialog.
 */
export const CatalogImportHistory: React.FC<CatalogImportHistoryProps> = ({
  history,
  lang,
  timezone,
  historyError,
  historyPage,
  historyTotal,
  onPageChange,
  onRetryHistory,
  result,
  onViewResult,
  onCloseResult,
}) => {
  const t = translations[lang];

  return (
    <>
      <details className="workspace-details">
        <summary>{t.historyTitle}</summary>

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
                    <button className="text-link" onClick={() => onViewResult(h.id)}>
                      {new Date(h.importedAt).toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US', {
                        timeZone: timezone ?? 'UTC',
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
        <Feedback retry={{ label: lang === 'zh' ? '重试' : 'Retry', run: onRetryHistory }}>
          {historyError}
        </Feedback>
      )}
      <Pagination lang={lang} page={historyPage} total={historyTotal} limit={20} onPage={onPageChange} />

      </details>
      {result && (
        <Dialog
          title={lang === 'zh' ? '题库导入结果' : 'Catalog import result'}
          lang={lang}
          onClose={onCloseResult}
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
    </>
  );
};
